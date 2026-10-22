(function (GH) {
  'use strict';

  /* ==========================================================================
   * GUITARRADA HERO — src/gameplay/chart.js
   * Modulo: GH.Chart   (dono: agente GAMEPLAY)
   *
   * O chart e a partitura jogavel. Este modulo pega o array cru de notas de
   * GH.Songs[i].charts[dificuldade] e devolve uma estrutura NORMALIZADA,
   * VALIDADA e INDEXADA, pronta para ser consumida 60 vezes por segundo sem
   * varrer nada.
   *
   * Contrato (ARCHITECTURE.md secao 6):
   *   GH.Chart = {
   *     speed, load(song, difficulty), notes,
   *     zAt(songTime, noteTime), timeAt(songTime, z),
   *     visibleRange(songTime), starPowerPhrases, reset()
   *   }
   *
   * Formula UNICA de posicao (secao 3 — ninguem mais implementa isto):
   *   z = STRIKE_Z + (noteTime - songTime) * -1 * speed
   * Nota no futuro => z negativo (longe). Nota no passado => z positivo (perto).
   * ==========================================================================*/

  var LANES = 5;

  /* Notas dentro desta janela sao o MESMO ataque (acorde). 8ms e seguro:
   * semicolcheia a 240bpm ainda tem 62ms de intervalo. */
  var CHORD_EPS = 0.008;

  /* Sustain menor que isso nao vale a pena — vira nota simples (evita
   * "tocos" de sustain de 1 frame que so poluem a pista). */
  var SUSTAIN_MIN = 0.090;

  /* Folga obrigatoria entre o fim de um sustain e a proxima nota da MESMA
   * raia. Sem isso o jogador precisaria soltar e reapertar em 0ms. */
  var SUSTAIN_GAP = 0.020;

  /* Duas notas iguais (mesmo t, mesma raia) dentro disso sao duplicata. */
  var DEDUPE_EPS = 0.004;

  /* Estados de nota (o agente de NOTAS le isto para saber o que desenhar). */
  var STATE = { PENDING: 0, HIT: 1, MISSED: 2, HELD: 3, DONE: 4 };

  /* --------------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------------*/

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function clampLane(v) {
    var n = Math.round(+v);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : (n > LANES - 1 ? LANES - 1 : n);
  }

  function layout() {
    return GH.Layout || {
      LANES: 5, LANE_W: 0.72, HALF_W: 1.80, SPAWN_Z: -46, DESPAWN_Z: 6,
      STRIKE_Z: 0, SURFACE_Y: 0, GEM_Y: 0.16,
      laneX: function (i) { return (i - 2) * 0.72; }
    };
  }

  /* BPM da musica num instante — usado apenas para estimar pontuacao base de
   * sustain no carregamento. O relogio oficial continua sendo o GH.Conductor. */
  function songBpmAt(song, t) {
    if (!song) return 120;
    var map = song.tempoMap;
    if (map && map.length) {
      var bpm = map[0].bpm || 120;
      for (var i = 0; i < map.length; i++) {
        if (map[i].t <= t) bpm = map[i].bpm || bpm; else break;
      }
      return bpm > 0 ? bpm : 120;
    }
    if (typeof song.bpm === 'number' && song.bpm > 0) return song.bpm;
    if (song.bpm && song.bpm.length && song.bpm[0]) {
      var b0 = song.bpm[0];
      return (typeof b0 === 'number' ? b0 : (b0.bpm || 120));
    }
    return 120;
  }

  /* Busca binaria: primeiro indice de `arr` cujo campo `.t` e >= t. */
  function lowerBoundT(arr, t) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /* Primeiro indice cujo `.t` e > t. */
  function upperBoundT(arr, t) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /* Busca binaria em array de indices ordenados por tempo (indice por raia). */
  function lowerBoundIdx(idxArr, notes, t) {
    var lo = 0, hi = idxArr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (notes[idxArr[mid]].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /* ==========================================================================
   * Normalizacao
   * ========================================================================*/

  /* Copia defensiva + saneamento de uma nota crua. Nunca confia no autor da
   * musica: campo faltando, NaN, lane fora de faixa, dur negativa — tudo tratado. */
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var t = +raw.t;
    if (!isFinite(t)) return null;
    if (t < 0) t = 0;

    var open = !!raw.open;
    var dur = +raw.dur;
    if (!isFinite(dur) || dur < 0) dur = 0;

    return {
      /* --- dados da partitura --- */
      t: t,
      lane: open ? clampLane(raw.lane === undefined ? 2 : raw.lane) : clampLane(raw.lane),
      dur: dur,
      hopo: !!raw.hopo,
      tap: !!raw.tap,
      open: open,
      sp: !!raw.sp,
      /* altura da melodia nessa nota (o som do acerto acompanha); -1 = sem */
      midi: (isFinite(+raw.midi) && +raw.midi > 0) ? +raw.midi : -1,
      chord: false,
      /* --- preenchido pela normalizacao --- */
      idx: -1,          // indice global em GH.Chart.notes
      end: t + dur,     // instante final do sustain
      group: -1,        // indice do acorde (grupo) em GH.Chart.groups
      mask: 0,          // bitmask das raias do grupo inteiro
      chordSize: 1,     // quantas gems no ataque
      root: true,       // e a nota "cabeca" do grupo?
      phrase: -1,       // indice da frase de star power (-1 = nenhuma)
      forcedHopo: false,// veio marcada hopo mas foi invalidada?
      forcedTap: false, // veio marcada tap mas foi invalidada?
      /* --- estado de runtime (GH.Scoring escreve, GH.Notes le) --- */
      state: STATE.PENDING
    };
  }

  function sortNotes(a, b) {
    if (a.t !== b.t) return a.t - b.t;
    if (a.open !== b.open) return a.open ? -1 : 1;
    return a.lane - b.lane;
  }

  /* ==========================================================================
   * Estado do modulo
   * ========================================================================*/

  var notes = [];
  var groups = [];
  var starPowerPhrases = [];
  var laneIndex = [[], [], [], [], []];   // indices de notas por raia
  var maxDur = 0;                          // maior sustain (para o culling)

  var stats = emptyStats();

  function emptyStats() {
    return {
      total: 0, groupsTotal: 0, chords: 0, sustains: 0, hopos: 0, taps: 0,
      opens: 0, spNotes: 0, spPhrases: 0,
      firstNoteTime: 0, lastNoteTime: 0, durationSec: 0,
      maxDensity: 0, avgDensity: 0, nps: 0,
      maxChordSize: 1, sustainSeconds: 0,
      baseScore: 0, baseNoteScore: 0, baseSustainScore: 0,
      difficultyRating: 0
    };
  }

  /* ==========================================================================
   * Agrupamento em acordes
   * ========================================================================*/

  /* Devolve { groups, notes }: `notes` e a lista FILTRADA (notas descartadas
   * por conflito nao sobrevivem — se sobrassem, virariam gems fantasmas que
   * nunca podem ser acertadas). */
  function buildGroups(list) {
    var out = [];
    var kept = [];
    var i = 0, n = list.length;

    while (i < n) {
      var t0 = list[i].t;
      var j = i + 1;
      while (j < n && (list[j].t - t0) <= CHORD_EPS) j++;

      var members = list.slice(i, j);

      /* Nota aberta nao convive com trastes no mesmo ataque: numa guitarra de
       * verdade a corda solta e a ausencia de traste. A aberta ganha e as
       * outras somem do chart. */
      var hasOpen = false, k;
      for (k = 0; k < members.length; k++) if (members[k].open) { hasOpen = true; break; }
      if (hasOpen && members.length > 1) {
        var firstOpen = null;
        var mergedSp = false, mergedDur = 0;
        for (k = 0; k < members.length; k++) {
          if (members[k].sp) mergedSp = true;
          if (members[k].open && !firstOpen) firstOpen = members[k];
          if (members[k].dur > mergedDur) mergedDur = members[k].dur;
        }
        firstOpen.sp = firstOpen.sp || mergedSp;
        if (firstOpen.dur <= 0 && mergedDur > 0) { firstOpen.dur = mergedDur; firstOpen.end = firstOpen.t + mergedDur; }
        members = [firstOpen];
      }

      var g = {
        idx: out.length,
        t: t0,
        lanes: [],
        noteIdxs: [],
        mask: 0,
        size: members.length,
        open: hasOpen,
        chord: members.length > 1,
        hopo: false,
        tap: false,
        sp: false,
        dur: 0,
        end: t0,
        phrase: -1,
        notes: members
      };

      for (k = 0; k < members.length; k++) {
        var m = members[k];
        m.t = t0;                       // alinha o ataque (quantiza o acorde)
        m.end = t0 + m.dur;
        m.group = g.idx;
        m.chord = members.length > 1;
        m.chordSize = members.length;
        m.root = (k === 0);
        if (!m.open) { g.mask |= (1 << m.lane); g.lanes.push(m.lane); }
        if (m.sp) g.sp = true;
        if (m.hopo) g.hopo = true;
        if (m.tap) g.tap = true;
        kept.push(m);
      }
      /* SP e por ataque: se uma nota do acorde e SP, o acorde todo e. */
      if (g.sp) for (k = 0; k < members.length; k++) members[k].sp = true;

      out.push(g);
      i = j;
    }
    return { groups: out, notes: kept };
  }

  /* Recalcula duracao/fim do ataque a partir das notas (depois do corte de
   * sustains, que pode ter encurtado membros individuais). */
  function refreshGroupSpans(gs) {
    for (var i = 0; i < gs.length; i++) {
      var g = gs[i];
      g.dur = 0; g.end = g.t;
      for (var k = 0; k < g.notes.length; k++) {
        var m = g.notes[k];
        m.end = m.t + m.dur;
        if (m.dur > g.dur) { g.dur = m.dur; g.end = m.end; }
      }
    }
  }

  /* ==========================================================================
   * Validacao de HOPO / tap
   * ========================================================================*/

  /* Regras (as mesmas de Guitar Hero / Clone Hero):
   *  - acorde NUNCA e HOPO natural (precisa de palhetada);
   *  - uma nota nao pode ser HOPO se a raia dela ja estava no ataque anterior
   *    (voce nao faz hammer-on/pull-off na mesma casa);
   *  - o primeiro ataque da musica nao pode ser HOPO (nao ha de onde martelar);
   *  - tap segue as mesmas restricoes de acorde, mas NAO exige nota anterior
   *    (tap e tap: encostou, soou).
   * As notas invalidadas guardam forcedHopo=true para o agente de NOTAS poder,
   * se quiser, desenhar diferente / para debug. */
  function validateHopos(gs) {
    for (var i = 0; i < gs.length; i++) {
      var g = gs[i];
      var prev = i > 0 ? gs[i - 1] : null;
      var wantHopo = g.hopo, wantTap = g.tap;

      /* --- tap --- */
      if (wantTap && g.chord) {
        g.tap = false;
        markNotes(g, 'tap', false, 'forcedTap');
      }

      /* --- hopo --- */
      var okHopo = wantHopo;
      if (g.chord) okHopo = false;
      else if (!prev) okHopo = false;
      else if (!g.open && (prev.mask & g.mask) !== 0) okHopo = false;   // mesma raia
      else if (g.open && prev.open) okHopo = false;                     // aberta apos aberta
      else if (prev.t >= g.t) okHopo = false;

      if (wantHopo && !okHopo) {
        g.hopo = false;
        markNotes(g, 'hopo', false, 'forcedHopo');
      } else if (okHopo) {
        g.hopo = true;
        markNotes(g, 'hopo', true, null);
      }

      /* Tap implica que nao precisa de palhetada; um tap tambem se comporta
       * como HOPO para a cadeia (a proxima nota pode encadear). */
      if (g.tap) markNotes(g, 'tap', true, null);
    }
  }

  function markNotes(g, field, value, flagField) {
    for (var i = 0; i < g.notes.length; i++) {
      g.notes[i][field] = value;
      if (flagField) g.notes[i][flagField] = true;
    }
  }

  /* ==========================================================================
   * Sustains
   * ========================================================================*/

  /* Corta o sustain quando a proxima nota da mesma raia (ou uma aberta) chega
   * antes do fim. Chart cru mal feito e comum; aqui isso vira jogavel. */
  function fixSustains(list) {
    var nextByLane = [-1, -1, -1, -1, -1];
    var nextOpen = -1;
    var i, nt;

    for (i = list.length - 1; i >= 0; i--) {
      nt = list[i];

      var limit = Infinity;
      if (nt.open) {
        /* Uma aberta e cortada pela proxima nota qualquer. */
        for (var l = 0; l < LANES; l++) if (nextByLane[l] >= 0) limit = Math.min(limit, list[nextByLane[l]].t);
        if (nextOpen >= 0) limit = Math.min(limit, list[nextOpen].t);
      } else {
        if (nextByLane[nt.lane] >= 0) limit = list[nextByLane[nt.lane]].t;
        if (nextOpen >= 0) limit = Math.min(limit, list[nextOpen].t);
      }

      if (nt.dur > 0 && isFinite(limit)) {
        var maxEnd = limit - SUSTAIN_GAP;
        if (nt.t + nt.dur > maxEnd) nt.dur = Math.max(0, maxEnd - nt.t);
      }
      if (nt.dur < SUSTAIN_MIN) nt.dur = 0;
      nt.end = nt.t + nt.dur;

      if (nt.open) nextOpen = i; else nextByLane[nt.lane] = i;
    }
  }

  /* ==========================================================================
   * Frases de Star Power
   * ========================================================================*/

  /* Silencio maior que isto encerra a frase de Star Power. Sem o corte, dois
   * blocos de SP separados por um solo inteiro virariam uma frase so — e o
   * jogador ficaria sem entender por que o medidor nao encheu. */
  var PHRASE_GAP = 2.0;

  function buildPhrases(gs) {
    var out = [];
    var i = 0;
    while (i < gs.length) {
      if (!gs[i].sp) { i++; continue; }
      var j = i + 1;
      while (j < gs.length && gs[j].sp && (gs[j].t - gs[j - 1].end) <= PHRASE_GAP) j++;
      var phrase = {
        idx: out.length,
        tStart: gs[i].t,
        tEnd: gs[j - 1].end,
        groupIdxs: [],
        noteIdxs: [],
        groupCount: j - i,
        noteCount: 0
      };
      for (var k = i; k < j; k++) {
        gs[k].phrase = phrase.idx;
        phrase.groupIdxs.push(k);
        for (var m = 0; m < gs[k].notes.length; m++) {
          gs[k].notes[m].phrase = phrase.idx;
          phrase.noteIdxs.push(gs[k].notes[m].idx);
          phrase.noteCount++;
        }
      }
      out.push(phrase);
      i = j;
    }
    return out;
  }

  /* Se a musica nao trouxe nenhuma marcacao de Star Power, geramos frases
   * musicalmente plausiveis: blocos de ataques consecutivos espalhados pela
   * musica, fora da introducao e da coda. Sem isto o Star Power seria
   * inacessivel — e o Star Power e metade da graca do jogo. */
  function generateStarPower(gs, duration) {
    if (!gs.length) return 0;
    var want = Math.max(2, Math.round(duration / 26));
    var first = gs[0].t, last = gs[gs.length - 1].t;
    var span = Math.max(1, last - first);
    var startPad = first + span * 0.06;
    var endPad = last - span * 0.06;

    var placed = 0, p;
    for (p = 0; p < want; p++) {
      var target = startPad + (endPad - startPad) * ((p + 0.5) / want);
      /* acha o ataque mais proximo do alvo */
      var gi = lowerBoundT(gs, target);
      if (gi >= gs.length) gi = gs.length - 1;
      /* A frase dura ~4 segundos de musica, limitada a 6..18 ataques — e a
       * duracao que o Guitar Hero usa e que da tempo de "sentir" a frase. */
      var gEnd = gi;
      while (gEnd < gs.length && (gs[gEnd].t - gs[gi].t) < 4.0 && (gEnd - gi) < 18) gEnd++;
      if (gEnd - gi < 6) gEnd = Math.min(gs.length, gi + 6);
      /* nao encosta na frase anterior */
      if (gi > 0 && gs[gi - 1].sp) continue;
      var overlap = false;
      for (var k = gi; k < gEnd; k++) if (gs[k].sp) { overlap = true; break; }
      if (overlap) continue;
      for (k = gi; k < gEnd; k++) {
        gs[k].sp = true;
        for (var m = 0; m < gs[k].notes.length; m++) gs[k].notes[m].sp = true;
      }
      placed++;
    }
    return placed;
  }

  /* ==========================================================================
   * Estatisticas
   * ========================================================================*/

  function computeStats(song, list, gs, phrases) {
    var s = emptyStats();
    s.total = list.length;
    s.groupsTotal = gs.length;
    s.spPhrases = phrases.length;

    var i;
    for (i = 0; i < list.length; i++) {
      var nt = list[i];
      if (nt.dur > 0) { s.sustains++; s.sustainSeconds += nt.dur; }
      if (nt.hopo) s.hopos++;
      if (nt.tap) s.taps++;
      if (nt.open) s.opens++;
      if (nt.sp) s.spNotes++;
    }
    for (i = 0; i < gs.length; i++) {
      if (gs[i].chord) s.chords++;
      if (gs[i].size > s.maxChordSize) s.maxChordSize = gs[i].size;
    }

    if (list.length) {
      s.firstNoteTime = list[0].t;
      s.lastNoteTime = list[list.length - 1].end;
    }
    s.durationSec = (song && song.durationSec) ? song.durationSec
                    : Math.max(s.lastNoteTime, 1);

    /* Densidade maxima: maior quantidade de gems numa janela deslizante de 1s
     * (dois ponteiros — O(n)). E a metrica que melhor prediz "dificuldade real". */
    var win = 1.0, lo = 0, best = 0;
    for (i = 0; i < list.length; i++) {
      while (list[lo].t < list[i].t - win) lo++;
      var c = i - lo + 1;
      if (c > best) best = c;
    }
    s.maxDensity = best;
    s.nps = s.durationSec > 0 ? (s.total / s.durationSec) : 0;
    s.avgDensity = s.nps;

    /* Pontuacao base = a nota "seca", sem multiplicador. As estrelas do fim
     * saem da razao entre o placar real e esta base. */
    s.baseNoteScore = s.total * 50;
    var sustainPts = 0;
    for (i = 0; i < gs.length; i++) {
      if (gs[i].dur > 0) {
        var bps = songBpmAt(song, gs[i].t) / 60;
        sustainPts += 25 * bps * gs[i].dur * gs[i].size;
      }
    }
    s.baseSustainScore = Math.round(sustainPts);
    s.baseScore = s.baseNoteScore + s.baseSustainScore;

    /* Nota de dificuldade estimada (0..10) — util para o menu de selecao
     * quando a musica nao declara difficultyStars. */
    var rating = s.nps * 1.35 + best * 0.42 +
                 (s.chords / Math.max(1, s.groupsTotal)) * 2.2 +
                 ((s.hopos + s.taps) / Math.max(1, s.total)) * 2.0;
    s.difficultyRating = Math.round(clamp(rating, 0, 10) * 10) / 10;

    return s;
  }

  /* ==========================================================================
   * API publica
   * ========================================================================*/

  var Chart = {

    /* Unidades de mundo por segundo. Nota a 1s de distancia fica a `speed`
     * unidades da linha de acerto. Com SPAWN_Z = -46 e speed 14, o jogador ve
     * ~3.3 segundos de musica a frente — a leitura classica de Guitar Hero. */
    speed: 14,

    STATE: STATE,
    CHORD_EPS: CHORD_EPS,
    SUSTAIN_MIN: SUSTAIN_MIN,

    notes: notes,
    groups: groups,
    starPowerPhrases: starPowerPhrases,
    laneIndex: laneIndex,
    stats: stats,

    song: null,
    difficulty: '',
    duration: 0,
    loaded: false,

    /* Ultima janela visivel calculada (atualizada por visibleRange). */
    visibleStart: 0,
    visibleEnd: -1,

    /* ---------------------------------------------------------------------
     * load(song, difficulty)
     * Normaliza, valida e indexa. Devolve o proprio GH.Chart.
     * Nunca lanca: musica quebrada vira chart vazio e o jogo segue.
     * -------------------------------------------------------------------*/
    load: function (song, difficulty) {
      this.unload();
      this.syncSettings();

      this.song = song || null;
      this.difficulty = difficulty || '';

      var raw = null;
      if (song && song.charts) {
        raw = song.charts[difficulty];
        if (!raw || !raw.length) {
          /* Fallback defensivo: a dificuldade pedida pode nao existir. */
          var order = ['guitarrada', 'dificil', 'puxado', 'medio', 'facil'];
          for (var f = 0; f < order.length && !(raw && raw.length); f++) raw = song.charts[order[f]];
          if (!raw || !raw.length) {
            for (var key in song.charts) {
              if (Object.prototype.hasOwnProperty.call(song.charts, key) &&
                  song.charts[key] && song.charts[key].length) { raw = song.charts[key]; break; }
            }
          }
        }
      }
      if (!raw || !raw.length) {
        this.loaded = false;
        this.duration = (song && song.durationSec) || 0;
        this.stats = stats = computeStats(song, notes, groups, starPowerPhrases);
        return this;
      }

      /* 1. copia defensiva + saneamento ---------------------------------- */
      var list = [], i, nt;
      for (i = 0; i < raw.length; i++) {
        nt = sanitize(raw[i]);
        if (nt) list.push(nt);
      }

      /* 2. ordena por tempo (abertas primeiro no empate) ------------------ */
      list.sort(sortNotes);

      /* 3. remove duplicatas exatas (mesmo t, mesma raia) ----------------- */
      var dedup = [];
      for (i = 0; i < list.length; i++) {
        nt = list[i];
        var dup = null;
        for (var d = dedup.length - 1; d >= 0; d--) {
          if (nt.t - dedup[d].t > DEDUPE_EPS) break;
          if (dedup[d].lane === nt.lane && dedup[d].open === nt.open) { dup = dedup[d]; break; }
        }
        if (dup) {
          /* Funde: fica o sustain mais longo e a uniao das flags. */
          if (nt.dur > dup.dur) { dup.dur = nt.dur; dup.end = dup.t + dup.dur; }
          dup.hopo = dup.hopo || nt.hopo;
          dup.tap = dup.tap || nt.tap;
          dup.sp = dup.sp || nt.sp;
          continue;
        }
        dedup.push(nt);
      }
      list = dedup;

      /* 4. agrupa em acordes (descarta conflitos aberta+traste) ----------- */
      var built = buildGroups(list);
      var gs = built.groups;
      list = built.notes;

      /* 5. corta sustains que invadem a proxima nota da mesma raia -------- */
      fixSustains(list);
      refreshGroupSpans(gs);

      /* 6. indices globais + mascara do ataque em cada nota --------------- */
      for (i = 0; i < list.length; i++) list[i].idx = i;
      for (i = 0; i < gs.length; i++) {
        var g = gs[i];
        for (var k = 0; k < g.notes.length; k++) {
          g.notes[k].mask = g.mask;
          g.noteIdxs.push(g.notes[k].idx);
        }
      }

      /* 7. valida HOPO / tap ---------------------------------------------- */
      validateHopos(gs);

      /* 8. star power ------------------------------------------------------ */
      var anySp = false;
      for (i = 0; i < gs.length; i++) if (gs[i].sp) { anySp = true; break; }
      var durationGuess = (song && song.durationSec) ||
                          (list.length ? list[list.length - 1].end : 0);
      /* Uma musica pode recusar o SP automatico (as licoes do tutorial: SP
       * aparece so na licao de SP, nunca sorteado nas outras). */
      var autoSp = this.autoStarPower && !(song && song.autoStarPower === false);
      if (!anySp && autoSp) generateStarPower(gs, durationGuess);
      var phrases = buildPhrases(gs);

      /* 9. indice por raia (nextNoteIdx em O(log n)) ---------------------- */
      for (i = 0; i < LANES; i++) laneIndex[i].length = 0;
      maxDur = 0;
      for (i = 0; i < list.length; i++) {
        nt = list[i];
        if (nt.open) { for (var l = 0; l < LANES; l++) laneIndex[l].push(i); }
        else laneIndex[nt.lane].push(i);
        if (nt.dur > maxDur) maxDur = nt.dur;
      }

      /* 10. publica -------------------------------------------------------- */
      notes.length = 0;
      for (i = 0; i < list.length; i++) notes.push(list[i]);
      groups.length = 0;
      for (i = 0; i < gs.length; i++) groups.push(gs[i]);
      starPowerPhrases.length = 0;
      for (i = 0; i < phrases.length; i++) starPowerPhrases.push(phrases[i]);

      this.notes = notes;
      this.groups = groups;
      this.starPowerPhrases = starPowerPhrases;
      this.stats = stats = computeStats(song, notes, groups, starPowerPhrases);
      this.duration = stats.durationSec;
      this.maxSustain = maxDur;
      this.loaded = notes.length > 0;

      return this;
    },

    /* Le GH.Settings.scrollSpeed sem quebrar se ele nao existir. */
    syncSettings: function () {
      var s = GH.Settings;
      if (s && typeof s.scrollSpeed === 'number' && isFinite(s.scrollSpeed) && s.scrollSpeed > 0) {
        this.speed = clamp(s.scrollSpeed, 4, 40);
      }
      return this.speed;
    },

    setSpeed: function (v) {
      var n = +v;
      if (!isFinite(n) || n <= 0) return this.speed;
      this.speed = clamp(n, 4, 40);
      if (GH.Settings) GH.Settings.scrollSpeed = this.speed;
      return this.speed;
    },

    /* ---------------------------------------------------------------------
     * Geometria — formula UNICA da secao 3.
     * -------------------------------------------------------------------*/

    zAt: function (songTime, noteTime) {
      return layout().STRIKE_Z + (noteTime - songTime) * -1 * this.speed;
    },

    timeAt: function (songTime, z) {
      return songTime - (z - layout().STRIKE_Z) / this.speed;
    },

    /* Comprimento em unidades de mundo de um sustain de `dur` segundos. */
    lengthOf: function (dur) { return dur * this.speed; },

    /* Quantos segundos de musica cabem na pista visivel. */
    lookaheadSec: function () { return (-layout().SPAWN_Z) / this.speed; },

    /* ---------------------------------------------------------------------
     * visibleRange(songTime) -> [iStart, iEnd]
     *
     * IMPORTANTE: iEnd e INCLUSIVO (ultimo indice visivel). Faixa vazia
     * devolve [0, -1], entao `for (i = r[0]; i <= r[1]; i++)` funciona sempre.
     * Busca binaria — nunca varre o array inteiro.
     * -------------------------------------------------------------------*/
    visibleRange: function (songTime) {
      var L = layout();
      var sp = this.speed;
      if (!notes.length || sp <= 0) { this.visibleStart = 0; this.visibleEnd = -1; return [0, -1]; }

      /* z <= DESPAWN_Z  =>  noteTime >= songTime - DESPAWN_Z/speed
       * z >= SPAWN_Z    =>  noteTime <= songTime + (-SPAWN_Z)/speed */
      var tNear = songTime - L.DESPAWN_Z / sp;
      var tFar = songTime + (-L.SPAWN_Z) / sp;

      /* Recua o inicio pelo maior sustain: a cabeca ja passou mas o rabo do
       * sustain ainda esta na tela e precisa ser desenhado. */
      var iStart = lowerBoundT(notes, tNear - maxDur - 0.001);

      /* Descarta, com limite duro, as notas cujo sustain ja acabou. */
      var guard = 0;
      while (iStart < notes.length && notes[iStart].end < tNear && guard < 512) { iStart++; guard++; }

      var iEnd = upperBoundT(notes, tFar) - 1;
      if (iEnd < iStart) { this.visibleStart = 0; this.visibleEnd = -1; return [0, -1]; }

      this.visibleStart = iStart;
      this.visibleEnd = iEnd;
      return [iStart, iEnd];
    },

    /* Versao sem alocacao para o loop quente do agente de NOTAS. */
    forEachVisible: function (songTime, fn) {
      var r = this.visibleRange(songTime);
      for (var i = r[0]; i <= r[1]; i++) fn(notes[i], i);
      return r[1] - r[0] + 1;
    },

    /* ---------------------------------------------------------------------
     * Navegacao / consulta
     * -------------------------------------------------------------------*/

    noteAt: function (idx) {
      return (idx >= 0 && idx < notes.length) ? notes[idx] : null;
    },

    groupAt: function (idx) {
      return (idx >= 0 && idx < groups.length) ? groups[idx] : null;
    },

    groupOfNote: function (noteIdx) {
      var nt = this.noteAt(noteIdx);
      return nt ? this.groupAt(nt.group) : null;
    },

    /* Primeiro indice de nota com t >= fromTime (busca binaria). */
    indexAtTime: function (t) { return lowerBoundT(notes, t); },

    /* Primeiro indice de ataque (grupo) com t >= fromTime. */
    groupIndexAtTime: function (t) { return lowerBoundT(groups, t); },

    /* Proxima nota daquela raia a partir de fromTime. -1 se nao houver.
     * Usa o indice por raia: O(log n). Abertas contam para todas as raias. */
    nextNoteIdx: function (lane, fromTime) {
      var l = clampLane(lane);
      var arr = laneIndex[l];
      if (!arr.length) return -1;
      var p = lowerBoundIdx(arr, notes, fromTime);
      return p < arr.length ? arr[p] : -1;
    },

    /* Nota anterior daquela raia (a que termina antes de fromTime). */
    prevNoteIdx: function (lane, fromTime) {
      var l = clampLane(lane);
      var arr = laneIndex[l];
      if (!arr.length) return -1;
      var p = lowerBoundIdx(arr, notes, fromTime) - 1;
      return p >= 0 ? arr[p] : -1;
    },

    /* [i0, i1] INCLUSIVO das notas com t em [t0, t1]. [0,-1] se vazio. */
    notesInWindow: function (t0, t1) {
      if (!notes.length) return [0, -1];
      var a = lowerBoundT(notes, t0);
      var b = upperBoundT(notes, t1) - 1;
      if (b < a) return [0, -1];
      return [a, b];
    },

    /* [i0, i1] INCLUSIVO dos ataques com t em [t0, t1]. */
    groupsInWindow: function (t0, t1) {
      if (!groups.length) return [0, -1];
      var a = lowerBoundT(groups, t0);
      var b = upperBoundT(groups, t1) - 1;
      if (b < a) return [0, -1];
      return [a, b];
    },

    /* Frase de Star Power que contem o instante t (ou null). */
    phraseAtTime: function (t) {
      for (var i = 0; i < starPowerPhrases.length; i++) {
        var p = starPowerPhrases[i];
        if (t >= p.tStart && t <= p.tEnd) return p;
      }
      return null;
    },

    /* Notas por segundo numa janela deslizante — o HUD/menu pode usar para
     * desenhar o "mapa de calor" da musica. */
    densityAt: function (t, window) {
      var w = window || 1;
      var r = this.notesInWindow(t - w * 0.5, t + w * 0.5);
      return (r[1] - r[0] + 1) / w;
    },

    /* Perfil de densidade da musica inteira (para a minimapa de resultados). */
    densityProfile: function (buckets) {
      var n = Math.max(8, buckets || 64);
      var out = new Array(n);
      var dur = Math.max(0.001, this.duration || stats.durationSec || 1);
      for (var i = 0; i < n; i++) out[i] = 0;
      for (i = 0; i < notes.length; i++) {
        var b = Math.floor((notes[i].t / dur) * n);
        if (b < 0) b = 0; if (b >= n) b = n - 1;
        out[b]++;
      }
      return out;
    },

    /* ---------------------------------------------------------------------
     * reset() — zera o estado de runtime das notas (nao descarrega o chart).
     * Chamado ao reiniciar a musica.
     * -------------------------------------------------------------------*/
    reset: function () {
      for (var i = 0; i < notes.length; i++) notes[i].state = STATE.PENDING;
      this.visibleStart = 0;
      this.visibleEnd = -1;
      return this;
    },

    /* Descarrega tudo (troca de musica). */
    unload: function () {
      notes.length = 0;
      groups.length = 0;
      starPowerPhrases.length = 0;
      for (var i = 0; i < LANES; i++) laneIndex[i].length = 0;
      maxDur = 0;
      this.song = null;
      this.difficulty = '';
      this.duration = 0;
      this.loaded = false;
      this.maxSustain = 0;
      this.stats = stats = emptyStats();
      this.visibleStart = 0;
      this.visibleEnd = -1;
      return this;
    },

    /* Gera frases de Star Power automaticamente quando a musica nao traz
     * nenhuma nota marcada com sp:true. Desligue se a musica ja vier marcada. */
    autoStarPower: true,

    maxSustain: 0
  };

  GH.Chart = Chart;

})(window.GH = window.GH || {});

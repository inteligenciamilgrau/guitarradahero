(function (GH) {
  'use strict';

  /* ==========================================================================
   * GUITARRADA HERO — src/gameplay/scoring.js
   * Modulo: GH.Scoring   (dono: agente GAMEPLAY)
   *
   * Este arquivo decide se o jogador acertou. E o juiz — e a sensacao do jogo
   * inteiro depende dele. As regras aqui sao as de Guitar Hero / Clone Hero,
   * nao uma aproximacao:
   *
   *  - Julgamento por ATAQUE (grupo), nao por gem: acorde e um evento so.
   *  - Acorde exige a mascara EXATA de trastes. Nota simples aceita
   *    "anchoring" (trastes MAIS GRAVES podem estar presos — todo guitarrista
   *    de plastico ancora o dedo).
   *  - Nota aberta exige nenhum traste.
   *  - HOPO/tap podem ser acertados sem palhetada, com a cadeia viva.
   *  - Palhetar sem casar nota = overstrum: quebra sequencia, tira vida e
   *    derruba os sustains segurados.
   *  - Palhetada tem leniencia (60ms): quem palheta um triz antes de fechar o
   *    acorde ainda acerta, e com o timestamp da PALHETADA (a precisao e do
   *    jogador, nao do atraso do dedo).
   *
   * Contrato (ARCHITECTURE.md secao 6):
   *   GH.Scoring = { reset(difficulty), HIT_WINDOW, judge(lane, inputTime),
   *     update(dt, songTime), score, streak, bestStreak, multiplier, notesHit,
   *     notesTotal, accuracy, health, starPower, starPowerActive,
   *     activateStarPower(), stars, failed, onEvent(fn) }
   *
   * --------------------------------------------------------------------------
   * COMO LIGAR (para o agente de INTEGRACAO) — nesta ordem:
   *
   *   GH.Chart.load(song, difficulty);
   *   GH.Scoring.reset(difficulty);
   *   GH.Scoring.attachInput();                 // liga teclado/gamepad sozinho
   *   GH.Scoring.onEvent(function (e) { ... }); // roteia para HUD/FX/Stage
   *   // por frame:
   *   GH.Scoring.update(dt, GH.Conductor.time);
   *   // no fim da musica:
   *   var stats = GH.Scoring.finish();
   *
   * attachInput() ja faz a ligacao CORRETA (palhetada -> strum, traste ->
   * fretDown/fretUp). NAO chame judge() de dentro de onFretDown: judge() sem
   * opcoes assume PALHETADA e cada aperto de traste viraria overstrum.
   * A acao 'starpower' do GH.Input deve chamar GH.Scoring.activateStarPower().
   * --------------------------------------------------------------------------
   * ==========================================================================*/

  var LANES = 5;

  /* --------------------------------------------------------------------------
   * NUMEROS QUE DEFINEM A SENSACAO
   * ------------------------------------------------------------------------*/

  var NOTE_PTS = 50;                 // pontos por gem
  var PERFECT_BONUS = 0.20;          // +20% quando o acerto e PERFEITO
  var SUSTAIN_PTS_PER_BEAT = 25;     // pontos por batida segurando o sustain
  var STREAK_PER_STEP = 10;          // notas para subir de multiplicador
  var MAX_BASE_MULT = 4;             // 1x -> 4x (8x com Star Power)

  var SP_PER_PHRASE = 0.25;          // frase inteira acertada enche 1/4
  var SP_ACTIVATE_MIN = 0.5;         // so ativa com metade do medidor
  var SP_DRAIN_PER_BEAT = 1 / 8;     // drena 1/8 do medidor por batida
  var SP_SUSTAIN_FILL_PER_BEAT = 1 / 48; // sustain dentro de frase de SP enche devagar
  var SP_HEALTH_REGEN = 0.045;       // vida por segundo enquanto o SP esta ativo
  var SP_HEAL_MULT = 2.0;            // acerto cura o dobro com SP ativo

  /* Leniencia da palhetada — ver comentario grande em src/core/input.js. */
  var STRUM_LENIENCY = 0.060;

  /* Tolerancia para "escorregar" o dedo no meio de um sustain sem perder. */
  var SUSTAIN_GRACE = 0.055;

  /* Frequencia dos eventos 'sustain' (feedback visual sem inundar o HUD). */
  var SUSTAIN_EVENT_INTERVAL = 1 / 15;

  /* Histograma de desvio: 41 caixas de 5ms cobrindo -100ms..+100ms. */
  var HIST_BINS = 41, HIST_BIN_MS = 5, HIST_CENTER = 20;

  /* Limiares de estrela, em multiplos da pontuacao base da musica.
   * Calibragem medida, nao chutada: uma partida PERFEITA sem usar Star Power
   * fecha em ~4.4x a base (teto teorico 4x * 1.2 do bonus de perfeito = 4.8x).
   * Entao 5 estrelas em 3.55x exige ~95% de precisao com a sequencia inteira
   * de pe — ou uma precisao um pouco menor compensada com bom uso do Star
   * Power, que e exatamente a curva do Guitar Hero. */
  var STAR_THRESHOLDS = [0.60, 1.10, 1.75, 2.60, 3.55];

  /* Estorno de overstrum causado por "tilt" (as duas setas juntas). */
  var REFUND_WINDOW = 0.25;

  /* --------------------------------------------------------------------------
   * Tabela por dificuldade. A janela de acerto do contrato (±70ms, perfeito
   * ±25ms) e a referencia; o facil abre a mao e o guitarrada aperta a vida.
   * ------------------------------------------------------------------------*/
  var DIFFICULTY = {
    facil:      { good: 0.095, perfect: 0.035, heal: 0.020, miss: -0.040, over: -0.020, start: 0.60 },
    medio:      { good: 0.082, perfect: 0.028, heal: 0.015, miss: -0.048, over: -0.026, start: 0.55 },
    puxado:     { good: 0.076, perfect: 0.026, heal: 0.0135, miss: -0.052, over: -0.028, start: 0.52 },
    dificil:    { good: 0.070, perfect: 0.025, heal: 0.012, miss: -0.055, over: -0.030, start: 0.50 },
    guitarrada: { good: 0.070, perfect: 0.025, heal: 0.010, miss: -0.062, over: -0.034, start: 0.50 },
    _default:   { good: 0.070, perfect: 0.025, heal: 0.012, miss: -0.055, over: -0.030, start: 0.50 }
  };

  var CHART_STATE = { PENDING: 0, HIT: 1, MISSED: 2, HELD: 3, DONE: 4 };

  /* --------------------------------------------------------------------------
   * Estado interno
   * ------------------------------------------------------------------------*/

  var _groups = [], _notes = [], _phrases = [];
  var _gJudged = null, _gResult = null, _gDelta = null;   // 0 nada,1 perfeito,2 bom,3 erro
  var _phraseHits = null, _phraseBroken = null, _phraseDone = null;

  var _ready = false;
  var _paused = false;
  var _missCursor = 0;
  var _hopoAlive = false;          // a cadeia de HOPO esta viva?
  var _mask = 0;                   // trastes segurados (espelho do GH.Input)
  var _songTime = 0;
  var _tuning = DIFFICULTY._default;
  var _goodWin = 0.070, _perfWin = 0.025;
  var _perfMs = 25;

  var _pendingStrum = null;        // {t, deadline, mask}
  var _consumedStrumTime = -1e9;   // palhetada ja transformada em acerto
  var _lastOverstrum = null;       // snapshot para estorno (tilt)

  /* Muita gente palheta TODAS as notas, inclusive as de HOPO/tap que ja foram
   * acertadas so com o dedo. Sem esta janela, esse habito viraria overstrum e
   * o jogador seria punido por tocar "certo demais". Depois de um acerto sem
   * palhetada, a palhetada que vem logo atras e simplesmente engolida. */
  var STRUM_ABSORB_AFTER_TAP = 0.110;
  var _absorbStrumUntil = -1e9;

  var _sustains = [];              // sustains ativos
  var _scoreF = 0;                 // placar em float (o publico e arredondado)
  var _sustainPts = 0;
  var _deltas = [];
  var _hist = new Array(HIST_BINS);
  for (var _hi = 0; _hi < HIST_BINS; _hi++) _hist[_hi] = 0;

  var _listeners = [];
  var _attached = false;
  var _muted = false;

  var _rngState = 0x9e3779b9;

  /* Callbacks guardados para desconectar do GH.Input sem vazar. */
  var _hStrum = null, _hFretDown = null, _hFretUp = null, _hCancel = null;

  /* --------------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------------*/

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function conductorTime() {
    var C = GH.Conductor;
    if (C && typeof C.time === 'number' && isFinite(C.time)) return C.time;
    return _songTime;
  }

  /* Batidas por segundo naquele instante — sustains e drenagem de SP sao
   * medidos em BATIDAS, nao em segundos, para a musica mandar no ritmo. */
  function bps(t) {
    var C = GH.Conductor;
    if (C && typeof C.bpmAt === 'function') {
      try {
        var b = C.bpmAt(t);
        if (isFinite(b) && b > 20 && b < 400) return b / 60;
      } catch (err) { /* maestro sem musica carregada — usa o fallback abaixo */ }
    }
    var song = GH.Chart && GH.Chart.song;
    if (song) {
      if (typeof song.bpm === 'number' && song.bpm > 0) return song.bpm / 60;
      if (song.tempoMap && song.tempoMap.length && song.tempoMap[0].bpm) return song.tempoMap[0].bpm / 60;
    }
    return 2;   // 120 bpm
  }

  function setting(key, def) {
    var s = GH.Settings;
    if (s && s[key] !== undefined && s[key] !== null) return s[key];
    return def;
  }

  /* Mascara atual de trastes. Prefere o GH.Input (fonte da verdade); cai para
   * a mascara que este modulo mantem por conta propria (modo captura, bot). */
  function syncMask() {
    var I = GH.Input;
    if (I && I.ready && typeof I.fretMask === 'number') _mask = I.fretMask;
    return _mask;
  }

  function setGuitarMuted(v) {
    if (_muted === v) return;
    _muted = v;
    var S = GH.Synth;
    if (S && typeof S.setGuitarMuted === 'function') {
      try { S.setGuitarMuted(v); } catch (err) {}
    }
  }

  function setSynthStarPower(v) {
    var S = GH.Synth;
    if (S && typeof S.setStarPower === 'function') {
      try { S.setStarPower(v); } catch (err) {}
    }
  }

  function inputConsumeStrum() {
    var I = GH.Input;
    if (I && typeof I.consumeStrum === 'function') { try { I.consumeStrum(); } catch (err) {} }
  }

  function rand() {
    /* mulberry32 local — deterministico, independente do GH.Util. */
    _rngState |= 0; _rngState = (_rngState + 0x6D2B79F5) | 0;
    var t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* --------------------------------------------------------------------------
   * Regras de casamento traste x nota
   * ------------------------------------------------------------------------*/

  /* Acorde: mascara EXATA (faltar ou sobrar raia = nao casa).
   * Nota simples: precisa da raia certa e NENHUMA raia mais aguda pressionada
   *   — trastes mais graves presos sao permitidos ("anchoring"), que e como
   *   todo mundo joga de verdade.
   * Nota aberta: nenhum traste. */
  function maskSatisfies(g, mask) {
    if (g.open) return mask === 0;
    if (g.size > 1) return mask === g.mask;
    var bit = g.mask;
    if ((mask & bit) === 0) return false;
    return (mask & ~((bit << 1) - 1)) === 0;
  }

  /* Manutencao do sustain: basta continuar segurando as raias do ataque.
   * Raias extras sao toleradas — o jogador precisa delas para as proximas
   * notas e seria cruel derrubar o sustain por isso. */
  function holdSatisfies(s, mask) {
    if (s.auto) return true;
    if (s.open) return true;
    return (mask & s.mask) === s.mask;
  }

  /* Ataque nao julgado mais proximo de `t` dentro de `win`. -1 se nenhum.
   * Busca binaria + varredura curta (a janela cobre poucos ataques). */
  function nearestUnjudged(t, win) {
    var n = _groups.length;
    if (!n) return -1;
    var lo = 0, hi = n, mid;
    var t0 = t - win;
    while (lo < hi) { mid = (lo + hi) >> 1; if (_groups[mid].t < t0) lo = mid + 1; else hi = mid; }
    var best = -1, bestAbs = Infinity;
    var t1 = t + win;
    for (var i = lo; i < n; i++) {
      var g = _groups[i];
      if (g.t > t1) break;
      if (_gJudged[i]) continue;
      var d = g.t - t; if (d < 0) d = -d;
      if (d < bestAbs) { bestAbs = d; best = i; }
    }
    return best;
  }

  /* ==========================================================================
   * Barramento de eventos — este e o feedback do jogo inteiro
   * ========================================================================*/

  function emit(e) {
    if (!e) return;
    e.score = S.score;
    e.streak = S.streak;
    e.multiplier = S.multiplier;
    e.baseMultiplier = S.baseMultiplier;
    e.health = S.health;
    e.starPower = S.starPower;
    e.starPowerActive = S.starPowerActive;
    e.accuracy = S.accuracy;
    e.notesHit = S.notesHit;
    e.notesTotal = S.notesTotal;
    if (e.time === undefined) e.time = _songTime;
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](e); }
      catch (err) { if (window.console && console.warn) console.warn('[GH.Scoring] listener falhou:', err); }
    }
  }

  /* ==========================================================================
   * Pontuacao / multiplicador
   * ========================================================================*/

  function computeMultiplier() {
    var base = 1 + Math.floor(S.streak / STREAK_PER_STEP);
    if (base > MAX_BASE_MULT) base = MAX_BASE_MULT;
    S.baseMultiplier = base;
    return S.starPowerActive ? base * 2 : base;
  }

  function addScore(pts) {
    _scoreF += pts;
    S.score = Math.round(_scoreF);
  }

  function recalcAccuracy() {
    var judged = S.notesHit + S.notesMissed;
    S.accuracy = judged > 0 ? (S.notesHit / judged) : 0;
    S.progress = S.notesTotal > 0 ? (judged / S.notesTotal) : 0;
  }

  function recomputeStars() {
    var base = S.baseScore;
    if (base <= 0) { S.starsFloat = 0; S.stars = 0; S.liveStars = 0; S.liveStarsFloat = 0; return; }
    S.starsFloat = ratioToStars(S.score / base);
    S.stars = Math.floor(S.starsFloat);
    if (S.stars > 5) S.stars = 5;

    /* Estrelas "ao vivo": mesma conta, mas so contra a parte da musica que ja
     * passou — e isso que o medidor de estrelas do HUD deve mostrar. */
    var passed = S.baseScorePassed;
    if (passed > 0) {
      S.liveStarsFloat = ratioToStars(S.score / passed);
      S.liveStars = Math.min(5, Math.floor(S.liveStarsFloat));
    } else { S.liveStarsFloat = 0; S.liveStars = 0; }

    /* A 6a estrela ("estrela de ouro") so sai com a musica inteira em pe:
     * 99% de precisao, nenhuma nota perdida e nenhuma palhetada a toa. */
    S.goldStar = (S.accuracy >= 0.99 && S.notesMissed === 0 &&
                  S.overstrums === 0 && S.stars >= 5);
    S.starsDisplay = S.goldStar ? 6 : S.stars;
  }

  function ratioToStars(r) {
    if (!isFinite(r) || r <= 0) return 0;
    var i;
    for (i = 0; i < STAR_THRESHOLDS.length; i++) {
      if (r < STAR_THRESHOLDS[i]) {
        var lo = i === 0 ? 0 : STAR_THRESHOLDS[i - 1];
        var hi = STAR_THRESHOLDS[i];
        return i + (r - lo) / Math.max(1e-6, hi - lo);
      }
    }
    return 5;
  }

  /* ==========================================================================
   * Acerto
   * ========================================================================*/

  function applyHit(gi, delta, source, silent) {
    var g = _groups[gi];
    var deltaMs = delta * 1000;
    var absMs = deltaMs < 0 ? -deltaMs : deltaMs;
    var perfect = absMs <= _perfMs;
    var i, nt;

    _gJudged[gi] = 1;
    _gResult[gi] = perfect ? 1 : 2;
    _gDelta[gi] = deltaMs;

    for (i = 0; i < g.notes.length; i++) {
      nt = g.notes[i];
      nt.state = (nt.dur > 0) ? CHART_STATE.HELD : CHART_STATE.HIT;
    }

    S.notesHit += g.size;
    if (perfect) S.perfects += g.size; else S.goods += g.size;

    /* Estatistica de precisao */
    _deltas.push(deltaMs);
    var bi = Math.round(deltaMs / HIST_BIN_MS) + HIST_CENTER;
    if (bi < 0) bi = 0;
    if (bi >= HIST_BINS) bi = HIST_BINS - 1;
    _hist[bi]++;
    if (deltaMs < -1) S.earlyCount++; else if (deltaMs > 1) S.lateCount++;

    var prevMult = S.multiplier;
    S.streak++;
    if (S.streak > S.bestStreak) S.bestStreak = S.streak;
    S.multiplier = computeMultiplier();

    var scoreDelta = NOTE_PTS * g.size * S.multiplier * (perfect ? (1 + PERFECT_BONUS) : 1);
    addScore(scoreDelta);

    S.health = clamp(S.health + _tuning.heal * (S.starPowerActive ? SP_HEAL_MULT : 1), 0, 1);
    S.baseScorePassed += NOTE_PTS * g.size;

    _hopoAlive = true;
    setGuitarMuted(false);          // acertou: a guitarra volta a soar
    if (source === 'hopo' || source === 'tap') {
      _absorbStrumUntil = g.t + delta + STRUM_ABSORB_AFTER_TAP;
    }

    if (g.phrase >= 0) phraseProgress(g.phrase, true, silent);
    if (g.dur > 0) startSustain(gi, g, source === 'auto');

    recalcAccuracy();
    recomputeStars();

    if (!silent) {
      emit({
        type: 'hit',
        source: source,
        lane: g.open ? -1 : (g.lanes.length ? g.lanes[0] : -1),
        lanes: g.lanes,
        noteIdx: g.noteIdxs.length ? g.noteIdxs[0] : -1,
        noteIdxs: g.noteIdxs,
        groupIdx: gi,
        quality: perfect ? 'perfect' : 'good',
        /* Alias de `quality`. judge() devolve o campo com o nome `result` e o
           contrato usa `quality` nas assinaturas de GH.Notes/GH.FX; publicar
           os dois evita a classe inteira de bug "undefined" no consumidor. */
        result: perfect ? 'perfect' : 'good',
        perfect: perfect,
        deltaMs: deltaMs,
        early: deltaMs < 0,
        chord: g.chord,
        chordSize: g.size,
        hopo: g.hopo,
        tap: g.tap,
        open: g.open,
        sp: g.sp,
        sustain: g.dur > 0,
        dur: g.dur,
        scoreDelta: Math.round(scoreDelta),
        noteTime: g.t
      });
      if (S.multiplier !== prevMult) {
        emit({ type: 'streak', up: true, level: S.baseMultiplier, reason: 'multiplier' });
      }
    }

    return {
      result: perfect ? 'perfect' : 'good',
      quality: perfect ? 'perfect' : 'good',
      note: g.notes[0],
      noteIdxs: g.noteIdxs,
      group: g,
      groupIdx: gi,
      deltaMs: deltaMs
    };
  }

  /* ==========================================================================
   * Erro (nota perdida) e overstrum
   * ========================================================================*/

  function applyMiss(gi, reason, silent) {
    var g = _groups[gi];
    var i;

    _gJudged[gi] = 1;
    _gResult[gi] = 3;
    _gDelta[gi] = 0;

    for (i = 0; i < g.notes.length; i++) g.notes[i].state = CHART_STATE.MISSED;

    S.notesMissed += g.size;
    S.misses++;
    S.baseScorePassed += NOTE_PTS * g.size;

    breakStreak();
    S.health = clamp(S.health + _tuning.miss, 0, 1);
    setGuitarMuted(true);            // errou: a guitarra emudece (regra do contrato)

    if (g.phrase >= 0) phraseProgress(g.phrase, false, silent);

    recalcAccuracy();
    recomputeStars();

    if (!silent) {
      emit({
        type: 'miss',
        reason: reason || 'timeout',
        quality: 'miss',
        result: 'miss',        /* mesmo par de aliases do evento de acerto */
        lane: g.open ? -1 : (g.lanes.length ? g.lanes[0] : -1),
        lanes: g.lanes,
        noteIdx: g.noteIdxs.length ? g.noteIdxs[0] : -1,
        noteIdxs: g.noteIdxs,
        groupIdx: gi,
        chord: g.chord,
        chordSize: g.size,
        open: g.open,
        sp: g.sp,
        noteTime: g.t
      });
      emit({ type: 'streak', up: false, level: 1, reason: 'miss' });
    }
    checkFail();
  }

  function breakStreak() {
    S.streak = 0;
    S.multiplier = computeMultiplier();
    _hopoAlive = false;
  }

  /* Palhetada sem nota casada. Quebra sequencia, tira vida e derruba os
   * sustains segurados — exatamente como no Guitar Hero. */
  function overstrum(t, silent) {
    _lastOverstrum = {
      time: t,
      streak: S.streak,
      bestStreak: S.bestStreak,
      health: S.health,
      multiplier: S.multiplier,
      overstrums: S.overstrums
    };

    S.overstrums++;
    breakStreak();
    S.health = clamp(S.health + _tuning.over, 0, 1);
    setGuitarMuted(true);
    dropAllSustains(t, silent);
    recomputeStars();

    if (!silent) {
      emit({ type: 'miss', reason: 'overstrum', quality: 'miss', result: 'miss',
             lane: -1, lanes: [], noteIdx: -1,
             noteIdxs: [], groupIdx: -1, chord: false, open: false, noteTime: t });
      emit({ type: 'streak', up: false, level: 1, reason: 'overstrum' });
    }
    checkFail();

    return { result: 'miss', quality: 'miss', note: null, noteIdxs: [],
             group: null, groupIdx: -1, deltaMs: 0, reason: 'overstrum' };
  }

  /* Estorna o overstrum recente (o gesto de "tilt" usa as duas setas e nao
   * deve custar a sequencia do jogador). */
  function refundOverstrum(t) {
    if (!_lastOverstrum) return false;
    if (Math.abs(t - _lastOverstrum.time) > REFUND_WINDOW) return false;
    S.streak = _lastOverstrum.streak;
    S.bestStreak = _lastOverstrum.bestStreak;
    S.health = _lastOverstrum.health;
    S.overstrums = _lastOverstrum.overstrums;
    S.multiplier = computeMultiplier();
    _lastOverstrum = null;
    recomputeStars();
    emit({ type: 'streak', up: true, level: S.baseMultiplier, reason: 'refund' });
    return true;
  }

  function checkFail() {
    if (S.failed) return;
    if (S.noFail || setting('noFail', false)) return;
    if (S.health > 0) return;
    S.health = 0;
    S.failed = true;
    emit({ type: 'fail', reason: 'rockmeter' });
  }

  /* ==========================================================================
   * Sustains
   * ========================================================================*/

  function startSustain(gi, g, auto) {
    var s = {
      groupIdx: gi,
      mask: g.mask,
      open: g.open,
      size: g.size,
      sp: g.sp,
      lanes: g.lanes,
      noteIdxs: g.noteIdxs,
      start: g.t,
      end: g.end,
      lastT: g.t,
      lostAt: -1,
      points: 0,
      nextEvent: 0,
      auto: !!auto
    };
    _sustains.push(s);
    return s;
  }

  function endSustain(i, completed, t, silent) {
    var s = _sustains[i];
    if (!s) return;
    _sustains.splice(i, 1);
    for (var k = 0; k < s.noteIdxs.length; k++) {
      var nt = _notes[s.noteIdxs[k]];
      if (nt && nt.state === CHART_STATE.HELD) nt.state = CHART_STATE.DONE;
    }
    if (!silent) {
      emit({
        type: 'sustainEnd',
        completed: !!completed,
        lane: s.open ? -1 : (s.lanes.length ? s.lanes[0] : -1),
        lanes: s.lanes,
        noteIdxs: s.noteIdxs,
        groupIdx: s.groupIdx,
        points: Math.round(s.points),
        progress: 1,
        time: t
      });
    }
  }

  function dropAllSustains(t, silent) {
    for (var i = _sustains.length - 1; i >= 0; i--) endSustain(i, false, t, silent);
  }

  function updateSustains(dt, t, silent) {
    if (!_sustains.length) return;
    var beat = bps(t);
    for (var i = _sustains.length - 1; i >= 0; i--) {
      var s = _sustains[i];
      var held = holdSatisfies(s, _mask);

      if (!held) {
        if (s.lostAt < 0) s.lostAt = t;
        if ((t - s.lostAt) > SUSTAIN_GRACE) {
          /* Soltar antes do fim encerra o ganho mas NAO quebra a sequencia. */
          endSustain(i, false, t, silent);
          continue;
        }
      } else {
        s.lostAt = -1;
      }

      var to = t < s.end ? t : s.end;
      var seg = to - s.lastT;
      if (seg > 0) {
        s.lastT = to;
        var pts = SUSTAIN_PTS_PER_BEAT * beat * seg * S.multiplier * s.size;
        s.points += pts;
        _sustainPts += pts;
        addScore(pts);
        S.baseScorePassed += SUSTAIN_PTS_PER_BEAT * beat * seg * s.size;
        /* Segurar um sustain dentro de frase de Star Power enche o medidor —
         * e o equivalente ao whammy do controle de guitarra. */
        if (s.sp && !S.starPowerActive) {
          S.starPower = clamp(S.starPower + seg * beat * SP_SUSTAIN_FILL_PER_BEAT, 0, 1);
          checkStarPowerReady();
        }
      }

      if (!silent && t >= s.nextEvent) {
        s.nextEvent = t + SUSTAIN_EVENT_INTERVAL;
        var span = Math.max(1e-6, s.end - s.start);
        emit({
          type: 'sustain',
          lane: s.open ? -1 : (s.lanes.length ? s.lanes[0] : -1),
          lanes: s.lanes,
          noteIdxs: s.noteIdxs,
          groupIdx: s.groupIdx,
          progress: clamp((t - s.start) / span, 0, 1),
          points: Math.round(s.points),
          active: held,
          sp: s.sp,
          time: t
        });
      }

      /* Epsilon: somar dt em float raramente cai exatamente no fim; sem a
       * folga o ultimo sustain da musica nunca fecharia. */
      if (t >= s.end - 1e-4) endSustain(i, true, t, silent);
    }
  }

  /* ==========================================================================
   * Star Power
   * ========================================================================*/

  function phraseProgress(pi, hit, silent) {
    if (pi < 0 || pi >= _phrases.length) return;
    if (_phraseDone[pi]) return;
    if (!hit) {
      if (!_phraseBroken[pi]) {
        _phraseBroken[pi] = 1;
        if (!silent) emit({ type: 'sp', action: 'phraseLost', phrase: pi });
      }
      return;
    }
    _phraseHits[pi]++;
    if (_phraseBroken[pi]) return;
    if (_phraseHits[pi] >= _phrases[pi].groupCount) {
      _phraseDone[pi] = 1;
      S.spPhrasesHit++;
      S.starPower = clamp(S.starPower + SP_PER_PHRASE, 0, 1);
      if (!silent) {
        emit({ type: 'sp', action: 'phrase', phrase: pi, gained: SP_PER_PHRASE });
        checkStarPowerReady();
      } else {
        checkStarPowerReady(true);
      }
    }
  }

  function checkStarPowerReady(silent) {
    var ready = S.starPower >= SP_ACTIVATE_MIN;
    if (ready && !S._spReadyFlag) {
      S._spReadyFlag = true;
      S.starPowerReady = true;
      if (!silent) emit({ type: 'sp', action: 'ready' });
    } else if (!ready && S._spReadyFlag) {
      S._spReadyFlag = false;
      S.starPowerReady = false;
    }
  }

  function updateStarPower(dt, t, silent) {
    if (!S.starPowerActive) return;
    var beat = bps(t);
    S.starPower -= dt * beat * S.spDrainPerBeat;
    /* Com Star Power ativo o rock meter se recupera mais rapido — e o momento
     * de virar o jogo depois de uma sequencia ruim. */
    S.health = clamp(S.health + dt * SP_HEALTH_REGEN, 0, 1);
    if (S.starPower <= 0) {
      S.starPower = 0;
      deactivateStarPower(t, silent);
    }
  }

  /* Trechos da musica com Star Power ligado, para o grafico de desempenho
   * dos resultados mostrar o multiplicador DOBRADO (ate 8x) onde ele valeu.
   * `b` fica -1 enquanto o trecho esta aberto. */
  var _spSpans = [];
  function spSpanOpen(t) { _spSpans.push({ a: t, b: -1 }); }
  function spSpanClose(t) {
    var s = _spSpans[_spSpans.length - 1];
    if (s && s.b < 0) s.b = Math.max(s.a, t);
  }

  function deactivateStarPower(t, silent) {
    if (!S.starPowerActive) return;
    spSpanClose(t);
    S.starPowerActive = false;
    S.multiplier = computeMultiplier();
    S.starPowerReady = false;
    S._spReadyFlag = false;
    setSynthStarPower(false);
    checkStarPowerReady(silent);
    if (!silent) emit({ type: 'sp', action: 'end', time: t });
  }

  /* ==========================================================================
   * Deteccao de notas perdidas
   * ========================================================================*/

  function detectMisses(t, silent) {
    while (_missCursor < _groups.length) {
      var g = _groups[_missCursor];
      if (g.t + _goodWin >= t) break;        // ainda da pra acertar
      if (!_gJudged[_missCursor]) applyMiss(_missCursor, 'timeout', silent);
      _missCursor++;
    }
  }

  /* ==========================================================================
   * Palhetada / trastes
   * ========================================================================*/

  function noneResult() {
    return { result: 'none', quality: 'none', note: null, noteIdxs: [],
             group: null, groupIdx: -1, deltaMs: 0 };
  }

  function doStrum(t, mask, buffered) {
    /* Uma palhetada ja convertida em acerto nao pode ser reprocessada quando o
     * GH.Input a reemite pelo buffer. */
    if (buffered && Math.abs(t - _consumedStrumTime) < 1e-4) return noneResult();

    var gi = nearestUnjudged(t, _goodWin);
    if (gi >= 0 && maskSatisfies(_groups[gi], mask)) {
      _pendingStrum = null;
      _consumedStrumTime = t;
      inputConsumeStrum();
      return applyHit(gi, t - _groups[gi].t, 'strum');
    }

    /* Sem casamento. Se existe uma nota na janela, o jogador provavelmente
     * palhetou antes de fechar o acorde — segura a palhetada por
     * STRUM_LENIENCY e tenta de novo a cada mudanca de traste / a cada frame. */
    if (gi >= 0) {
      if (!buffered) {
        /* Palhetar de novo com uma palhetada ainda pendurada = overstrum da
         * anterior (voce palhetou duas vezes para uma nota so). */
        if (_pendingStrum) { var old = _pendingStrum; _pendingStrum = null; overstrum(old.t); }
        _pendingStrum = { t: t, deadline: t + STRUM_LENIENCY, mask: mask };
      } else if (_pendingStrum) {
        _pendingStrum.mask = mask;
      } else {
        _pendingStrum = { t: t, deadline: t + STRUM_LENIENCY, mask: mask };
      }
      return noneResult();
    }

    /* Palhetada logo depois de um HOPO/tap acertado so com o dedo: engole. */
    if (t <= _absorbStrumUntil) {
      _pendingStrum = null;
      inputConsumeStrum();
      return noneResult();
    }

    /* Nao ha nota nenhuma perto: overstrum imediato (feedback tem que ser na
     * hora, senao o jogador nao entende o que aconteceu). */
    if (_pendingStrum) { var p = _pendingStrum; _pendingStrum = null; overstrum(p.t); }
    return overstrum(t);
  }

  /* Reavalia a palhetada em buffer com a mascara atual. */
  function retryPending(t) {
    if (!_pendingStrum) return null;
    var gi = nearestUnjudged(_pendingStrum.t, _goodWin);
    if (gi < 0) {
      var p = _pendingStrum; _pendingStrum = null;
      return overstrum(p.t);
    }
    if (maskSatisfies(_groups[gi], _mask)) {
      var pt = _pendingStrum.t;
      _pendingStrum = null;
      _consumedStrumTime = pt;
      inputConsumeStrum();
      return applyHit(gi, pt - _groups[gi].t, 'strum-buffer');
    }
    if (t >= _pendingStrum.deadline) {
      var q = _pendingStrum; _pendingStrum = null;
      return overstrum(q.t);
    }
    return null;
  }

  /* Traste pressionado: primeiro resolve a palhetada em buffer, depois tenta
   * HOPO/tap. Apertar traste NUNCA e punido (nada de "ghost tap penalty"). */
  function doFret(lane, t, mask) {
    if (_pendingStrum) {
      var r = retryPending(t);
      if (r && r.result !== 'none') return r;
    }

    var gi = nearestUnjudged(t, _goodWin);
    if (gi < 0) return noneResult();
    var g = _groups[gi];

    var canTap = !!g.tap;                    // tap sempre pode, sem cadeia
    var canHopo = !!g.hopo && _hopoAlive;    // hopo exige a cadeia viva
    if (!canTap && !canHopo) return noneResult();
    if (!maskSatisfies(g, mask)) return noneResult();

    return applyHit(gi, t - g.t, canTap ? 'tap' : 'hopo');
  }

  /* ==========================================================================
   * API publica
   * ========================================================================*/

  var S = {

    /* --- janelas (contrato) --------------------------------------------- */
    HIT_WINDOW: 0.070,
    PERFECT_WINDOW: 0.025,
    STRUM_LENIENCY: STRUM_LENIENCY,

    /* --- placar --------------------------------------------------------- */
    score: 0,
    streak: 0,
    bestStreak: 0,
    multiplier: 1,
    baseMultiplier: 1,
    notesHit: 0,
    notesMissed: 0,
    notesTotal: 0,
    perfects: 0,
    goods: 0,
    misses: 0,
    overstrums: 0,
    earlyCount: 0,
    lateCount: 0,
    accuracy: 0,
    progress: 0,

    /* --- medidores ------------------------------------------------------ */
    health: 0.5,
    starPower: 0,
    starPowerActive: false,
    starPowerReady: false,
    spPhrasesHit: 0,
    spPhrasesTotal: 0,
    spDrainPerBeat: SP_DRAIN_PER_BEAT,
    _spReadyFlag: false,

    /* --- fim ------------------------------------------------------------ */
    stars: 0,
    starsDisplay: 0,     // = stars, ou 6 quando a estrela de ouro sai
    starsFloat: 0,
    liveStars: 0,
    liveStarsFloat: 0,
    goldStar: false,
    failed: false,
    baseScore: 0,
    baseScorePassed: 0,

    /* --- configuracao --------------------------------------------------- */
    difficulty: '',
    autoPlay: false,     // bot: acerta tudo sozinho (demo / modo captura)
    noFail: false,       // partida sem fracasso por conta do jogo (tutorial)
    autoSfx: false,      // o roteamento de SFX pertence ao game.js

    /* ---------------------------------------------------------------------
     * reset(difficulty) — zera tudo e amarra no chart carregado.
     * -------------------------------------------------------------------*/
    reset: function (difficulty) {
      var C = GH.Chart;
      _groups = (C && C.groups) ? C.groups : [];
      _notes = (C && C.notes) ? C.notes : [];
      _phrases = (C && C.starPowerPhrases) ? C.starPowerPhrases : [];

      this.difficulty = difficulty || (C && C.difficulty) || '';
      _tuning = DIFFICULTY[this.difficulty] || DIFFICULTY._default;
      _goodWin = _tuning.good;
      _perfWin = _tuning.perfect;
      _perfMs = _perfWin * 1000;
      this.HIT_WINDOW = _goodWin;
      this.PERFECT_WINDOW = _perfWin;

      var ng = _groups.length;
      _gJudged = new Uint8Array(ng);
      _gResult = new Uint8Array(ng);
      _gDelta = new Float32Array(ng);

      var np = _phrases.length;
      _phraseHits = new Int32Array(np);
      _phraseBroken = new Uint8Array(np);
      _phraseDone = new Uint8Array(np);

      _missCursor = 0;
      _hopoAlive = false;
      _pendingStrum = null;
      _consumedStrumTime = -1e9;
      _absorbStrumUntil = -1e9;
      _lastOverstrum = null;
      _sustains.length = 0;
      _spSpans.length = 0;
      _scoreF = 0;
      _sustainPts = 0;
      _deltas.length = 0;
      for (var i = 0; i < HIST_BINS; i++) _hist[i] = 0;
      _mask = 0;
      _songTime = 0;
      _paused = false;
      _muted = false;
      _rngState = 0x9e3779b9;

      this.score = 0;
      this.streak = 0;
      this.bestStreak = 0;
      this.multiplier = 1;
      this.baseMultiplier = 1;
      this.notesHit = 0;
      this.notesMissed = 0;
      this.notesTotal = (C && C.stats) ? C.stats.total : _notes.length;
      this.perfects = 0;
      this.goods = 0;
      this.misses = 0;
      this.overstrums = 0;
      this.earlyCount = 0;
      this.lateCount = 0;
      this.accuracy = 0;
      this.progress = 0;
      this.health = _tuning.start;
      this.starPower = 0;
      this.starPowerActive = false;
      this.starPowerReady = false;
      this._spReadyFlag = false;
      this.spPhrasesHit = 0;
      this.spPhrasesTotal = np;
      this.stars = 0;
      this.starsDisplay = 0;
      this.starsFloat = 0;
      this.liveStars = 0;
      this.liveStarsFloat = 0;
      this.goldStar = false;
      this.failed = false;
      this.baseScore = (C && C.stats) ? C.stats.baseScore : (this.notesTotal * NOTE_PTS);
      this.baseScorePassed = 0;

      if (C && typeof C.reset === 'function') C.reset();

      setGuitarMuted(false);
      setSynthStarPower(false);

      _ready = _groups.length > 0;
      this.ready = _ready;
      return this;
    },

    /* ---------------------------------------------------------------------
     * judge(lane, inputTime [, opts]) — CONTRATO.
     * Sem opts, e tratado como "o jogador tocou esta raia palhetando", que e o
     * caso mais util para quem integra. Com opts da para separar as fontes:
     *   opts = { strum: true|false, mask: <bitmask>, buffered: true|false }
     * Devolve { result:'perfect'|'good'|'miss'|'none', note, deltaMs, ... }.
     * -------------------------------------------------------------------*/
    judge: function (lane, inputTime, opts) {
      if (!_ready || _paused) return noneResult();
      var t = (typeof inputTime === 'number' && isFinite(inputTime)) ? inputTime : conductorTime();
      _songTime = Math.max(_songTime, t);

      var wantStrum = opts ? (opts.strum !== false) : true;
      var mask;
      if (opts && typeof opts.mask === 'number') {
        mask = opts.mask;
      } else if (GH.Input && GH.Input.ready && typeof GH.Input.fretMask === 'number') {
        /* Ha um dispositivo de verdade: a mascara real manda. */
        mask = syncMask();
      } else {
        /* Chamada solta (`judge(lane, t)` sem GH.Input): a intencao e "o
         * jogador tocou ESTA raia". Nao herdamos a mascara anterior — heranca
         * acumularia raias e o proximo acorde/nota simples falharia. */
        mask = 0;
      }
      if (typeof lane === 'number' && lane >= 0 && lane < LANES) mask |= (1 << lane);
      _mask = mask;

      if (wantStrum) return doStrum(t, mask, !!(opts && opts.buffered));
      return doFret((typeof lane === 'number' ? lane : -1), t, mask);
    },

    /* Palhetada (ligar em GH.Input.onStrum). */
    strum: function (tSec, info) {
      if (!_ready || _paused) return noneResult();
      var t = (typeof tSec === 'number' && isFinite(tSec)) ? tSec : conductorTime();
      _songTime = Math.max(_songTime, t);
      var mask = (info && typeof info.mask === 'number') ? info.mask : syncMask();
      _mask = mask;
      return doStrum(t, mask, !!(info && info.buffered));
    },

    /* Traste pressionado (ligar em GH.Input.onFretDown). */
    fretDown: function (lane, tSec, mask) {
      if (!_ready || _paused) return noneResult();
      var t = (typeof tSec === 'number' && isFinite(tSec)) ? tSec : conductorTime();
      _songTime = Math.max(_songTime, t);
      if (typeof mask === 'number') _mask = mask; else syncMask();
      if (typeof lane === 'number' && lane >= 0 && lane < LANES) _mask |= (1 << lane);
      return doFret(lane, t, _mask);
    },

    /* Traste solto (ligar em GH.Input.onFretUp). Nunca pune; pode encerrar
     * sustain e pode fechar o acorde certo para a palhetada em buffer. */
    fretUp: function (lane, tSec, mask) {
      if (!_ready) return noneResult();
      var t = (typeof tSec === 'number' && isFinite(tSec)) ? tSec : conductorTime();
      if (typeof mask === 'number') _mask = mask; else syncMask();
      if (typeof lane === 'number' && lane >= 0 && lane < LANES) _mask &= ~(1 << lane);
      if (_paused) return noneResult();
      if (_pendingStrum) {
        var r = retryPending(t);
        if (r) return r;
      }
      return noneResult();
    },

    /* Cancelamento de palhetada vindo do gesto de "tilt". */
    cancelStrum: function (tSec, reason) {
      var t = (typeof tSec === 'number' && isFinite(tSec)) ? tSec : conductorTime();
      _pendingStrum = null;
      refundOverstrum(t);
      return true;
    },

    /* ---------------------------------------------------------------------
     * update(dt, songTime) — chamado a cada frame pelo game.js
     * -------------------------------------------------------------------*/
    update: function (dt, songTime) {
      if (!_ready) return;
      if (typeof dt !== 'number' || !isFinite(dt) || dt < 0) dt = 0;
      if (dt > 0.25) dt = 0.25;
      var t = (typeof songTime === 'number' && isFinite(songTime)) ? songTime : conductorTime();
      _songTime = t;

      syncMask();
      if (_paused) return;

      /* Bot (demo/attract/captura): acerta tudo que cruzou a linha. */
      if (this.autoPlay) autoPlayStep(t);

      /* 1. palhetada em buffer — antes da deteccao de erro, para a nota ainda
       *    ter chance no ultimo frame da janela. */
      if (_pendingStrum) {
        if (t >= _pendingStrum.deadline) {
          var p = _pendingStrum; _pendingStrum = null; overstrum(p.t);
        } else {
          retryPending(t);
        }
      }

      /* 2. notas que passaram da janela sem julgamento */
      detectMisses(t, false);

      /* 3. sustains */
      updateSustains(dt, t, false);

      /* 4. star power */
      updateStarPower(dt, t, false);

      /* 5. rock meter */
      checkFail();
    },

    /* ---------------------------------------------------------------------
     * Star Power
     * -------------------------------------------------------------------*/
    activateStarPower: function () {
      if (!_ready) return false;
      if (this.starPowerActive) return false;         // nao reativa enquanto ativo
      if (this.starPower < SP_ACTIVATE_MIN) return false;
      if (this.failed) return false;
      spSpanOpen(_songTime);
      this.starPowerActive = true;
      this.multiplier = computeMultiplier();
      this.starPowerReady = false;
      this._spReadyFlag = false;
      setSynthStarPower(true);
      emit({ type: 'sp', action: 'start', time: _songTime });
      return true;
    },

    endStarPower: function () { deactivateStarPower(_songTime, false); },

    /* ---------------------------------------------------------------------
     * Eventos
     * -------------------------------------------------------------------*/
    onEvent: function (fn) {
      if (typeof fn === 'function' && _listeners.indexOf(fn) < 0) _listeners.push(fn);
      return fn;
    },
    offEvent: function (fn) {
      var i = _listeners.indexOf(fn);
      if (i >= 0) _listeners.splice(i, 1);
    },
    clearEvents: function () { _listeners.length = 0; },

    /* ---------------------------------------------------------------------
     * Ligacao automatica com o GH.Input (idempotente).
     * O game.js pode usar isto em vez de ligar tudo na mao.
     * -------------------------------------------------------------------*/
    attachInput: function () {
      var I = GH.Input;
      if (!I || _attached) return false;
      _hStrum = function (t, info) { S.strum(t, info); };
      _hFretDown = function (lane, t, mask) { S.fretDown(lane, t, mask); };
      _hFretUp = function (lane, t, mask) { S.fretUp(lane, t, mask); };
      _hCancel = function (t, reason) { S.cancelStrum(t, reason); };
      I.onStrum(_hStrum);
      I.onFretDown(_hFretDown);
      I.onFretUp(_hFretUp);
      if (I.onStrumCancel) I.onStrumCancel(_hCancel);
      _attached = true;
      return true;
    },
    detachInput: function () {
      var I = GH.Input;
      if (!I || !_attached) return false;
      if (I.offStrum) I.offStrum(_hStrum);
      if (I.offFretDown) I.offFretDown(_hFretDown);
      if (I.offFretUp) I.offFretUp(_hFretUp);
      if (I.offStrumCancel) I.offStrumCancel(_hCancel);
      _attached = false;
      return true;
    },

    /* ---------------------------------------------------------------------
     * Controle de fluxo
     * -------------------------------------------------------------------*/
    setPaused: function (v) {
      _paused = !!v;
      if (_paused) _pendingStrum = null;
    },
    isPaused: function () { return _paused; },
    ready: false,

    /* ---------------------------------------------------------------------
     * Estatisticas finais completas (tela de resultados)
     * -------------------------------------------------------------------*/
    getStats: function () {
      var i, sum = 0, n = _deltas.length;
      for (i = 0; i < n; i++) sum += _deltas[i];
      var avg = n ? sum / n : 0;
      var varsum = 0;
      for (i = 0; i < n; i++) { var d = _deltas[i] - avg; varsum += d * d; }
      var std = n > 1 ? Math.sqrt(varsum / (n - 1)) : 0;

      var C = GH.Chart;
      var dur = (C && C.stats && C.stats.durationSec) ? C.stats.durationSec : Math.max(1, _songTime);

      var edges = new Array(HIST_BINS);
      for (i = 0; i < HIST_BINS; i++) edges[i] = (i - HIST_CENTER) * HIST_BIN_MS;

      return {
        songId: (C && C.song && C.song.id) || '',
        songTitle: (C && C.song && C.song.title) || '',
        difficulty: this.difficulty,
        score: this.score,
        notesHit: this.notesHit,
        notesMissed: this.notesMissed,
        notesTotal: this.notesTotal,
        perfects: this.perfects,
        goods: this.goods,
        misses: this.misses,
        overstrums: this.overstrums,
        accuracy: this.accuracy,
        bestStreak: this.bestStreak,
        fullCombo: (this.notesMissed === 0 && this.overstrums === 0 && this.notesHit === this.notesTotal),
        stars: this.stars,
        starsDisplay: this.starsDisplay,
        starsFloat: this.starsFloat,
        goldStar: this.goldStar,
        health: this.health,
        failed: this.failed,
        baseScore: this.baseScore,
        sustainPoints: Math.round(_sustainPts),
        spPhrasesHit: this.spPhrasesHit,
        spPhrasesTotal: this.spPhrasesTotal,
        earlyCount: this.earlyCount,
        lateCount: this.lateCount,
        avgDeltaMs: Math.round(avg * 100) / 100,
        stdDeltaMs: Math.round(std * 100) / 100,
        nps: dur > 0 ? Math.round((this.notesHit / dur) * 100) / 100 : 0,
        durationSec: dur,
        histogram: { binMs: HIST_BIN_MS, bins: HIST_BINS, edges: edges, counts: _hist.slice(0) },
        deltas: _deltas.slice(0),
        hitWindowMs: Math.round(_goodWin * 1000),
        perfectWindowMs: Math.round(_perfWin * 1000)
      };
    },

    /* Encerra a musica: fecha sustains e emite o evento final. */
    finish: function () {
      dropAllSustains(_songTime, false);
      detectMisses(1e9, false);
      recomputeStars();
      var st = this.getStats();
      emit({ type: 'finish', stats: st });
      return st;
    },

    /* ---------------------------------------------------------------------
     * Consulta do estado de julgamento (o agente de NOTAS usa para saber o
     * que ja foi acertado sem precisar guardar estado proprio).
     * -------------------------------------------------------------------*/
    /* Trechos com Star Power ligado [{a, b}] (copia; trecho ainda aberto
       termina no instante atual). */
    starPowerSpans: function () {
      var out = [];
      for (var i = 0; i < _spSpans.length; i++) {
        out.push({ a: _spSpans[i].a, b: _spSpans[i].b < 0 ? _songTime : _spSpans[i].b });
      }
      return out;
    },
    groupJudged: function (gi) { return _gJudged && gi >= 0 && gi < _gJudged.length ? _gJudged[gi] === 1 : false; },
    groupResult: function (gi) {
      if (!_gResult || gi < 0 || gi >= _gResult.length) return 'none';
      var r = _gResult[gi];
      return r === 1 ? 'perfect' : (r === 2 ? 'good' : (r === 3 ? 'miss' : 'none'));
    },
    groupDelta: function (gi) { return _gDelta && gi >= 0 && gi < _gDelta.length ? _gDelta[gi] : 0; },
    activeSustains: function () { return _sustains; },
    pendingStrum: function () { return _pendingStrum; },
    fretMask: function () { return _mask; },
    hopoChainAlive: function () { return _hopoAlive; },

    /* ---------------------------------------------------------------------
     * MODO CAPTURA / DEMO
     * -------------------------------------------------------------------*/

    /* Estado forcado (usado por GH.Game.forceState). */
    forceState: function (o) {
      if (!o) return this;
      if (typeof o.score === 'number') { _scoreF = o.score; this.score = Math.round(o.score); }
      if (typeof o.streak === 'number') {
        this.streak = Math.max(0, Math.round(o.streak));
        if (this.streak > this.bestStreak) this.bestStreak = this.streak;
      }
      if (typeof o.health === 'number') {
        this.health = clamp(o.health, 0, 1);
        /* `failed` e uma TRAVA: uma vez acionada, nada mais a solta sozinho —
           e isso esta certo durante a partida. Mas forceState existe para
           montar uma cena do zero (modo captura, replay, demo), e la um
           `health` positivo significa "o jogador esta vivo". Sem isto, uma
           simulacao anterior que zerou a vida deixava a trava de pe e
           activateStarPower() falhava em silencio — a cena gameplay_sp saia
           sem Star Power nenhum. Quem quiser forcar o estado de fracasso passa
           `failed: true` explicitamente (tratado logo abaixo). */
        if (this.health > 0 && typeof o.failed !== 'boolean') this.failed = false;
      }
      if (typeof o.starPower === 'number') this.starPower = clamp(o.starPower, 0, 1);
      if (typeof o.starPowerActive === 'boolean') {
        if (o.starPowerActive && !this.starPowerActive) spSpanOpen(_songTime);
        else if (!o.starPowerActive && this.starPowerActive) spSpanClose(_songTime);
        this.starPowerActive = o.starPowerActive;
        setSynthStarPower(o.starPowerActive);
      }
      if (typeof o.failed === 'boolean') this.failed = o.failed;
      this.multiplier = computeMultiplier();
      /* Multiplicador explicito sobrepoe a conta (captura pede 2x/8x exatos). */
      if (typeof o.multiplier === 'number' && o.multiplier > 0) {
        this.multiplier = o.multiplier;
        this.baseMultiplier = this.starPowerActive ? Math.max(1, o.multiplier / 2) : o.multiplier;
      }
      if (typeof o.notesHit === 'number') this.notesHit = Math.max(0, Math.round(o.notesHit));
      if (typeof o.notesMissed === 'number') this.notesMissed = Math.max(0, Math.round(o.notesMissed));
      if (typeof o.muted === 'boolean') setGuitarMuted(o.muted);
      recalcAccuracy();
      recomputeStars();
      checkStarPowerReady(true);
      return this;
    },

    /* Simula a musica ate `songTime` como se um jogador tivesse tocado.
     * Da HISTORIA de verdade ao estado (sequencia, placar, star power, vida)
     * — o modo captura depende disso para as telas nao parecerem vazias.
     * opts = { accuracy: 0..1, perfectRatio: 0..1, seed: int, silent: bool } */
    autoPlayTo: function (songTime, opts) {
      if (!_ready) return this;
      var o = opts || {};
      var acc = (typeof o.accuracy === 'number') ? clamp(o.accuracy, 0, 1) : 1;
      var pr = (typeof o.perfectRatio === 'number') ? clamp(o.perfectRatio, 0, 1) : 0.82;
      var silent = o.silent !== false;
      if (typeof o.seed === 'number') _rngState = o.seed | 0;

      var i, prevT = _songTime;
      for (i = _missCursor; i < _groups.length; i++) {
        var g = _groups[i];
        if (g.t > songTime) break;
        if (_gJudged[i]) continue;
        _songTime = g.t;
        if (acc >= 1 || rand() < acc) {
          var jitter = (rand() < pr)
            ? (rand() - 0.5) * 2 * _perfWin * 0.7
            : (_perfWin + rand() * (_goodWin - _perfWin) * 0.8) * (rand() < 0.5 ? -1 : 1);
          applyHit(i, jitter, 'auto', silent);
          /* Ativa o Star Power assim que der, para a captura pegar o jogo no
           * seu momento mais bonito. */
          if (o.useStarPower !== false && !this.starPowerActive &&
              this.starPower >= SP_ACTIVATE_MIN) {
            spSpanOpen(g.t);
            this.starPowerActive = true;
            this.multiplier = computeMultiplier();
            setSynthStarPower(true);
            if (!silent) emit({ type: 'sp', action: 'start', time: g.t });
          }
        } else {
          applyMiss(i, 'timeout', silent);
        }
        _missCursor = i + 1;

        /* Contabiliza sustains e drenagem entre um ataque e o seguinte. */
        var step = g.t - prevT;
        if (step > 0) {
          updateSustains(step, g.t, silent);
          updateStarPower(step, g.t, silent);
        }
        prevT = g.t;
      }
      var tail = songTime - prevT;
      if (tail > 0) {
        updateSustains(tail, songTime, silent);
        updateStarPower(tail, songTime, silent);
      }
      _songTime = songTime;
      detectMisses(songTime, silent);
      recalcAccuracy();
      recomputeStars();
      return this;
    },

    /* Constantes expostas para o HUD/menus */
    NOTE_PTS: NOTE_PTS,
    PERFECT_BONUS: PERFECT_BONUS,
    SUSTAIN_PTS_PER_BEAT: SUSTAIN_PTS_PER_BEAT,
    SP_ACTIVATE_MIN: SP_ACTIVATE_MIN,
    SP_PER_PHRASE: SP_PER_PHRASE,
    MAX_BASE_MULT: MAX_BASE_MULT,
    STAR_THRESHOLDS: STAR_THRESHOLDS,
    DIFFICULTY: DIFFICULTY
  };

  /* Bot do modo demo: acerta as notas conforme elas cruzam a linha. */
  function autoPlayStep(t) {
    for (var i = _missCursor; i < _groups.length; i++) {
      var g = _groups[i];
      if (g.t > t) break;
      if (_gJudged[i]) continue;
      applyHit(i, t - g.t < 0.001 ? 0 : (t - g.t) * 0.15, 'auto', false);
      if (!S.starPowerActive && S.starPower >= SP_ACTIVATE_MIN) S.activateStarPower();
    }
  }

  GH.Scoring = S;

})(window.GH = window.GH || {});

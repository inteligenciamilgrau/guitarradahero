/* ===========================================================================
   GUITARRADA HERO — src/gameplay/tutorial.js
   GH.Tutorial: a primeira aula de guitarrada.

   Quem nunca jogou nao sabe que uma nota e TRASTE + PALHETADA. O tutorial
   ensina tocando, uma regra de cada vez:
     1. os trastes          cada cor e uma tecla
     2. a palhetada         a outra mao
     3. as duas maos        segurar + palhetar junto, 3 vezes seguidas
     4. primeira nota       segurar + palhetar na linha
     5. trocando de cor     as cinco raias
     6. o bastao            nota aberta: palhetar sem traste
     7. notas longas        sustain: segurar ate o rabo acabar
     8. acordes             duas teclas, uma palhetada
     9. star power          encher o medidor e ativar
   As tres primeiras sao so de teclado (nada desce pela pista). As outras sao
   musicas curtas montadas por GH.Songs.compose(): a banda toca de verdade e a
   licao so passa quando o jogador bate a meta — senao, explica e repete.

   FLUXO (o GH.Game empresta o palco — secao 8B de game.js)
     card  explicacao na tela, palco vazio (GH.Game.clearStage): o jogador
           aperta trastes e palheta a vontade sem nada ser julgado
     play  GH.Game.startSong(licao) sem contagem; faixa compacta no topo e um
           "treinador" que explica cada erro na hora
     fim   update() ve a licao acabar, mede e volta para o card — da proxima
           licao (com o parabens) ou da mesma (com a dica)

   As teclas mostradas saem de GH.Input.getBindings(): quem redefiniu os
   controles ve as SUAS teclas, com o mesmo nome da tela de controles.
   =========================================================================== */

(function (GH) {
  'use strict';

  /* =========================================================================
     1. RITMO DAS LICOES
     ========================================================================= */

  var BPM = 100;                 /* devagar: quem nunca jogou precisa ler a pista */
  var BEAT = 60 / BPM;
  var BAR = BEAT * 4;
  var FIRST = BAR;               /* um compasso de banda antes da primeira nota */
  var END_PAD = 1.0;             /* respiro depois do ultimo ataque antes de medir */
  var DIFF = 'facil';            /* a janela de acerto mais generosa do jogo */

  /* Harmonia funcional em La maior: I, IV, V7. Cada licao TERMINA na tonica:
     contando do ultimo compasso para tras, I <- V7 <- IV <- I ...; o primeiro
     compasso (so banda, antes das notas) fica sempre na tonica. A ultima
     nota da licao cai num compasso de I e resolve. */
  var CHORD = { I: 'A', IV: 'D', V: 'E7' };
  var CADENCE = [CHORD.I, CHORD.V, CHORD.IV, CHORD.I];
  function progression(bars) {
    var out = [];
    for (var b = 0; b < bars; b++) out.push(b === 0 ? CHORD.I : CADENCE[(bars - 1 - b) % 4]);
    return out;
  }

  var NEXT_DELAY = 1.2;          /* licao de teclado cumprida -> proxima */
  var COACH_GAP = 2.2;           /* intervalo minimo entre duas dicas */
  var COACH_LIFE = 3.0;          /* quanto tempo a dica fica na tela */

  var LANE_NAMES = ['verde', 'vermelho', 'amarelo', 'azul', 'laranja'];

  /* Notas medidas em BATIDAS a partir da primeira (que cai em FIRST). */
  function gem(beat, lane, beats) {
    return { t: FIRST + beat * BEAT, lane: lane, dur: (beats || 0) * BEAT };
  }
  function openGem(beat) { return { t: FIRST + beat * BEAT, lane: 0, open: true }; }
  function spGem(beat, lane) { var n = gem(beat, lane); n.sp = true; return n; }
  function chord(beat, a, b) { return [gem(beat, a), gem(beat, b)]; }
  function flat(list) { return [].concat.apply([], list); }

  /* =========================================================================
     2. AS LICOES
     Texto em HTML confiavel (escrito aqui). Fichas que viram tecla na tela:
       {f0}..{f4} traste da raia (na cor dela)   {strum} {strumUp} {sp}
       <c0>..</c0> texto na cor da raia          <sp>..</sp> azul do SP
     ========================================================================= */

  var LESSONS = [
    {
      kind: 'frets',
      title: 'Os trastes',
      body: 'Os cinco círculos coloridos lá embaixo, na pista, são os <b>trastes</b>. ' +
            'Cada cor tem a sua tecla — é a mão que aperta as casas no braço da guitarra.',
      goal: 'Aperte as cinco teclas, uma de cada vez',
      done: 'Isso! Cada cor, uma tecla.'
    },
    {
      kind: 'strum',
      title: 'A palhetada',
      body: 'Agora a outra mão: <b>palhetar</b> é bater nas cordas. ' +
            'Aperte {strum} — o {strumUp} também palheta.',
      need: 3,
      goal: 'Palhete 3 vezes',
      done: 'Boa! Pra tocar você usa as duas mãos: <b>traste + palhetada</b>.'
    },
    {
      /* A parte que mais confunde quem nunca jogou: as duas maos AO MESMO
         TEMPO. Treina sem nota nenhuma antes de pedir isso na pista. */
      kind: 'combo',
      title: 'As duas mãos juntas',
      body: 'O segredo de toda nota: <b>segure {f0}</b> e, sem soltar, <b>palhete {strum}</b>.',
      need: 3,
      goal: 'Acerte 3 vezes seguidas',
      done: 'Isso! Segurar e palhetar ao mesmo tempo: é assim que toda nota sai.'
    },
    {
      kind: 'song',
      firstNote: true,
      title: 'Sua primeira nota',
      body: 'As notas descem pela pista. Quando a nota <c0>verde</c0> encostar no círculo verde, ' +
            '<b>segure {f0} e palhete {strum}</b>.',
      task: '{f0}<i>+</i>{strum}',
      hint: 'Segure {f0} e palhete {strum} na linha',
      notes: [gem(0, 0), gem(2, 0), gem(4, 0), gem(6, 0)],
      need: 3
    },
    {
      kind: 'song',
      title: 'Trocando de cor',
      body: 'Agora cada nota vem de uma cor. Segure a tecla <b>da cor da nota</b> e palhete quando ' +
            'ela chegar na linha. Deixe os dedos em cima das cinco teclas.',
      task: '{f0}{f1}{f2}{f3}{f4}<i>+</i>{strum}',
      hint: 'Tecla da cor da nota + {strum}',
      notes: [gem(0, 0), gem(2, 1), gem(4, 2), gem(6, 3), gem(8, 4), gem(10, 3), gem(12, 2), gem(14, 1)],
      need: 6
    },
    {
      kind: 'song',
      title: 'O bastão',
      body: 'O <b>bastão</b> colorido que atravessa a pista inteira é a nota aberta: ' +
            '<b>palhete sem segurar nenhum traste</b>. Solte tudo e só palhete.',
      task: '<span class="tu-open"></span><i>=</i>{strum}',
      hint: 'Bastão: solte os trastes e só palhete {strum}',
      notes: [openGem(0), openGem(2), gem(4, 0), openGem(6), gem(8, 1), openGem(10)],
      need: 4
    },
    {
      kind: 'song',
      title: 'Notas longas',
      body: 'Nota com <b>rabo</b>? Palhete e <b>continue segurando</b> a tecla até o rabo acabar. ' +
            'Quanto mais tempo segura, mais pontos ganha.',
      task: '<span class="tu-tail" data-lane="0"></span><i>=</i>{f0}<i>+</i>{strum}<i>e segure</i>',
      hint: 'Palhete e segure a tecla até o rabo acabar',
      notes: [gem(0, 0, 2), gem(4, 1, 2), gem(8, 2, 3)],
      need: 2
    },
    {
      kind: 'song',
      title: 'Acordes',
      body: 'Duas notas lado a lado são um <b>acorde</b>: segure <b>as duas teclas juntas</b> ' +
            'e palhete uma vez só.',
      task: '{f0}{f1}<i>+</i>{strum}',
      hint: 'Duas teclas juntas + uma palhetada',
      notes: flat([chord(0, 0, 1), chord(2, 0, 1), chord(4, 1, 2), chord(6, 1, 2)]),
      need: 3
    },
    {
      kind: 'song',
      sp: true,
      title: 'Star Power',
      body: 'Notas <sp>azuis brilhando</sp> valem <b>Star Power</b>. Acerte todas as de uma frase para ' +
            'encher o medidor da direita. Com ele pela metade, aperte {sp}: <b>os pontos dobram!</b>',
      task: '<span class="tu-spgem"></span><span class="tu-spgem"></span><span class="tu-spgem"></span>' +
            '<i>&rarr;</i>{sp}',
      hint: 'Acerte todas as notas azuis',
      notes: [spGem(0, 0), spGem(2, 1), spGem(4, 2), spGem(6, 1),
              gem(8, 0), gem(10, 1),
              spGem(12, 2), spGem(14, 1), spGem(16, 0), spGem(18, 1),
              gem(20, 2), gem(22, 1), gem(24, 0), gem(26, 1), gem(28, 2), gem(30, 1)],
      goal: 'Meta: ative o Star Power'
    }
  ];

  var FINAL = {
    kind: 'done',
    kick: 'Tutorial concluído',
    title: 'Pronto pra tocar!',
    tips: [
      'A cada <b>10 acertos seguidos</b> o multiplicador sobe — até <b>4×</b> (8× com Star Power).',
      'Palhetar sem nota na linha é <b>palhetada à toa</b>: quebra a sua sequência.',
      'Errou? A guitarra some da música até você acertar de novo.',
      'Comece no <b>Fácil</b> — só três cores — e vá subindo.'
    ],
    go: 'Palhete {strum} para escolher uma música'
  };

  /* =========================================================================
     3. ESTADO
     ========================================================================= */

  var active = false;
  var idx = 0;                   /* licao corrente (LESSONS.length = final) */
  var phase = 'card';            /* 'card' | 'play' */
  var flash = null;              /* {kind:'ok'|'bad', html} no topo do card */
  var clock = 0;                 /* segundos de tutorial (para na pausa) */

  var step = 0;                  /* licao de teclado: progresso */
  var nextAt = -1;               /* licao de teclado cumprida: troca em... */
  var leaving = false;           /* fim do tutorial pedido; sai no proximo quadro */

  var hits = 0;                  /* licao tocada: ataques acertados */
  var heldIn = [], watchLo = 0;  /* trastes que o jogador segurou na janela de cada ataque */
  var spPhrases = 0, spReady = false, spOn = false;
  var coachAt = -1e9, coachUntil = -1, lastTip = '';

  var songs = {};                /* musica de cada licao (montada uma vez) */
  var unsub = [];
  var root = null, N = {};

  /* =========================================================================
     4. FERRAMENTAS
     ========================================================================= */

  function mcall(modName, fnName, a, b, c) {
    var m = GH[modName];
    if (!m || typeof m[fnName] !== 'function') return undefined;
    try { return m[fnName](a, b, c); }
    catch (e) {
      try { if (console && console.warn) console.warn('GH.Tutorial: ' + modName + '.' + fnName, e); } catch (e2) { /* ok */ }
      return undefined;
    }
  }

  function sfx(name, a, b) {
    var A = GH.Audio;
    if (!A || !A.sfx || typeof A.sfx[name] !== 'function') return;
    try { A.sfx[name](a, b); } catch (e) { /* som e enfeite */ }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function laneColor(i) {
    try {
      if (GH.Palette && typeof GH.Palette.laneCss === 'function') return GH.Palette.laneCss(i, 'glow');
    } catch (e) { /* fallback */ }
    return ['#39e08a', '#ff3b4e', '#ffcf4a', '#4aa8ff', '#ff8a2b'][i % 5];
  }

  /* Primeira tecla ligada a uma acao, com o nome da tela de controles. */
  function keyOf(action) {
    var code = '';
    try {
      var b = GH.Input && GH.Input.getBindings ? GH.Input.getBindings() : null;
      if (b && b[action] && b[action].length) code = b[action][0];
    } catch (e) { code = ''; }
    if (GH.Menus && typeof GH.Menus.keyLabel === 'function') return GH.Menus.keyLabel(code);
    return code || '—';
  }

  function keycap(action, lane) {
    var style = '';
    if (lane >= 0) {
      var c = laneColor(lane);
      style = ' style="--lc:' + c + ';--lb:' + c + '99"';
    }
    return '<kbd class="tu-k' + (lane >= 0 ? ' lane' : '') + '"' + style + '>' + esc(keyOf(action)) + '</kbd>';
  }

  /* Troca as fichas do texto das licoes por teclas e cores de verdade. */
  function fmt(html) {
    return String(html)
      .replace(/\{f([0-4])\}/g, function (m, i) { return keycap('fret' + i, +i); })
      .replace(/\{strum\}/g, function () { return keycap('strumDown', -1); })
      .replace(/\{strumUp\}/g, function () { return keycap('strumUp', -1); })
      .replace(/\{sp\}/g, function () { return keycap('starpower', -1); })
      .replace(/<c([0-4])>/g, function (m, i) { return '<b style="color:' + laneColor(+i) + '">'; })
      .replace(/<\/c[0-4]>/g, '</b>')
      .replace(/<sp>/g, '<b class="tu-sp">')
      .replace(/<\/sp>/g, '</b>');
  }

  function lessonAt(i) { return i < LESSONS.length ? LESSONS[i] : FINAL; }

  function groupCount(L) {
    var seen = {}, n = 0, notes = L.notes || [];
    for (var i = 0; i < notes.length; i++) {
      var k = notes[i].t.toFixed(4);
      if (!seen[k]) { seen[k] = 1; n++; }
    }
    return n;
  }

  /* =========================================================================
     5. AS MUSICAS DAS LICOES
     ========================================================================= */

  /* Cada licao vira uma musica curta: um compasso de banda, as notas e o
     compasso que fecha. As licoes de teclado tambem tem a sua (sem notas) —
     ela so veste o palco: tema e cabecalho do HUD. */
  function lessonSong(i) {
    i = Math.min(i, LESSONS.length - 1);
    if (songs[i]) return songs[i];
    var L = LESSONS[i];
    var notes = L.notes || [];
    var last = FIRST;
    for (var k = 0; k < notes.length; k++) last = Math.max(last, notes[k].t + (notes[k].dur || 0));
    var bars = Math.max(2, Math.ceil((last + BEAT) / BAR));
    var s = GH.Songs.compose({
      id: 'tutorial-' + (i + 1),
      title: 'Tutorial',
      artist: L.title,
      tribute: 'Aula de guitarrada — lição ' + (i + 1) + ' de ' + LESSONS.length,
      genre: 'Aula',
      bpm: BPM, timeSig: [4, 4], year: 2026, palette: 'para', seed: 0x7E7A00 + i,
      key: 'A', scale: 'major', soloScale: 'major', pool: 'guitarrada',
      stars: { facil: 1, medio: 1, puxado: 1, dificil: 1, guitarrada: 1 },
      drumPattern: 'rock', drumVariant: 'guitarrada-marcha', bassPattern: 'guitarrada-drive',
      percussion: ['ganza', 'agogo'],
      instruments: { guitar: 'guitarrada-clean', bass: 'round-wound', keys: 'organ-soft', brass: false },
      cover: { hue: 26, hue2: 176, motif: 'guitar-wave', subtitle: 'Aula de guitarrada' },
      sections: [[L.title, bars, progression(bars), { intensity: 0.40, dyn: 'mp', pads: true, brass: false, stops: [] }]]
    }, notes);
    s.tutorial = true;
    s.autoStarPower = false;       /* SP so na licao de SP */
    s.lessonEnd = last + END_PAD;
    songs[i] = s;
    return s;
  }

  /* =========================================================================
     6. INTERFACE (HTML por cima do canvas, abaixo dos menus)
     ========================================================================= */

  var CSS = [
    '#gh-tut{position:absolute;inset:0;z-index:40;pointer-events:none;overflow:hidden;color:#eef2ff;',
    'font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;',
    'transition:opacity .25s ease}',
    '#gh-tut.paused{opacity:0}',
    '#gh-tut *{box-sizing:border-box;margin:0;padding:0}',

    /* ---------------------------------------------------------------- card */
    '#gh-tut .tu-card{position:absolute;left:50%;top:12.5%;width:min(92vw,78vmin);text-align:center;',
    'padding:2.4vmin 3.2vmin 2.1vmin;border-radius:1.6vmin;opacity:0;',
    'transform:translate(-50%,-1.6vmin) scale(.97);',
    'transition:opacity .3s ease,transform .45s cubic-bezier(.2,1.25,.35,1);',
    'background:linear-gradient(158deg,rgba(19,24,44,.90) 0%,rgba(6,8,16,.94) 100%);',
    'border:1px solid rgba(255,255,255,.12);',
    'box-shadow:0 2.4vmin 6vmin rgba(0,0,0,.62),inset 0 1px 0 rgba(255,255,255,.08)}',
    '#gh-tut .tu-card::before{content:"";position:absolute;left:8%;right:8%;top:-1px;height:2px;',
    'background:linear-gradient(90deg,transparent,var(--gh-neon,#25e8ce),var(--gh-highway-edge,#ff3d8a),transparent)}',
    '#gh-tut.ph-card .tu-card{opacity:1;transform:translate(-50%,0) scale(1)}',

    '#gh-tut .tu-flash{display:inline-block;margin:0 0 1.5vmin;padding:.55vmin 1.7vmin;border-radius:99px;',
    'font-weight:800;font-size:clamp(11px,1.8vmin,19px);line-height:1.35}',
    '#gh-tut .tu-flash.ok{color:#c9f9de;background:rgba(57,224,138,.14);box-shadow:inset 0 0 0 1px rgba(57,224,138,.45)}',
    '#gh-tut .tu-flash.bad{color:#ffe3b0;background:rgba(255,160,60,.14);box-shadow:inset 0 0 0 1px rgba(255,170,70,.48);',
    'border-radius:1.4vmin}',
    '#gh-tut .tu-flash .tu-why{display:block;margin-top:.5vmin;font-weight:700;color:#fff1d6}',
    '#gh-tut .tu-flash .tu-k{font-size:.86em;height:1.6em;min-width:1.8em;margin:0 .1em;vertical-align:.04em}',

    '#gh-tut .tu-kick{font-weight:800;letter-spacing:.42em;text-transform:uppercase;',
    'font-size:clamp(9px,1.35vmin,15px);color:var(--gh-neon,#25e8ce)}',
    '#gh-tut .tu-title{margin-top:.7vmin;font-family:"Segoe UI Black","Arial Black",Impact,sans-serif;',
    'font-weight:900;font-style:italic;text-transform:uppercase;font-size:clamp(20px,4.6vmin,52px);',
    'line-height:1.02;letter-spacing:.01em;padding:0 .1em;',
    'background:linear-gradient(178deg,#fff4d8 8%,#ffcf4a 46%,#ff6a1e 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 .35vmin 0 rgba(0,0,0,.6))}',
    '#gh-tut .tu-body{margin:1.5vmin auto 0;max-width:66vmin;font-size:clamp(12px,2.1vmin,23px);',
    'line-height:1.55;color:#dfe5fa}',
    '#gh-tut .tu-body b{color:#fff;font-weight:800}',
    '#gh-tut .tu-sp{color:var(--gh-sp,#8fd8ff) !important;text-shadow:0 0 1.2vmin rgba(143,216,255,.7)}',

    '#gh-tut .tu-task{margin-top:2vmin;display:flex;align-items:center;justify-content:center;',
    'gap:1vmin;flex-wrap:wrap;font-size:clamp(14px,2.8vmin,30px)}',
    '#gh-tut .tu-task i{font-style:normal;font-weight:900;color:var(--gh-gold,#ffcf4a);margin:0 .3vmin;',
    'font-size:.82em;letter-spacing:.02em}',

    /* tecla: um keycap de verdade, com a "altura" na sombra de baixo */
    '#gh-tut .tu-k{display:inline-flex;align-items:center;justify-content:center;position:relative;',
    'min-width:2.3em;height:2.1em;padding:0 .55em;border-radius:.42em;font:inherit;font-weight:900;',
    'font-style:normal;line-height:1;color:var(--lc,#f2f5ff);',
    'background:linear-gradient(180deg,#2d3456 0%,#161b2e 100%);',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 .26em 0 rgba(0,0,0,.6),0 0 0 1px var(--lb,rgba(255,255,255,.2));',
    'transition:transform .08s ease,background .15s ease,color .15s ease}',
    '#gh-tut .tu-body .tu-k{font-size:.86em;height:1.75em;min-width:1.95em;margin:0 .12em;vertical-align:.06em}',
    '#gh-tut .tu-k.cur{animation:tu-pop 1.05s ease-in-out infinite;',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 .26em 0 rgba(0,0,0,.6),0 0 0 2px var(--lc,#fff),0 0 2.2vmin var(--lc,#fff)}',
    '#gh-tut .tu-k.down,#gh-tut .tu-k.tap{transform:translateY(.2em);',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 .06em 0 rgba(0,0,0,.6),0 0 0 2px var(--lc,#fff)}',
    '#gh-tut .tu-k.ok{background:var(--lc,#fff);color:#0b0e18;animation:none}',
    '#gh-tut .tu-k.ok::after{content:"\\2713";position:absolute;right:-.45em;top:-.55em;width:1.15em;height:1.15em;',
    'border-radius:50%;background:#0b0e18;color:var(--lc,#fff);font-size:.62em;line-height:1.15em;',
    'box-shadow:0 0 0 2px var(--lc,#fff)}',
    /* depois de .cur: a tecla esperada e justamente a que balanca */
    '#gh-tut .tu-k.nope{animation:tu-nope .32s ease}',

    '#gh-tut .tu-dots{display:flex;gap:1.1vmin;margin-left:1.2vmin}',
    '#gh-tut .tu-dot{width:2vmin;height:2vmin;border-radius:50%;border:2px solid rgba(255,255,255,.32);',
    'transition:background .15s ease,box-shadow .15s ease}',
    '#gh-tut .tu-dot.on{background:var(--gh-gold,#ffcf4a);border-color:var(--gh-gold,#ffcf4a);',
    'box-shadow:0 0 1.4vmin var(--gh-gold,#ffcf4a)}',

    /* desenhos das notas especiais */
    '#gh-tut .tu-open{display:inline-block;width:7.5em;height:.72em;border-radius:.3em;',
    'box-shadow:0 0 1.6vmin rgba(255,255,255,.35),inset 0 1px 0 rgba(255,255,255,.5)}',
    '#gh-tut .tu-tail{display:inline-block;position:relative;width:5.4em;height:.9em}',
    '#gh-tut .tu-tail::before{content:"";position:absolute;left:.3em;right:0;top:.27em;height:.36em;border-radius:.2em;',
    'background:linear-gradient(90deg,var(--lc,#39e08a),transparent)}',
    '#gh-tut .tu-tail::after{content:"";position:absolute;left:0;top:0;width:1.5em;height:.9em;border-radius:50%;',
    'background:var(--lc,#39e08a);box-shadow:0 0 1.2vmin var(--lc,#39e08a)}',
    '#gh-tut .tu-spgem{display:inline-block;width:1.5em;height:.9em;border-radius:50%;',
    'background:radial-gradient(circle at 50% 40%,#f2fbff 0%,var(--gh-sp,#8fd8ff) 60%,#3a7fb0 100%);',
    'box-shadow:0 0 1.5vmin var(--gh-sp,#8fd8ff)}',

    '#gh-tut .tu-tips{margin:1.7vmin auto 0;max-width:64vmin;text-align:left;list-style:none;display:grid;gap:1vmin}',
    '#gh-tut .tu-tips li{position:relative;padding-left:2.6vmin;font-size:clamp(11px,1.9vmin,21px);',
    'line-height:1.42;color:#dfe5fa}',
    '#gh-tut .tu-tips li b{color:#fff}',
    '#gh-tut .tu-tips li::before{content:"";position:absolute;left:.4vmin;top:.5em;width:.95vmin;height:.95vmin;',
    'transform:rotate(45deg);background:linear-gradient(135deg,var(--gh-gold,#ffcf4a),var(--gh-ui-accent,#ff3d8a))}',

    /* dica viva da licao das duas maos; a altura minima segura o layout */
    '#gh-tut .tu-tip{min-height:1.5em;margin-top:1.4vmin;font-weight:700;color:#ffd58a;',
    'font-size:clamp(11px,1.8vmin,19px);line-height:1.5}',
    '#gh-tut .tu-tip .tu-k{font-size:.86em;height:1.6em;min-width:1.8em;margin:0 .1em;vertical-align:.04em}',
    '#gh-tut .tu-goal{margin-top:1.8vmin;font-size:clamp(9px,1.45vmin,16px);letter-spacing:.2em;',
    'text-transform:uppercase;font-weight:800;color:var(--gh-textDim,#95a0c0)}',
    '#gh-tut .tu-go{margin-top:1.7vmin;font-weight:800;font-size:clamp(12px,2.1vmin,23px);color:#fff;',
    'animation:tu-blink 1.5s ease-in-out infinite}',
    '#gh-tut .tu-go .tu-k{font-size:.9em;height:1.8em;margin:0 .15em}',
    '#gh-tut .tu-esc{margin-top:1.3vmin;font-size:clamp(8px,1.15vmin,13px);letter-spacing:.16em;',
    'text-transform:uppercase;color:#5a6485;font-weight:700}',

    /* --------------------------------------------- faixa durante a licao */
    '#gh-tut .tu-bar{position:absolute;left:50%;top:10%;display:flex;align-items:center;gap:1.5vmin;',
    'padding:.85vmin 1vmin .85vmin 2vmin;border-radius:99px;white-space:nowrap;opacity:0;',
    'transform:translate(-50%,-1vmin);transition:opacity .3s ease,transform .35s ease;',
    'background:rgba(8,10,20,.80);border:1px solid rgba(255,255,255,.13);',
    'font-weight:700;font-size:clamp(11px,1.95vmin,21px);',
    'box-shadow:0 1vmin 3vmin rgba(0,0,0,.5)}',
    '#gh-tut.ph-play .tu-bar{opacity:1;transform:translate(-50%,0)}',
    '#gh-tut .tu-bar .tu-k{font-size:.9em;height:1.75em;margin:0 .12em}',
    '#gh-tut .tu-bar.hot{color:#fff4d8;box-shadow:0 0 0 2px var(--gh-gold,#ffcf4a),0 0 3vmin rgba(255,207,74,.55);',
    'animation:tu-pulse .7s ease-in-out infinite}',
    '#gh-tut .tu-bar.win{box-shadow:0 0 0 2px var(--gh-sp,#8fd8ff),0 0 3vmin rgba(143,216,255,.55)}',
    '#gh-tut .tu-count{padding:.35vmin 1.3vmin;border-radius:99px;background:rgba(255,255,255,.08);',
    'font-variant-numeric:tabular-nums;color:var(--gh-textDim,#95a0c0)}',
    '#gh-tut .tu-count b{color:#fff;font-size:1.12em}',
    '#gh-tut .tu-count.met{background:rgba(57,224,138,.18);color:#c9f9de}',

    '#gh-tut .tu-coach{position:absolute;left:50%;top:17.5%;max-width:80vw;padding:.8vmin 1.9vmin;',
    'border-radius:1vmin;text-align:center;opacity:0;transform:translate(-50%,-.8vmin);',
    'transition:opacity .25s ease,transform .3s ease;',
    'background:rgba(44,14,10,.84);border:1px solid rgba(255,140,90,.42);color:#ffe7d6;',
    'font-weight:700;font-size:clamp(11px,1.85vmin,20px);line-height:1.4}',
    '#gh-tut .tu-coach.good{background:rgba(8,40,24,.84);border-color:rgba(57,224,138,.45);color:#d4ffe6}',
    '#gh-tut .tu-coach.on{opacity:1;transform:translate(-50%,0)}',
    '#gh-tut .tu-coach .tu-k{font-size:.9em;height:1.7em;margin:0 .12em}',

    /* tu-pulse e da faixa (que ja vive em translate(-50%)); tu-pop e das teclas */
    '@keyframes tu-pulse{0%,100%{transform:translate(-50%,0) scale(1)}50%{transform:translate(-50%,0) scale(1.06)}}',
    '@keyframes tu-pop{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}',
    '@keyframes tu-nope{0%,100%{transform:translateX(0)}25%{transform:translateX(-.28em)}75%{transform:translateX(.28em)}}',
    '@keyframes tu-blink{0%,100%{opacity:1}50%{opacity:.45}}'
  ].join('');

  function build() {
    if (root) return;
    if (!document.getElementById('gh-tut-css')) {
      var st = document.createElement('style');
      st.id = 'gh-tut-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var ui = document.getElementById('gh-ui') || document.body;
    root = document.createElement('div');
    root.id = 'gh-tut';
    root.innerHTML = '<div class="tu-card"></div>' +
      '<div class="tu-bar"><span class="tu-hint"></span><span class="tu-count"></span></div>' +
      '<div class="tu-coach"></div>';
    ui.appendChild(root);
    N.card = root.querySelector('.tu-card');
    N.bar = root.querySelector('.tu-bar');
    N.hint = root.querySelector('.tu-hint');
    N.count = root.querySelector('.tu-count');
    N.coach = root.querySelector('.tu-coach');
  }

  function setPhase(p) {
    phase = p;
    if (root) root.className = 'ph-' + p;
  }

  /* --------------------------------------------------------------- card */
  function showCard() {
    var L = lessonAt(idx);
    var h = '';
    if (flash) h += '<p class="tu-flash ' + flash.kind + '">' + fmt(flash.html) + '</p>';
    h += '<p class="tu-kick">' + esc(L.kick || ('Lição ' + (idx + 1) + ' de ' + LESSONS.length)) + '</p>';
    h += '<h2 class="tu-title">' + esc(L.title) + '</h2>';
    if (L.body) h += '<p class="tu-body">' + fmt(L.body) + '</p>';
    if (L.tips) {
      h += '<ul class="tu-tips">';
      for (var i = 0; i < L.tips.length; i++) h += '<li>' + fmt(L.tips[i]) + '</li>';
      h += '</ul>';
    }

    if (L.kind === 'frets') {
      h += '<div class="tu-task">';
      for (var f = 0; f < 5; f++) h += fmt('{f' + f + '}');
      h += '</div>';
    } else if (L.kind === 'strum' || L.kind === 'combo') {
      h += '<div class="tu-task">' + fmt(L.kind === 'combo' ? '{f0}<i>+</i>{strum}' : '{strum}') +
           '<span class="tu-dots">';
      for (var d = 0; d < L.need; d++) h += '<span class="tu-dot"></span>';
      h += '</span></div>';
      if (L.kind === 'combo') h += '<p class="tu-tip"></p>';
    } else if (L.task) {
      h += '<div class="tu-task">' + fmt(L.task) + '</div>';
    }

    if (L.kind === 'song') {
      h += '<p class="tu-goal">' + esc(L.goal || ('Meta: acerte ' + L.need + ' de ' + groupCount(L))) + '</p>';
      h += '<p class="tu-go">' + fmt('Palhete {strum} para começar') + '</p>';
    } else if (L.kind === 'done') {
      h += '<p class="tu-go">' + fmt(L.go) + '</p>';
    } else {
      h += '<p class="tu-goal">' + esc(L.goal) + '</p>';
    }
    h += '<p class="tu-esc">' + esc(keyOf('pause')) + ' &middot; pausar ou sair do tutorial</p>';
    N.card.innerHTML = h;

    /* desenhos que dependem da paleta */
    var open = N.card.querySelectorAll('.tu-open');
    for (var o = 0; o < open.length; o++) {
      open[o].style.background = 'linear-gradient(90deg,' +
        [0, 1, 2, 3, 4].map(laneColor).join(',') + ')';
    }
    var tails = N.card.querySelectorAll('.tu-tail');
    for (var t = 0; t < tails.length; t++) tails[t].style.setProperty('--lc', laneColor(+tails[t].getAttribute('data-lane')));

    N.keys = N.card.querySelectorAll('.tu-task .tu-k');
    N.dots = N.card.querySelectorAll('.tu-dot');
    N.tip = N.card.querySelector('.tu-tip');
    step = 0;
    nextAt = -1;
    comboPendingAt = 0;
    /* a dica da licao que acabou ja esta no aviso do card; o balao sai */
    N.coach.className = 'tu-coach';
    coachUntil = -1;
    markStep();
    setPhase('card');
  }

  /* Pinta o progresso das licoes de teclado (teclas feitas / palhetadas). */
  function markStep() {
    var kind = lessonAt(idx).kind, i;
    if (kind === 'frets') {
      for (i = 0; i < N.keys.length; i++) {
        N.keys[i].classList.toggle('ok', i < step);
        N.keys[i].classList.toggle('cur', i === step);
      }
    } else if (kind === 'strum' || kind === 'combo') {
      for (i = 0; i < N.dots.length; i++) N.dots[i].classList.toggle('on', i < step);
    }
  }

  function tapKey(k) {
    if (!k) return;
    k.classList.add('tap');
    setTimeout(function () { k.classList.remove('tap'); }, 110);
  }

  function nudge(el) {
    if (!el) return;
    el.classList.remove('nope');
    void el.offsetWidth;          /* reinicia a animacao */
    el.classList.add('nope');
  }

  /* ---------------------------------------------------- faixa e treinador */
  function showBar() {
    var L = lessonAt(idx);
    N.bar.className = 'tu-bar';
    N.hint.innerHTML = fmt(L.hint || '');
    updateCount();
    N.coach.className = 'tu-coach';
    coachUntil = -1;
    setPhase('play');
  }

  function updateCount() {
    var L = lessonAt(idx);
    if (L.sp) {
      N.count.innerHTML = spOn ? '<b>2&times;</b> pontos'
        : ('frases <b>' + spPhrases + '</b>/2');
      N.count.className = 'tu-count' + (spOn ? ' met' : '');
      return;
    }
    N.count.innerHTML = 'acertos <b>' + hits + '</b>/' + L.need;
    N.count.className = 'tu-count' + (hits >= L.need ? ' met' : '');
  }

  function coach(html, good) {
    if (clock - coachAt < COACH_GAP) return;
    coachAt = clock;
    coachUntil = clock + COACH_LIFE;
    if (!good) lastTip = html;
    N.coach.innerHTML = fmt(html);
    N.coach.className = 'tu-coach on' + (good ? ' good' : '');
  }

  /* =========================================================================
     7. FLUXO
     ========================================================================= */

  function dress() {
    if (GH.Game && GH.Game.clearStage) GH.Game.clearStage(lessonSong(idx), DIFF);
  }

  function startLesson() {
    var L = lessonAt(idx);
    hits = 0; spPhrases = 0; spReady = false; spOn = false;
    heldIn.length = 0; watchLo = 0;
    lastTip = '';
    coachAt = -1e9;
    showBar();
    sfx('uiSelect');
    /* sem 3-2-1: o card ja foi a preparacao, a palhetada ja foi o "vai" */
    GH.Game.startSong(lessonSong(idx), DIFF, { countdown: false });
  }

  /* Ataques acertados no chart carregado (antes de o palco ser limpo). */
  function measure() {
    var C = GH.Chart, S = GH.Scoring, total = 0, ok = 0;
    if (C && C.groups && S && typeof S.groupResult === 'function') {
      for (var i = 0; i < C.groups.length; i++) {
        total++;
        var r = S.groupResult(i);
        if (r === 'perfect' || r === 'good') ok++;
      }
    }
    return { total: total, hit: ok };
  }

  function finishLesson() {
    var L = lessonAt(idx);
    var m = measure();
    var pass = L.sp ? spOn : (m.hit >= L.need);
    if (pass) {
      flash = { kind: 'ok', html: L.sp ? '&#10003; Star Power ativado — pontos em dobro!'
        : ('&#10003; Mandou bem! ' + m.hit + ' de ' + m.total + '.') };
      idx++;
      sfx('crowdCheer', 0.7);
    } else {
      var why = L.sp
        ? 'Faltou ativar o Star Power. Acerte <b>todas</b> as notas azuis e aperte {sp} com o medidor pela metade.'
        : (m.hit ? ('Quase! ' + m.hit + ' de ' + m.total + ' — a meta é ' + L.need + '. Bora de novo!')
                 : 'Nenhuma nota dessa vez — bora de novo!');
      if (lastTip && !L.sp) why += '<span class="tu-why">Dica: ' + lastTip + '</span>';
      flash = { kind: 'bad', html: why };
    }
    dress();
    showCard();
  }

  function completeKeyboardLesson() {
    nextAt = clock + NEXT_DELAY;
    sfx('uiSelect');
    mcall('Highway', 'pulse', 1.1);
  }

  /* ---------------------------------------- licao "as duas maos juntas" */
  /* Palhetada que chegou um triz ANTES da tecla: quem aperta as duas "juntas"
     quase nunca acerta o mesmo milissegundo. O proprio jogo da 60 ms de folga
     (GH.Input); aqui 90 ms, para o iniciante nao ser punido por isso. */
  var COMBO_GRACE_MS = 90;
  var comboPendingAt = 0;

  function comboHit() {
    comboPendingAt = 0;
    step++;
    markStep();
    tapKey(N.keys[1]);
    mcall('FX', 'hit', 0, 'perfect');
    sfx('hit', 0, 'perfect');
    if (N.tip) N.tip.innerHTML = step < 3 ? fmt('Isso! Mais ' + (3 - step) + (3 - step === 1 ? ' vez' : ' vezes') + ', sem errar.') : '';
    if (step >= lessonAt(idx).need) completeKeyboardLesson();
  }

  function comboMiss() {
    comboPendingAt = 0;
    var held = heldMask();
    var restart = step > 0;
    step = 0;
    markStep();
    nudge(N.keys[0]);
    sfx('uiBack');
    var why = held === 0 ? 'Faltou segurar {f0}! Segure e, sem soltar, palhete {strum}.'
            : (held & 1) ? 'Segure só o {f0} — solte as outras teclas.'
            : 'Essa não é a tecla verde: segure {f0} e palhete {strum}.';
    if (N.tip) N.tip.innerHTML = fmt(why + (restart ? ' A contagem recomeçou: tem que ser 3 seguidas.' : ''));
  }

  /* ------------------------------------------------------- entrada */
  function onFretDown(lane) {
    if (!active || phase !== 'card' || nextAt >= 0) return;
    var kind = lessonAt(idx).kind;
    if (kind === 'combo') {
      if (lane === 0 && comboPendingAt && performance.now() - comboPendingAt <= COMBO_GRACE_MS &&
          heldMask() === 1) comboHit();
      return;
    }
    if (kind !== 'frets') return;
    if (lane !== step) { nudge(N.keys[step]); return; }
    mcall('FX', 'hit', lane, 'perfect');
    sfx('uiMove');
    step++;
    markStep();
    if (step >= 5) completeKeyboardLesson();
  }

  function onStrum(t, info) {
    if (!active || phase !== 'card' || nextAt >= 0) return;
    if (info && info.buffered) return;
    if (!GH.Game || GH.Game.state !== 'playing') return;
    var L = lessonAt(idx);
    if (L.kind === 'combo') {
      tapKey(N.keys[1]);
      if (heldMask() === 1) { comboHit(); return; }
      /* sem a tecla (ainda): espera a folga antes de chamar de erro */
      var at = comboPendingAt = performance.now();
      setTimeout(function () {
        if (active && comboPendingAt === at && lessonAt(idx).kind === 'combo') comboMiss();
      }, COMBO_GRACE_MS + 10);
      return;
    }
    if (L.kind === 'strum') {
      tapKey(N.keys[0]);
      mcall('Highway', 'pulse', 0.8);
      sfx('uiMove');
      step++;
      markStep();
      if (step >= L.need) completeKeyboardLesson();
    } else if (L.kind === 'song') {
      /* a palhetada que comeca a licao nao pode ser reaproveitada pelo
         buffer do GH.Input como palhetada da musica */
      mcall('Input', 'consumeStrum');
      startLesson();
    } else if (L.kind === 'done') {
      /* Sai no PROXIMO quadro. Saindo daqui, o resto desta mesma tecla ja
         cairia no menu: Enter e palhetada E confirmar, e confirmaria a
         primeira musica da selecao. */
      mcall('Input', 'consumeStrum');
      sfx('uiSelect');
      leaving = true;
    }
  }

  /* ------------------------------------------ o treinador ve cada evento */
  function heldMask() {
    return (GH.Input && typeof GH.Input.fretMask === 'number') ? GH.Input.fretMask : 0;
  }

  /* Acumula os trastes segurados enquanto cada ataque esta na janela. Na
     hora em que o erro chega (fim da janela) o jogador ja pode ter soltado
     a tecla — e "faltou palhetar" so da para dizer olhando a janela toda. */
  function watchFrets(songTime) {
    var C = GH.Chart;
    if (!C || !C.groups) return;
    var held = heldMask();
    for (var i = watchLo; i < C.groups.length; i++) {
      var g = C.groups[i];
      if (g.t - 0.12 > songTime) break;
      if (songTime > g.t + 0.12) { if (i === watchLo) watchLo++; continue; }
      heldIn[i] = (heldIn[i] || 0) | held;
    }
  }

  function nearGroup(t) {
    var C = GH.Chart, S = GH.Scoring;
    if (!C || !C.groups) return null;
    for (var i = 0; i < C.groups.length; i++) {
      var g = C.groups[i];
      if (Math.abs(g.t - t) < 0.3 && !(S && S.groupJudged && S.groupJudged(i))) return g;
    }
    return null;
  }

  function keysOf(lanes) {
    var out = '';
    for (var i = 0; i < lanes.length; i++) out += (i ? ' + ' : '') + '{f' + lanes[i] + '}';
    return out;
  }

  function onScoring(e) {
    if (!active || phase !== 'play' || !e) return;
    var L = lessonAt(idx);
    var lanes = e.lanes || [];
    var held = heldMask();
    var want = 0, i;
    for (i = 0; i < lanes.length; i++) want |= 1 << lanes[i];

    if (e.type === 'hit') {
      hits++;
      updateCount();
      if (hits === 1 && L.firstNote) coach('Isso! É assim que se toca.', true);
      return;
    }

    if (e.type === 'miss' && e.reason === 'overstrum') {
      var g = nearGroup(e.noteTime !== undefined ? e.noteTime : e.time);
      if (!g) { coach('Palhetada à toa! Palhete só quando a nota chegar na linha.'); return; }
      var right = g.open ? held === 0 : (held & g.mask) === g.mask;
      if (right) coach('Cedo demais! Palhete na hora em que a nota encostar na linha.');
      else if (g.open) coach('Solte os trastes! No bastão é só palhetar {strum}.');
      else if (g.size > 1) coach('Acorde: segure ' + keysOf(g.lanes) + ' juntas e palhete uma vez.');
      else coach('Tecla errada! Essa nota é ' + LANE_NAMES[g.lanes[0]] + ': segure ' + keysOf(g.lanes) + '.');
      return;
    }

    if (e.type === 'miss') {
      var had = held | (e.groupIdx >= 0 ? (heldIn[e.groupIdx] || 0) : 0);
      if (e.open) coach(had ? 'Solte os trastes! No bastão é só palhetar {strum}.'
                            : 'Palhete {strum} quando o bastão passar na linha.');
      else if (want && (had & want) === want) coach('Faltou palhetar! Aperte {strum} quando a nota encostar na linha.');
      else if (lanes.length > 1) coach('Acorde: segure ' + keysOf(lanes) + ' juntas e palhete uma vez.');
      else if (lanes.length) coach('Segure ' + keysOf(lanes) + ' (' + LANE_NAMES[lanes[0]] + ') e palhete {strum}.');
      return;
    }

    if (e.type === 'sustainEnd' && !e.completed && lanes.length) {
      coach('Segure a tecla até o rabo da nota acabar!');
      return;
    }

    if (e.type === 'sp' && L.sp) {
      if (e.action === 'phrase') { spPhrases++; updateCount(); coach('Frase completa! O medidor encheu um pouco.', true); }
      else if (e.action === 'phraseLost') coach('Errou uma nota azul: essa frase não enche o medidor.');
      else if (e.action === 'ready' && !spOn) {
        spReady = true;
        N.hint.innerHTML = fmt('AGORA! Aperte {sp}');
        N.bar.className = 'tu-bar hot';
      } else if (e.action === 'start') {
        spOn = true;
        N.hint.innerHTML = fmt('Star Power! Pontos em dobro');
        N.bar.className = 'tu-bar win';
        updateCount();
      }
    }
  }

  function onState(ev) {
    if (!active || !root || !ev) return;
    root.classList.toggle('paused', ev.state === 'paused');
    /* voltou da pausa no meio de um card: as teclas podem ter mudado nas
       configuracoes, entao o card se redesenha com as atuais — sem perder
       o que o jogador ja fez na licao de teclado */
    if (ev.prev === 'paused' && ev.state === 'playing' && phase === 'card' && nextAt < 0) {
      var done = step;
      showCard();
      step = done;
      markStep();
    }
  }

  /* =========================================================================
     8. API PUBLICA (o GH.Game chama)
     ========================================================================= */

  function subscribe() {
    var I = GH.Input, G = GH.Game;
    if (I && I.onFretDown) { I.onFretDown(onFretDown); unsub.push(function () { I.offFretDown(onFretDown); }); }
    if (I && I.onStrum) { I.onStrum(onStrum); unsub.push(function () { I.offStrum(onStrum); }); }
    if (G && G.on) { unsub.push(G.on('scoring', onScoring)); unsub.push(G.on('state', onState)); }
  }

  GH.Tutorial = {
    lessons: LESSONS,
    /* a musica de uma licao (ferramentas conferem melodia e harmonia) */
    songFor: function (i) { return lessonSong(i); },

    begin: function () {
      if (!GH.Songs || typeof GH.Songs.compose !== 'function') return false;
      build();
      if (!active) subscribe();
      active = true;
      idx = 0;
      flash = null;
      clock = 0;
      leaving = false;
      root.className = '';
      dress();
      showCard();
      return true;
    },

    update: function (dt, songTime) {
      if (!active) return;
      clock += (dt > 0 ? dt : 0);

      if (leaving) { leaving = false; GH.Game.leaveTutorial('songselect'); return; }

      if (phase === 'card') {
        /* o card e silencioso: se a pausa retomou o maestro, ele para */
        if (GH.Conductor && GH.Conductor.isPlaying) mcall('Conductor', 'stop');
        var L = lessonAt(idx);
        if (L.kind === 'frets' && N.keys) {
          for (var i = 0; i < N.keys.length; i++) {
            N.keys[i].classList.toggle('down', !!(GH.Input && GH.Input.isFret && GH.Input.isFret(i)));
          }
        } else if (L.kind === 'combo' && N.keys && N.keys[0]) {
          /* a tecla verde afunda enquanto esta segurada: o jogador VE que
             esta segurando na hora de palhetar */
          N.keys[0].classList.toggle('down', !!(GH.Input && GH.Input.isFret && GH.Input.isFret(0)));
        }
        if (nextAt >= 0 && clock >= nextAt) {
          flash = { kind: 'ok', html: '&#10003; ' + L.done };
          idx++;
          dress();
          showCard();
        }
        return;
      }

      /* play */
      watchFrets(songTime);
      if (coachUntil > 0 && clock >= coachUntil) { coachUntil = -1; N.coach.className = 'tu-coach'; }
      var song = lessonSong(idx);
      if (GH.Game && GH.Game.state === 'playing' && songTime >= song.lessonEnd) finishLesson();
    },

    /* "Recomecar" da pausa (ou R): refaz a licao corrente desde o card */
    restartLesson: function () {
      if (!active) return;
      flash = null;
      dress();
      showCard();
    },

    end: function () {
      if (!active) return;
      active = false;
      for (var i = 0; i < unsub.length; i++) { try { unsub[i](); } catch (e) { /* ok */ } }
      unsub.length = 0;
      if (root) root.className = 'paused';
      setTimeout(function () { if (!active && root) { N.card.innerHTML = ''; root.className = ''; } }, 300);
    },

    get active() { return active; },
    get lesson() { return idx; },
    get phase() { return phase; },
    debug: function () {
      return { active: active, lesson: idx, phase: phase, step: step, hits: hits,
               spPhrases: spPhrases, spReady: spReady, spOn: spOn };
    }
  };

})(window.GH = window.GH || {});

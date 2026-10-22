/* ===========================================================================
   GUITARRADA HERO — src/gameplay/game.js
   GH.Game: a maquina de estados e o BARRAMENTO DE FEEDBACK do jogo inteiro.

   Responsabilidades (contrato, secao 6 e 7 do ARCHITECTURE.md):
     1. Maquina de estados
        boot -> title -> songselect -> difficulty -> countdown -> playing
             -> (paused) -> results -> title,  mais credits e settings.
     2. Ciclo de vida de uma musica: Chart.load, Scoring.reset, Conductor.load/
        start, Synth.prepare, Highway/Notes/FX/Stage/HUD reset+show.
     3. Roteamento de GH.Scoring.onEvent para GH.FX, GH.HUD, GH.Stage,
        GH.Synth, GH.Audio.sfx e GH.Engine — cada acerto vira luz, particula,
        som, tremor, numero flutuante e reacao do publico.
     4. Roteamento de GH.Conductor.onBeat/onBar/onSection para GH.Stage e
        GH.Highway.
     5. GH.Input -> julgamento, star power, pausa e navegacao de menu.
     6. forceState(cfg) — monta um estado arbitrario para o MODO CAPTURA.
     7. Tutorial — empresta o palco ao GH.Tutorial (secao 8B).

   REGRA DE OURO: tudo que sai deste modulo passa por mcall(), que e uma
   chamada com guarda. Nenhum modulo ausente ou quebrado pode derrubar o jogo
   ou deixar a tela preta. Enquanto os outros agentes trabalham, metade do
   GH nao existe — e o jogo tem que continuar rodando.

   QUEM CHAMA update() DOS MODULOS VISUAIS:
   este arquivo. GH.Game roda como updater do Engine e chama, na ordem certa:
       Conductor -> Scoring -> Stage -> Highway -> Notes -> FX -> HUD
   com (dt, songTime). Se um modulo visual preferir se registrar sozinho no
   Engine, basta expor `selfDriven = true` que o Game respeita e nao chama.
   =========================================================================== */

(function (GH) {
  'use strict';

  /* =========================================================================
     1. CONSTANTES
     ========================================================================= */

  var STATES = ['boot', 'title', 'songselect', 'difficulty', 'countdown',
                'playing', 'paused', 'results', 'credits', 'settings'];
  var IS_STATE = {};
  (function () { for (var i = 0; i < STATES.length; i++) IS_STATE[STATES[i]] = true; })();

  var DIFFICULTIES = ['facil', 'medio', 'puxado', 'dificil', 'guitarrada'];

  /* Batidas de contagem regressiva antes da musica (visual + som). */
  var COUNTDOWN_BEATS = 3;
  /* Folga extra alem do lookahead da pista, para as primeiras notas entrarem
     por cima da borda do fundo em vez de aparecerem do nada. */
  var LEADIN_PAD = 0.55;
  /* Tempo de "wash" de transicao entre estados (fade multiplicativo). */
  var TRANSITION_SEC = 0.34;
  /* Quanto tempo a chama de um traste continua acesa depois do ultimo acerto. */
  var FLAME_HOLD = 0.34;
  /* Silencio depois do fim das notas antes de abrir a tela de resultados. */
  var OUTRO_SEC = 2.2;

  /* Modulos visuais que o Game conduz por frame (na ordem de desenho). */
  var DRIVEN = [
    { name: 'Stage',   needsTime: true },
    { name: 'Highway', needsTime: true },
    { name: 'Notes',   needsTime: true },
    { name: 'FX',      needsTime: false },
    { name: 'HUD',     needsTime: false }
  ];

  /* =========================================================================
     2. ESTADO PRIVADO
     ========================================================================= */

  var inited = false;
  var capture = false;              /* modo captura: sem audio, sem input */
  var state = 'boot';
  var prevState = 'boot';
  var stateTime = 0;                /* segundos dentro do estado atual */
  var transition = 0;               /* 0..1, decai; alimenta Engine.setFade */

  var song = null;
  var difficulty = 'medio';
  var stats = null;

  var songTime = 0;                 /* espelho de GH.Conductor.time */
  var leadIn = 0;                   /* quanto tempo antes do 0 comecamos */
  var countdownShown = -1;          /* ultimo numero de contagem exibido */
  var finishAt = -1;                /* quando abrir a tela de resultados */
  var running = false;              /* ha uma musica montada */

  /* Tutorial: o GH.Tutorial conduz as licoes e o Game empresta o palco.
     Guardamos a escolha do jogador para devolve-la quando o tutorial acabar
     (as licoes passam por prepareSong e trocariam a musica do menu). */
  var tutorial = false;
  var tutorialReturn = null;

  /* Chamas por traste (o "combo fire" do Guitar Hero). */
  var flameUntil = [0, 0, 0, 0, 0];
  var flameOn = [false, false, false, false, false];

  /* Energia do show — sobe com acertos, cai com erros. Vai para o palco. */
  var energy = 0.45;
  var energyTarget = 0.45;
  var lastSectionIntensity = 0.5;

  /* Ouvintes externos (HUD/Menus podem observar o jogo). */
  var listeners = {};

  /* Cancelamentos das inscricoes no Conductor. */
  var unhookBeat = null, unhookBar = null, unhookSection = null;

  /* Modo captura: roteiro de eventos agendados. */
  var capScript = [];
  var capAuto = false;              /* o bot interno esta tocando? */
  var capAccuracy = 1;
  var capUseSp = false;
  var capMissFrom = 1e9;            /* a partir daqui, erra de proposito */

  /* Diagnostico (nunca quebra, nunca vaza para a UI). */
  var log = [];
  var warnCount = {};

  /* =========================================================================
     3. FERRAMENTAS DEFENSIVAS
     ========================================================================= */

  function warn(key, e) {
    var n = (warnCount[key] || 0) + 1;
    warnCount[key] = n;
    if (n > 3) return;
    var msg = 'GH.Game: ' + key + ' -> ' + (e && e.message ? e.message : e);
    log.push(msg);
    if (log.length > 200) log.shift();
    try { if (typeof console !== 'undefined' && console.warn) console.warn(msg); } catch (err) { /* nada */ }
  }

  /* Chamada com guarda para outro modulo. Devolve undefined se nao existir. */
  function mcall(modName, fnName, a, b, c, d) {
    var m = GH[modName];
    if (!m) return undefined;
    var f = m[fnName];
    if (typeof f !== 'function') return undefined;
    try { return f.call(m, a, b, c, d); } catch (e) { warn(modName + '.' + fnName, e); return undefined; }
  }

  function mhas(modName, fnName) {
    var m = GH[modName];
    return !!(m && typeof m[fnName] === 'function');
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function U() { return GH.Util || null; }
  function easeOutCubic(t) { var u = 1 - t; return 1 - u * u * u; }

  /* Cor de tema/paleta sem inventar hex solto. */
  function paletteHex(path, fallback) {
    try {
      var P = GH.Palette;
      if (!P) return fallback;
      if (path === 'danger') return P.ui && P.ui.hex ? P.ui.hex.danger : fallback;
      if (path === 'sp') return P.sp && P.sp.hex ? P.sp.hex.glow : fallback;
      if (path === 'spCore') return P.sp && P.sp.hex ? P.sp.hex.core : fallback;
      if (path === 'gold') return P.ui && P.ui.hex ? P.ui.hex.gold : fallback;
      if (path === 'success') return P.ui && P.ui.hex ? P.ui.hex.success : fallback;
      if (path === 'accent') return (P.current && P.current.hex) ? P.current.hex.accent : fallback;
      if (path === 'neon') return (P.current && P.current.hex) ? P.current.hex.neon : fallback;
    } catch (e) { /* cai no fallback */ }
    return fallback;
  }

  function laneColorHex(lane) {
    try {
      var P = GH.Palette;
      if (P && P.laneHex && P.laneHex[lane]) return P.laneHex[lane];
    } catch (e) { /* fallback abaixo */ }
    return paletteHex('accent', '#ffffff');
  }

  /* =========================================================================
     4. EVENTOS DO PROPRIO GAME (para HUD / Menus / ferramentas)
     ========================================================================= */

  function on(name, fn) {
    if (typeof fn !== 'function') return function () {};
    (listeners[name] = listeners[name] || []).push(fn);
    return function () { off(name, fn); };
  }
  function off(name, fn) {
    var l = listeners[name];
    if (!l) return;
    var i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  function emit(name, payload) {
    var l = listeners[name];
    if (!l) return;
    for (var i = 0; i < l.length; i++) {
      try { l[i](payload); } catch (e) { warn('listener:' + name, e); }
    }
  }

  /* =========================================================================
     5. DEFINICAO DOS ESTADOS
     Cada estado descreve o que a tela precisa ser. enter/exit sao opcionais.
     ========================================================================= */

  var DEF = {

    boot: {
      cam: 'title', camTime: 0, hud: false, menu: null,
      inputContext: 'menu', intensity: 0.20, showWorld: true
    },

    title: {
      cam: 'title', camTime: 1.3, hud: false, menu: 'showTitle',
      inputContext: 'menu', intensity: 0.42, showWorld: true,
      enter: function () {
        teardownSong(false);
        /* plateia de fundo sempre; quem cala e o volume da plateia */
        mcall('Audio', 'ambience', true, 0.5);
        mcall('FX', 'crowdReaction', 'idle');
      }
    },

    songselect: {
      cam: 'songselect', camTime: 0.9, hud: false, menu: 'showSongSelect',
      inputContext: 'menu', intensity: 0.5, showWorld: true
    },

    difficulty: {
      cam: 'difficulty', camTime: 0.7, hud: false, menu: 'showDifficulty',
      inputContext: 'menu', intensity: 0.55, showWorld: true,
      menuArg: function () { return song; }
    },

    countdown: {
      cam: 'countdown', camTime: 0.9, hud: true, menu: null,
      inputContext: 'game', intensity: 0.62, showWorld: true,
      enter: function () {
        countdownShown = -1;
        mcall('Audio', 'ambience', true, 0.75);
        mcall('FX', 'crowdReaction', 'anticipation');
        mcall('HUD', 'event', { type: 'countdown', count: COUNTDOWN_BEATS, phase: 'begin' });
      }
    },

    playing: {
      cam: 'gameplay', camTime: 0.75, hud: true, menu: null,
      inputContext: 'game', intensity: 0.75, showWorld: true,
      enter: function (opts) {
        /* quiet: comecou sem contagem — sem o "VAI!" e sem a festa da largada */
        if (!opts || (!opts.fromPause && !opts.quiet)) {
          mcall('HUD', 'event', { type: 'go' });
          sfx('uiSelect');
          sfx('crowdCheer', 0.85);
          mcall('Engine', 'bloomPulse', 0.34, 3.0);
          mcall('FX', 'crowdReaction', 'start');
        }
        mcall('Scoring', 'setPaused', false);
        mcall('Conductor', 'resume');
      }
    },

    paused: {
      cam: 'pause', camTime: 0.55, hud: true, menu: 'showPause',
      inputContext: 'menu', intensity: 0.30, showWorld: true,
      enter: function () {
        mcall('Conductor', 'pause');
        mcall('Scoring', 'setPaused', true);
        mcall('Synth', 'stopAll');
        allFlamesOff();
        mcall('Audio', 'duck', 'music', 0.35, 0.25);
      },
      exit: function () {
        mcall('Audio', 'duck', 'music', 1.0, 0.25);
      }
    },

    results: {
      cam: 'results', camTime: 1.5, hud: false, menu: 'showResults',
      inputContext: 'menu', intensity: 0.55, showWorld: true,
      menuArg: function () { return stats; },
      enter: function () {
        mcall('Conductor', 'pause');
        mcall('Scoring', 'setPaused', true);
        mcall('Synth', 'stopAll');
        allFlamesOff();
        mcall('Notes', 'reset');
        var failed = !!(stats && stats.failed);
        if (failed) {
          mcall('FX', 'crowdReaction', 'boo');
          sfx('fail');
          mcall('Engine', 'flash', paletteHex('danger', '#ff3b4e'), 0.55, 0.45);
        } else {
          var s = (stats && stats.starsDisplay) || 0;
          mcall('FX', 'crowdReaction', s >= 5 ? 'ecstatic' : 'cheer');
          sfx('crowdCheer', clamp01(0.5 + s * 0.1));
          mcall('Engine', 'flash', paletteHex('gold', '#ffcf4a'), 0.30, 0.7);
          mcall('Engine', 'bloomPulse', 0.5, 1.6);
        }
        /* Bloqueio de input: o jogador pode estar em desespero ainda apertando
           botoes quando a tela de resultados abre. Sem isso, um Enter ou seta
           pressionado na agonia final sai imediatamente para o titulo antes de
           a pessoa ver a pontuacao. Desabilitamos tudo por 1.2s e reabilitamos
           so depois que a animacao de entrada ja assentou. */
        if (!capture) {
          mcall('Input', 'setEnabled', false);
          var self = this;
          setTimeout(function () {
            try { mcall('Input', 'setEnabled', true); } catch (e) { /* ok */ }
          }, 1200);
        }
      }
    },

    credits: {
      cam: 'title', camTime: 1.4, hud: false, menu: 'showCredits',
      inputContext: 'menu', intensity: 0.35, showWorld: true
    },

    settings: {
      cam: 'songselect', camTime: 0.7, hud: false, menu: 'showSettings',
      inputContext: 'menu', intensity: 0.35, showWorld: true
    }
  };

  /* =========================================================================
     6. ATALHOS DE AUDIO
     ========================================================================= */

  function sfx(name, a, b, c) {
    var A = GH.Audio;
    if (!A || !A.sfx || typeof A.sfx[name] !== 'function') return;
    try { A.sfx[name](a, b, c); } catch (e) { warn('Audio.sfx.' + name, e); }
  }

  /* Altura da melodia na nota acertada (-1 se o chart nao traz): o som do
     acerto toca ESSA nota, e nao a afinacao fixa da raia. */
  function noteMidi(idx) {
    var C = GH.Chart;
    var n = (C && C.notes && idx >= 0) ? C.notes[idx] : null;
    return (n && n.midi > 0) ? n.midi : -1;
  }

  /* =========================================================================
     7. TRANSICAO DE ESTADO
     ========================================================================= */

  function applyStateVisuals(def, opts) {
    /* camera */
    if (def.cam) mcall('Engine', 'camPreset', def.cam, capture ? 0 : def.camTime);

    /* HUD */
    if (def.hud) { mcall('HUD', 'show'); } else { mcall('HUD', 'hide'); }

    /* menus: escondemos tudo e abrimos so o da vez */
    mcall('Menus', 'hideAll');
    if (def.menu) {
      var arg = def.menuArg ? def.menuArg() : undefined;
      if (mhas('Menus', def.menu)) mcall('Menus', def.menu, arg);
    }

    /* intensidade base do palco/engine (o gameplay sobrescreve por frame) */
    var it = def.intensity;
    if (typeof it === 'number') {
      energyTarget = it;
      mcall('Engine', 'setIntensity', it);
      mcall('Stage', 'setIntensity', it);
    }

    /* contexto de input */
    if (!capture) mcall('Input', 'setContext', def.inputContext || 'menu');

    if (def.enter) {
      try { def.enter(opts || null); } catch (e) { warn('enter:' + state, e); }
    }
  }

  function setState(next, opts) {
    if (!IS_STATE[next]) { warn('setState', 'estado invalido: ' + next); return state; }
    if (next === state && !(opts && opts.force)) return state;

    var oldDef = DEF[state];
    if (oldDef && oldDef.exit) {
      try { oldDef.exit(next); } catch (e) { warn('exit:' + state, e); }
    }

    /* Saiu do palco (pausa -> sair, fim do tutorial...): o tutorial acaba
       ANTES de a tela nova montar, para ela ja ver a musica do jogador. */
    if (tutorial && next !== 'playing' && next !== 'countdown' && next !== 'paused') endTutorial();

    prevState = state;
    state = next;
    stateTime = 0;
    transition = capture ? 0 : 1;      /* dispara o wash de transicao */
    GH.Game.state = state;
    GH.Game.prevState = prevState;

    applyStateVisuals(DEF[state] || DEF.title, opts);
    emit('state', { state: state, prev: prevState, opts: opts || null });
    return state;
  }

  /* =========================================================================
     8. CICLO DE VIDA DE UMA MUSICA
     ========================================================================= */

  function resolveSong(s) {
    var list = GH.Songs;
    if (!list || !list.length) return null;
    if (!s) return list[0];
    if (typeof s === 'string') {
      if (typeof list.byId === 'function') {
        var f = list.byId(s);
        if (f) return f;
      }
      for (var i = 0; i < list.length; i++) if (list[i].id === s) return list[i];
      return list[0];
    }
    if (typeof s === 'number') return list[clamp(s | 0, 0, list.length - 1)];
    return s;
  }

  function resolveDifficulty(d) {
    if (typeof d !== 'string') return difficulty;
    for (var i = 0; i < DIFFICULTIES.length; i++) if (DIFFICULTIES[i] === d) return d;
    return difficulty;
  }

  /* Prepara TUDO para tocar `s` em `d`. Nao inicia o relogio. */
  function prepareSong(s, d) {
    song = resolveSong(s) || song;
    difficulty = resolveDifficulty(d);
    if (!song) { warn('prepareSong', 'nenhuma musica disponivel'); return false; }

    GH.Game.song = song;
    GH.Game.difficulty = difficulty;
    /* licao do tutorial nao vira "ultima musica tocada" */
    try {
      if (GH.Settings && !song.tutorial) {
        if (typeof GH.Settings.set === 'function') {
          GH.Settings.set('lastSongId', song.id);
          GH.Settings.set('lastDifficulty', difficulty);
        } else {
          GH.Settings.lastSongId = song.id;
          GH.Settings.lastDifficulty = difficulty;
          if (typeof GH.Settings.save === 'function') GH.Settings.save();
        }
      }
    } catch (e) { /* ok */ }

    /* tema cromatico da musica */
    if (song.palette) mcall('Palette', 'setTheme', song.palette);

    /* velocidade da pista vem das configuracoes do jogador */
    mcall('Chart', 'syncSettings');

    /* chart + placar */
    mcall('Chart', 'load', song, difficulty);
    mcall('Scoring', 'reset', difficulty);
    if (GH.Scoring) {
      GH.Scoring.autoPlay = false;
      /* no tutorial ninguem e vaiado: errar faz parte de aprender */
      GH.Scoring.noFail = !!song.tutorial;
    }

    /* audio */
    mcall('Synth', 'prepare', song);
    mcall('Conductor', 'load', song);

    /* visual */
    mcall('Highway', 'setTheme', song.palette || 'para');
    mcall('Stage', 'setTheme', song.palette || 'para');
    mcall('Highway', 'setStarPower', false);
    mcall('Notes', 'setStarPower', false);
    mcall('Stage', 'setStarPower', false);
    mcall('FX', 'starPower', false);
    mcall('Engine', 'setStarPower', false);
    mcall('Notes', 'reset');
    mcall('FX', 'reset');
    mcall('HUD', 'reset');
    mcall('HUD', 'setSong', song, difficulty);
    allFlamesOff();

    energy = energyTarget = 0.55;
    lastSectionIntensity = 0.5;
    finishAt = -1;
    running = true;
    GH.Game.running = true;

    /* lead-in: a pista precisa nascer cheia, nao "pipocar" notas */
    var spb = 0.5;
    try { spb = 60 / (mcall('Conductor', 'bpmAt', 0) || song.bpm || 120); } catch (e) { spb = 0.5; }
    var look = 3.3;
    try {
      if (mhas('Chart', 'lookaheadSec')) look = GH.Chart.lookaheadSec();
    } catch (e2) { look = 3.3; }
    leadIn = Math.max(COUNTDOWN_BEATS * spb + 0.25, look + LEADIN_PAD);
    GH.Game.leadIn = leadIn;
    return true;
  }

  /* Desmonta a musica corrente (voltar ao titulo). */
  function teardownSong(keepChart) {
    mcall('Conductor', 'stop');
    mcall('Synth', 'stopAll');
    mcall('Synth', 'setGuitarMuted', false);
    mcall('Synth', 'setStarPower', false);
    mcall('Scoring', 'setPaused', false);
    allFlamesOff();
    mcall('FX', 'starPower', false);
    mcall('FX', 'streakLevel', 0);
    mcall('FX', 'reset');
    mcall('Notes', 'reset');
    mcall('Highway', 'setStarPower', false);
    mcall('Notes', 'setStarPower', false);
    mcall('Stage', 'setStarPower', false);
    mcall('Engine', 'setStarPower', false);
    if (!keepChart) mcall('Chart', 'reset');
    running = false;
    GH.Game.running = false;
    finishAt = -1;
    songTime = 0;
    GH.Game.songTime = 0;
  }

  /* Comeca a partida: contagem regressiva e depois a musica.
     opts.countdown === false: sem 3-2-1 (as licoes do tutorial). O relogio
     comeca so com a folga que a primeira nota precisa para entrar pelo fundo
     da pista, e o jogo vai direto para 'playing'. */
  function startSong(s, d, opts) {
    if (!prepareSong(s, d)) return false;
    if (opts && opts.countdown === false) {
      var first = (GH.Chart && GH.Chart.stats) ? GH.Chart.stats.firstNoteTime : 0;
      var look = mcall('Chart', 'lookaheadSec') || 3.3;
      leadIn = Math.max(0.6, look + LEADIN_PAD - first);
      GH.Game.leadIn = leadIn;
      mcall('Conductor', 'start', -leadIn);
      mcall('Scoring', 'setPaused', false);
      setState('playing', { quiet: true });
      return true;
    }
    mcall('Conductor', 'start', -leadIn);
    mcall('Scoring', 'setPaused', false);
    setState('countdown');
    return true;
  }

  function restart() {
    /* no tutorial, recomecar e refazer a licao — com a explicacao na frente */
    if (tutorial) { mcall('Tutorial', 'restartLesson'); return true; }
    if (!song) return false;
    return startSong(song, difficulty);
  }

  function quit() {
    teardownSong(false);
    stats = null;
    GH.Game.stats = null;
    setState('title');
    return true;
  }

  /* Encerra a musica e abre os resultados.
     `Scoring.finish()` emite o evento 'finish', que volta para ca por
     routeFinish — o cadeado `finishing` corta a reentrada. */
  var finishing = false;
  function finishSong(failed) {
    if (finishing) return;
    if (!running && state === 'results') return;
    finishing = true;
    finishAt = -1;
    var st = mcall('Scoring', 'finish');
    if (!st) st = mcall('Scoring', 'getStats') || {};
    st.failed = !!failed || !!st.failed;
    st.song = song;
    st.songTitle = st.songTitle || (song && song.title) || '';
    st.songArtist = (song && song.artist) || '';
    st.songGenre = (song && song.genre) || '';
    st.tribute = (song && song.tribute) || '';
    st.difficulty = st.difficulty || difficulty;
    st.difficultyLabel = difficultyLabel(st.difficulty);
    stats = st;
    GH.Game.stats = st;
    running = false;
    GH.Game.running = false;
    setState('results');
    finishing = false;
  }

  function difficultyLabel(d) {
    try {
      if (GH.Songs && typeof GH.Songs.labelOf === 'function') return GH.Songs.labelOf(d);
    } catch (e) { /* fallback */ }
    return d;
  }

  /* =========================================================================
     8B. TUTORIAL
     O GH.Tutorial e dono das licoes; daqui ele so pega o palco emprestado:
       startTutorial()      titulo -> tutorial (o menu chama)
       clearStage(dress, d) palco sem musica entre uma licao e outra
       startSong(licao)     cada licao e uma musica curta, com contagem
       leaveTutorial(next)  fim: volta para o titulo ou para a selecao
     Enquanto `tutorial` estiver ligado, o fim da musica nao abre resultados —
     quem decide que a licao acabou e o GH.Tutorial.update().
     ========================================================================= */

  function startTutorial() {
    if (!mhas('Tutorial', 'begin')) { warn('startTutorial', 'GH.Tutorial ausente'); return false; }
    if (!tutorial) tutorialReturn = { song: song, difficulty: difficulty };
    tutorial = true;
    GH.Game.tutorial = true;
    stats = null;
    GH.Game.stats = null;
    mcall('Tutorial', 'begin');
    return true;
  }

  /* Palco sem musica: pista, HUD e banda de pe, mas sem notas e sem relogio.
     Sem chart o GH.Scoring nao julga nada — nem palhetada a toa —, entao o
     jogador aperta trastes e palheta a vontade enquanto le a licao. `dress`
     veste o palco (tema e HUD) com uma musica sem toca-la, na dificuldade `d`. */
  function clearStage(dress, d) {
    if (d) { difficulty = resolveDifficulty(d); GH.Game.difficulty = difficulty; }
    teardownSong(false);
    mcall('Chart', 'unload');
    mcall('Scoring', 'reset', difficulty);
    mcall('Conductor', 'load', null);
    if (dress) {
      if (dress.palette) {
        mcall('Palette', 'setTheme', dress.palette);
        mcall('Highway', 'setTheme', dress.palette);
        mcall('Stage', 'setTheme', dress.palette);
      }
      mcall('HUD', 'reset');
      mcall('HUD', 'setSong', dress, difficulty);
    }
    if (state !== 'playing') setState('playing', { fromPause: true });
    /* voltar ao 'playing' retoma o maestro; aqui o relogio fica parado */
    mcall('Conductor', 'stop');
  }

  function leaveTutorial(next) {
    /* o gancho de setState() encerra o tutorial */
    setState(next === 'songselect' ? 'songselect' : 'title');
  }

  function endTutorial() {
    if (!tutorial) return;
    tutorial = false;
    GH.Game.tutorial = false;
    mcall('Tutorial', 'end');
    teardownSong(false);
    if (GH.Scoring) GH.Scoring.noFail = false;
    var back = tutorialReturn;
    tutorialReturn = null;
    if (back && back.song) {
      song = back.song;
      difficulty = back.difficulty;
      GH.Game.song = song;
      GH.Game.difficulty = difficulty;
      if (song.palette) mcall('Palette', 'setTheme', song.palette);
    }
  }

  /* =========================================================================
     9. BARRAMENTO DE FEEDBACK — GH.Scoring.onEvent
     E aqui que o jogo ganha alma: cada evento vira luz, particula, som,
     tremor, numero flutuante e reacao do publico.
     ========================================================================= */

  function bumpEnergy(delta) {
    energyTarget = clamp01(energyTarget + delta);
  }

  function setFlame(lane, on) {
    if (lane < 0 || lane > 4) return;
    if (flameOn[lane] === on) return;
    flameOn[lane] = on;
    mcall('FX', 'flames', lane, on);
  }
  function allFlamesOff() {
    for (var i = 0; i < 5; i++) { flameUntil[i] = 0; setFlame(i, false); }
  }

  function currentMultiplier() {
    var S = GH.Scoring;
    return (S && S.multiplier) ? S.multiplier : 1;
  }

  /* ------------------------------ ACERTO ---------------------------------- */
  function routeHit(e) {
    var S = GH.Scoring;
    var mult = currentMultiplier();
    var perfect = (e.quality === 'perfect');
    var lanes = e.lanes && e.lanes.length ? e.lanes : (e.lane >= 0 ? [e.lane] : []);
    var i, ln;

    /* --- notas: apaga a gem, acende o rastro --- */
    if (e.noteIdxs && e.noteIdxs.length) {
      for (i = 0; i < e.noteIdxs.length; i++) mcall('Notes', 'onHit', e.noteIdxs[i], e.quality);
    } else if (e.noteIdx >= 0) {
      mcall('Notes', 'onHit', e.noteIdx, e.quality);
    }

    /* --- efeitos por raia: chama, faisca, onda de choque --- */
    if (e.open) {
      mcall('FX', 'openHit');
      for (i = 0; i < 5; i++) { mcall('FX', 'hit', i, e.quality); flameUntil[i] = songTime + FLAME_HOLD; }
      mcall('Engine', 'kick', 0.075);
    } else {
      for (i = 0; i < lanes.length; i++) {
        ln = lanes[i];
        mcall('FX', 'hit', ln, e.quality);
        flameUntil[ln] = songTime + FLAME_HOLD;
        mcall('Engine', 'punchLane', ln, perfect ? 0.030 : 0.020);
      }
    }

    /* chamas so a partir de 2x, como no Guitar Hero */
    if (mult >= 2 || (S && S.starPowerActive)) {
      for (i = 0; i < lanes.length; i++) setFlame(lanes[i], true);
      if (e.open) for (i = 0; i < 5; i++) setFlame(i, true);
    }

    /* --- pista: pulso na linha de acerto --- */
    var pulse = (perfect ? 0.85 : 0.55) * (e.chord ? 1.25 : 1) * (e.sp ? 1.2 : 1);
    mcall('Highway', 'pulse', clamp(pulse, 0, 1.6));

    /* --- camera + bloom --- */
    if (perfect) mcall('Engine', 'bloomPulse', 0.055 + 0.02 * Math.min(4, mult), 5.0);
    if (e.chord) mcall('Engine', 'kick', 0.030 + 0.006 * e.chordSize);

    /* --- som --- (a corda do acerto pode ser desligada nas Opcoes: sobra a
       dica de tempo, que fica bem mais facil de ouvir) */
    if (!(GH.Settings && GH.Settings.strumSfx === false)) {
      if (e.open) sfx('openHit', noteMidi(e.noteIdx));
      else sfx('hit', lanes.length ? lanes[0] : 0, e.quality, noteMidi(e.noteIdx));
    }
    /* dica de tempo: plim = perfeito, bip subindo = adiantou, bup descendo =
       atrasou. O bot do modo demo/captura nao precisa de aula. */
    if (e.source !== 'auto' && !(GH.Settings && GH.Settings.timingCues === false)) {
      sfx('judge', perfect ? 'perfect' : (e.deltaMs < 0 ? 'early' : 'late'), noteMidi(e.noteIdx));
    }

    /* --- guitarra volta a soar --- */
    mcall('Synth', 'setGuitarMuted', false);

    /* --- palco e publico --- */
    bumpEnergy(perfect ? 0.020 : 0.012);
    if (e.sp) mcall('FX', 'crowdReaction', 'phrase');

    /* --- HUD: numero flutuante, placar, medidores --- */
    mcall('HUD', 'event', e);
  }

  /* ------------------------------- ERRO ----------------------------------- */
  function routeMiss(e) {
    var i;
    var lanes = e.lanes && e.lanes.length ? e.lanes : (e.lane >= 0 ? [e.lane] : []);

    if (e.noteIdxs && e.noteIdxs.length) {
      for (i = 0; i < e.noteIdxs.length; i++) mcall('Notes', 'onMiss', e.noteIdxs[i]);
    } else if (e.noteIdx >= 0) {
      mcall('Notes', 'onMiss', e.noteIdx);
    }

    if (lanes.length) { for (i = 0; i < lanes.length; i++) mcall('FX', 'miss', lanes[i]); }
    else mcall('FX', 'miss', -1);

    allFlamesOff();
    mcall('FX', 'streakLevel', 0);

    /* guitarra emudece — a regra classica do genero */
    mcall('Synth', 'setGuitarMuted', true);

    /* tela: flash vermelho + tremor seco. A palhetada a toa doi menos que
       perder a nota, entao tem metade da intensidade e some mais rapido. */
    var red = paletteHex('danger', '#ff3b4e');
    var over = (e.reason === 'overstrum');
    mcall('Engine', 'flash', red, over ? 0.16 : 0.34, over ? 0.16 : 0.30);
    mcall('Engine', 'shake', over ? 0.18 : 0.36, 0.18);

    sfx('miss');
    bumpEnergy(-0.075);
    mcall('FX', 'crowdReaction', 'miss');
    mcall('HUD', 'event', e);
  }

  /* ---------------------------- SEQUENCIA --------------------------------- */
  function routeStreak(e) {
    mcall('FX', 'streakLevel', e.level || 0);
    if (e.up) {
      sfx('streakUp', e.level || 1);
      mcall('Engine', 'bloomPulse', 0.22 + 0.05 * (e.level || 1), 2.6);
      mcall('Engine', 'kick', 0.055);
      mcall('Highway', 'pulse', 1.1);
      mcall('FX', 'crowdReaction', 'streak');
      sfx('crowdCheer', clamp01(0.35 + 0.15 * (e.level || 1)));
      bumpEnergy(0.10);
      /* acende as chamas de todos os trastes que estao no combo */
      for (var i = 0; i < 5; i++) if (flameUntil[i] > songTime - 0.6) setFlame(i, true);
    } else {
      allFlamesOff();
      bumpEnergy(-0.05);
    }
    mcall('HUD', 'event', e);
  }

  /* ---------------------------- STAR POWER -------------------------------- */
  function routeSp(e) {
    var act = e.action;
    if (act === 'start') {
      mcall('FX', 'starPower', true);
      mcall('Notes', 'setStarPower', true);
      mcall('Highway', 'setStarPower', true);
      mcall('Stage', 'setStarPower', true);
      mcall('Engine', 'setStarPower', true);
      mcall('Synth', 'setStarPower', true);
      mcall('Engine', 'flash', paletteHex('spCore', '#f2fbff'), 0.45, 0.55);
      mcall('Engine', 'bloomPulse', 0.85, 1.4);
      mcall('Engine', 'shake', 0.5, 0.5);
      sfx('starPowerOn');
      sfx('crowdCheer', 1.0);
      mcall('FX', 'crowdReaction', 'starpower');
      bumpEnergy(0.35);
      for (var i = 0; i < 5; i++) setFlame(i, true);
    } else if (act === 'end') {
      mcall('FX', 'starPower', false);
      mcall('Notes', 'setStarPower', false);
      mcall('Highway', 'setStarPower', false);
      mcall('Stage', 'setStarPower', false);
      mcall('Engine', 'setStarPower', false);
      mcall('Synth', 'setStarPower', false);
      sfx('starPowerOff');
      mcall('Engine', 'bloomPulse', 0.3, 2.2);
      bumpEnergy(-0.12);
      allFlamesOff();
    } else if (act === 'ready') {
      mcall('Engine', 'bloomPulse', 0.2, 3.0);
      mcall('FX', 'crowdReaction', 'spready');
    } else if (act === 'phrase') {
      mcall('Engine', 'bloomPulse', 0.16, 3.5);
      mcall('Highway', 'pulse', 0.9);
      bumpEnergy(0.06);
    }
    mcall('HUD', 'event', e);
  }

  /* ------------------------------ SUSTAIN --------------------------------- */
  function routeSustain(e) {
    var lanes = e.lanes && e.lanes.length ? e.lanes : (e.lane >= 0 ? [e.lane] : []);
    for (var i = 0; i < lanes.length; i++) {
      if (e.active) { flameUntil[lanes[i]] = songTime + FLAME_HOLD; setFlame(lanes[i], true); }
    }
    if (e.active) {
      mcall('Highway', 'pulse', 0.30);
      if (e.sp) mcall('Engine', 'bloomPulse', 0.06, 6.0);
      bumpEnergy(0.004);
    }
    mcall('HUD', 'event', e);
  }

  function routeSustainEnd(e) {
    var lanes = e.lanes && e.lanes.length ? e.lanes : (e.lane >= 0 ? [e.lane] : []);
    for (var i = 0; i < lanes.length; i++) flameUntil[lanes[i]] = songTime + 0.12;
    if (e.completed) {
      for (var j = 0; j < lanes.length; j++) mcall('FX', 'hit', lanes[j], 'perfect');
      mcall('Engine', 'bloomPulse', 0.12, 4.0);
    }
    mcall('HUD', 'event', e);
  }

  /* ------------------------------ FRACASSO -------------------------------- */
  function routeFail(e) {
    allFlamesOff();
    mcall('FX', 'streakLevel', 0);
    mcall('FX', 'crowdReaction', 'boo');
    mcall('Synth', 'setGuitarMuted', true);
    mcall('Synth', 'stopAll');
    mcall('Engine', 'flash', paletteHex('danger', '#ff3b4e'), 0.85, 0.9);
    mcall('Engine', 'shake', 1.0, 0.9);
    sfx('fail');
    mcall('HUD', 'event', e);
    if (!capture) finishSong(true);
  }

  function routeFinish(e) {
    if (capture || finishing) return;
    if (state === 'results') return;
    finishSong(!!(e && e.stats && e.stats.failed));
  }

  function onScoringEvent(e) {
    if (!e || !e.type) return;
    try {
      switch (e.type) {
        case 'hit':        routeHit(e); break;
        case 'miss':       routeMiss(e); break;
        case 'streak':     routeStreak(e); break;
        case 'sp':         routeSp(e); break;
        case 'sustain':    routeSustain(e); break;
        case 'sustainEnd': routeSustainEnd(e); break;
        case 'fail':       routeFail(e); break;
        case 'finish':     routeFinish(e); break;
        default:           mcall('HUD', 'event', e); break;
      }
    } catch (err) { warn('onScoringEvent:' + e.type, err); }
    emit('scoring', e);
  }

  /* =========================================================================
     10. ROTEAMENTO DO CONDUCTOR (batida / compasso / secao)
     ========================================================================= */

  function onBeat(beatIndex, beatTime) {
    var strong = ((beatIndex | 0) % 4 === 0);
    mcall('Stage', 'beat', beatIndex, beatTime);
    mcall('Highway', 'pulse', strong ? 0.55 : 0.28);
    if (state === 'countdown') countdownTick(beatIndex);
    emit('beat', beatIndex);
  }

  function onBar(barIndex, barTime) {
    mcall('Stage', 'bar', barIndex, barTime);
    mcall('Highway', 'pulse', 0.42);
    emit('bar', barIndex);
  }

  function onSection(sec) {
    if (!sec) return;
    lastSectionIntensity = (typeof sec.intensity === 'number') ? clamp01(sec.intensity) : 0.6;
    mcall('HUD', 'event', { type: 'section', name: sec.name, index: sec.index, t: sec.t, section: sec });
    mcall('Stage', 'setIntensity', clamp01(lastSectionIntensity * 0.6 + energy * 0.4));
    mcall('FX', 'crowdReaction', 'section');
    emit('section', sec);
  }

  /* Contagem regressiva: 3, 2, 1 nas ultimas batidas antes do zero. */
  function countdownTick(beatIndex) {
    var n = Math.ceil(-songTime / Math.max(0.05, secondsPerBeat()));
    if (n < 1 || n > COUNTDOWN_BEATS) return;
    if (n === countdownShown) return;
    countdownShown = n;
    mcall('HUD', 'event', { type: 'countdown', count: n });
    sfx('uiMove');
    mcall('Engine', 'kick', 0.05);
    mcall('Highway', 'pulse', 0.7);
    mcall('FX', 'crowdReaction', 'countdown');
    emit('countdown', n);
  }

  function secondsPerBeat() {
    var C = GH.Conductor;
    if (C && typeof C.secondsPerBeat === 'number' && C.secondsPerBeat > 0) return C.secondsPerBeat;
    var bpm = (song && song.bpm) || 120;
    return 60 / bpm;
  }

  /* =========================================================================
     11. INPUT
     ========================================================================= */

  function onAction(name) {
    try {
      switch (name) {
        case 'pause':
          if (state === 'playing' || state === 'countdown') setState('paused');
          else if (state === 'paused') setState('playing', { fromPause: true });
          /* Nos menus, Esc e "voltar" — o mesmo caminho do Backspace, e
             quem decide para onde e cada tela (musica -> titulo, dificuldade
             -> musica...). Antes so configuracoes e creditos voltavam; na
             escolha de musica e de dificuldade o Esc nao fazia nada, apesar
             do rodape dizer "Esc voltar". */
          else menuBack();
          break;

        case 'starpower':
          if (state === 'playing') {
            var okSp = mcall('Scoring', 'activateStarPower');
            if (!okSp) { sfx('uiBack'); mcall('HUD', 'event', { type: 'spDenied' }); }
          }
          break;

        /* Atalho de recomecar so na pausa e nos resultados: com a musica
           rodando, um R esbarrado jogava fora a partida inteira. */
        case 'restart':
          if (state === 'paused' || state === 'results') restart();
          break;

        /* 'Enter' e palhetada E confirmar. O GH.Input ja suprime as acoes de
           menu no contexto 'game', mas a garantia final mora aqui: com a
           musica rodando, palhetar NUNCA pode virar um clique de menu. */
        case 'start':
          if (state === 'playing' || state === 'countdown') break;
          menuAdvance();
          break;

        case 'back':
          if (state === 'playing' || state === 'countdown') break;
          menuBack();
          break;

        case 'up': case 'down': case 'left': case 'right':
          /* um so caminho: se o modulo de menus expoe move(), ele manda;
             senao tentamos nav(). Chamar os dois moveria o cursor duas vezes. */
          if (mhas('Menus', 'move')) mcall('Menus', 'move', name);
          else if (mhas('Menus', 'nav')) mcall('Menus', 'nav', name);
          sfx('uiMove');
          break;
      }
    } catch (e) { warn('onAction:' + name, e); }
    emit('action', name);
  }

  /* "Enter" nos menus: se o modulo de menus responde, ele manda; senao o Game
     faz o caminho padrao para o jogo nunca travar sem menus. */
  function menuAdvance() {
    if (mhas('Menus', 'confirm')) { mcall('Menus', 'confirm'); return; }
    sfx('uiSelect');
    switch (state) {
      case 'title':      setState('songselect'); break;
      case 'songselect': setState('difficulty'); break;
      case 'difficulty': startSong(song, difficulty); break;
      case 'paused':     setState('playing', { fromPause: true }); break;
      case 'results':    setState('title'); break;
      case 'credits':    setState('title'); break;
      case 'settings':   setState('title'); break;
    }
  }

  function menuBack() {
    if (mhas('Menus', 'back')) { mcall('Menus', 'back'); return; }
    sfx('uiBack');
    switch (state) {
      case 'songselect': setState('title'); break;
      case 'difficulty': setState('songselect'); break;
      case 'settings':   setState('title'); break;
      case 'credits':    setState('title'); break;
      case 'paused':     quit(); break;
      case 'results':    setState('title'); break;
    }
  }

  /* Escolha vinda de GH.Menus.onChoose — aceita string ou objeto. */
  function onMenuChoose(choice, data) {
    try {
      var action = choice, payload = data || null;
      if (choice && typeof choice === 'object') {
        action = choice.action || choice.type || choice.id || '';
        payload = choice;
      }
      switch (action) {
        case 'play': case 'start': case 'confirm':
          if (payload && payload.song) song = resolveSong(payload.song);
          if (payload && payload.songId) song = resolveSong(payload.songId);
          if (payload && payload.difficulty) difficulty = resolveDifficulty(payload.difficulty);
          startSong(song, difficulty);
          break;
        case 'song': case 'selectSong':
          song = resolveSong((payload && (payload.song || payload.songId || payload.value)) || data) || song;
          GH.Game.song = song;
          if (song && song.palette) mcall('Palette', 'setTheme', song.palette);
          setState('difficulty');
          break;
        case 'difficulty': case 'selectDifficulty':
          difficulty = resolveDifficulty((payload && (payload.difficulty || payload.value)) || data);
          GH.Game.difficulty = difficulty;
          startSong(song, difficulty);
          break;
        case 'songselect': setState('songselect'); break;
        case 'tutorial':   startTutorial(); break;
        case 'settings':   setState('settings'); break;
        case 'credits':    setState('credits'); break;
        case 'title': case 'quit': case 'exit': quit(); break;
        case 'resume':     setState('playing', { fromPause: true }); break;
        case 'restart':    restart(); break;
        case 'back':       menuBack(); break;
        default:           menuAdvance(); break;
      }
    } catch (e) { warn('onMenuChoose', e); }
  }

  /* =========================================================================
     12. LOOP
     ========================================================================= */

  function driveVisuals(dt, t) {
    for (var i = 0; i < DRIVEN.length; i++) {
      var d = DRIVEN[i];
      var m = GH[d.name];
      if (!m || m.selfDriven === true || typeof m.update !== 'function') continue;
      try {
        if (d.needsTime) m.update(dt, t);
        else m.update(dt);
      } catch (e) { warn(d.name + '.update', e); }
    }
  }

  function updateFlames(t) {
    for (var i = 0; i < 5; i++) {
      if (flameOn[i] && t > flameUntil[i]) setFlame(i, false);
    }
  }

  function updateEnergy(dt) {
    var S = GH.Scoring;
    if (S && running) {
      /* alvo natural: combina secao da musica, multiplicador e vida */
      var mult = clamp((S.multiplier || 1) / 8, 0, 1);
      var hp = clamp01(S.health === undefined ? 1 : S.health);
      var base = lastSectionIntensity * 0.45 + mult * 0.35 + hp * 0.20;
      if (S.starPowerActive) base = clamp01(base * 0.7 + 0.45);
      energyTarget = clamp01(energyTarget * 0.90 + base * 0.10);
    }
    var k = 1 - Math.exp(-dt * 3.2);
    energy += (energyTarget - energy) * k;
    mcall('Stage', 'setIntensity', energy);
    mcall('Engine', 'setIntensity', energy);
  }

  function updateTransition(dt) {
    if (transition <= 0) return;
    transition -= dt / TRANSITION_SEC;
    if (transition < 0) transition = 0;
    /* uFade e multiplicativo: 1 = normal, 0 = preto. */
    var fade = 0.42 + 0.58 * easeOutCubic(1 - transition);
    mcall('Engine', 'setFade', clamp01(fade));
    if (transition === 0) mcall('Engine', 'setFade', 1);
  }

  function runCapScript(t) {
    if (!capScript.length) return;
    while (capScript.length && capScript[0].at <= t) {
      var item = capScript.shift();
      try { item.fn(); } catch (e) { warn('capScript', e); }
    }
  }

  function update(dt, elapsed) {
    if (!inited) return;
    if (!(dt > 0)) dt = 1 / 60;
    stateTime += dt;

    /* ---- 1. relogio mestre ---- */
    var C = GH.Conductor;
    if (C) {
      try { C.update(dt); } catch (e) { warn('Conductor.update', e); }
      songTime = C.time;
      if (!isFinite(songTime)) songTime = 0;
    } else {
      songTime += (state === 'playing' || state === 'countdown') ? dt : 0;
    }
    GH.Game.songTime = songTime;

    /* ---- 2. roteiro do modo captura ---- */
    if (capture) runCapScript(songTime);

    /* ---- 3. julgamento ---- */
    if (running && (state === 'playing' || state === 'countdown')) {
      if (capAuto) {
        /* bot interno da captura: da HISTORIA real ao estado */
        var acc = (songTime >= capMissFrom) ? 0 : capAccuracy;
        mcall('Scoring', 'autoPlayTo', songTime, {
          accuracy: acc, perfectRatio: 0.86, silent: false, useStarPower: capUseSp
        });
      } else if (state === 'playing') {
        mcall('Scoring', 'update', dt, songTime);
      }
    }

    /* ---- 4. contagem regressiva -> tocando ---- */
    if (state === 'countdown') {
      countdownTick(-1);
      if (songTime >= -0.001) setState('playing');
    }

    /* ---- 5. fim da musica (no tutorial, quem encerra e a licao) ---- */
    if (running && state === 'playing' && !tutorial) {
      var dur = songDuration();
      if (finishAt < 0 && dur > 0 && songTime >= dur) finishAt = songTime + OUTRO_SEC;
      if (finishAt > 0 && songTime >= finishAt && !capture) finishSong(false);
    }
    if (tutorial && (state === 'playing' || state === 'countdown')) {
      mcall('Tutorial', 'update', dt, songTime);
    }

    /* ---- 6. espetaculo ---- */
    updateFlames(songTime);
    updateEnergy(dt);
    updateTransition(dt);

    /* ---- 7. modulos visuais ---- */
    driveVisuals(dt, songTime);
  }

  function songDuration() {
    var C = GH.Chart;
    if (C && C.duration > 0) return C.duration;
    if (song && song.durationSec > 0) return song.durationSec;
    return 0;
  }

  /* =========================================================================
     13. MODO CAPTURA — forceState
     ========================================================================= */

  /* Procura o momento "mais fotogenico" da musica perto de `t`.
     scorer(group) da a nota de cada ataque; a janela de `span` segundos com a
     maior soma vence. Devolve o songTime que coloca essa janela chegando na
     linha de acerto. */
  function pickMoment(t, scorer, span, radius) {
    var C = GH.Chart;
    if (!C || !C.groups || !C.groups.length) return t;
    var g = C.groups;
    var lo = Math.max(0, t - radius), hi = t + radius;
    var best = -1, bestT = t;
    var i = 0;
    /* posiciona o cursor no primeiro grupo dentro do raio */
    while (i < g.length && g[i].t < lo) i++;
    for (; i < g.length && g[i].t <= hi; i++) {
      var sum = 0;
      for (var j = i; j < g.length && g[j].t < g[i].t + span; j++) sum += scorer(g[j]);
      if (sum > best) { best = sum; bestT = g[i].t; }
    }
    if (best <= 0) return t;
    /* a janela boa tem que estar CHEGANDO, nao ja passada */
    return Math.max(0.5, bestT - 0.45);
  }

  function scoreDense(g) {
    return 1 + (g.size > 1 ? 0.6 : 0) + (g.dur > 0.25 ? 0.4 : 0);
  }

  /* A cena `gameplay_chords` tem uma lista de compras do contrato: acordes,
     HOPOs, sustains longos E uma nota aberta. Um scorer simples raramente
     acerta a nota aberta (ela e rara), entao varremos a musica INTEIRA e
     damos um bonus enorme a janela que contem pelo menos uma aberta, com um
     puxao suave de volta para o `t` pedido para o parametro nao virar enfeite. */
  function pickChordMoment(t) {
    var C = GH.Chart;
    if (!C || !C.groups || !C.groups.length) return t;
    /* span = o que cabe na pista visivel (SPAWN_Z / speed) */
    var span = 3.0;
    try { if (typeof C.lookaheadSec === 'function') span = clamp(C.lookaheadSec() * 0.92, 1.6, 4.2); } catch (e0) { span = 3.0; }
    var g = C.groups;
    var best = -1e9, bestT = t;
    for (var i = 0; i < g.length; i++) {
      var sum = 0, open = 0, chord = 0, sus = 0, hopo = 0;
      for (var j = i; j < g.length && g[j].t < g[i].t + span; j++) {
        var q = g[j];
        if (q.open) { open++; sum += 3.0; }
        if (q.size > 1) { chord++; sum += 2.6; }
        if (q.hopo) { hopo++; sum += 1.1; }
        if (q.tap) sum += 0.8;
        if (q.dur > 0.45) { sus++; sum += 1.8; }
        sum += 0.25;
      }
      /* a janela ideal tem os QUATRO ingredientes ao mesmo tempo */
      var score = sum
        + (open > 0 ? 200 : 0)
        + (hopo > 0 ? 100 : 0) + (hopo > 1 ? 30 : 0)
        + (chord > 1 ? 90 : 0) + (chord > 3 ? 25 : 0)
        + (sus > 0 ? 70 : 0)
        - Math.abs(g[i].t - t) * 0.35;
      if (score > best) { best = score; bestT = g[i].t; }
    }
    return Math.max(0.5, bestT - 0.45);
  }

  /* Empurra `t` para logo depois do ataque mais proximo, para que o evento
     daquele ataque (acerto ou erro) ainda esteja "quente" no frame final. */
  function anchorAfterGroup(t, lag) {
    var C = GH.Chart;
    if (!C || !C.groups || !C.groups.length) return t;
    var g = C.groups, best = null, bestD = 1e9;
    for (var i = 0; i < g.length; i++) {
      var d = Math.abs(g[i].t - t);
      if (d < bestD) { bestD = d; best = g[i]; }
      else if (g[i].t > t) break;      /* lista ordenada: ja passou do melhor */
    }
    return best ? best.t + lag : t;
  }

  /* Coloca o songTime dentro de uma frase de star power (para gameplay_sp). */
  function pickSpMoment(t) {
    var C = GH.Chart;
    if (!C || !C.starPowerPhrases || !C.starPowerPhrases.length) return pickMoment(t, scoreDense, 2.0, 14);
    var ph = C.starPowerPhrases, best = null, bestD = 1e9;
    for (var i = 0; i < ph.length; i++) {
      var mid = (ph[i].tStart + ph[i].tEnd) * 0.5;
      var d = Math.abs(mid - t);
      if (d < bestD) { bestD = d; best = ph[i]; }
    }
    if (!best) return t;
    return Math.max(0.5, best.tStart - 0.2);
  }

  /* Cenas de captura da tabela da secao 7. Cada uma descreve a musica, a
     dificuldade e os numeros que o print precisa mostrar. */
  var CAP_SCENES = {
    title:      { state: 'title' },
    songselect: { state: 'songselect' },
    difficulty: { state: 'difficulty' },
    credits:    { state: 'credits' },
    settings:   { state: 'settings' },

    gameplay: {
      state: 'playing', songId: 'guitarrada-ver-o-peso', difficulty: 'guitarrada',
      snap: 'dense', streak: 14, multiplier: 2, health: 0.82,
      starPower: 0.34, starPowerActive: false, accuracy: 1
    },

    gameplay_sp: {
      state: 'playing', songId: 'guitarrada-ver-o-peso', difficulty: 'guitarrada',
      snap: 'sp', streak: 96, multiplier: 8, health: 1.0,
      starPower: 1.0, starPowerActive: false, accuracy: 1,
      activateSpAfter: 1.25          /* ativa 1,25 s depois do inicio do preroll */
    },

    gameplay_chords: {
      state: 'playing', songId: 'frevo-de-aco', difficulty: 'guitarrada',
      snap: 'chords', streak: 42, multiplier: 4, health: 0.94,
      starPower: 0.45, starPowerActive: false, accuracy: 1
    },

    gameplay_miss: {
      state: 'playing', songId: 'guitarrada-ver-o-peso', difficulty: 'dificil',
      snap: 'dense', streak: 0, multiplier: 1, health: 0.44,
      starPower: 0.22, starPowerActive: false, accuracy: 1,
      missLast: 1.15, muted: true
    },

    stage_wide: {
      state: 'playing', songId: 'guitarrada-ver-o-peso', difficulty: 'guitarrada',
      snap: 'dense', streak: 58, multiplier: 4, health: 0.96,
      starPower: 0.66, starPowerActive: false, accuracy: 1,
      cam: 'cinematic', hud: false
    },

    results: {
      state: 'results', songId: 'guitarrada-ver-o-peso', difficulty: 'guitarrada',
      fullRun: true
    },

    pause: {
      state: 'playing', songId: 'guitarrada-ver-o-peso', difficulty: 'guitarrada',
      snap: 'dense', streak: 33, multiplier: 4, health: 0.71,
      starPower: 0.52, starPowerActive: false, accuracy: 1,
      pauseAfter: 2.6                /* pausa 0,4 s antes do frame final */
    }
  };

  /* forceState(cfg) — contrato da secao 7.
     cfg = { scene, songId, difficulty, songTime, streak, multiplier, health,
             starPower, starPowerActive, preroll, cam, hud }
     Deixa o Conductor posicionado em (songTime - preroll) e monta o roteiro
     que o main.js executa simulando ate songTime. */
  function forceState(cfg) {
    cfg = cfg || {};
    var sceneName = cfg.scene || 'gameplay';
    var base = CAP_SCENES[sceneName] || CAP_SCENES.gameplay;
    var o = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) o[k] = base[k];
    for (k in cfg) {
      if (!Object.prototype.hasOwnProperty.call(cfg, k)) continue;
      if (cfg[k] === undefined || cfg[k] === null) continue;
      o[k] = cfg[k];
    }

    capture = true;
    GH.Game.capture = true;
    capScript.length = 0;
    capAuto = false;
    capMissFrom = 1e9;
    capUseSp = false;
    capAccuracy = (typeof o.accuracy === 'number') ? o.accuracy : 1;

    var preroll = (typeof o.preroll === 'number') ? o.preroll : 3.0;
    var target = (typeof o.songTime === 'number' && isFinite(o.songTime)) ? o.songTime : 32;

    /* ---- cenas que nao precisam de musica rodando ---- */
    var wants = o.state || 'playing';

    /* Sempre preparamos a musica: ate a tela de titulo fica melhor com o tema
       cromatico certo, e songselect/results precisam dos dados. */
    prepareSong(o.songId || (cfg.songId) || null, o.difficulty || 'guitarrada');
    if (!song) { warn('forceState', 'sem musicas'); setState(wants === 'boot' ? 'title' : wants); return GH.Game; }

    if (wants === 'title' || wants === 'songselect' || wants === 'difficulty' ||
        wants === 'credits' || wants === 'settings') {
      teardownSong(true);
      setState(wants, { force: true });
      mcall('Engine', 'setFade', 1);
      GH.Game.captureScene = sceneName;
      return GH.Game;
    }

    /* ---- tela de resultados: roda a musica inteira em silencio ---- */
    if (wants === 'results') {
      mcall('Scoring', 'autoPlayTo', songDuration() + 1, {
        accuracy: o.fullRun === false ? 0.93 : 1, perfectRatio: 0.97,
        silent: true, useStarPower: true
      });
      var st = mcall('Scoring', 'getStats') || {};
      st.song = song;
      st.songTitle = st.songTitle || song.title;
      st.songArtist = song.artist;
      st.songGenre = song.genre;
      st.tribute = song.tribute;
      st.difficulty = difficulty;
      st.difficultyLabel = difficultyLabel(difficulty);
      st.failed = !!o.failed;
      stats = st; GH.Game.stats = st;
      teardownSong(true);
      setState('results', { force: true });
      mcall('Engine', 'setFade', 1);
      GH.Game.captureScene = sceneName;
      return GH.Game;
    }

    /* ---- cenas de jogo ---- */
    /* 1. escolhe o instante fotogenico */
    if (o.snap === 'chords') target = pickChordMoment(target);
    else if (o.snap === 'sp') target = pickSpMoment(target);
    else if (o.snap === 'dense') target = pickMoment(target, scoreDense, 2.2, 10);
    /* Cena de ERRO: o print tem que pegar o erro FRESCO. Ancoramos o instante
       final 0,13 s depois de um ataque, para que a ultima nota errada ainda
       esteja piscando em vermelho e o flash de tela nao tenha decaido. */
    if (typeof o.missLast === 'number') target = anchorAfterGroup(target, 0.13);

    var dur = songDuration();
    if (dur > 0) target = clamp(target, preroll + 0.5, dur - 1.5);
    GH.Game.captureTime = target;

    var t0 = Math.max(0, target - preroll);

    /* 2. relogio virtual posicionado (start nao "toma posse" do relogio, entao
          o update(dt) por frame continua avancando sozinho) */
    mcall('Conductor', 'start', t0);
    songTime = t0;
    GH.Game.songTime = t0;

    /* 3. historia silenciosa ate t0 — placar, sequencia e vida com passado */
    mcall('Scoring', 'autoPlayTo', t0, {
      accuracy: capAccuracy, perfectRatio: 0.88, silent: true, useStarPower: false
    });

    /* 4. numeros exatos pedidos */
    var numbers = {
      streak: o.streak, multiplier: o.multiplier, health: o.health,
      starPower: o.starPower, starPowerActive: o.starPowerActive,
      muted: !!o.muted, failed: false
    };
    mcall('Scoring', 'forceState', numbers);
    syncVisualsToScoring();

    /* 5. entra no estado de jogo */
    capAuto = true;
    running = true;
    GH.Game.running = true;
    setState('playing', { force: true, fromPause: true });
    if (o.cam) mcall('Engine', 'camPreset', o.cam, 0);
    if (o.hud === false) mcall('HUD', 'hide');
    mcall('Engine', 'setFade', 1);

    /* 6. roteiro: o que acontece durante a simulacao */
    if (typeof o.activateSpAfter === 'number') {
      capScript.push({ at: t0 + o.activateSpAfter, fn: function () {
        mcall('Scoring', 'activateStarPower');
      } });
    }
    if (typeof o.missLast === 'number') {
      capMissFrom = target - o.missLast;
    }
    /* Reaplica os numeros pouco antes do frame final: o HUD tem tempo de
       assentar a animacao e o print sai com o valor exato do contrato.
       Na cena de ERRO isso tem que acontecer ANTES da janela de erros, senao
       os erros que vem depois nao apareceriam no medidor de vida. */
    var applyAt = (typeof o.missLast === 'number')
      ? (target - o.missLast - 0.25)
      : (target - 0.55);
    capScript.push({ at: applyAt, fn: function () {
      var n2 = {
        streak: o.streak, multiplier: o.multiplier, health: o.health, muted: !!o.muted
      };
      if (!o.activateSpAfter) { n2.starPower = o.starPower; n2.starPowerActive = o.starPowerActive; }
      mcall('Scoring', 'forceState', n2);
      syncVisualsToScoring();
    } });
    if (typeof o.pauseAfter === 'number') {
      capScript.push({ at: t0 + o.pauseAfter, fn: function () { setState('paused'); } });
    }
    capScript.sort(function (a, b) { return a.at - b.at; });

    GH.Game.captureScene = sceneName;
    return GH.Game;
  }

  /* Alinha as flags visuais com o que o GH.Scoring diz agora (usado depois de
     um forceState, que muda os numeros sem emitir evento). */
  function syncVisualsToScoring() {
    var S = GH.Scoring;
    if (!S) return;
    var sp = !!S.starPowerActive;
    mcall('FX', 'starPower', sp);
    mcall('Notes', 'setStarPower', sp);
    mcall('Highway', 'setStarPower', sp);
    mcall('Stage', 'setStarPower', sp);
    mcall('Engine', 'setStarPower', sp);
    mcall('Synth', 'setStarPower', sp);
    var mult = S.multiplier || 1;
    mcall('FX', 'streakLevel', S.baseMultiplier || 1);
    var wantFlames = (mult >= 2 || sp);
    for (var i = 0; i < 5; i++) {
      if (wantFlames) { flameUntil[i] = songTime + FLAME_HOLD; setFlame(i, true); }
      else setFlame(i, false);
    }
    mcall('HUD', 'event', { type: 'sync', multiplier: mult, streak: S.streak, health: S.health });
  }

  /* Resumo do que esta VISIVEL na pista agora. Serve de conferencia objetiva
     para o modo captura ("a cena de acordes tem mesmo acordes?") e de apoio
     para o agente de NOTAS. */
  function visibleSummary() {
    var C = GH.Chart;
    if (!C || !C.notes || !C.notes.length || typeof C.visibleRange !== 'function') return null;
    var r;
    try { r = C.visibleRange(songTime); } catch (e) { return null; }
    var out = { total: 0, chord: 0, hopo: 0, tap: 0, open: 0, sustain: 0, sp: 0, lanes: [0, 0, 0, 0, 0] };
    for (var i = r[0]; i <= r[1]; i++) {
      var n = C.notes[i];
      if (!n) continue;
      out.total++;
      if (n.chord) out.chord++;
      if (n.hopo) out.hopo++;
      if (n.tap) out.tap++;
      if (n.open) out.open++;
      if (n.dur > 0.12) out.sustain++;
      if (n.sp) out.sp++;
      if (!n.open && n.lane >= 0 && n.lane < 5) out.lanes[n.lane]++;
    }
    return out;
  }

  /* =========================================================================
     14. INIT
     ========================================================================= */

  function init(opts) {
    if (inited) return GH.Game;
    opts = opts || {};
    capture = !!(opts.capture || (typeof window !== 'undefined' && window.__GH_CAP));
    GH.Game.capture = capture;
    inited = true;
    GH.Game.inited = true;

    /* --- updater principal: roda ANTES dos updaters dos modulos visuais,
           porque game.js e inicializado antes deles pelo main.js --- */
    mcall('Engine', 'addUpdater', update);

    /* --- entrada (no headless nao ha teclado nem gamepad) --- */
    if (!capture) {
      mcall('Input', 'init');
      mcall('Scoring', 'attachInput');
      if (mhas('Input', 'onAction')) GH.Input.onAction(onAction);
    }

    /* --- barramento de feedback --- */
    if (mhas('Scoring', 'onEvent')) GH.Scoring.onEvent(onScoringEvent);

    /* --- relogio musical ---
       Conductor.init() sem argumento resolve sozinho: em captura ele NAO
       procura AudioContext nenhum e entra no relogio virtual. */
    mcall('Conductor', 'init');
    unhookBeat = mcall('Conductor', 'onBeat', onBeat) || null;
    unhookBar = mcall('Conductor', 'onBar', onBar) || null;
    unhookSection = mcall('Conductor', 'onSection', onSection) || null;

    /* --- menus --- */
    if (mhas('Menus', 'onChoose')) mcall('Menus', 'onChoose', onMenuChoose);

    /* --- musica/dificuldade padrao --- */
    var savedSongId = null;
    try { if (GH.Settings && GH.Settings.lastSongId) savedSongId = GH.Settings.lastSongId; } catch (e) { savedSongId = null; }
    song = resolveSong(savedSongId);
    GH.Game.song = song;
    var savedDiff = null;
    try { if (GH.Settings && (GH.Settings.lastDifficulty || GH.Settings.difficulty)) savedDiff = GH.Settings.lastDifficulty || GH.Settings.difficulty; } catch (e) { savedDiff = null; }
    difficulty = resolveDifficulty(savedDiff || 'medio');
    GH.Game.difficulty = difficulty;

    emit('init', null);
    return GH.Game;
  }

  function dispose() {
    if (!inited) return;
    mcall('Engine', 'removeUpdater', update);
    if (typeof unhookBeat === 'function') unhookBeat();
    if (typeof unhookBar === 'function') unhookBar();
    if (typeof unhookSection === 'function') unhookSection();
    mcall('Scoring', 'offEvent', onScoringEvent);
    if (!capture) mcall('Scoring', 'detachInput');
    teardownSong(false);
    inited = false;
    GH.Game.inited = false;
  }

  /* =========================================================================
     15. API PUBLICA
     ========================================================================= */

  GH.Game = {
    /* ciclo de vida */
    init: init,
    dispose: dispose,
    update: update,

    /* maquina de estados */
    setState: setState,
    state: 'boot',
    prevState: 'boot',
    states: STATES.slice(),
    isState: function (s) { return state === s; },

    /* partida */
    start: startSong,
    startSong: startSong,
    prepareSong: prepareSong,
    restart: restart,
    quit: quit,
    finish: function (failed) { finishSong(!!failed); },
    pause: function () { if (state === 'playing' || state === 'countdown') setState('paused'); },
    resume: function () { if (state === 'paused') setState('playing', { fromPause: true }); },
    togglePause: function () {
      if (state === 'paused') setState('playing', { fromPause: true });
      else if (state === 'playing' || state === 'countdown') setState('paused');
    },

    /* selecao */
    setSong: function (s) {
      song = resolveSong(s) || song;
      GH.Game.song = song;
      if (song && song.palette) mcall('Palette', 'setTheme', song.palette);
      try {
        if (GH.Settings && typeof GH.Settings.set === 'function') {
          GH.Settings.set('lastSongId', song.id);
        }
      } catch (e) { /* ok */ }
      return song;
    },
    setDifficulty: function (d) {
      difficulty = resolveDifficulty(d);
      GH.Game.difficulty = difficulty;
      try {
        if (GH.Settings && typeof GH.Settings.set === 'function') {
          GH.Settings.set('difficulty', difficulty);
          GH.Settings.set('lastDifficulty', difficulty);
        }
      } catch (e) { /* ok */ }
      return difficulty;
    },
    songs: function () { return GH.Songs || []; },
    difficulties: DIFFICULTIES.slice(),
    difficultyLabel: difficultyLabel,

    /* tutorial (secao 8B) */
    startTutorial: startTutorial,
    clearStage: clearStage,
    leaveTutorial: leaveTutorial,
    tutorial: false,

    /* dados correntes */
    song: null,
    difficulty: 'medio',
    stats: null,
    songTime: 0,
    leadIn: 0,
    running: false,
    energy: function () { return energy; },

    /* eventos do proprio jogo */
    on: on,
    off: off,

    /* modo captura */
    forceState: forceState,
    captureScenes: CAP_SCENES,
    captureScene: '',
    captureTime: 0,
    capture: false,
    syncVisuals: syncVisualsToScoring,

    /* diagnostico */
    log: log,
    inited: false,
    debug: function () {
      var S = GH.Scoring || {};
      return {
        state: state, prev: prevState, t: Math.round(songTime * 1000) / 1000,
        song: song ? song.id : null, difficulty: difficulty,
        running: running, capture: capture,
        score: S.score, streak: S.streak, mult: S.multiplier,
        health: Math.round((S.health || 0) * 1000) / 1000,
        sp: Math.round((S.starPower || 0) * 1000) / 1000,
        spActive: S.starPowerActive,
        misses: S.misses, notesHit: S.notesHit,
        acc: Math.round((S.accuracy || 0) * 1000) / 1000,
        stars: S.starsDisplay, gold: S.goldStar,
        energy: Math.round(energy * 100) / 100,
        onTrack: visibleSummary(),
        warnings: log.slice(-8)
      };
    }
  };

})(window.GH = window.GH || {});

(function (GH) {
  'use strict';

  /* ==========================================================================
   * GUITARRADA HERO — src/audio/conductor.js
   * Dono: agente AUDIO-CORE.
   *
   * Este arquivo entrega DUAS coisas:
   *
   *   GH.Settings  — configuracao global persistida (offsets de latencia,
   *                  volumes, qualidade, velocidade da pista, dificuldade).
   *
   *   GH.Conductor — o RELOGIO MESTRE. Em jogo de ritmo, se o relogio estiver
   *                  errado, tudo parece errado: a nota "passa" antes do som,
   *                  o publico pula fora do tempo, a chama sai atrasada. Por
   *                  isso o tempo aqui NAO vem de requestAnimationFrame nem de
   *                  Date.now(): vem de audioCtx.currentTime, que e o unico
   *                  relogio do navegador cravado no mesmo cristal que gera as
   *                  amostras que o jogador esta ouvindo.
   *
   * Tres clocks convivem, e e importante nao confundi-los:
   *
   *   ctx.currentTime  — tempo absoluto do hardware de audio (nunca volta).
   *   rawTime          — posicao na musica, ancorada no instante do start.
   *                      E o tempo em que a MUSICA e agendada.
   *   time             — rawTime menos (audioOffsetMs + videoOffsetMs). E o
   *                      tempo do JOGO: julgamento de acerto, posicao das
   *                      notas na pista, batidas visuais. E o que faz o jogo
   *                      parecer justo em maquinas com latencias diferentes.
   * ========================================================================== */

  /* ==========================================================================
   * PARTE 1 — GH.Settings
   * ========================================================================== */

  var STORAGE_KEY = 'guitarrada-hero.settings.v1';

  var DEFAULTS = {
    // Latencia. Positivo = o som sai DEPOIS do esperado, entao o relogio de
    // jogo precisa atrasar na mesma medida para a nota bater junto com o som.
    audioOffsetMs: 0,
    // Positivo = a imagem chega depois (TV com processamento, v-sync duplo).
    videoOffsetMs: 0,

    volumes: { master: 0.90, music: 0.85, guitar: 1.00, drums: 0.92, sfx: 0.80, crowd: 0.55 },

    quality: 'high',        // 'low' | 'med' | 'high' | 'ultra'
    scrollSpeed: 14,        // unidades/segundo — alimenta GH.Chart.speed
    difficulty: 'medio',    // dificuldade preferida do jogador
    reverbIR: 'clube',      // 'clube' | 'arena'
    lefty: false,           // inverte a ordem das raias
    showFPS: false,
    hitFlash: true,         // flash de tela no acerto (pode incomodar)
    crowdAmbience: true,    // leito de plateia continuo nos menus
    crowd3D: true,          // publico instanciado e animado ao fundo do palco
    calibrated: false,      // o jogador ja passou pela calibracao?

    /* Chaves de JOGABILIDADE. Nasceram em src/core/input.js (que carrega antes
       daqui) e viviam fora do ciclo de vida da configuracao: como este arquivo
       criava GH.Settings do zero, elas eram apagadas no load — GH.Scoring lia
       noFail e sempre achava o default, e o menu nao tinha como liga-las.
       Agora sao chaves de primeira classe: entram no sanitize, no save e no
       reset como qualquer outra. */
    noFail: false,          // pratica: o rock meter nunca mata
    invertStrum: false      // inverte cima/baixo da palhetada
  };

  var VALID_QUALITY = { low: 1, med: 1, high: 1, ultra: 1 };
  var VALID_DIFF = { facil: 1, medio: 1, dificil: 1, guitarrada: 1 };
  var VALID_IR = { clube: 1, arena: 1 };

  function clampNum(v, lo, hi, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return fallback;
    return n < lo ? lo : (n > hi ? hi : n);
  }

  // Copia profunda rasa o suficiente para o nosso formato (1 nivel de objeto).
  function cloneDefaults() {
    var o = {}, k;
    for (k in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
      if (k === 'volumes') {
        o.volumes = {};
        for (var v in DEFAULTS.volumes) {
          if (Object.prototype.hasOwnProperty.call(DEFAULTS.volumes, v)) o.volumes[v] = DEFAULTS.volumes[v];
        }
      } else {
        o[k] = DEFAULTS[k];
      }
    }
    return o;
  }

  // Sanitiza qualquer entrada (inclusive JSON corrompido no localStorage).
  function sanitize(target, src) {
    if (!src || typeof src !== 'object') return target;
    if (typeof src.audioOffsetMs !== 'undefined') target.audioOffsetMs = clampNum(src.audioOffsetMs, -500, 500, 0);
    if (typeof src.videoOffsetMs !== 'undefined') target.videoOffsetMs = clampNum(src.videoOffsetMs, -500, 500, 0);
    if (typeof src.scrollSpeed !== 'undefined') target.scrollSpeed = clampNum(src.scrollSpeed, 6, 32, 14);
    if (src.quality && VALID_QUALITY[src.quality]) target.quality = src.quality;
    if (src.difficulty && VALID_DIFF[src.difficulty]) target.difficulty = src.difficulty;
    if (src.reverbIR && VALID_IR[src.reverbIR]) target.reverbIR = src.reverbIR;
    if (typeof src.lefty !== 'undefined') target.lefty = !!src.lefty;
    if (typeof src.showFPS !== 'undefined') target.showFPS = !!src.showFPS;
    if (typeof src.hitFlash !== 'undefined') target.hitFlash = !!src.hitFlash;
    if (typeof src.crowdAmbience !== 'undefined') target.crowdAmbience = !!src.crowdAmbience;
    if (typeof src.crowd3D !== 'undefined') target.crowd3D = !!src.crowd3D;
    if (typeof src.calibrated !== 'undefined') target.calibrated = !!src.calibrated;
    if (typeof src.noFail !== 'undefined') target.noFail = !!src.noFail;
    if (typeof src.invertStrum !== 'undefined') target.invertStrum = !!src.invertStrum;
    if (src.volumes && typeof src.volumes === 'object') {
      for (var k in DEFAULTS.volumes) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS.volumes, k)) continue;
        if (typeof src.volumes[k] !== 'undefined') {
          target.volumes[k] = clampNum(src.volumes[k], 0, 1, DEFAULTS.volumes[k]);
        }
      }
    }
    return target;
  }

  var settingsListeners = [];

  function notifySettings(key) {
    for (var i = 0; i < settingsListeners.length; i++) {
      try { settingsListeners[i](GH.Settings, key); } catch (e) { /* ouvinte ruim nao derruba o resto */ }
    }
  }

  // localStorage pode simplesmente NAO EXISTIR em file:// (ou lancar
  // SecurityError). Todo acesso e blindado; falhar em salvar nunca e fatal.
  function storageGet() {
    try {
      if (!window.localStorage) return null;
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (e) { return null; }
  }
  function storageSet(str) {
    try {
      if (!window.localStorage) return false;
      window.localStorage.setItem(STORAGE_KEY, str);
      return true;
    } catch (e) { return false; }
  }

  function settingsLoad() {
    var raw = storageGet();
    if (!raw) return GH.Settings;
    var obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    if (obj) sanitize(GH.Settings, obj);
    return GH.Settings;
  }

  function settingsSave() {
    var payload = {
      audioOffsetMs: GH.Settings.audioOffsetMs,
      videoOffsetMs: GH.Settings.videoOffsetMs,
      volumes: GH.Settings.volumes,
      quality: GH.Settings.quality,
      scrollSpeed: GH.Settings.scrollSpeed,
      difficulty: GH.Settings.difficulty,
      reverbIR: GH.Settings.reverbIR,
      lefty: GH.Settings.lefty,
      showFPS: GH.Settings.showFPS,
      hitFlash: GH.Settings.hitFlash,
      crowdAmbience: GH.Settings.crowdAmbience,
      crowd3D: GH.Settings.crowd3D,
      calibrated: GH.Settings.calibrated,
      noFail: GH.Settings.noFail,
      invertStrum: GH.Settings.invertStrum
    };
    var str;
    try { str = JSON.stringify(payload); } catch (e) { return false; }
    return storageSet(str);
  }

  // Empurra a configuracao para quem depende dela. Tudo defensivo: cada modulo
  // pode ainda nao existir (ordem de carregamento) ou estar em modo mudo.
  function settingsApply() {
    var S = GH.Settings;
    try {
      if (GH.Audio && GH.Audio.setVolume) {
        for (var k in S.volumes) {
          if (Object.prototype.hasOwnProperty.call(S.volumes, k)) GH.Audio.setVolume(k, S.volumes[k]);
        }
      }
      if (GH.Audio && GH.Audio.setReverbIR) GH.Audio.setReverbIR(S.reverbIR);
    } catch (e) {}
    try { if (GH.Chart) GH.Chart.speed = S.scrollSpeed; } catch (e2) {}
    try { if (GH.Engine && GH.Engine.setQuality) GH.Engine.setQuality(S.quality); } catch (e3) {}
    try { if (GH.Stage && GH.Stage.setCrowdEnabled) GH.Stage.setCrowdEnabled(S.crowd3D); } catch (e4) {}
    return S;
  }

  function settingsSet(path, value) {
    var S = GH.Settings;
    var patch = {};
    if (typeof path === 'string' && path.indexOf('volumes.') === 0) {
      patch.volumes = {};
      patch.volumes[path.slice(8)] = value;
    } else if (typeof path === 'string') {
      patch[path] = value;
    } else if (path && typeof path === 'object') {
      patch = path;
    } else {
      return S;
    }
    sanitize(S, patch);
    settingsApply();
    settingsSave();
    notifySettings(typeof path === 'string' ? path : null);
    return S;
  }

  function settingsGet(path) {
    var S = GH.Settings;
    if (typeof path !== 'string') return undefined;
    if (path.indexOf('volumes.') === 0) return S.volumes[path.slice(8)];
    return S[path];
  }

  function settingsReset() {
    var fresh = cloneDefaults(), k;
    for (k in fresh) {
      if (!Object.prototype.hasOwnProperty.call(fresh, k)) continue;
      /* volumes e copiado NO LUGAR: quem guardou a referencia (mixer do audio,
         sliders do menu) continua olhando para o mesmo objeto. */
      if (k === 'volumes') {
        for (var v in fresh.volumes) {
          if (Object.prototype.hasOwnProperty.call(fresh.volumes, v)) GH.Settings.volumes[v] = fresh.volumes[v];
        }
      } else {
        GH.Settings[k] = fresh[k];
      }
    }
    settingsApply();
    settingsSave();
    notifySettings(null);
    return GH.Settings;
  }

  /* Publicacao NAO destrutiva de GH.Settings.
     Este arquivo e o dono do objeto, mas nao e o primeiro a toca-lo:
     src/core/input.js carrega antes e cria as chaves que precisa. Trocar o
     objeto inteiro (GH.Settings = cloneDefaults()) apagava o que ja estava la
     e, pior, invalidava qualquer referencia que outro modulo tivesse guardado.
     Aqui preenchemos SO o que falta e preservamos a identidade do objeto. */
  (function publishSettings() {
    var base = cloneDefaults(), k;
    GH.Settings = GH.Settings || {};
    for (k in base) {
      if (!Object.prototype.hasOwnProperty.call(base, k)) continue;
      if (k === 'volumes') {
        GH.Settings.volumes = GH.Settings.volumes || {};
        for (var v in base.volumes) {
          if (!Object.prototype.hasOwnProperty.call(base.volumes, v)) continue;
          if (typeof GH.Settings.volumes[v] !== 'number') GH.Settings.volumes[v] = base.volumes[v];
        }
      } else if (typeof GH.Settings[k] === 'undefined') {
        GH.Settings[k] = base[k];
      }
    }
  })();

  GH.Settings.load = settingsLoad;
  GH.Settings.save = settingsSave;
  GH.Settings.apply = settingsApply;
  GH.Settings.set = settingsSet;
  GH.Settings.get = settingsGet;
  GH.Settings.reset = settingsReset;
  GH.Settings.defaults = cloneDefaults;
  GH.Settings.setVolume = function (bus, v) { return settingsSet('volumes.' + bus, v); };
  GH.Settings.onChange = function (fn) {
    if (typeof fn !== 'function') return function () {};
    settingsListeners.push(fn);
    return function () {
      var i = settingsListeners.indexOf(fn);
      if (i >= 0) settingsListeners.splice(i, 1);
    };
  };
  // Offset total em SEGUNDOS, do jeito que o relogio consome.
  Object.defineProperty(GH.Settings, 'offsetSec', {
    get: function () { return (GH.Settings.audioOffsetMs + GH.Settings.videoOffsetMs) / 1000; }
  });

  // Carrega na hora do parse: menus e audio ja acham valores prontos.
  settingsLoad();

  /* ==========================================================================
   * PARTE 2 — GH.Conductor
   * ========================================================================== */

  /* --- constantes de sincronismo ------------------------------------------ */

  // Ganho da correcao proporcional que persegue o relogio de audio.
  // Constante de tempo ~= 1/SMOOTH_K = 125 ms. Alto o bastante para nunca
  // derivar; baixo o bastante para o degrau de ctx.currentTime (que so atualiza
  // a cada bloco de render, ~2,7 ms) nao virar tremor visivel na pista.
  var SMOOTH_K = 8.0;

  // Se o erro passar disto, nao e jitter: e seek, engasgo de aba em segundo
  // plano ou troca de dispositivo. Ressincroniza seco em vez de escorregar.
  var RESYNC_SEC = 0.075;

  // Predicao maxima aceita num frame. Frame mais longo que isso e um travamento;
  // deixamos o relogio de audio corrigir sozinho em vez de prever besteira.
  var MAX_FRAME_SEC = 0.25;

  // Buraco maior que isso entre dois despachos = pulo, nao atraso: as batidas
  // intermediarias sao descartadas (ninguem quer 300 flashes de uma vez).
  var MAX_CATCHUP_SEC = 2.0;
  var MAX_EVENTS_PER_DISPATCH = 128;

  // ---------------------------------------------------------------------------
  // VIGIA DO RELOGIO DE AUDIO (a correcao do bug "nao acerto nenhuma nota")
  //
  // ctx.currentTime e o melhor relogio do navegador — quando ele anda. Ele PODE
  // nao andar: contexto suspenso pela politica de autoplay, maquina sem
  // dispositivo de saida, fone desconectado no meio, driver que sumiu, aba que
  // o sistema operacional silenciou. Nesses casos `currentTime` fica CRAVADO.
  //
  // O codigo antigo perseguia o alvo do audio sem nenhuma desconfianca: com o
  // audio parado, o erro estourava RESYNC_SEC todo frame e a ressincronizacao
  // seca puxava o tempo do jogo de volta para o mesmo instante, para sempre.
  // Efeito medido no harness (shots/_inputtest.html, cenario H): GH.Conductor.time
  // congelado em -3,78 s, o jogo preso em `countdown`, e TODA palhetada julgada
  // com desvio de -4719 ms, -5637 ms, -6555 ms... ou seja, 0% de acerto e uma
  // chuva de overstrum. O jogador ve a reacao do input e nenhum acerto.
  //
  // Agora o maestro desconfia: se o relogio de audio nao anda enquanto o relogio
  // de parede anda, ele e declarado PARADO e o tempo passa a vir do relogio de
  // parede. Se o audio voltar, reancoramos SEM degrau e voltamos a segui-lo.
  // Isto nao afrouxa nenhuma janela de acerto: so garante que o tempo exista.
  // ---------------------------------------------------------------------------
  var CTX_STALL_SEC = 0.25;    // audio parado por mais que isto = relogio morto
  var CTX_WAKE_SEC = 0.05;     // e preciso este tanto de audio andando pra voltar

  /* --- estado -------------------------------------------------------------- */

  var ctx = null;             // AudioContext, ou null = relogio virtual
  var virtual = true;         // true quando nao ha AudioContext
  var song = null;
  var loaded = false;

  var segs = [];              // segmentos do mapa de andamento
  var beatsPerBar = 4;
  var sections = [];          // copia ordenada de song.sections
  var duration = 0;

  var playing = false;
  var startCtxTime = 0;       // ctx.currentTime no instante do start
  var startOffset = 0;        // posicao da musica correspondente ao start
  var pausedRaw = 0;          // posicao crua congelada na pausa
  var virtualRaw = 0;         // posicao crua no modo virtual

  var smoothRaw = 0;          // posicao crua SUAVIZADA (o que o jogo consome)
  var lastWall = 0;           // performance.now() da ultima amostragem
  var haveWall = false;

  /* --- vigia do relogio de audio --- */
  var ctxDead = false;        // o relogio de audio esta parado?
  var ctxLastTime = -1;       // ultimo ctx.currentTime observado
  var ctxStall = 0;           // segundos de parede com o audio parado
  var ctxAwake = 0;           // segundos de parede com o audio andando de novo
  var ctxQuiet = 0;           // segundos de parede sem o audio andar, ja morto
  var ctxDeadCount = 0;       // quantas vezes o audio morreu (diagnostico)

  /* GRAVADOR DE VOO DO AUDIO.
     Fica sempre armado, mas guarda so ~16 s e amostra a 4 Hz: custo pequeno e
     memoria constante. O objetivo e conservar o ANTES do defeito — abrir o F3
     depois do silencio nao pode apagar a causa. Eventos de transporte entram
     imediatamente; amostras periodicas entram pelo mesmo pump do scheduler. */
  var FLIGHT_MAX = 80;
  var FLIGHT_PERIOD = 0.25;
  var flight = [];
  var flightLastWall = -1e9;
  var flightSeq = 0;

  var lastEventTime = 0;      // ate onde os eventos ja foram despachados
  var lastSectionIdx = -1;
  var lastBeatIdx = -1;       // apenas informativo (ultimo beat despachado)
  var lastBarIdx = -1;

  var listeners = { beat: [], bar: [], section: [] };

  /* JANELA DE LOOKAHEAD — medida, nao chutada.
   *
   * Com 0,20 s a janela nao sobrevive a um quadro gordo: a bancada
   * shots/_schedload.html, com engasgos de 150-400 ms na thread principal,
   * mediu 286 eventos agendados com instante JA PASSADO, 289 notas
   * empurradas para "agora" (fora do compasso, todas somando no mesmo
   * instante) e 7,08 s de musica que a janela nunca chegou a pedir — 551
   * eventos que simplesmente nao tocaram. E exatamente a "trepidada de
   * ruido" que o jogador ouve quando a tela enche de particula.
   *
   * 0,75 s da quase o dobro de folga sobre o pior quadro observado
   * (394 ms) e continua bem abaixo do tempo de reacao do jogo: mute e
   * Star Power sao rampas de AudioParam no barramento, aplicadas em
   * ctx.currentTime, e portanto NAO dependem desta janela.
   *
   * O tick de 100 ms e so a rede de seguranca. Na pratica quem pede musica
   * e o proprio quadro (pumpScheduler('frame') dentro de update()), o que
   * distribui o trabalho em fatias de ~16 ms em vez de rajadas.
   */
  var lookahead = 0.75;       // janela BASE agendada a frente, em segundos
  var TICK_MS = 100;          // periodicidade do scheduler (rede de seguranca)
  var PUMP_MIN_SEC = 0.008;   // nao adianta reagendar mais denso que isto
  var LATE_GRACE = 0.02;      // tolerancia de atraso antes de desistir da nota

  /* JANELA QUE APRENDE — medida na bancada shots/_cruelload.html.
   *
   * Uma janela FIXA, por maior que seja, tem um tamanho de engasgo que a
   * derruba. O caso que derrubou a de 0,75 s nao foi carga de render: foi o
   * jogador trocar de aba. Com `document.hidden`, o Chrome estrangula
   * setInterval para no minimo 1000 ms e PARA o rAF — as duas fontes de tick
   * somem de uma vez, e 1,0 s > 0,75 s. Medido antes desta correcao, em 30 s
   * de aba escondida: 29 janelas perdidas, 6,67 s de musica que nunca tocou
   * (541 eventos) e 53 notas vistas com instante ja passado.
   *
   * Duas defesas, uma preditiva e uma reativa:
   *
   *   1. PREDITIVA — `visibilitychange`. Quando a aba some, sabemos de
   *      antemao que o timer vai ser estrangulado. O evento chega na thread
   *      principal ANTES do estrangulamento comecar a valer, entao a janela
   *      sobe para HIDDEN_LOOKAHEAD e a fila e reabastecida na hora. Nao se
   *      perde nem a primeira janela.
   *
   *   2. REATIVA — `learnGap()`. Qualquer outra fome (congelamento de
   *      600-900 ms, GC do navegador, disco travado) e aprendida do proprio
   *      intervalo entre bombeadas: a proxima pausa pode ser tao ruim quanto
   *      a ultima, entao a janela passa a valer 1,6x o pior intervalo
   *      recente. A folga relaxa sozinha (BOOST_TAU) para o jogo nao ficar
   *      com uma fila gigante depois de um susto isolado.
   *
   * Por que crescer a janela e seguro: cada nota carrega um instante
   * ABSOLUTO de ctx, o orcamento de polifonia e contado por TEMPO (imune ao
   * tamanho da janela), e tudo que salta no tempo — pause/resume/seek/start
   * — cancela a fila com stopAll(). O mute da guitarra e o Star Power sao
   * rampas de AudioParam no barramento, aplicadas em ctx.currentTime: nao
   * dependem da janela e continuam imediatos (12 ms e 25 ms, medidos). */
  var LOOKAHEAD_MAX = 2.5;       // teto absoluto da janela efetiva
  var HIDDEN_LOOKAHEAD = 2.5;    // aba escondida: timer estrangulado a 1 s
  var BOOST_TAU = 6.0;           // relaxamento da folga conquistada (segundos)
  var lookaheadBoost = 0;        // folga extra conquistada na marra
  var lastGapWall = -1;          // instante da ultima bombeada, para medir o vao
  var schedTimer = 0;
  var schedWorker = null;     // fonte de tick imune a fome da thread principal
  var schedWorkerURL = '';
  var lastPumpWall = -1;
  var schedCursor = 0;        // ate onde ja pedimos musica ao GH.Synth (cru)

  var suppressAutoAdvance = false;   // avanco virtual explicito ja aconteceu

  // Buffer reaproveitado no despacho de eventos: zero alocacao no loop quente.
  var evPool = [];
  var evCount = 0;

  /* --- helpers ------------------------------------------------------------- */

  function wallNow() {
    if (window.performance && window.performance.now) return window.performance.now() * 0.001;
    return Date.now() * 0.001;
  }

  function isCaptureMode() {
    try {
      if (window.__GH_CAP) return true;
      var s = (window.location && window.location.search) || '';
      if (/[?&]cap=/.test(s)) return true;
    } catch (e) {}
    return false;
  }

  function offsetSec() {
    var S = GH.Settings;
    return (S.audioOffsetMs + S.videoOffsetMs) / 1000;
  }

  function safeSynth(method, a, b, c) {
    var s = GH.Synth;
    if (!s || typeof s[method] !== 'function') return;
    try { s[method](a, b, c); } catch (e) { /* o synth nunca derruba o relogio */ }
  }

  function round3(v) {
    return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : null;
  }

  function flightPush(entry) {
    entry.seq = ++flightSeq;
    entry.wall = round3(wallNow());
    try {
      entry.ctx = ctx ? round3(ctx.currentTime) : null;
      entry.state = ctx ? String(ctx.state || 'unknown') : 'virtual';
    } catch (e) { entry.ctx = null; entry.state = 'error'; }
    entry.song = round3(smoothRaw);
    entry.cursor = round3(schedCursor);
    entry.stalled = !!ctxDead;
    entry.stallCount = ctxDeadCount;
    flight.push(entry);
    if (flight.length > FLIGHT_MAX) flight.splice(0, flight.length - FLIGHT_MAX);
  }

  function flightEvent(kind, detail) {
    var e = { type: String(kind || 'event') }, k;
    if (detail) {
      for (k in detail) {
        if (Object.prototype.hasOwnProperty.call(detail, k)) e[k] = detail[k];
      }
    }
    flightPush(e);
  }

  function flightSample(force) {
    var w = wallNow();
    if (!force && w - flightLastWall < FLIGHT_PERIOD) return;
    flightLastWall = w;
    var e = { type: 'sample' };
    try {
      if (ctx && typeof ctx.getOutputTimestamp === 'function') {
        var ts = ctx.getOutputTimestamp();
        if (ts) {
          e.outCtx = round3(ts.contextTime);
          e.outPerf = round3(ts.performanceTime);
        }
      }
      if (ctx) {
        e.baseLatency = round3(ctx.baseLatency);
        e.outputLatency = round3(ctx.outputLatency);
      }
    } catch (eTs) { /* timestamp e opcional */ }
    try {
      var sd = GH.Synth && GH.Synth.diag ? GH.Synth.diag() : null;
      if (sd) {
        e.voices = sd.voices; e.activeNodes = sd.activeNodes; e.liveNodes = sd.liveNodes;
        e.queued = sd.scheduled; e.past = sd.past; e.dropped = sd.dropped;
        e.rearm = sd.rearm; e.stopAll = sd.stopAll;
      }
    } catch (eSyn) { /* diagnostico nao interfere no audio */ }
    e.skips = _sd.skips;
    e.skippedSec = round3(_sd.skippedSec);
    flightPush(e);
  }

  /* --- MAPA DE ANDAMENTO ---------------------------------------------------
   * segs[i] = { t: segundos, bpm: number, beat: batidas acumuladas ate t }
   * Suporta mudanca de andamento no meio da musica; entre dois pontos o
   * andamento e constante (nao interpolamos — isso e o que charts reais fazem).
   * ------------------------------------------------------------------------ */
  function buildTempoMap(s) {
    var raw = [], i, e;

    if (s && Object.prototype.toString.call(s.tempoMap) === '[object Array]' && s.tempoMap.length) {
      for (i = 0; i < s.tempoMap.length; i++) {
        e = s.tempoMap[i];
        if (e && isFinite(e.t) && isFinite(e.bpm) && e.bpm > 0) raw.push({ t: Math.max(0, e.t), bpm: e.bpm });
      }
    } else if (s && Object.prototype.toString.call(s.bpm) === '[object Array]' && s.bpm.length) {
      // song.bpm pode vir como array de mudancas [{t,bpm}] ou de numeros.
      for (i = 0; i < s.bpm.length; i++) {
        e = s.bpm[i];
        if (e && typeof e === 'object' && isFinite(e.t) && e.bpm > 0) raw.push({ t: Math.max(0, e.t), bpm: e.bpm });
        else if (isFinite(e) && e > 0 && raw.length === 0) raw.push({ t: 0, bpm: e });
      }
    }

    if (!raw.length) {
      var b = (s && isFinite(s.bpm) && s.bpm > 0) ? s.bpm : 120;
      raw.push({ t: 0, bpm: b });
    }

    raw.sort(function (x, y) { return x.t - y.t; });
    if (raw[0].t > 0) raw.unshift({ t: 0, bpm: raw[0].bpm });

    // Remove duplicatas no mesmo instante (fica valendo a ultima).
    var clean = [];
    for (i = 0; i < raw.length; i++) {
      if (clean.length && Math.abs(clean[clean.length - 1].t - raw[i].t) < 1e-6) clean[clean.length - 1] = raw[i];
      else clean.push(raw[i]);
    }

    // Batidas acumuladas em cada fronteira.
    clean[0].beat = 0;
    for (i = 1; i < clean.length; i++) {
      clean[i].beat = clean[i - 1].beat + (clean[i].t - clean[i - 1].t) * clean[i - 1].bpm / 60;
    }
    segs = clean;
  }

  function segAtTime(t) {
    if (!segs.length) return null;
    if (t <= segs[0].t) return segs[0];
    var lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (segs[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return segs[lo];
  }

  function segAtBeat(b) {
    if (!segs.length) return null;
    if (b <= segs[0].beat) return segs[0];
    var lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (segs[mid].beat <= b) lo = mid; else hi = mid - 1;
    }
    return segs[lo];
  }

  function bpmAt(t) {
    var s = segAtTime(isFinite(t) ? t : 0);
    return s ? s.bpm : 120;
  }

  function beatAt(t) {
    if (!isFinite(t)) return 0;
    var s = segAtTime(t);
    if (!s) return t * 2;               // 120 bpm de emergencia
    return s.beat + (t - s.t) * s.bpm / 60;
  }

  function timeAtBeat(b) {
    if (!isFinite(b)) return 0;
    var s = segAtBeat(b);
    if (!s) return b * 0.5;
    return s.t + (b - s.beat) * 60 / s.bpm;
  }

  function barAt(t) { return beatAt(t) / beatsPerBar; }
  function timeAtBar(b) { return timeAtBeat(b * beatsPerBar); }

  /* --- RELOGIO ------------------------------------------------------------- */

  // Posicao crua exata derivada do relogio de audio (sem suavizacao).
  // Com o relogio de audio PARADO, a verdade passa a ser a estimativa suavizada
  // (que anda pelo relogio de parede) — senao o agendador do Synth ficaria
  // pedindo eternamente a mesma janela de musica.
  function rawAudioNow() {
    if (!ctx) return virtualRaw;
    if (!playing) return pausedRaw;
    if (ctxDead) return smoothRaw;
    return (ctx.currentTime - startCtxTime) + startOffset;
  }

  /* Reancora o relogio de audio no tempo que o jogo ja esta mostrando.
     Depois disto `target` vale exatamente `smoothRaw`, entao a volta do audio
     nao produz degrau nenhum na pista.

     REANCORAR E UM SALTO NO TEMPO — e por isso CANCELA A FILA.
     Medido na bancada shots/_dupcheck.html (regime 8b, seis engasgos de
     120 ms do dispositivo): sem este stopAll(), a volta do relogio de audio
     agendava 289 eventos PELA SEGUNDA VEZ, 198 deles audiveis, com as duas
     copias separadas por ~100 ms. Bumbo, caixa, ganza e guitarra tocando duas
     vezes com um decimo de segundo de defasagem — exatamente a "trepidada de
     ruido" relatada pelo jogador.
     A cadeia era esta: o relogio de audio para -> o vigia declara o contexto
     morto -> o cursor da janela e arrastado de volta para `smoothRaw`, ate
     uma janela inteira ATRAS de onde a musica ja tinha sido entregue ao
     hardware -> o relogio volta, reancoramos, e a proxima janela comeca no
     passado -> GH.Synth ve o cursor recuar e REABILITA os eventos daquele
     trecho -> as vozes ja enfileiradas continuam la, e as novas entram por
     cima. Ninguem tinha agendado duas vezes por concorrencia entre as fontes
     de tick: quem duplicava era a propria recuperacao do relogio.
     A epoca (`audioEpoch`) muda aqui, entao TUDO que ja foi entregue com a
     epoca antiga esta no instante errado. Cancelar e a unica leitura correta:
     e a mesma disciplina que start(), pause(), resume() e seek() ja seguem —
     todo salto no tempo cancela a fila. */
  function reanchorCtx() {
    if (!ctx) return;
    flightEvent('reanchor', { oldEpoch: round3(startCtxTime - startOffset) });
    safeSynth('stopAll', 'reanchor');
    startCtxTime = ctx.currentTime;
    startOffset = smoothRaw;
    schedCursor = smoothRaw;
    /* O vao atravessado pelo engasgo do dispositivo nao diz nada sobre a
       saude da thread principal: nao pode virar folga de lookahead. */
    lastGapWall = -1;
  }

  /* Declara o relogio de audio morto.
     Nao ha tempo a devolver: desde que o ramo de ressincronizacao parou de
     puxar `smoothRaw` para tras, nada e engolido durante a suspeita — a
     estimativa apenas SEGURA no lugar ate o vigia decidir. Devolver os
     CTX_STALL_SEC aqui, como a versao anterior fazia, produziria agora um
     degrau para FRENTE de ~250 ms (medido no harness: 4,05 s -> 4,33 s), que
     teleporta a pista. O jogo simplesmente retoma dali, andando pelo relogio de
     parede: monotono, sem salto, sem marcha a re. */
  function declareDead() {
    ctxStall = 0;
    ctxQuiet = 0;
  }

  /* Vigia: devolve true quando o relogio de audio esta parado (e portanto o
     tempo do jogo tem que vir do relogio de parede). Chamado uma vez por
     amostragem, com o dt de parede daquela amostragem. */
  function watchAudioClock(dtWall) {
    var t = ctx.currentTime;
    var moved = (ctxLastTime >= 0) ? (t - ctxLastTime) : 0;
    ctxLastTime = t;

    /* Contexto explicitamente suspenso/fechado: morto na hora, sem esperar. */
    var st = ctx.state;
    if (st === 'suspended' || st === 'closed' || st === 'interrupted') {
      if (!ctxDead) {
        ctxDead = true; ctxDeadCount++; declareDead();
        flightEvent('audio-dead', { reason: 'state-' + st });
        if (!hiddenTab()) safeSynth('onAudioStall', 'state-' + st);
      }
      ctxAwake = 0;
      return true;
    }

    if (!ctxDead) {
      if (moved > 0) { ctxStall = 0; }
      else {
        ctxStall += dtWall;
        if (ctxStall > CTX_STALL_SEC) {
          ctxDead = true; ctxDeadCount++; ctxAwake = 0; declareDead();
          flightEvent('audio-dead', { reason: 'clock-not-moving' });
          if (!hiddenTab()) safeSynth('onAudioStall', 'clock-not-moving');
        }
      }
    } else {
      /* Morto: so volta a valer depois de andar de verdade por um tempinho —
         um unico degrau pode ser ruido de medicao.
         ATENCAO: `sampleClock()` roda a CADA leitura de GH.Conductor.time — e
         o jogo le esse getter dezenas de vezes por frame (input, juiz, pista,
         notas, HUD...). Todas as leituras depois da primeira tem dtWall = 0 e
         `moved` = 0, porque o relogio de audio so anda em blocos de render.
         Zerar `ctxAwake` nessas leituras tornava a VOLTA IMPOSSIVEL: o contador
         era destruido antes de chegar aos 50 ms e o maestro ficava no relogio
         de parede para sempre — com o agendador do Synth desligado, ou seja,
         a musica nunca mais tocava mesmo depois do audio voltar.
         Por isso o contador de "quieto" tambem e em tempo de PAREDE: uma
         amostra sem movimento nao derruba nada; so derruba se o audio ficar
         parado outra vez por um periodo inteiro de suspeita. */
      if (moved > 0) {
        ctxQuiet = 0;
        ctxAwake += dtWall;
        if (ctxAwake > CTX_WAKE_SEC) {
          ctxDead = false; ctxStall = 0; ctxAwake = 0; ctxQuiet = 0;
          reanchorCtx();
        }
      } else {
        ctxQuiet += dtWall;
        if (ctxQuiet > CTX_STALL_SEC) { ctxAwake = 0; ctxQuiet = 0; }
      }
    }
    return ctxDead;
  }

  /* Amostra o relogio.
   *
   * O truque: ctx.currentTime so avanca em degraus (um bloco de render de cada
   * vez). Ler direto dele faz a pista "tremer". Entao mantemos uma estimativa
   * propria que:
   *   1) avanca com o relogio de parede (previsao — suave por natureza);
   *   2) leva uma correcao PROPORCIONAL ao erro contra o relogio de audio.
   *
   * Como a correcao e sempre proporcional ao erro medido contra o audio, a
   * estimativa NUNCA deriva: o erro em regime permanente vale
   * (diferenca de taxa entre os cristais)/SMOOTH_K, algo como 0,1 ms.
   * E, como a previsao e continua, nao ha degrau visivel.
   */
  function sampleClock() {
    var w = wallNow();
    var dt = haveWall ? (w - lastWall) : 0;
    lastWall = w;
    haveWall = true;
    if (!(dt > 0) || dt > MAX_FRAME_SEC) dt = 0;

    if (virtual || !ctx) { smoothRaw = virtualRaw; return smoothRaw; }
    if (!playing) { smoothRaw = pausedRaw; return smoothRaw; }

    /* O relogio de audio esta vivo? Se nao estiver, o tempo do jogo continua
       andando pelo relogio de parede — a musica pode ter emudecido, mas a
       partida NAO pode congelar (era exatamente esse o bug do "nao acerto
       nenhuma nota": tempo cravado, todo input julgado a segundos da nota). */
    if (watchAudioClock(dt)) {
      smoothRaw += dt;
      return smoothRaw;
    }

    var target = (ctx.currentTime - startCtxTime) + startOffset;
    var predicted = smoothRaw + dt;
    var err = target - predicted;

    if (err > RESYNC_SEC) {
      smoothRaw = target;                       // audio A FRENTE: salta e segue
    } else if (err < -RESYNC_SEC) {
      /* Audio ATRAS da nossa estimativa por mais que a folga. Tocando, isso so
         acontece quando o relogio de audio esta engasgando. A versao anterior
         ressincronizava SECO tambem para tras — e como o preditor voltava a
         andar no frame seguinte, o tempo do jogo ficava PINGANDO: medido no
         harness, 4,09 s -> 4,03 s -> 4,09 s -> 4,03 s durante os 250 ms de
         suspeita. Sao 60-75 ms de vaivem, mais que a janela de acerto inteira
         (+-70 ms): a pista anda de re e o juiz ve a nota sair e voltar.
         O tempo musical NUNCA anda para tras enquanto toca — a mesma regra que
         o ramo suave ja obedecia. Entao seguramos a estimativa parada e
         deixamos o audio alcancar; se ele nao alcancar, o vigia declara o
         relogio morto em CTX_STALL_SEC e o tempo volta pelo relogio de parede. */
      /* smoothRaw permanece onde esta */
    } else {
      var k = SMOOTH_K * dt;
      if (k > 1) k = 1;
      var next = predicted + err * k;
      // O tempo musical nunca anda para tras enquanto tocando.
      smoothRaw = next < smoothRaw ? smoothRaw : next;
    }
    return smoothRaw;
  }

  function timeNow() { return smoothRaw - offsetSec(); }

  /* --- EVENTOS -------------------------------------------------------------
   * Regra de ordem quando dois eventos caem no MESMO instante:
   *   1) section  2) bar  3) beat
   * Estrutura maior primeiro: quem ouve a secao ja trocou de estado quando o
   * pulso do compasso chega, e o pulso da batida fecha por ultimo.
   * ------------------------------------------------------------------------ */
  function pushEvent(t, kind, index) {
    if (evCount >= MAX_EVENTS_PER_DISPATCH) return;
    var e = evPool[evCount];
    if (!e) { e = { t: 0, k: 0, i: 0 }; evPool[evCount] = e; }
    e.t = t; e.k = kind; e.i = index;
    evCount++;
  }

  function sortEvents() {
    // Insertion sort: a lista tem tipicamente 1 a 4 itens por frame.
    for (var i = 1; i < evCount; i++) {
      var cur = evPool[i], j = i - 1;
      while (j >= 0 && (evPool[j].t > cur.t || (evPool[j].t === cur.t && evPool[j].k > cur.k))) {
        evPool[j + 1] = evPool[j];
        j--;
      }
      evPool[j + 1] = cur;
    }
  }

  function fire(list, a, b) {
    for (var i = 0; i < list.length; i++) {
      try { list[i](a, b); } catch (e) { /* um ouvinte quebrado nao para a musica */ }
    }
  }

  function resetEventCursors(atTime) {
    lastEventTime = atTime - 1e-6;
    lastSectionIdx = -1;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].t <= lastEventTime) lastSectionIdx = i; else break;
    }
    lastBeatIdx = Math.floor(beatAt(lastEventTime));
    lastBarIdx = Math.floor(barAt(lastEventTime));
  }

  function dispatchEvents() {
    // Sem musica carregada o mapa padrao (120 bpm 4/4) continua valendo: menus
    // e telas de titulo podem pulsar no ritmo sem precisar de um chart.
    var now = timeNow();
    var prev = lastEventTime;

    if (now <= prev) { return; }                 // tempo parado ou andando para tras
    if (now - prev > MAX_CATCHUP_SEC) {          // pulo: reposiciona sem disparar
      resetEventCursors(now);
      lastEventTime = now;
      return;
    }

    evCount = 0;

    // --- batidas: todo inteiro k com prev < timeAtBeat(k) <= now
    var b0 = beatAt(prev), b1 = beatAt(now);
    var kBeat = Math.floor(b0) + 1;
    var kBeatEnd = Math.floor(b1);
    var guard = 0;
    while (kBeat <= kBeatEnd && guard++ < MAX_EVENTS_PER_DISPATCH) {
      pushEvent(timeAtBeat(kBeat), 2, kBeat);
      kBeat++;
    }

    // --- compassos
    var r0 = b0 / beatsPerBar, r1 = b1 / beatsPerBar;
    var kBar = Math.floor(r0) + 1;
    var kBarEnd = Math.floor(r1);
    guard = 0;
    while (kBar <= kBarEnd && guard++ < MAX_EVENTS_PER_DISPATCH) {
      pushEvent(timeAtBar(kBar), 1, kBar);
      kBar++;
    }

    // --- secoes
    var si = lastSectionIdx + 1;
    while (si < sections.length && sections[si].t <= now) {
      if (sections[si].t > prev) pushEvent(sections[si].t, 0, si);
      lastSectionIdx = si;
      si++;
    }

    lastEventTime = now;
    if (!evCount) return;

    sortEvents();
    for (var i = 0; i < evCount; i++) {
      var e = evPool[i];
      if (e.k === 0) {
        fire(listeners.section, sections[e.i], sections[e.i].t);
      } else if (e.k === 1) {
        lastBarIdx = e.i;
        fire(listeners.bar, e.i, e.t);
      } else {
        lastBeatIdx = e.i;
        fire(listeners.beat, e.i, e.t);
      }
    }
    evCount = 0;
  }

  /* --- LOOKAHEAD SCHEDULER -------------------------------------------------
   * "A Tale of Two Clocks" (Chris Wilson): um setInterval grosseiro acorda a
   * cada 25 ms e pede ao GH.Synth que agende TUDO que cai nos proximos 200 ms.
   * O setInterval so precisa ser pontual o suficiente para nao perder a janela;
   * a precisao de verdade vem de o Synth marcar cada evento com um tempo
   * absoluto de ctx (start(t)/setValueAtTime(t)), que o hardware honra na
   * amostra exata.
   *
   * A janela e em tempo CRU (rawTime), nao no tempo compensado: os offsets de
   * latencia existem para alinhar julgamento e imagem ao que se ouve, nao para
   * deslocar a propria musica.
   * ------------------------------------------------------------------------ */
  /* Diagnostico do agendador (GH.Conductor.schedDiag).
     `skippedSec` e a medida do dano: segundos de MUSICA que a janela de
     lookahead nunca chegou a pedir porque o tick chegou tarde demais. Cada
     segundo aqui e um punhado de notas que simplesmente nao tocaram. */
  var _sd = { ticks: 0, maxGapMs: 0, lastTickWall: -1, skips: 0, skippedSec: 0, src: {} };

  function schedDiagTick(src) {
    var w = wallNow();
    if (_sd.lastTickWall >= 0) {
      var gap = (w - _sd.lastTickWall) * 1000;
      if (gap > _sd.maxGapMs) _sd.maxGapMs = gap;
    }
    _sd.lastTickWall = w;
    _sd.ticks++;
    _sd.src[src] = (_sd.src[src] || 0) + 1;
  }

  /* A aba esta escondida? Consultado a cada bombeada (leitura de propriedade,
     custo zero) para cobrir tambem o caso em que a pagina JA nasce escondida
     e o evento visibilitychange nunca chega. */
  function hiddenTab() {
    try { return !!(window.document && window.document.hidden); } catch (e) { return false; }
  }

  /* Janela efetiva: base + folga aprendida, com piso de aba escondida e teto
     duro. Nunca menor que a base configurada. */
  function effLookahead() {
    var la = lookahead + lookaheadBoost;
    if (hiddenTab() && la < HIDDEN_LOOKAHEAD) la = HIDDEN_LOOKAHEAD;
    return la > LOOKAHEAD_MAX ? LOOKAHEAD_MAX : la;
  }

  /* Aprende com o intervalo REAL entre duas bombeadas. Nao e estimativa de
     fps: e o vao de verdade entre duas oportunidades de agendar, que e
     exatamente o que a janela precisa cobrir. */
  function learnGap(w) {
    if (lastGapWall >= 0) {
      var gap = w - lastGapWall;
      if (gap > 0) {
        if (lookaheadBoost > 0) {
          lookaheadBoost *= Math.exp(-gap / BOOST_TAU);
          if (lookaheadBoost < 0.005) lookaheadBoost = 0;
        }
        /* So aprende com vao que AMEACOU a janela de verdade.
           Um quadro de 16 ms nao ensina nada e nao pode inflar a fila; e um
           salto absurdo (maquina que dormiu e acordou, relogio de tempo
           virtual do headless) tambem nao e fome de thread — quem cuida
           desse caso e o vigia do relogio de audio, nao a janela. Sem estes
           dois limites a janela cresceria em ambientes onde nada esta
           errado, e o proprio agendador viraria fonte de engasgo: cada
           janela e um lote de vozes montado de uma vez na thread principal. */
        if (gap > effLookahead() * 0.6 && gap < 5) {
          var need = gap * 1.6 + 0.15 - lookahead;
          if (need > lookaheadBoost) {
            lookaheadBoost = need > (LOOKAHEAD_MAX - lookahead) ? (LOOKAHEAD_MAX - lookahead) : need;
          }
        }
      }
    }
    lastGapWall = w;
  }

  function schedulerTick() {
    if (!playing || !ctx || !loaded) return;
    /* Relogio de audio parado: nao adianta agendar nada — o tempo absoluto do
       ctx nao esta andando e a fila so acumularia eventos que estourariam
       todos de uma vez quando o audio voltasse. Arrastamos o cursor junto com
       o tempo do jogo e esperamos o vigia reancorar. */
    /* O CURSOR SO ANDA PARA FRENTE.
       Aqui a intencao e nao deixar o cursor apodrecendo no passado enquanto o
       audio esta morto; a versao anterior fazia isso com uma atribuicao seca,
       que ARRASTAVA o cursor para tras (o cursor ja estava uma janela inteira
       a frente de `rawAudioNow()`). Um cursor que recua e, para GH.Synth, um
       pedido de reagendar musica ja entregue — ver o comentario em
       reanchorCtx(). Mover so para frente mantem a particao das janelas
       disjunta, que e o que torna as tres fontes de tick (setInterval, quadro
       e Worker) inofensivas umas as outras. */
    if (ctxDead) {
      var rd = rawAudioNow();
      if (rd > schedCursor) { schedCursor = rd; }
      return;
    }
    var raw = rawAudioNow();
    var until = raw + effLookahead();
    var from = schedCursor;
    // Se a aba ficou em segundo plano, o intervalo e estrangulado e o cursor
    // fica no passado. Nao adianta agendar o que ja passou: pula pra frente.
    if (from < raw - LATE_GRACE) {
      _sd.skips++;
      _sd.skippedSec += (raw - LATE_GRACE) - from;
      flightEvent('scheduler-skip', { seconds: round3((raw - LATE_GRACE) - from) });
      from = raw - LATE_GRACE;
    }
    if (until <= from) return;
    safeSynth('schedule', song, from, until);
    schedCursor = until;
  }

  /* Uma unica porta de entrada para todas as fontes de tick. schedulerTick()
     e idempotente (a janela so anda para frente), entao ter varias fontes e
     seguro: o que uma perde, a outra cobre. O estrangulamento so existe para
     nao repetir trabalho inutil dentro do mesmo milissegundo. */
  function pumpScheduler(src, force) {
    if (!playing || !ctx || !loaded) return;
    var w = wallNow();
    if (!force && lastPumpWall >= 0 && (w - lastPumpWall) < PUMP_MIN_SEC) return;
    lastPumpWall = w;
    learnGap(w);
    schedDiagTick(src);
    schedulerTick();
    flightSample(false);
  }

  /* A ABA SUMIU. O navegador estrangula setInterval para >= 1 s e para o rAF
     no mesmo instante — as duas fontes de tick de uma vez. Este evento chega
     ANTES do estrangulamento valer, entao e a unica chance de reabastecer a
     fila com a janela ja maior. Sem `force`, a garganta de 8 ms do pump
     poderia justamente engolir esta bombeada, que e a que importa.
     Voltando a ser visivel, o vao atravessado nao ensina nada (a musica
     continuou tocando o tempo todo), so zeramos a medida. */
  function onVisibilityChange() {
    lastGapWall = -1;
    try { pumpScheduler('visibility', true); } catch (e) {}
  }

  try {
    if (window.document && window.document.addEventListener) {
      window.document.addEventListener('visibilitychange', onVisibilityChange, false);
    }
  } catch (eVis) { /* sem document: nada a fazer, o timer continua valendo */ }

  /* FONTE DE TICK EM WEB WORKER.
   *
   * O timer de um Worker nao e estrangulado pelo trabalho de render nem pelo
   * "intensive throttling" que o Chrome aplica a aba em segundo plano. Sem
   * arquivo externo: o codigo do worker nasce de um Blob local (nao e rede,
   * nao viola a regra de "zero URL externa").
   *
   * MEDIDO, e a verdade e desconfortavel: em `file://` o Chrome recusa
   * silenciosamente o worker de Blob — a bancada shots/_workerprobe.html
   * mediu 0 ticks, sem excecao e sem onerror. Por isso o setInterval NUNCA
   * e desligado: o worker e um reforco, nao um substituto. Onde ele
   * funciona (GitHub Pages, http/https) o jogo ganha um relogio que a
   * thread principal nao consegue matar; onde nao funciona, nada muda.
   *
   * E preciso ser honesto sobre o que o worker NAO resolve: se a thread
   * principal ficar presa 300 ms, a mensagem dele tambem so e entregue
   * quando ela voltar. Quem salva a musica nesse caso e o LOOKAHEAD. */
  function startWorkerClock() {
    if (schedWorker) return;
    try {
      if (typeof window.Worker !== 'function') return;
      if (typeof window.Blob !== 'function') return;
      if (!window.URL || typeof window.URL.createObjectURL !== 'function') return;
      var src =
        'var id=0;' +
        'self.onmessage=function(e){var d=e.data||{};' +
        'if(d.cmd===\'start\'){if(id)clearInterval(id);id=setInterval(function(){self.postMessage(1);},d.ms||100);}' +
        'else if(d.cmd===\'stop\'){if(id)clearInterval(id);id=0;}};';
      schedWorkerURL = window.URL.createObjectURL(new window.Blob([src], { type: 'application/javascript' }));
      schedWorker = new window.Worker(schedWorkerURL);
      schedWorker.onmessage = function () { pumpScheduler('worker'); };
      schedWorker.onerror = function () { stopWorkerClock(); };
      schedWorker.postMessage({ cmd: 'start', ms: TICK_MS });
    } catch (e) {
      /* Sem worker o jogo continua igual: o setInterval e o tick por quadro
         ja cobrem tudo. Nunca e fatal. */
      stopWorkerClock();
    }
  }

  function stopWorkerClock() {
    try { if (schedWorker) { schedWorker.onmessage = null; schedWorker.terminate(); } } catch (e) {}
    schedWorker = null;
    try { if (schedWorkerURL && window.URL && window.URL.revokeObjectURL) window.URL.revokeObjectURL(schedWorkerURL); } catch (e2) {}
    schedWorkerURL = '';
  }

  function startScheduler() {
    stopScheduler();
    if (!ctx) return;                 // sem audio nao ha nada para agendar
    schedTimer = window.setInterval(function () { pumpScheduler('timer'); }, TICK_MS);
    startWorkerClock();
    lastPumpWall = -1;
    /* O intervalo atravessado por uma pausa (ou pela troca de musica) nao
       ensina nada sobre a saude da thread: nao pode virar folga. */
    lastGapWall = -1;
    schedDiagTick('start');
    schedulerTick();                  // primeira janela imediatamente
  }

  function stopScheduler() {
    if (schedTimer) { window.clearInterval(schedTimer); schedTimer = 0; }
    stopWorkerClock();
    lastPumpWall = -1;
  }

  /* --- CICLO DE VIDA ------------------------------------------------------- */

  /* Zera o vigia. Chamado sempre que a base de tempo muda de dono
     (troca de contexto, start, resume, seek): o historico anterior nao vale
     mais e comecar "desconfiando" atrasaria o jogo por 250 ms a toa. */
  function resetWatchdog() {
    ctxDead = false;
    ctxLastTime = -1;
    ctxStall = 0;
    ctxAwake = 0;
    ctxQuiet = 0;
  }

  function setClockSource(audioCtx) {
    ctx = audioCtx || null;
    virtual = !ctx;
    resetWatchdog();
    flightEvent('clock-source', { source: virtual ? 'virtual' : 'audio-context' });
  }

  // Em captura nunca adotamos AudioContext. Fora dela, se o Audio subiu depois
  // do Conductor.init(), adotamos o contexto no primeiro start().
  function resolveClock() {
    if (ctx) return;
    if (isCaptureMode()) { virtual = true; return; }
    try {
      if (GH.Audio && GH.Audio.ctx) setClockSource(GH.Audio.ctx);
    } catch (e) {}
  }

  function init(audioCtx) {
    var c = audioCtx;
    if (typeof c === 'undefined') {
      c = null;
      if (!isCaptureMode()) {
        try { if (GH.Audio && GH.Audio.ctx) c = GH.Audio.ctx; } catch (e) {}
      }
    }
    setClockSource(c);
    buildTempoMap(song);
    haveWall = false;
    resetWatchdog();
    return GH.Conductor;
  }

  function load(s) {
    song = s || null;
    loaded = !!song;

    buildTempoMap(song);

    // Formula de compasso. Em 6/8, o "beat" continua sendo a seminima do bpm,
    // entao o compasso vale 6*(4/8) = 3 batidas. Isso mantem beatAt() coerente
    // com o bpm declarado, que e o que o chart usa.
    beatsPerBar = 4;
    if (song && Object.prototype.toString.call(song.timeSig) === '[object Array]' && song.timeSig.length >= 2) {
      var num = song.timeSig[0], den = song.timeSig[1];
      if (num > 0 && den > 0) beatsPerBar = num * 4 / den;
    }
    if (!(beatsPerBar > 0)) beatsPerBar = 4;

    sections = [];
    if (song && Object.prototype.toString.call(song.sections) === '[object Array]') {
      for (var i = 0; i < song.sections.length; i++) {
        var sec = song.sections[i];
        if (!sec || !isFinite(sec.t)) continue;
        sections.push({ t: Math.max(0, sec.t), name: sec.name || ('Secao ' + (i + 1)), index: sections.length, src: sec });
      }
      sections.sort(function (a, b) { return a.t - b.t; });
      for (var j = 0; j < sections.length; j++) sections[j].index = j;
    }

    duration = (song && isFinite(song.durationSec) && song.durationSec > 0) ? song.durationSec : 0;

    playing = false;
    startOffset = 0; pausedRaw = 0; virtualRaw = 0; smoothRaw = 0;
    schedCursor = 0;
    haveWall = false;
    resetWatchdog();
    /* Carregar outra musica devolve a posse do relogio virtual: a proxima
       execucao pode escolher de novo entre update(dt) e advanceVirtual(dt). */
    suppressAutoAdvance = false;
    resetEventCursors(0);

    // Ajusta o eco ao andamento da musica: o slapback da guitarrada so soa
    // certo quando esta amarrado no tempo (colcheia pontuada por padrao).
    try {
      if (GH.Audio && GH.Audio.syncDelayToTempo) GH.Audio.syncDelayToTempo(bpmAt(0), 0.75);
    } catch (e2) {}

    safeSynth('prepare', song);
    return GH.Conductor;
  }

  function start(offsetSec_) {
    resolveClock();
    var off = (typeof offsetSec_ === 'number' && isFinite(offsetSec_)) ? offsetSec_ : 0;
    if (off < -30) off = -30;

    /* Comecar do zero e um SALTO no tempo, exatamente como seek(). Se alguem
       chamar start() sem parar antes (reiniciar depois de falhar, trocar de
       musica pelo menu), existe ate uma janela inteira de musica velha ja
       entregue ao hardware, que tocaria por cima da nova. stopAll() fecha
       essas vozes com rampa e reabilita o plano. Quando start() vem depois
       de stop(), como no fluxo normal do jogo, isto e um no-op. */
    flightEvent('start', { offset: round3(off) });
    safeSynth('stopAll', 'start');
    lookaheadBoost = 0;          // musica nova, historia de fome zerada

    playing = true;
    if (ctx) {
      startCtxTime = ctx.currentTime;
      startOffset = off;
    } else {
      virtualRaw = off;
    }
    pausedRaw = off;
    smoothRaw = off;
    haveWall = false;
    resetWatchdog();
    schedCursor = off;
    resetEventCursors(off - offsetSec());
    startScheduler();
    return GH.Conductor;
  }

  function pause() {
    if (!playing) return GH.Conductor;
    pausedRaw = rawAudioNow();
    playing = false;
    smoothRaw = pausedRaw;
    stopScheduler();
    flightEvent('pause', { at: round3(pausedRaw) });
    safeSynth('stopAll', 'pause');
    return GH.Conductor;
  }

  function resume() {
    if (playing) return GH.Conductor;
    resolveClock();
    playing = true;
    if (ctx) {
      startCtxTime = ctx.currentTime;
      startOffset = pausedRaw;
    } else {
      virtualRaw = pausedRaw;
    }
    smoothRaw = pausedRaw;
    haveWall = false;
    resetWatchdog();
    schedCursor = pausedRaw;                 // nao reagenda o que ficou na pausa
    resetEventCursors(pausedRaw - offsetSec());
    startScheduler();
    flightEvent('resume', { at: round3(pausedRaw) });
    return GH.Conductor;
  }

  function stop() {
    playing = false;
    stopScheduler();
    flightEvent('stop', { at: round3(smoothRaw) });
    safeSynth('stopAll', 'stop');
    pausedRaw = 0; virtualRaw = 0; smoothRaw = 0; schedCursor = 0;
    haveWall = false;
    resetWatchdog();
    resetEventCursors(0);
    return GH.Conductor;
  }

  // Salta para uma posicao sem disparar as batidas do caminho.
  function seek(t) {
    var v = (typeof t === 'number' && isFinite(t)) ? t : 0;
    /* Com lookahead de 0,75 s existe ate 3/4 de segundo de musica JA
       agendada no hardware. Saltar sem cancelar deixaria essa fila tocar
       por cima da posicao nova — som do trecho antigo em cima do novo.
       stopAll() fecha as vozes com rampa e reabilita o plano. */
    flightEvent('seek', { to: round3(v) });
    safeSynth('stopAll', 'seek');
    if (ctx && playing) {
      startCtxTime = ctx.currentTime;
      startOffset = v;
    }
    pausedRaw = v;
    virtualRaw = v;
    smoothRaw = v;
    haveWall = false;
    resetWatchdog();
    schedCursor = v;
    resetEventCursors(v - offsetSec());
    return GH.Conductor;
  }

  /* --- ATUALIZACAO POR FRAME -----------------------------------------------
   * Tres padroes de uso convivem sem conflito:
   *   a) jogo normal: GH.Game chama update(dt) por frame;
   *   b) captura: main.js chama advanceVirtual(1/60) em passos fixos;
   *   c) captura simplificada: depois de start(t0), so update(dt) — no modo
   *      virtual o proprio update avanca o relogio.
   * REGRA DE POSSE DO RELOGIO VIRTUAL (endurecida na integracao):
   * assim que alguem chama advanceVirtual()/setVirtualTime() uma unica vez,
   * esse alguem passa a ser o DONO do relogio e o update() para de avancar
   * sozinho pelo resto da execucao. Antes disso a supressao era de um tiro so:
   * a sequencia advanceVirtual + update + update (que acontece de verdade
   * quando o game.js atualiza o Conductor e o main.js tambem chama dentro do
   * passo de captura) andava DOIS dt num frame, e o print saia fora do tempo.
   * Com a posse explicita, chamar update() N vezes por frame e inofensivo.
   * ------------------------------------------------------------------------ */
  function update(dt) {
    if (virtual) {
      if (suppressAutoAdvance) {
        /* nao zeramos mais o flag: o dono explicito continua no comando */
      } else if (playing && typeof dt === 'number' && isFinite(dt) && dt > 0) {
        virtualRaw += dt > MAX_FRAME_SEC ? MAX_FRAME_SEC : dt;
      }
    }
    sampleClock();
    dispatchEvents();
    /* O QUADRO TAMBEM E UMA FONTE DE TICK.
       Depois de um quadro de 300 ms, esperar mais um periodo do setInterval
       para reabastecer a janela e desperdicar o unico instante em que a
       thread esta livre. Aqui a janela e reabastecida na primeira
       oportunidade, sem timer nenhum, e em fatias de um quadro — o que
       tambem espalha o custo de montar vozes em vez de concentra-lo em
       rajadas de 100 ms. */
    pumpScheduler('frame');
    return timeNow();
  }

  function advanceVirtual(dt) {
    if (!virtual) return timeNow();
    // Respeita a pausa exatamente como o relogio de audio faria: pausado, o
    // tempo musical nao anda por mais que o loop de simulacao chame isto.
    if (playing && typeof dt === 'number' && isFinite(dt)) virtualRaw += dt;
    suppressAutoAdvance = true;
    sampleClock();
    dispatchEvents();
    return timeNow();
  }

  function setVirtualTime(t) {
    if (!virtual) return timeNow();
    // Posicionamento absoluto: vale mesmo pausado (e um seek, nao um avanco).
    if (typeof t === 'number' && isFinite(t)) { virtualRaw = t; pausedRaw = t; }
    suppressAutoAdvance = true;
    sampleClock();
    dispatchEvents();
    return timeNow();
  }

  /* --- INSCRICAO EM EVENTOS ------------------------------------------------ */
  function subscribe(list, fn) {
    if (typeof fn !== 'function') return function () {};
    list.push(fn);
    return function () {
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }
  function unsubscribe(list, fn) {
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /* --- CONVERSAO PARA O RELOGIO DO HARDWARE --------------------------------
   * GH.Synth precisa transformar "segundo 12,5 da musica" em "instante
   * absoluto do AudioContext". Estas duas funcoes sao o cambio oficial.
   * ------------------------------------------------------------------------ */
  function audioEpoch() {
    // ctx.currentTime correspondente ao segundo 0 (cru) da musica.
    if (!ctx) return 0;
    return startCtxTime - startOffset;
  }
  function ctxTimeAt(rawSongTime) {
    if (!ctx) return 0;
    return audioEpoch() + (isFinite(rawSongTime) ? rawSongTime : 0);
  }
  function songTimeAtCtx(ctxT) {
    if (!ctx) return 0;
    return (isFinite(ctxT) ? ctxT : 0) - audioEpoch();
  }

  function scheduleAhead(seconds) {
    if (typeof seconds === 'number' && isFinite(seconds)) {
      lookahead = seconds < 0.05 ? 0.05 : (seconds > 2 ? 2 : seconds);
    }
    return lookahead;
  }

  function sectionAt(t) {
    if (!sections.length) return null;
    var found = null;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].t <= t) found = sections[i]; else break;
    }
    return found;
  }

  /* --- API PUBLICA --------------------------------------------------------- */

  GH.Conductor = {
    init: function (audioCtx) { try { return init(audioCtx); } catch (e) { return GH.Conductor; } },
    load: function (s) { try { return load(s); } catch (e) { return GH.Conductor; } },
    start: function (o) { try { return start(o); } catch (e) { return GH.Conductor; } },
    pause: function () { try { return pause(); } catch (e) { return GH.Conductor; } },
    resume: function () { try { return resume(); } catch (e) { return GH.Conductor; } },
    stop: function () { try { return stop(); } catch (e) { return GH.Conductor; } },
    seek: function (t) { try { return seek(t); } catch (e) { return GH.Conductor; } },
    update: function (dt) { try { return update(dt); } catch (e) { return 0; } },

    // Relogio virtual (modo captura) — mesma API, sem AudioContext.
    setVirtualTime: function (t) { try { return setVirtualTime(t); } catch (e) { return 0; } },
    advanceVirtual: function (dt) { try { return advanceVirtual(dt); } catch (e) { return 0; } },

    // Mapa de andamento
    bpmAt: function (t) { try { return bpmAt(t); } catch (e) { return 120; } },
    beatAt: function (t) { try { return beatAt(t); } catch (e) { return 0; } },
    timeAtBeat: function (b) { try { return timeAtBeat(b); } catch (e) { return 0; } },
    barAt: function (t) { try { return barAt(t); } catch (e) { return 0; } },
    timeAtBar: function (b) { try { return timeAtBar(b); } catch (e) { return 0; } },
    sectionAt: function (t) { try { return sectionAt(t); } catch (e) { return null; } },

    // Eventos (devolvem uma funcao de cancelamento)
    onBeat: function (fn) { return subscribe(listeners.beat, fn); },
    onBar: function (fn) { return subscribe(listeners.bar, fn); },
    onSection: function (fn) { return subscribe(listeners.section, fn); },
    offBeat: function (fn) { unsubscribe(listeners.beat, fn); },
    offBar: function (fn) { unsubscribe(listeners.bar, fn); },
    offSection: function (fn) { unsubscribe(listeners.section, fn); },
    clearListeners: function () { listeners.beat.length = 0; listeners.bar.length = 0; listeners.section.length = 0; },

    // Agendamento antecipado (GH.Synth)
    scheduleAhead: scheduleAhead,
    ctxTimeAt: ctxTimeAt,
    songTimeAtCtx: songTimeAtCtx,
    tickIntervalMs: TICK_MS,

    /* Diagnostico do agendador — numeros, nao opiniao. */
    schedDiag: function () {
      return {
        ticks: _sd.ticks,
        maxGapMs: Math.round(_sd.maxGapMs * 10) / 10,
        skips: _sd.skips,
        skippedSec: Math.round(_sd.skippedSec * 1000) / 1000,
        lookahead: lookahead,
        lookaheadEff: Math.round(effLookahead() * 1000) / 1000,
        boost: Math.round(lookaheadBoost * 1000) / 1000,
        hidden: hiddenTab(),
        tickMs: TICK_MS,
        src: _sd.src,
        audioState: ctx ? String(ctx.state || 'unknown') : 'virtual',
        audioStallCount: ctxDeadCount,
        flightEntries: flight.length
      };
    },
    resetSchedDiag: function () {
      _sd.ticks = 0; _sd.maxGapMs = 0; _sd.lastTickWall = -1;
      _sd.skips = 0; _sd.skippedSec = 0; _sd.src = {};
    },
    flightDiag: function () { return flight.slice(0); },
    resetFlightDiag: function () {
      flight.length = 0; flightSeq = 0; flightLastWall = -1e9;
      flightEvent('flight-reset');
    }
  };

  /* --- getters ------------------------------------------------------------- */

  // Tempo de JOGO: ja compensado por audioOffsetMs + videoOffsetMs.
  Object.defineProperty(GH.Conductor, 'time', {
    get: function () { sampleClock(); return timeNow(); }
  });
  // Tempo CRU da musica (sem compensacao) — e o que o Synth agenda.
  Object.defineProperty(GH.Conductor, 'rawTime', {
    get: function () { sampleClock(); return smoothRaw; }
  });
  Object.defineProperty(GH.Conductor, 'beat', {
    get: function () { sampleClock(); return beatAt(timeNow()); }
  });
  Object.defineProperty(GH.Conductor, 'bar', {
    get: function () { sampleClock(); return beatAt(timeNow()) / beatsPerBar; }
  });
  // Fase dentro da batida (0..1) — pulso visual sem precisar de callback.
  Object.defineProperty(GH.Conductor, 'beatPhase', {
    get: function () {
      sampleClock();
      var b = beatAt(timeNow());
      return b - Math.floor(b);
    }
  });
  Object.defineProperty(GH.Conductor, 'barPhase', {
    get: function () {
      sampleClock();
      var r = beatAt(timeNow()) / beatsPerBar;
      return r - Math.floor(r);
    }
  });
  Object.defineProperty(GH.Conductor, 'bpm', { get: function () { sampleClock(); return bpmAt(timeNow()); } });
  Object.defineProperty(GH.Conductor, 'secondsPerBeat', { get: function () { sampleClock(); return 60 / bpmAt(timeNow()); } });
  Object.defineProperty(GH.Conductor, 'beatsPerBar', { get: function () { return beatsPerBar; } });
  Object.defineProperty(GH.Conductor, 'isPlaying', { get: function () { return playing; } });
  Object.defineProperty(GH.Conductor, 'isVirtual', { get: function () { return virtual; } });
  /* Diagnostico do vigia: true quando o relogio de audio parou e o tempo do
     jogo esta vindo do relogio de parede. O HUD/menu pode avisar o jogador,
     e o harness de input confere isto. */
  Object.defineProperty(GH.Conductor, 'audioStalled', { get: function () { return ctxDead; } });
  Object.defineProperty(GH.Conductor, 'audioStallCount', { get: function () { return ctxDeadCount; } });
  Object.defineProperty(GH.Conductor, 'song', { get: function () { return song; } });
  Object.defineProperty(GH.Conductor, 'duration', { get: function () { return duration; } });
  Object.defineProperty(GH.Conductor, 'progress', {
    get: function () {
      if (!(duration > 0)) return 0;
      sampleClock();
      var p = timeNow() / duration;
      return p < 0 ? 0 : (p > 1 ? 1 : p);
    }
  });
  Object.defineProperty(GH.Conductor, 'section', { get: function () { sampleClock(); return sectionAt(timeNow()); } });
  Object.defineProperty(GH.Conductor, 'sectionName', {
    get: function () { var s = GH.Conductor.section; return s ? s.name : ''; }
  });
  Object.defineProperty(GH.Conductor, 'sections', { get: function () { return sections; } });
  Object.defineProperty(GH.Conductor, 'tempoMap', { get: function () { return segs; } });
  Object.defineProperty(GH.Conductor, 'beatIndex', { get: function () { return lastBeatIdx; } });
  Object.defineProperty(GH.Conductor, 'barIndex', { get: function () { return lastBarIdx; } });
  Object.defineProperty(GH.Conductor, 'audioEpoch', { get: function () { return audioEpoch(); } });
  Object.defineProperty(GH.Conductor, 'lookahead', { get: function () { return lookahead; } });
  Object.defineProperty(GH.Conductor, 'ctx', { get: function () { return ctx; } });

  // Mapa de andamento padrao ja no parse: beat/bar funcionam mesmo antes de
  // qualquer musica ser carregada (menus pulsando a 120 bpm, por exemplo).
  buildTempoMap(null);
  resetEventCursors(0);

})(window.GH = window.GH || {});

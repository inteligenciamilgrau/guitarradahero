(function (GH) {
  'use strict';

  /* ==========================================================================
   * GUITARRADA HERO — src/core/input.js
   * Modulo: GH.Input   (dono: agente GAMEPLAY)
   *
   * Responsabilidade: transformar teclado/gamepad em EVENTOS MUSICAIS com
   * carimbo de tempo confiavel. Num jogo de ritmo o input nao e "qual tecla" —
   * e "em que instante da musica". Todo evento sai daqui ja com o tempo em
   * segundos de musica (GH.Conductor.time), compensado pela defasagem entre o
   * instante fisico do evento e o instante em que o handler roda.
   *
   * Contrato (ARCHITECTURE.md secao 6):
   *   GH.Input = {
   *     init(), isFret(i), isStrumDown(), justStrummed(),
   *     onFretDown(fn(i,tSec)), onFretUp(fn(i,tSec)),
   *     onStrum(fn(tSec)), onAction(fn(name)),
   *     bindings, setBinding(action, code), gamepadConnected
   *   }
   * Tudo o mais e API adicional (aditiva, nao quebra o contrato).
   * ==========================================================================*/

  var LANES = 5;

  /* --------------------------------------------------------------------------
   * AJUSTES DE SENSACAO — cada numero aqui muda como o jogo "parece".
   * ------------------------------------------------------------------------*/

  /* Buffer de palhetada ("strum leniency", ~60ms — igual ao Clone Hero).
   * Problema real: o jogador palheta um triz ANTES de terminar de posicionar os
   * dedos. Fisicamente a palhetada chega primeiro, o traste chega 10~50ms
   * depois. Sem buffer isso vira overstrum e o jogo parece injusto e "duro".
   * Com buffer, a palhetada fica pendurada por STRUM_BUFFER_SEC: se dentro
   * dessa janela o jogador fechar o acorde certo, a palhetada e reaproveitada
   * com o SEU TIMESTAMP ORIGINAL (isso importa — julgar pelo tempo do dedo
   * roubaria precisao do jogador). Aqui, o Input reemite a palhetada marcada
   * como `buffered:true` sempre que a mascara de trastes muda; o GH.Scoring
   * tambem mantem sua propria leniencia e so pune overstrum quando a janela
   * expira sem casamento. Os dois lados juntos = sensacao de Guitar Hero. */
  var STRUM_BUFFER_SEC = 0.060;

  /* Quantas reemissoes uma mesma palhetada pode gerar (evita spam se o jogador
   * dedilhar muito rapido dentro do buffer). */
  var STRUM_BUFFER_MAX_REPLAYS = 6;

  /* justStrummed(): considera "acabou de palhetar" dentro dessa janela. */
  var JUST_STRUM_SEC = 0.080;

  /* "Tilt": ArrowUp + ArrowDown pressionados quase juntos = Star Power,
   * imitando o gesto de levantar a guitarra. */
  var TILT_WINDOW_SEC = 0.150;

  /* Defasagem maxima aceita entre event.timeStamp e agora. Acima disso o
   * timestamp e considerado lixo (browser antigo/epoca diferente) e ignorado. */
  var MAX_EVENT_LAG_MS = 200;

  /* Tamanho do historico curto de eventos (deteccao de HOPO/tap, debug, replay). */
  var HISTORY_MAX = 96;

  /* --------------------------------------------------------------------------
   * Configuracoes globais — merge NAO destrutivo.
   * GH.Settings nao tem dono declarado no contrato; varios modulos leem dele.
   * Criamos so as chaves que faltam, nunca sobrescrevemos as existentes.
   * ------------------------------------------------------------------------*/
  GH.Settings = GH.Settings || {};
  if (typeof GH.Settings.audioOffsetMs !== 'number') GH.Settings.audioOffsetMs = 0;
  if (typeof GH.Settings.videoOffsetMs !== 'number') GH.Settings.videoOffsetMs = 0;
  if (typeof GH.Settings.scrollSpeed !== 'number') GH.Settings.scrollSpeed = 14;
  if (typeof GH.Settings.noFail !== 'boolean') GH.Settings.noFail = false;
  if (typeof GH.Settings.invertStrum !== 'boolean') GH.Settings.invertStrum = false;

  /* --------------------------------------------------------------------------
   * Bindings padrao. Um codigo de tecla pode disparar VARIAS acoes
   * (ex.: Enter = palhetada para baixo + "start" nos menus).
   * ------------------------------------------------------------------------*/
  var DEFAULT_BINDINGS = {
    fret0: ['KeyA', 'Digit1', 'Numpad1'],
    fret1: ['KeyS', 'Digit2', 'Numpad2'],
    fret2: ['KeyD', 'Digit3', 'Numpad3'],
    fret3: ['KeyF', 'Digit4', 'Numpad4'],
    fret4: ['KeyG', 'Digit5', 'Numpad5'],
    strumUp: ['ArrowUp'],
    strumDown: ['ArrowDown', 'Enter', 'NumpadEnter'],
    starpower: ['Space'],
    pause: ['Escape', 'KeyP'],
    back: ['Backspace'],
    start: ['Enter', 'NumpadEnter', 'Space'],
    restart: ['KeyR'],
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    left: ['ArrowLeft'],
    right: ['ArrowRight']
  };

  /* Acoes que so fazem sentido NUM MENU — suprimidas no contexto 'game'.
   *
   * `start` esta aqui por um motivo concreto: 'Enter' e, ao mesmo tempo,
   * PALHETADA e CONFIRMAR. Com o jogo rodando, cada palhetada com Enter
   * disparava tambem um "confirmar" que atravessava GH.Game -> GH.Menus.
   * Hoje isso e inofensivo porque nenhuma tela de menu esta aberta durante a
   * partida, mas e uma bomba armada: basta uma tela ficar montada para o
   * jogador "clicar" no menu toda vez que palheta. Uma tecla tem um
   * significado de cada vez — quem decide qual e o CONTEXTO. */
  var NAV_ACTIONS = { up: 1, down: 1, left: 1, right: 1, start: 1, back: 1 };
  /* Acoes despachadas por onAction(name). */
  var PLAIN_ACTIONS = {
    starpower: 1, pause: 1, back: 1, start: 1, restart: 1,
    up: 1, down: 1, left: 1, right: 1
  };

  /* --------------------------------------------------------------------------
   * Perfil de gamepad. Guitarras USB/Bluetooth (Xplorer, Les Paul, Wii, PS3)
   * costumam expor os trastes nos botoes 0..4 em ordem "A B X Y LB", que no
   * mapeamento standard vira verde=0, vermelho=1, azul=2, amarelo=3, laranja=4.
   * Por isso fretButtons mapeia raia -> indice de botao: [0,1,3,2,4].
   * Tudo reconfiguravel em runtime (menu de opcoes pode mexer).
   * ------------------------------------------------------------------------*/
  var gamepadProfile = {
    name: 'auto',
    fretButtons: [0, 1, 3, 2, 4],
    fretButtonsAlt: [0, 1, 2, 3, 4],
    strumButtons: [12, 13],          // d-pad cima / baixo
    strumAxis: 1,                    // eixo vertical do stick esquerdo
    strumAxisOn: 0.55,
    strumAxisOff: 0.25,
    spButtons: [6, 7, 10, 11],       // gatilhos / analogicos clicados
    tiltAxis: 3,                     // eixo de tilt/whammy quando existir
    tiltOn: 0.72,
    pauseButtons: [9],
    backButtons: [8],
    navAxis: 1,
    deadzone: 0.35,
    buttonThreshold: 0.5
  };

  /* --------------------------------------------------------------------------
   * Estado interno
   * ------------------------------------------------------------------------*/
  var inited = false;
  var enabled = true;
  var context = 'all';                 // 'all' | 'game' | 'menu'

  var fretMask = 0;                    // bitmask das 5 raias
  var fretDownAt = [0, 0, 0, 0, 0];    // tempo musical do ultimo fretDown por raia
  var fretUpAt = [0, 0, 0, 0, 0];
  var fretHeldSource = [0, 0, 0, 0, 0]; // 1=teclado 2=gamepad 3=ambos

  var strumHeldKeyboard = 0;           // bitmask: 1=up 2=down
  var strumHeldPad = 0;
  var lastStrumMusicTime = -1e9;
  var lastStrumRealTime = -1e9;
  var lastStrumDir = 0;                // +1 = para cima, -1 = para baixo
  var strumConsumed = true;

  var strumUpAt = -1e9, strumDownAt = -1e9;   // tempo real (ms) das setas

  /* Buffer de palhetada pendente */
  var pendingStrum = null;             // {tMusic, tReal, mask, replays, dir}

  var history = [];                    // historico curto de eventos
  var frameSerial = 0;
  var lastPollReal = -1;
  var lastPollDt = 1 / 60;

  var gamepadIndex = -1;
  var gamepadId = '';
  var padPrevButtons = {};      // estado anterior dos botoes (borda de subida)
  var padStrumAxisArmed = true;
  var padStrumAxisSign = 0;
  var padTiltArmed = true;

  /* CALIBRACAO DE REPOUSO DO CONTROLE.
   * Nem todo dispositivo que o navegador chama de "gamepad" e um gamepad:
   * volantes, manches, pedaleiras e adaptadores genericos aparecem com eixos
   * em repouso valendo -1 ou +1 e, as vezes, com botoes marcados como
   * pressionados o tempo todo. Sem calibrar, isso vira traste preso (que a
   * tecla do teclado NAO consegue soltar, porque a fonte e outra) e a mascara
   * de trastes nunca mais bate com nota nenhuma — o jogador palheta a partida
   * inteira sem acertar um gem. O primeiro poll depois de conectar/resetar so
   * MEDE: guarda botoes e eixos como "repouso" e nao emite nada. */
  var padSeeded = false;
  var padAxisRest = [];

  /* Listeners registrados pelo jogo */
  var lFretDown = [], lFretUp = [], lStrum = [], lAction = [], lStrumCancel = [], lGamepad = [];

  /* Handlers do DOM guardados para poder remover em dispose() */
  var hKeyDown = null, hKeyUp = null, hBlur = null, hGpConn = null, hGpDisc = null,
      hContext = null, hVisibility = null;

  /* Mapa code -> [acoes]; reconstruido a cada mudanca de binding */
  var codeMap = {};

  var bindings = cloneBindings(DEFAULT_BINDINGS);

  /* Updater registrado no engine (para poder remover) */
  var engineUpdater = null;
  var rafId = 0;

  /* ==========================================================================
   * Utilidades
   * ========================================================================*/

  function cloneBindings(src) {
    var out = {}, k;
    for (k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k].slice();
    }
    return out;
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  /* Tempo musical corrente. Fonte da verdade = GH.Conductor.time.
   * Se o maestro ainda nao existe (boot, menus), cai para um relogio real —
   * o valor nunca e usado para julgamento nesse caso. */
  function conductorTime() {
    var C = GH.Conductor;
    if (C && typeof C.time === 'number' && isFinite(C.time)) return C.time;
    return nowMs() / 1000;
  }

  /* Tempo musical NO INSTANTE do evento.
   * event.timeStamp (Chrome/Edge) usa a mesma base de performance.now(); a
   * diferenca entre agora e o timeStamp e exatamente quanto o evento ficou na
   * fila antes de chegar aqui. Subtrair essa defasagem devolve ao jogador os
   * milissegundos que o navegador comeu. */
  function musicalTimeOf(ev) {
    var t = conductorTime();
    if (!ev) return t;
    var ts = ev.timeStamp;
    if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return t;
    var lag = nowMs() - ts;
    if (!isFinite(lag) || lag < 0 || lag > MAX_EVENT_LAG_MS) return t;
    return t - lag / 1000;
  }

  function codeOf(e) {
    if (e.code) return e.code;
    var k = e.key || '';
    if (k.length === 1) {
      var c = k.toUpperCase();
      if (c >= 'A' && c <= 'Z') return 'Key' + c;
      if (c >= '0' && c <= '9') return 'Digit' + c;
      if (c === ' ') return 'Space';
    }
    return k;
  }

  function rebuildCodeMap() {
    codeMap = {};
    var action, list, i, code;
    for (action in bindings) {
      if (!Object.prototype.hasOwnProperty.call(bindings, action)) continue;
      list = bindings[action];
      if (!list) continue;
      for (i = 0; i < list.length; i++) {
        code = list[i];
        if (!code) continue;
        if (!codeMap[code]) codeMap[code] = [];
        if (codeMap[code].indexOf(action) < 0) codeMap[code].push(action);
      }
    }
  }

  function laneOfAction(action) {
    if (action.length === 5 && action.indexOf('fret') === 0) {
      var n = action.charCodeAt(4) - 48;
      if (n >= 0 && n < LANES) return n;
    }
    return -1;
  }

  function safeCall(list, a, b, c) {
    for (var i = 0; i < list.length; i++) {
      try { list[i](a, b, c); } catch (err) {
        if (window.console && console.warn) console.warn('[GH.Input] listener falhou:', err);
      }
    }
  }

  function pushHistory(rec) {
    history.push(rec);
    if (history.length > HISTORY_MAX) history.shift();
  }

  /* ==========================================================================
   * Nucleo: trastes
   * ========================================================================*/

  function fretDown(lane, tMusic, source) {
    if (lane < 0 || lane >= LANES) return;
    var bit = 1 << lane;
    var already = (fretMask & bit) !== 0;
    fretHeldSource[lane] |= source;
    if (already) return;

    fretMask |= bit;
    fretDownAt[lane] = tMusic;
    API.fretMask = fretMask;          // espelho publico ANTES de qualquer callback

    pushHistory({ type: 'fretdown', lane: lane, t: tMusic, real: nowMs(), mask: fretMask });

    if (context !== 'menu') safeCall(lFretDown, lane, tMusic, fretMask);

    /* Buffer de palhetada: o dedo chegou depois da palheta — reaproveita. */
    replayBufferedStrum();
  }

  function fretUp(lane, tMusic, source) {
    if (lane < 0 || lane >= LANES) return;
    var bit = 1 << lane;
    fretHeldSource[lane] &= ~source;
    if (fretHeldSource[lane] !== 0) return;      // ainda segurado por outra fonte
    if ((fretMask & bit) === 0) return;

    fretMask &= ~bit;
    fretUpAt[lane] = tMusic;
    API.fretMask = fretMask;          // espelho publico ANTES de qualquer callback

    pushHistory({ type: 'fretup', lane: lane, t: tMusic, real: nowMs(), mask: fretMask });

    if (context !== 'menu') safeCall(lFretUp, lane, tMusic, fretMask);

    /* Soltar traste tambem pode fechar o acorde certo (ex.: tirar a raia que
     * sobrava num acorde exato). Vale reavaliar a palhetada em buffer. */
    replayBufferedStrum();
  }

  function releaseAllFrets(tMusic) {
    for (var i = 0; i < LANES; i++) {
      if (fretMask & (1 << i)) {
        fretHeldSource[i] = 0;
        fretMask &= ~(1 << i);
        fretUpAt[i] = tMusic;
        API.fretMask = fretMask;
        if (context !== 'menu') safeCall(lFretUp, i, tMusic, fretMask);
      }
      fretHeldSource[i] = 0;
    }
    fretMask = 0;
    API.fretMask = 0;
  }

  /* ==========================================================================
   * Nucleo: palhetada
   * ========================================================================*/

  function emitStrum(tMusic, dir, buffered) {
    lastStrumMusicTime = tMusic;
    lastStrumRealTime = nowMs();
    lastStrumDir = dir;
    strumConsumed = false;

    var info = {
      buffered: !!buffered,
      dir: dir,
      mask: fretMask,
      musicTime: tMusic,
      realTime: lastStrumRealTime
    };

    pushHistory({ type: 'strum', lane: -1, t: tMusic, real: lastStrumRealTime,
                  mask: fretMask, dir: dir, buffered: !!buffered });

    if (context !== 'menu') safeCall(lStrum, tMusic, info);
  }

  function strum(tMusic, dir) {
    /* No contexto de MENU a palhetada nem existe. Antes daqui so os callbacks
     * eram suprimidos: o buffer de palhetada continuava sendo criado, com o
     * tempo musical do MENU. O Enter que inicia a musica na tela de
     * dificuldade deixava essa palhetada pendurada e, ja dentro do jogo, o
     * primeiro traste apertado a reemitia — virando um overstrum fantasma no
     * segundo 0 (visto no rastro do teste de boot real: "OVERSTRUM em t=0").
     * Sequencia quebrada de graca, logo na primeira nota. */
    if (context === 'menu') { pendingStrum = null; return; }
    if (GH.Settings.invertStrum) dir = -dir;

    /* Uma nova palhetada cancela a anterior que ainda estava em buffer:
     * palhetar duas vezes sem acertar e overstrum de verdade, e quem decide
     * isso e o GH.Scoring (aqui so paramos de reemitir a antiga). */
    pendingStrum = {
      tMusic: tMusic,
      tReal: nowMs(),
      mask: fretMask,
      replays: 0,
      dir: dir
    };

    emitStrum(tMusic, dir, false);
  }

  /* Reemite a palhetada guardada se ela ainda esta dentro da janela de buffer
   * e a mascara de trastes mudou desde a ultima tentativa. */
  function replayBufferedStrum() {
    var p = pendingStrum;
    if (!p) return;
    if (context === 'menu') { pendingStrum = null; return; }
    var age = (nowMs() - p.tReal) / 1000;
    if (age > STRUM_BUFFER_SEC) { pendingStrum = null; return; }
    if (p.replays >= STRUM_BUFFER_MAX_REPLAYS) return;
    if (p.mask === fretMask) return;             // nada mudou, nao adianta
    p.mask = fretMask;
    p.replays++;
    /* Reemite com o TIMESTAMP ORIGINAL da palhetada — a precisao pertence ao
     * momento em que o jogador palhetou, nao ao momento em que o dedo chegou. */
    emitStrum(p.tMusic, p.dir, true);
  }

  /* Cancelamento de palhetada: usado pelo "tilt" (setas juntas = Star Power),
   * onde as duas palhetadas foram um gesto, nao uma tentativa de acerto.
   * GH.Scoring pode estornar o overstrum recente ao receber isso. */
  function cancelStrum(tMusic, reason) {
    pendingStrum = null;
    strumConsumed = true;
    safeCall(lStrumCancel, tMusic, reason || 'tilt');
  }

  /* ==========================================================================
   * Acoes
   * ========================================================================*/

  function emitAction(name, tMusic, extra) {
    if (context === 'game' && NAV_ACTIONS[name]) return;
    pushHistory({ type: 'action', name: name, t: tMusic, real: nowMs() });
    safeCall(lAction, name, tMusic, extra || null);
  }

  /* ==========================================================================
   * Teclado
   * ========================================================================*/

  function onKeyDown(e) {
    if (!enabled) return;
    if (e.repeat) return;                       // anti auto-repeat do sistema
    var code = codeOf(e);
    var acts = codeMap[code];
    if (!acts || !acts.length) return;

    if (e.preventDefault) e.preventDefault();

    var tMusic = musicalTimeOf(e);
    var i, action, lane;

    for (i = 0; i < acts.length; i++) {
      action = acts[i];
      lane = laneOfAction(action);
      if (lane >= 0) { fretDown(lane, tMusic, 1); continue; }

      if (action === 'strumUp') {
        strumUpAt = nowMs();
        strumHeldKeyboard |= 1;
        if (checkTilt(tMusic)) continue;
        strum(tMusic, +1);
        continue;
      }
      if (action === 'strumDown') {
        /* Enter tambem e strumDown; so conta para o tilt quando e a seta. */
        if (code === 'ArrowDown') strumDownAt = nowMs();
        strumHeldKeyboard |= 2;
        if (code === 'ArrowDown' && checkTilt(tMusic)) continue;
        strum(tMusic, -1);
        continue;
      }
      if (PLAIN_ACTIONS[action]) emitAction(action, tMusic, { code: code, device: 'keyboard' });
    }
  }

  function onKeyUp(e) {
    if (!enabled) return;
    var code = codeOf(e);
    var acts = codeMap[code];
    if (!acts || !acts.length) return;
    if (e.preventDefault) e.preventDefault();

    var tMusic = musicalTimeOf(e);
    var i, action, lane;
    for (i = 0; i < acts.length; i++) {
      action = acts[i];
      lane = laneOfAction(action);
      if (lane >= 0) { fretUp(lane, tMusic, 1); continue; }
      if (action === 'strumUp') { strumHeldKeyboard &= ~1; strumUpAt = -1e9; }
      else if (action === 'strumDown') { strumHeldKeyboard &= ~2; if (code === 'ArrowDown') strumDownAt = -1e9; }
    }
  }

  /* Tilt: as duas setas quase juntas = Star Power (imita levantar a guitarra).
   * Retorna true se consumiu o evento como tilt. */
  function checkTilt(tMusic) {
    var t = nowMs();
    if (strumUpAt > 0 && strumDownAt > 0 &&
        Math.abs(strumUpAt - strumDownAt) <= TILT_WINDOW_SEC * 1000 &&
        (t - Math.min(strumUpAt, strumDownAt)) <= TILT_WINDOW_SEC * 1000) {
      cancelStrum(tMusic, 'tilt');
      emitAction('starpower', tMusic, { device: 'tilt' });
      return true;
    }
    return false;
  }

  function onBlur() {
    /* Perder o foco com traste segurado deixaria a nota "colada". Solta tudo. */
    var t = conductorTime();
    releaseAllFrets(t);
    strumHeldKeyboard = 0; strumHeldPad = 0;
    strumUpAt = -1e9; strumDownAt = -1e9;
    pendingStrum = null;
  }

  /* ==========================================================================
   * Gamepad
   * ========================================================================*/

  function getPads() {
    if (!navigator.getGamepads) return null;
    try { return navigator.getGamepads(); } catch (err) { return null; }
  }

  function detectPad() {
    var pads = getPads();
    if (!pads) return;
    var i, p;
    /* Mantem o pad atual se ainda estiver vivo. */
    if (gamepadIndex >= 0) {
      p = pads[gamepadIndex];
      if (p && p.connected) return;
      setPad(-1, '');
    }
    for (i = 0; i < pads.length; i++) {
      p = pads[i];
      if (p && p.connected) { setPad(i, p.id || ('gamepad ' + i)); return; }
    }
  }

  function setPad(idx, id) {
    var wasConnected = gamepadIndex >= 0;
    gamepadIndex = idx;
    gamepadId = id || '';
    padPrevButtons = {};
    padStrumAxisArmed = true;
    padStrumAxisSign = 0;
    padTiltArmed = true;
    padSeeded = false;
    padAxisRest.length = 0;
    API.gamepadConnected = idx >= 0;
    API.gamepadId = gamepadId;
    if (wasConnected !== (idx >= 0)) {
      /* Auto-deteccao de perfil: guitarras costumam se anunciar. */
      if (idx >= 0) {
        var lower = gamepadId.toLowerCase();
        if (lower.indexOf('guitar') >= 0 || lower.indexOf('xplorer') >= 0 ||
            lower.indexOf('les paul') >= 0 || lower.indexOf('rock band') >= 0) {
          gamepadProfile.name = 'guitar';
        } else {
          gamepadProfile.name = 'pad';
        }
      }
      safeCall(lGamepad, idx >= 0, gamepadId);
    }
  }

  function buttonPressed(pad, index) {
    if (index == null || index < 0) return false;
    var b = pad.buttons[index];
    if (!b) return false;
    if (typeof b === 'number') return b >= gamepadProfile.buttonThreshold;
    if (b.pressed) return true;
    return (typeof b.value === 'number') && b.value >= gamepadProfile.buttonThreshold;
  }

  function pollGamepad(dt) {
    if (gamepadIndex < 0) { detectPad(); if (gamepadIndex < 0) return; }
    var pads = getPads();
    if (!pads) return;
    var pad = pads[gamepadIndex];
    if (!pad || !pad.connected) { setPad(-1, ''); return; }

    /* Eventos de gamepad sao amostrados: o toque real aconteceu em algum ponto
     * do frame anterior. Assumir o meio do frame reduz o erro sistematico pela
     * metade — de graca, e o jogador sente. */
    var tMusic = conductorTime() - (dt > 0 ? dt * 0.5 : 0);

    var frets = (gamepadProfile.name === 'pad')
      ? gamepadProfile.fretButtonsAlt : gamepadProfile.fretButtons;

    var i, pressed, prev, bIdx;

    /* --- primeiro poll: so MEDE o repouso, nao emite nada --- */
    if (!padSeeded) {
      for (i = 0; i < LANES; i++) padPrevButtons['f' + i] = buttonPressed(pad, frets[i]);
      padPrevButtons.sUp = buttonPressed(pad, gamepadProfile.strumButtons[0]);
      padPrevButtons.sDn = buttonPressed(pad, gamepadProfile.strumButtons[1]);
      padPrevButtons.lf = buttonPressed(pad, 14);
      padPrevButtons.rg = buttonPressed(pad, 15);
      padPrevButtons.a0 = buttonPressed(pad, 0);
      padPrevButtons.sp = anyPressed(pad, gamepadProfile.spButtons);
      padPrevButtons.pa = anyPressed(pad, gamepadProfile.pauseButtons);
      padPrevButtons.bk = anyPressed(pad, gamepadProfile.backButtons);
      padAxisRest.length = 0;
      if (pad.axes) {
        for (i = 0; i < pad.axes.length; i++) {
          var rv = pad.axes[i];
          padAxisRest.push((typeof rv === 'number' && isFinite(rv)) ? rv : 0);
        }
      }
      padStrumAxisArmed = true;
      padStrumAxisSign = 0;
      padTiltArmed = true;
      padSeeded = true;
      return;
    }

    /* --- trastes --- */
    for (i = 0; i < LANES; i++) {
      bIdx = frets[i];
      pressed = buttonPressed(pad, bIdx);
      prev = !!padPrevButtons['f' + i];
      if (pressed && !prev) fretDown(i, tMusic, 2);
      else if (!pressed && prev) fretUp(i, tMusic, 2);
      padPrevButtons['f' + i] = pressed;
    }

    /* --- palhetada por d-pad --- */
    var sUp = buttonPressed(pad, gamepadProfile.strumButtons[0]);
    var sDn = buttonPressed(pad, gamepadProfile.strumButtons[1]);
    var pUp = !!padPrevButtons.sUp, pDn = !!padPrevButtons.sDn;
    strumHeldPad = (sUp ? 1 : 0) | (sDn ? 2 : 0);

    if (sUp && sDn && !(pUp && pDn)) {
      /* as duas direcoes juntas = tilt */
      cancelStrum(tMusic, 'tilt');
      emitAction('starpower', tMusic, { device: 'gamepad-tilt' });
    } else {
      if (sUp && !pUp) strum(tMusic, +1);
      if (sDn && !pDn) strum(tMusic, -1);
    }
    padPrevButtons.sUp = sUp;
    padPrevButtons.sDn = sDn;

    /* --- palhetada por eixo (barra de palheta analogica / stick) ---
     * Sempre RELATIVO ao repouso medido: um manche cujo eixo 1 descansa em
     * -1.0 nao pode nascer palhetando. */
    var ax = gamepadProfile.strumAxis;
    if (ax >= 0 && pad.axes && pad.axes.length > ax) {
      var v = pad.axes[ax] - (padAxisRest[ax] || 0);
      if (typeof v === 'number' && isFinite(v)) {
        var mag = Math.abs(v);
        var sign = v < 0 ? +1 : -1;   // eixo Y negativo = para cima
        if (padStrumAxisArmed && mag >= gamepadProfile.strumAxisOn) {
          padStrumAxisArmed = false;
          padStrumAxisSign = sign;
          strum(tMusic, sign);
        } else if (!padStrumAxisArmed && mag <= gamepadProfile.strumAxisOff) {
          padStrumAxisArmed = true;
          padStrumAxisSign = 0;
        } else if (!padStrumAxisArmed && mag >= gamepadProfile.strumAxisOn && sign !== padStrumAxisSign) {
          /* virou o sentido sem passar pelo centro — conta como nova palhetada */
          padStrumAxisSign = sign;
          strum(tMusic, sign);
        }
      }
    }

    /* --- eixo de tilt (Star Power) --- */
    var ti = gamepadProfile.tiltAxis;
    if (ti >= 0 && pad.axes && pad.axes.length > ti) {
      var tv = pad.axes[ti] - (padAxisRest[ti] || 0);
      if (typeof tv === 'number' && isFinite(tv)) {
        if (padTiltArmed && Math.abs(tv) >= gamepadProfile.tiltOn) {
          padTiltArmed = false;
          emitAction('starpower', tMusic, { device: 'gamepad-tilt-axis' });
        } else if (!padTiltArmed && Math.abs(tv) < gamepadProfile.tiltOn * 0.6) {
          padTiltArmed = true;
        }
      }
    }

    /* --- botoes de acao --- */
    pollActionButtons(pad, gamepadProfile.spButtons, 'sp', 'starpower', tMusic);
    pollActionButtons(pad, gamepadProfile.pauseButtons, 'pa', 'pause', tMusic);
    pollActionButtons(pad, gamepadProfile.backButtons, 'bk', 'back', tMusic);

    /* --- navegacao de menu pelo stick/d-pad horizontal --- */
    if (context !== 'game') {
      var lft = buttonPressed(pad, 14), rgt = buttonPressed(pad, 15);
      if (lft && !padPrevButtons.lf) emitAction('left', tMusic, { device: 'gamepad' });
      if (rgt && !padPrevButtons.rg) emitAction('right', tMusic, { device: 'gamepad' });
      padPrevButtons.lf = lft; padPrevButtons.rg = rgt;
      if (sUp && !pUp) emitAction('up', tMusic, { device: 'gamepad' });
      if (sDn && !pDn) emitAction('down', tMusic, { device: 'gamepad' });
      if (buttonPressed(pad, 0) && !padPrevButtons.a0) emitAction('start', tMusic, { device: 'gamepad' });
      padPrevButtons.a0 = buttonPressed(pad, 0);
    }
  }

  function anyPressed(pad, list) {
    if (!list) return false;
    for (var i = 0; i < list.length; i++) if (buttonPressed(pad, list[i])) return true;
    return false;
  }

  function pollActionButtons(pad, list, key, action, tMusic) {
    if (!list) return;
    var any = anyPressed(pad, list);
    if (any && !padPrevButtons[key]) emitAction(action, tMusic, { device: 'gamepad' });
    padPrevButtons[key] = any;
  }

  /* ==========================================================================
   * Loop
   * ========================================================================*/

  function update(dt) {
    var t = nowMs();
    /* Guarda de frame: se o engine E o game chamarem update() no mesmo frame,
     * o gamepad nao e lido duas vezes (isso duplicaria palhetadas). */
    if (lastPollReal > 0 && (t - lastPollReal) < 1.0) return;
    if (typeof dt !== 'number' || !isFinite(dt) || dt <= 0) {
      dt = lastPollReal > 0 ? Math.min(0.25, (t - lastPollReal) / 1000) : 1 / 60;
    }
    lastPollReal = t;
    lastPollDt = dt;
    frameSerial++;

    /* Expira o buffer de palhetada. */
    if (pendingStrum && (t - pendingStrum.tReal) / 1000 > STRUM_BUFFER_SEC) pendingStrum = null;

    if (enabled) {
      try { pollGamepad(dt); } catch (err) {
        if (window.console && console.warn) console.warn('[GH.Input] gamepad falhou:', err);
      }
    }
  }

  function ownRaf() {
    rafId = 0;
    if (!inited) return;
    update(0);
    if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(ownRaf);
  }

  /* ==========================================================================
   * API publica
   * ========================================================================*/

  var API = {

    /* --- constantes de sensacao, expostas para o menu de calibragem --- */
    STRUM_BUFFER_SEC: STRUM_BUFFER_SEC,
    JUST_STRUM_SEC: JUST_STRUM_SEC,
    LANES: LANES,

    bindings: bindings,
    gamepadConnected: false,
    gamepadId: '',
    gamepadProfile: gamepadProfile,
    history: history,
    ready: false,

    /* Mascara de bits das raias seguradas (bit i = raia i). */
    fretMask: 0,

    /* ---------------------------------------------------------------------
     * init() — idempotente. Chamar de novo NAO duplica listeners.
     * -------------------------------------------------------------------*/
    init: function () {
      if (inited) { this.ready = true; return this; }
      inited = true;

      rebuildCodeMap();

      hKeyDown = function (e) { onKeyDown(e); };
      hKeyUp = function (e) { onKeyUp(e); };
      hBlur = function () { onBlur(); };
      hContext = function (e) { /* impede menu de contexto atrapalhar o jogo */
        if (context === 'game' && e.preventDefault) e.preventDefault();
      };
      hVisibility = function () { if (document.hidden) onBlur(); };
      hGpConn = function (e) {
        if (e && e.gamepad) setPad(e.gamepad.index, e.gamepad.id || '');
        else detectPad();
      };
      hGpDisc = function (e) {
        if (e && e.gamepad && e.gamepad.index === gamepadIndex) setPad(-1, '');
        else detectPad();
      };

      window.addEventListener('keydown', hKeyDown, { passive: false });
      window.addEventListener('keyup', hKeyUp, { passive: false });
      window.addEventListener('blur', hBlur, false);
      document.addEventListener('visibilitychange', hVisibility, false);
      window.addEventListener('contextmenu', hContext, false);
      window.addEventListener('gamepadconnected', hGpConn, false);
      window.addEventListener('gamepaddisconnected', hGpDisc, false);

      detectPad();

      /* Prefere o loop do engine (um lugar so, dt correto). Se nao existe,
       * mantem um rAF proprio para o gamepad continuar respondendo nos menus. */
      if (GH.Engine && typeof GH.Engine.addUpdater === 'function') {
        engineUpdater = function (dt) { update(dt); };
        try { GH.Engine.addUpdater(engineUpdater); } catch (err) { engineUpdater = null; }
      }
      if (!engineUpdater && typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(ownRaf);
      }

      this.ready = true;
      this.fretMask = 0;
      return this;
    },

    /* Remove listeners (usado em testes/modo captura). */
    dispose: function () {
      if (!inited) return;
      window.removeEventListener('keydown', hKeyDown);
      window.removeEventListener('keyup', hKeyUp);
      window.removeEventListener('blur', hBlur);
      document.removeEventListener('visibilitychange', hVisibility);
      window.removeEventListener('contextmenu', hContext);
      window.removeEventListener('gamepadconnected', hGpConn);
      window.removeEventListener('gamepaddisconnected', hGpDisc);
      if (engineUpdater && GH.Engine && GH.Engine.removeUpdater) {
        try { GH.Engine.removeUpdater(engineUpdater); } catch (err) {}
      }
      engineUpdater = null;
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = 0;
      inited = false;
      this.ready = false;
    },

    update: update,

    /* --- consulta de estado ---------------------------------------------- */

    isFret: function (i) { return (fretMask & (1 << i)) !== 0; },
    anyFret: function () { return fretMask !== 0; },
    fretCount: function () {
      var m = fretMask, n = 0;
      while (m) { n += m & 1; m >>= 1; }
      return n;
    },
    /* Raia mais aguda segurada (util para "anchoring"). -1 se nenhuma. */
    highestFret: function () {
      for (var i = LANES - 1; i >= 0; i--) if (fretMask & (1 << i)) return i;
      return -1;
    },
    fretHeldSince: function (i) { return fretDownAt[i]; },

    isStrumDown: function () { return (strumHeldKeyboard | strumHeldPad) !== 0; },

    /* Houve palhetada nos ultimos `win` segundos (tempo real). Nao consome. */
    justStrummed: function (win) {
      var w = (typeof win === 'number' ? win : JUST_STRUM_SEC) * 1000;
      return (nowMs() - lastStrumRealTime) <= w;
    },
    /* Idade da ultima palhetada em segundos (tempo real). */
    strumAge: function () { return (nowMs() - lastStrumRealTime) / 1000; },
    /* Houve palhetada recente que AINDA nao virou acerto (o GH.Scoring chama
     * consumeStrum() quando converte). Util para o HUD piscar a palheta so
     * enquanto ela esta "no ar". */
    strumUnconsumed: function (win) {
      var w = (typeof win === 'number' ? win : JUST_STRUM_SEC) * 1000;
      return !strumConsumed && (nowMs() - lastStrumRealTime) <= w;
    },
    lastStrumTime: function () { return lastStrumMusicTime; },
    lastStrumDirection: function () { return lastStrumDir; },

    /* Consome a palhetada pendente: o GH.Scoring chama isto quando a palhetada
     * virou acerto, para o buffer nao tentar reaproveita-la de novo. */
    consumeStrum: function () {
      strumConsumed = true;
      pendingStrum = null;
    },
    /* Info do buffer (ou null). */
    strumBuffer: function () {
      if (!pendingStrum) return null;
      return {
        musicTime: pendingStrum.tMusic,
        ageSec: (nowMs() - pendingStrum.tReal) / 1000,
        replays: pendingStrum.replays,
        dir: pendingStrum.dir
      };
    },

    /* Historico curto: eventos dos ultimos `ms` milissegundos. */
    recent: function (ms) {
      var lim = nowMs() - (ms || 250), out = [];
      for (var i = history.length - 1; i >= 0; i--) {
        if (history[i].real < lim) break;
        out.push(history[i]);
      }
      return out.reverse();
    },

    /* --- registro de callbacks -------------------------------------------- */

    onFretDown: function (fn) { if (typeof fn === 'function' && lFretDown.indexOf(fn) < 0) lFretDown.push(fn); return fn; },
    onFretUp: function (fn) { if (typeof fn === 'function' && lFretUp.indexOf(fn) < 0) lFretUp.push(fn); return fn; },
    onStrum: function (fn) { if (typeof fn === 'function' && lStrum.indexOf(fn) < 0) lStrum.push(fn); return fn; },
    onAction: function (fn) { if (typeof fn === 'function' && lAction.indexOf(fn) < 0) lAction.push(fn); return fn; },
    onStrumCancel: function (fn) { if (typeof fn === 'function' && lStrumCancel.indexOf(fn) < 0) lStrumCancel.push(fn); return fn; },
    onGamepad: function (fn) { if (typeof fn === 'function' && lGamepad.indexOf(fn) < 0) lGamepad.push(fn); return fn; },

    offFretDown: function (fn) { var i = lFretDown.indexOf(fn); if (i >= 0) lFretDown.splice(i, 1); },
    offFretUp: function (fn) { var i = lFretUp.indexOf(fn); if (i >= 0) lFretUp.splice(i, 1); },
    offStrum: function (fn) { var i = lStrum.indexOf(fn); if (i >= 0) lStrum.splice(i, 1); },
    offAction: function (fn) { var i = lAction.indexOf(fn); if (i >= 0) lAction.splice(i, 1); },
    offStrumCancel: function (fn) { var i = lStrumCancel.indexOf(fn); if (i >= 0) lStrumCancel.splice(i, 1); },
    offGamepad: function (fn) { var i = lGamepad.indexOf(fn); if (i >= 0) lGamepad.splice(i, 1); },

    clearListeners: function () {
      lFretDown.length = 0; lFretUp.length = 0; lStrum.length = 0;
      lAction.length = 0; lStrumCancel.length = 0; lGamepad.length = 0;
    },

    /* --- bindings --------------------------------------------------------- */

    /* Substitui TODAS as teclas de uma acao por `code`. */
    setBinding: function (action, code) {
      if (!action || !code) return false;
      bindings[action] = [code];
      rebuildCodeMap();
      return true;
    },
    addBinding: function (action, code) {
      if (!action || !code) return false;
      if (!bindings[action]) bindings[action] = [];
      if (bindings[action].indexOf(code) < 0) bindings[action].push(code);
      rebuildCodeMap();
      return true;
    },
    removeBinding: function (action, code) {
      if (!bindings[action]) return false;
      var i = bindings[action].indexOf(code);
      if (i < 0) return false;
      bindings[action].splice(i, 1);
      rebuildCodeMap();
      return true;
    },
    getBindings: function () { return cloneBindings(bindings); },
    resetBindings: function () {
      var k;
      for (k in bindings) if (Object.prototype.hasOwnProperty.call(bindings, k)) delete bindings[k];
      var d = cloneBindings(DEFAULT_BINDINGS);
      for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) bindings[k] = d[k];
      rebuildCodeMap();
    },
    /* Persistencia opcional — file:// pode nao ter localStorage, entao tudo
     * dentro de try/catch. O modo captura NAO carrega (determinismo). */
    saveBindings: function () {
      try { localStorage.setItem('gh.bindings', JSON.stringify(bindings)); return true; }
      catch (err) { return false; }
    },
    /* SEGURANCA: o localStorage e da ORIGEM inteira, nao deste jogo. Publicado
     * num usuario.github.io, qualquer outra pagina do mesmo usuario pode ter
     * escrito 'gh.bindings'. Entao tratamos como entrada hostil: so entram
     * acoes que existem no mapa padrao e so entram codigos com a forma de um
     * KeyboardEvent.code de verdade (letra/numero, ate 32 chars). Isso impede
     * que texto arbitrario viaje ate a tela de opcoes. */
    loadBindings: function () {
      try {
        var raw = localStorage.getItem('gh.bindings');
        if (!raw) return false;
        var obj = JSON.parse(raw), k, i, list, clean;
        if (!obj || typeof obj !== 'object') return false;
        var CODE_RE = /^[A-Za-z0-9]{1,32}$/;
        for (k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          if (!Object.prototype.hasOwnProperty.call(DEFAULT_BINDINGS, k)) continue;
          list = obj[k];
          if (!list || typeof list.length !== 'number') continue;
          clean = [];
          for (i = 0; i < list.length && clean.length < 12; i++) {
            if (typeof list[i] === 'string' && CODE_RE.test(list[i])) clean.push(list[i]);
          }
          if (clean.length) bindings[k] = clean;
        }
        rebuildCodeMap();
        return true;
      } catch (err) { return false; }
    },

    /* --- contexto / habilitacao -------------------------------------------- */

    /* 'game'  = suprime navegacao de menu (setas nao viram up/down)
     * 'menu'  = suprime trastes/palhetada (nao gera overstrum no menu)
     * 'all'   = despacha tudo (padrao) */
    /* Trocar de contexto zera o estado "no ar" do instrumento. Uma palhetada
     * em buffer, um traste segurado ou uma seta presa nao podem atravessar a
     * fronteira menu<->jogo: do outro lado eles seriam julgados com o tempo
     * musical do lado de ca. */
    setContext: function (ctx) {
      var next = (ctx === 'game' || ctx === 'menu') ? ctx : 'all';
      if (next === context) return;
      var t = conductorTime();
      releaseAllFrets(t);
      pendingStrum = null;
      strumHeldKeyboard = 0; strumHeldPad = 0;
      strumUpAt = -1e9; strumDownAt = -1e9;
      strumConsumed = true;
      padPrevButtons = {};
      padSeeded = false;
      context = next;
    },
    getContext: function () { return context; },

    setEnabled: function (v) {
      enabled = !!v;
      if (!enabled) onBlur();
    },
    isEnabled: function () { return enabled; },

    /* Zera estado de tecla/palhetada sem remover listeners. */
    reset: function () {
      var t = conductorTime();
      releaseAllFrets(t);
      strumHeldKeyboard = 0; strumHeldPad = 0;
      strumUpAt = -1e9; strumDownAt = -1e9;
      lastStrumMusicTime = -1e9; lastStrumRealTime = -1e9; lastStrumDir = 0;
      strumConsumed = true;
      pendingStrum = null;
      history.length = 0;
      padPrevButtons = {};
      padSeeded = false;              /* remede o repouso do controle */
      padAxisRest.length = 0;
      this.fretMask = 0;
    },

    /* --- injecao (modo captura, demo/attract, testes) ---------------------- */
    injectFretDown: function (lane, tSec) { fretDown(lane, (typeof tSec === 'number' ? tSec : conductorTime()), 4); },
    injectFretUp: function (lane, tSec) { fretUp(lane, (typeof tSec === 'number' ? tSec : conductorTime()), 4); },
    injectStrum: function (tSec, dir) { strum((typeof tSec === 'number' ? tSec : conductorTime()), dir || -1); },
    injectAction: function (name, tSec) { emitAction(name, (typeof tSec === 'number' ? tSec : conductorTime()), { device: 'inject' }); },

    /* Tempo musical atual (mesma fonte usada nos carimbos). */
    time: conductorTime
  };

  /* API.fretMask e espelhado dentro de fretDown/fretUp/releaseAllFrets, SEMPRE
   * antes de chamar os listeners — o GH.Scoring le essa mascara dentro do
   * proprio callback de palhetada, entao ela precisa ja estar atualizada.
   * Campo simples (nao getter) porque e lido no loop quente. */

  GH.Input = API;

})(window.GH = window.GH || {});

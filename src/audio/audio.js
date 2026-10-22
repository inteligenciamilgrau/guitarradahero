(function (GH) {
  'use strict';

  /* ==========================================================================
   * GUITARRADA HERO — src/audio/audio.js
   * Dono: agente AUDIO-CORE.
   *
   * Responsabilidades:
   *   1. Criar e manter o AudioContext e todo o grafo de mixagem.
   *   2. Barramentos (music/guitar/drums/sfx/crowd) -> master -> glue -> limiter.
   *   3. Envios compartilhados de REVERB (convolver com IR gerada por codigo)
   *      e DELAY ping-pong estereo com filtro no laco.
   *   4. Efeitos sonoros 100% sintetizados na hora (nenhum sample em disco).
   *   5. MODO MUDO: se estivermos em captura headless (window.__GH_CAP ou ?cap=)
   *      ou se o AudioContext nao puder ser criado, tudo vira no-op seguro,
   *      GH.Audio.ctx fica null e NADA no jogo quebra por causa disso.
   *
   * Regra de ouro deste arquivo: nenhuma funcao publica pode lancar excecao.
   * O jogo tem que rodar mesmo sem placa de som.
   * ========================================================================== */

  /* --------------------------------------------------------------------------
   * Estado privado
   * ------------------------------------------------------------------------ */
  var ctx = null;            // AudioContext (null == modo mudo)
  var muted = false;         // true quando estamos sem audio
  var built = false;         // init() ja rodou
  var graphOk = false;       // grafo montado com sucesso

  var masterGain = null;     // soma de todos os barramentos
  var glueComp = null;       // compressor "cola de mixagem"
  var limiter = null;        // limitador de pico (teto do master)
  var clipIn = null;         // atenuacao de entrada do soft-clipper
  var safetyClip = null;     // saturador macio: rede de seguranca final
  var clipOut = null;        // recuperacao de ganho pos soft-clipper
  var outGain = null;        // ganho final / makeup
  var analyser = null;       // medidor pros visuais
  var analyserBytes = null;

  // Barramentos. O OBJETO e o mesmo desde o inicio (as chaves sempre existem),
  // para que `GH.Audio.buses.guitar` nunca estoure mesmo antes do init.
  var buses = { music: null, guitar: null, drums: null, sfx: null, crowd: null };
  var busSends = {};         // { nome: { reverb: GainNode, delay: GainNode } }
  // Entrada de efeito das VOZES de cada barramento (ver sendFrom): segue o
  // fader do barramento, para volume 0 calar tambem o reverb da voz.
  var voiceSends = {};       // { nome: { reverb: GainNode, delay: GainNode } }

  // Nos de efeito expostos para o agente de musica (GH.Synth) plugar direto.
  var fx = {
    reverbIn: null, reverbHP: null, reverbConv: null, reverbReturn: null,
    delayIn: null, delayL: null, delayR: null, delayFb: null,
    delayLP: null, delayHP: null, delayReturn: null,
    delayPanL: null, delayPanR: null
  };

  var irs = {};              // { clube: AudioBuffer, arena: AudioBuffer }
  var currentIR = 'clube';
  var noiseBuf = { white: null, pink: null, brown: null };
  var pluckBuf = [];         // 5 buffers Karplus-Strong (um por raia)
  var pluckOpen = null;      // pluck grave da nota aberta
  var shaperCurves = {};     // curvas de waveshaper por "quantidade"

  /* --------------------------------------------------------------------------
   * ORCAMENTO DE SFX — em VOZES e em NOS
   *
   * `voices` sozinho nao era um teto: ele conta CHAMADAS, e as chamadas nao
   * tem o mesmo tamanho nem de longe. Medido em shots/_sfxload.html (caso
   * ANAT), nos criados por chamada:
   *     hit 7 · openHit 8 · miss 8 · streakUp 18 · starPowerOn 25 ·
   *     crowdCheer 125
   * Ou seja: 32 "vozes" tanto podem ser 224 nos (32 acertos) quanto 4000
   * (32 gritos de plateia). Um teto que varia 18x nao e teto.
   *
   * Entao ha dois limites agora: o de vozes, que continua, e um de NOS VIVOS,
   * que e o recurso que realmente se esgota. Nenhum dos dois muda um som
   * sequer — eles so decidem se uma voz NOVA entra, exatamente como o
   * `voices` ja fazia.
   *
   * O TETO DE NOS E FOLGADO DE PROPOSITO, e o numero saiu de medicao, nao de
   * palpite. O pior caso que o jogo consegue produzir foi montado a mao em
   * shots/_sfxab.html (caso 4): 5,5 acertos por segundo durante 6 s + um
   * streakUp + um erro + Star Power ligando + DOIS gritos de plateia
   * sobrepostos. Nessa bancada a limpeza fica SUSPENSA durante o render (ver
   * o bloco de timers em shots/_sfxdrive.js), entao o numero que sai — 535
   * nos — e um TETO ESTRITO: e tudo que foi criado em 6,5 s sem nada ser
   * devolvido. A simultaneidade real e menor. Um teto de 320 recusava vozes
   * ate nesse teste, e teto que dispara em jogo normal nao e protecao, e
   * defeito. Com 1024 sobra quase 2x sobre o limite superior de um cenario ja
   * mais duro que o jogo, e o caso patologico (uma duzia de plateias
   * empilhadas) ainda para de pe.
   * ------------------------------------------------------------------------ */
  var voices = 0;            // vozes de sfx ativas (evita avalanche de nos)
  var MAX_VOICES = 32;
  var liveNodes = 0;         // nos de SFX vivos (criados e ainda conectados)
  var MAX_SFX_NODES = 1024;
  var peakVoices = 0, peakNodes = 0, droppedVoices = 0, droppedNodes = 0;

  var ambience = null;       // nos do leito de plateia continuo

  /* ==========================================================================
   * ESTABILIDADE DE AUDIO (latencyHint) — o remedio para o "corta"
   *
   * O jogador relatou "trepidada de ruido quando tem muitos objetos", com o
   * Gerenciador de Tarefas mostrando CPU 36% e as duas GPUs em ~30% DURANTE o
   * jogo. Maquina folgada e som cortando ao mesmo tempo tem uma explicacao so:
   * UNDERRUN. A thread de audio do navegador e UMA, processa blocos de 128
   * amostras e tem `bufferSize/sampleRate` para entregar cada lote. Se o lote
   * atrasa, a placa recebe silencio — e silencio no meio de uma onda e um
   * estalo. Nada disso aparece na CPU total, porque o gargalo e um PRAZO de
   * uma thread, nao a capacidade da maquina.
   *
   * A medicao (shots/_dspload.html + tools/dsprun.sh, OfflineAudioContext com
   * DSP de verdade) mostrou que esta trilha e cara por construcao e que a
   * conta esta espalhada: o grafo fixo responde por so ~14% e o resto sao as
   * vozes, com a guitarra custando ~4x por nota o que custa qualquer outra
   * familia. Nao ha um vilao para remover — cortar custo de verdade exigiria
   * mudar o som, e o jogador disse que a musica esta EXCELENTE.
   *
   * Sobra a outra alavanca, que e maior e nao custa uma amostra de timbre:
   * DAR FOLGA A THREAD. `latencyHint` nao altera o DSP; altera o tamanho do
   * lote de saida, ou seja, quantos blocos de 128 amostras a thread pode
   * adiantar antes que a placa fique sem nada. Com 'interactive' (o que estava
   * aqui) o navegador escolhe o MENOR lote viavel: latencia minima e folga
   * minima — basta um soluco de poucos milissegundos para furar. Com
   * 'playback' o lote e varias vezes maior: a mesma CPU, o mesmo DSP, mas o
   * soluco cabe dentro da folga e nao vira estalo.
   *
   * O preco e latencia — que num jogo de ritmo seria proibitivo se o jogo nao
   * compensasse. Este compensa: `GH.Settings.audioOffsetMs` existe e o
   * `setStability` abaixo REESCREVE esse offset sozinho pela diferenca medida
   * em `ctx.baseLatency`, para o jogador nao ter de refazer a calibracao.
   *
   * O padrao e 'playback'. Antes era 'balanced', na crenca de que ele dobrava
   * a folga — MEDIDO no Edge/Chromium do Windows, nao dobra: 'interactive' e
   * 'balanced' dao o MESMO buffer (10 ms = 3,8 blocos de 128 amostras), e o
   * jogador continuou ouvindo corte com 165 fps. 'playback' da 20 ms (7,5
   * blocos), o dobro da folga, por 10 ms de latencia que a compensacao
   * automatica absorve. Quem tiver maquina sobrando escolhe 'interactive' no
   * menu (Saida de audio); a escolha explicita do jogador e respeitada.
   * ======================================================================== */
  var STAB_KEY = 'guitarrada-hero.audio.v1';
  var VALID_STAB = { interactive: 1, balanced: 1, playback: 1 };
  var DEFAULT_STAB = 'playback';
  var stability = DEFAULT_STAB;
  // O jogador escolheu o modo no menu? Sem escolha explicita vale o padrao —
  // e e assim que quem tinha o 'balanced' antigo salvo migra para o novo.
  var stabChosen = false;
  // O hint com que o contexto ATUAL nasceu. Difere de `stability` quando o
  // jogador escolheu outro modo e ainda nao recarregou a pagina.
  var stabActive = '';
  // baseLatency (ms) observada da ultima vez que o offset foi compensado.
  // Guardar isto e o que impede a compensacao de ser aplicada duas vezes.
  var stabRefMs = -1;

  function stabLoad() {
    try {
      if (!window.localStorage) return;
      var raw = window.localStorage.getItem(STAB_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && o.chosen && o.stability && VALID_STAB[o.stability]) {
        stability = o.stability;
        stabChosen = true;
      }
      if (o && typeof o.refMs === 'number' && isFinite(o.refMs)) stabRefMs = o.refMs;
    } catch (e) { /* localStorage pode nem existir em file:// */ }
  }
  function stabSave() {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(STAB_KEY,
        JSON.stringify({ stability: stability, refMs: stabRefMs, chosen: stabChosen }));
    } catch (e) {}
  }
  stabLoad();

  /* Compensa o offset de calibracao pela MUDANCA de latencia do contexto.
     So a diferenca entra: o valor absoluto de baseLatency ja estava embutido
     na calibracao que o jogador fez com os proprios ouvidos, e sobrescrever o
     numero dele seria pior que nao fazer nada. Positivo = som sai depois =
     relogio de jogo atrasa na mesma medida. */
  function recalibrateOffset() {
    if (!ctx) return 0;
    var bl = (typeof ctx.baseLatency === 'number' && isFinite(ctx.baseLatency))
      ? ctx.baseLatency * 1000 : -1;
    if (bl < 0) return 0;
    if (stabRefMs < 0) { stabRefMs = bl; stabSave(); return 0; }
    var delta = bl - stabRefMs;
    stabRefMs = bl;
    stabSave();
    // Menos de 1 ms nao e mudanca de buffer, e ruido de medicao do navegador.
    if (Math.abs(delta) < 1) return 0;
    try {
      var S = GH.Settings;
      if (!S || typeof S.audioOffsetMs !== 'number') return delta;
      var v = S.audioOffsetMs + delta;
      S.audioOffsetMs = v < -500 ? -500 : (v > 500 ? 500 : v);
      if (typeof S.save === 'function') S.save();
    } catch (e) {}
    return delta;
  }

  // Volumes padrao por barramento. GH.Settings (conductor.js) sobrescreve.
  var DEFAULT_VOL = {
    master: 0.90, music: 0.85, guitar: 1.00, drums: 0.92, sfx: 0.80, crowd: 0.55
  };
  var volume = {
    master: DEFAULT_VOL.master, music: DEFAULT_VOL.music, guitar: DEFAULT_VOL.guitar,
    drums: DEFAULT_VOL.drums, sfx: DEFAULT_VOL.sfx, crowd: DEFAULT_VOL.crowd
  };

  // Quanto de cada barramento vai pros envios por padrao. A guitarra e a que
  // mais precisa: o timbre de guitarrada e slapback + reverb curto.
  // Com as IRs normalizadas em norma L2, o envio e o wet/dry aproximado:
  // 0.30 de envio ~= 18% de sala na soma. Valores calibrados por medicao.
  var DEFAULT_SEND = {
    music:  { reverb: 0.16, delay: 0.00 },
    guitar: { reverb: 0.30, delay: 0.32 },
    // Bateria sem reverb global: a sala dela ja vem do sintetizador (gravada
    // na stem). Com os dois, o eco no bumbo e na caixa ficava dobrado.
    drums:  { reverb: 0.00, delay: 0.00 },
    // Efeitos quase secos: o eco nas palhetadas incomodava. So um toque de
    // sala (era reverb 0.22 + delay 0.06) para os bipes nao soarem "de papel".
    sfx:    { reverb: 0.06, delay: 0.00 },
    crowd:  { reverb: 0.45, delay: 0.00 }
  };

  /* --------------------------------------------------------------------------
   * Utilidades numericas locais (sem depender de GH.Util — este arquivo tem que
   * ser auto-suficiente e carregar antes de qualquer coisa musical)
   * ------------------------------------------------------------------------ */

  // mulberry32: PRNG deterministico de 32 bits, rapido e com boa distribuicao.
  // Usado para gerar IRs e cordas sempre iguais (nada de reverb diferente a
  // cada partida).
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // dB -> ganho linear
  function db(x) { return Math.pow(10, x / 20); }

  // Coeficiente de um passa-baixa de 1 polo para uma frequencia de corte.
  function onePoleCoef(freqHz, sampleRate) {
    return Math.exp(-2 * Math.PI * Math.max(1, freqHz) / sampleRate);
  }

  /* --------------------------------------------------------------------------
   * RUIDOS — gerados corretamente, nao "branco filtrado na marra"
   * ------------------------------------------------------------------------ */

  // Ruido ROSA — filtro de Paul Kellett (versao "refined", 7 polos).
  // Aproxima -3 dB/oitava com erro < 0.05 dB de 10 Hz a 20 kHz, muito mais fiel
  // que jogar um passa-baixa em cima de ruido branco. Cada b_k e um passa-baixa
  // de 1 polo com constante de tempo diferente; a soma das saidas produz a
  // inclinacao 1/f.
  function fillPinkKellett(data, rnd) {
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (var i = 0; i < data.length; i++) {
      var w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      var pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      data[i] = pink * 0.11;   // 0.11 mantem o pico dentro de [-1,1]
    }
  }

  // Ruido ROSA — algoritmo de Voss-McCartney (versao com contador binario).
  // ROWS geradores de branco sao atualizados em taxas que caem pela metade a
  // cada linha; qual linha atualizar em cada amostra sai da contagem de zeros a
  // direita do contador. Somando-os, cada oitava recebe a mesma energia = rosa.
  // Fica com um "grao" ligeiramente diferente do Kellett; usamos ele nas camadas
  // graves da plateia para as duas texturas nao ficarem correlacionadas.
  function fillPinkVoss(data, rnd) {
    var ROWS = 16;
    var rows = new Float32Array(ROWS);
    var runningSum = 0;
    var i, k;
    for (k = 0; k < ROWS; k++) { rows[k] = rnd() * 2 - 1; runningSum += rows[k]; }
    var counter = 0;
    var norm = 1 / (ROWS + 1);
    for (i = 0; i < data.length; i++) {
      counter++;
      // indice da linha = numero de zeros a direita do contador
      var c = counter, idx = 0;
      while ((c & 1) === 0 && idx < ROWS - 1) { c >>= 1; idx++; }
      runningSum -= rows[idx];
      rows[idx] = rnd() * 2 - 1;
      runningSum += rows[idx];
      var white = rnd() * 2 - 1;    // linha "sempre atualizada" (topo do espectro)
      data[i] = (runningSum + white) * norm * 1.9;
    }
  }

  // Ruido MARROM (browniano, -6 dB/oitava): integracao do branco com vazamento
  // (o "leak" impede o passeio aleatorio de sair da escala e virar DC).
  function fillBrown(data, rnd) {
    var last = 0;
    for (var i = 0; i < data.length; i++) {
      var w = rnd() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.2;
    }
  }

  function fillWhite(data, rnd) {
    for (var i = 0; i < data.length; i++) data[i] = rnd() * 2 - 1;
  }

  /* --------------------------------------------------------------------------
   * LACO SEM DEGRAU
   *
   * Todos os ruidos deste arquivo sao tocados com `loop = true`. Um buffer de
   * ruido gerado amostra a amostra NAO comeca nem termina em zero: quando o
   * laco volta, a saida salta de x[n-1] para x[0] numa amostra so.
   *
   * Para o ruido BRANCO tanto faz — branco ja e salto, o degrau some na
   * textura. Para o ROSA e o MARROM nao: neles o valor passeia devagar (-3 e
   * -6 dB/oitava), entao o degrau e uma DESCONTINUIDADE DE BAIXA FREQUENCIA
   * — um baque, repetido a cada volta do laco (4 s no rosa, 3 s no marrom),
   * durante toda a musica, porque o leito de plateia fica ligado do countdown
   * ao fim.
   *
   * MEDIDO (shots/_sfxloop.html, caso BUF), como razao entre o salto do laco e
   * a inclinacao tipica do proprio ruido:
   *     branco   0,33071  /  0,81762  =  0,40x   (some no ruido)
   *     rosa[0]  0,03828  /  0,11517  =  0,33x
   *     rosa[1]  0,43231  /  0,12890  =  3,35x   <-- degrau
   *     marrom   0,14442  /  0,03636  =  3,97x   <-- degrau
   *
   * A correcao e a tecnica classica de loop de sampler, e nao muda o timbre:
   * geramos F amostras A MAIS do que a duracao nominal e cruzamos a cauda
   * sobre a cabeca com uma curva de POTENCIA CONSTANTE (sqrt), truncando
   * depois para a duracao nominal. Duas fatias independentes do mesmo ruido
   * somadas com ganhos sqrt(a) e sqrt(1-a) tem exatamente a mesma potencia
   * que qualquer uma delas sozinha — o espectro e o nivel ficam iguais.
   * Ao fim, a amostra 0 do buffer novo E a amostra `nominal` do temporario, e
   * a ultima e a `nominal-1`: duas amostras VIZINHAS do ruido original. O laco
   * passa a ser continuo por construcao, nao por sorte.
   *
   * Nenhum outro modulo depende destes bytes: `GH.Audio.noiseBuffer()` nao e
   * chamado em lugar nenhum fora deste arquivo (o GH.Synth gera os proprios),
   * entao isto nao encosta na musica que o jogador aprovou.
   * ------------------------------------------------------------------------ */
  var LOOP_FADE = 2048;        // ~43 ms a 48 kHz

  // Preenche `fill(tmp, rnd)` com nominal+F amostras, cruza e devolve `nominal`.
  function seamlessNoise(fill, nominal, seed) {
    var F = Math.min(LOOP_FADE, Math.max(1, nominal >> 2));
    var tmp = new Float32Array(nominal + F);
    fill(tmp, mulberry32(seed));
    var out = new Float32Array(nominal);
    var i;
    // i=0     -> a=0 -> out[0]   = tmp[nominal]   (vizinha de tmp[nominal-1])
    // i=F-1   -> a=1 -> out[F-1] = tmp[F-1]       (vizinha de tmp[F])
    for (i = 0; i < F; i++) {
      var a = F > 1 ? i / (F - 1) : 1;
      out[i] = tmp[i] * Math.sqrt(a) + tmp[nominal + i] * Math.sqrt(1 - a);
    }
    for (i = F; i < nominal; i++) out[i] = tmp[i];
    return out;
  }

  /* --------------------------------------------------------------------------
   * IMPULSE RESPONSE PROCEDURAL — o coracao do reverb
   *
   * Modelo (simples mas convincente):
   *   pre-delay  -> silencio inicial = distancia ate a primeira parede
   *   early      -> punhado de reflexoes discretas (dao o "tamanho" da sala)
   *   tail       -> ruido com envelope exponencial (RT60 controlado)
   *   damping    -> passa-baixa de 1 polo com corte CAINDO ao longo da cauda:
   *                 o ar e as superficies absorvem agudo mais rapido que grave,
   *                 entao o fim do reverb e sempre mais escuro que o comeco
   *   difusao    -> ruido descorrelacionado por canal + taps diferentes em cada
   *                 lado = imagem estereo larga sem soar "duplicada"
   * ------------------------------------------------------------------------ */
  // Norma L2 alvo das IRs. 0.6 = o retorno molhado nunca passa do seco, mesmo
  // com o envio a 100%. Ver o comentario da normalizacao no fim da funcao.
  var REVERB_L2 = 0.6;

  function renderImpulseResponse(opt) {
    var sr = ctx.sampleRate;
    var seconds = opt.seconds;
    var n = Math.max(256, Math.floor(seconds * sr));
    var buffer = ctx.createBuffer(2, n, sr);

    for (var ch = 0; ch < 2; ch++) {
      var data = buffer.getChannelData(ch);
      // Semente diferente por canal => ruido descorrelacionado => estereo real.
      var rnd = mulberry32(opt.seed + ch * 7919);
      var preDelay = Math.floor((opt.preDelayMs / 1000) * sr) + (ch === 1 ? Math.floor(opt.spreadMs / 1000 * sr) : 0);

      // Constante de decaimento: queremos -60 dB exatamente em rt60 segundos.
      // ln(1000) = 6.907755 -> decay = 6.907755 / rt60
      var decay = 6.907755 / Math.max(0.05, opt.rt60);

      // Estado dos filtros do "ar"
      var lpState = 0;
      var hpState = 0, hpPrev = 0;
      var aHP = onePoleCoef(opt.highPassHz, sr);
      var coefRefreshEvery = 64;
      var aLP = onePoleCoef(opt.hfStartHz, sr);

      var buildSamples = Math.max(1, Math.floor(opt.buildMs / 1000 * sr));

      for (var i = 0; i < n; i++) {
        if (i < preDelay) { data[i] = 0; continue; }
        var j = i - preDelay;
        var t = j / sr;
        var norm = t / Math.max(0.001, seconds);

        // Corte do passa-baixa cai exponencialmente de hfStart ate hfEnd.
        if ((j % coefRefreshEvery) === 0) {
          var fc = opt.hfEndHz + (opt.hfStartHz - opt.hfEndHz) * Math.exp(-norm * opt.dampCurve);
          aLP = onePoleCoef(fc, sr);
        }

        var env = Math.exp(-t * decay);
        // "build-up": a densidade sobe nos primeiros ms em vez de comecar com
        // um estalo seco. E o que separa reverb de "porta de ruido".
        if (j < buildSamples) env *= (j / buildSamples) * (j / buildSamples);

        var w = (rnd() * 2 - 1) * env;

        // passa-baixa de 1 polo (absorcao de agudos)
        lpState = w * (1 - aLP) + lpState * aLP;
        var s = lpState;

        // passa-alta de 1 polo (tira o ronco grave que embola a mistura)
        hpState = aHP * (hpState + s - hpPrev);
        hpPrev = s;
        s = hpState;

        data[i] = s * opt.tailGain;
      }

      // Reflexoes iniciais: taps discretos, com ganho decrescente e polaridade
      // alternada (evita acumulo de fase no grave). Cada canal tem seus tempos.
      var taps = opt.earlyTaps;
      for (var k = 0; k < taps; k++) {
        var tapT = (opt.earlyMinMs + (opt.earlyMaxMs - opt.earlyMinMs) * Math.pow(rnd(), 0.72)) / 1000;
        var pos = preDelay + Math.floor(tapT * sr);
        if (pos >= n - 2) continue;
        var g = opt.earlyGain * Math.exp(-tapT * (6.907755 / (opt.rt60 * 0.42))) * (rnd() < 0.5 ? -1 : 1);
        // pequena "mancha" de 3 amostras para o tap nao virar clique digital
        data[pos] += g;
        data[pos + 1] += g * 0.5;
        data[pos + 2] += g * 0.22;
      }

      // Fade final de 30 ms: garante que a IR termina exatamente em zero.
      var fade = Math.min(n, Math.floor(0.03 * sr));
      for (var f = 0; f < fade; f++) {
        var idx = n - 1 - f;
        data[idx] *= (f / fade);
      }
    }

    // Normalizacao pela NORMA L2 (raiz da energia total), nao pelo pico e nem
    // pelo RMS. A convolucao multiplica a amplitude de um sinal de banda larga
    // por ||h||2 = sqrt(soma dos quadrados). Normalizar pelo RMS deixaria esse
    // ganho proporcional a sqrt(comprimento): a cauda de 3 s da 'arena' sairia
    // uns 7 dB mais alta que a de 1,3 s do 'clube' so por ser mais longa, e as
    // duas sairiam ~23 dB acima do sinal seco. Fixando ||h||2 o envio tem
    // ganho previsivel e trocar de sala muda o TAMANHO, nao o volume.
    var energy = 0;
    for (var c2 = 0; c2 < 2; c2++) {
      var d2 = buffer.getChannelData(c2);
      for (var m = 0; m < d2.length; m++) energy += d2[m] * d2[m];
    }
    var norm2 = Math.sqrt(energy / 2);          // norma L2 media por canal
    var scale = norm2 > 1e-9 ? clamp(REVERB_L2 / norm2, 1e-5, 1e5) : 1;
    for (var c3 = 0; c3 < 2; c3++) {
      var d3 = buffer.getChannelData(c3);
      for (var q = 0; q < d3.length; q++) d3[q] *= scale;
    }
    return buffer;
  }

  function buildIRs() {
    // CLUBE — sala pequena de Belem, madeira e gente. Cauda curta, muitas
    // reflexoes iniciais, escurece rapido. Deixa a guitarra "no lugar" sem
    // afogar o ataque da palhetada.
    irs.clube = renderImpulseResponse({
      seconds: 1.30, rt60: 1.20, preDelayMs: 11, spreadMs: 1.7, buildMs: 7,
      hfStartHz: 8200, hfEndHz: 1500, dampCurve: 3.4, highPassHz: 130,
      earlyTaps: 22, earlyMinMs: 7, earlyMaxMs: 95, earlyGain: 0.30,
      tailGain: 0.85, seed: 20260730
    });
    // ARENA — palco grande, cauda longa e escura, pre-delay maior (a parede do
    // fundo esta longe). Usada em Star Power e nos finais grandiosos.
    irs.arena = renderImpulseResponse({
      seconds: 3.00, rt60: 2.80, preDelayMs: 27, spreadMs: 3.1, buildMs: 16,
      hfStartHz: 6600, hfEndHz: 900, dampCurve: 3.9, highPassHz: 105,
      earlyTaps: 30, earlyMinMs: 18, earlyMaxMs: 190, earlyGain: 0.20,
      tailGain: 1.0, seed: 91127
    });
  }

  /* --------------------------------------------------------------------------
   * CORDA PINCADA — Karplus-Strong estendido, renderizado uma vez no init
   *
   * Por que em Float32Array e nao com DelayNode: um laco de realimentacao
   * passando por DelayNode no WebAudio tem atraso MINIMO de 128 amostras (um
   * render quantum), o que limitaria a corda a ~375 Hz. Rodando o algoritmo na
   * mao conseguimos afinacao exata em qualquer frequencia, com allpass de
   * atraso fracionario, e ainda por cima sem custo em tempo de jogo.
   * ------------------------------------------------------------------------ */
  function renderPluck(freq, seconds, opt) {
    var sr = ctx.sampleRate;
    var n = Math.max(128, Math.floor(seconds * sr));
    var out = new Float32Array(n);
    var rnd = mulberry32(opt.seed || 12345);

    var bright = clamp(opt.bright, 0, 0.98);   // 0 = filtro do laco bem fechado
    var damp = clamp(opt.damp, 0.80, 0.9995);  // ganho do laco -> sustain

    // O filtro de laco (media de 2 pontos) ja acrescenta 0.5*(1-bright) amostra
    // de atraso; descontamos isso para a corda ficar AFINADA de verdade.
    var loopExtra = 0.5 * (1 - bright);
    var L = sr / Math.max(20, freq);
    var target = L - loopExtra;
    var N = Math.max(2, Math.floor(target - 0.5));
    var d = target - N;                        // 0.5 <= d < 1.5 (bem condicionado)
    var c = (1 - d) / (1 + d);                 // allpass: atraso fracionario = d

    var line = new Float32Array(N);

    // Excitacao: ruido branco passado por um passa-baixa de 1 polo. Quanto mais
    // alto pickTone, mais "palheta dura"; mais baixo, mais "polpa do dedo".
    var aExc = onePoleCoef(opt.pickTone || 5200, sr);
    var lp = 0, i;
    for (i = 0; i < N; i++) {
      var w = rnd() * 2 - 1;
      lp = w * (1 - aExc) + lp * aExc;
      line[i] = lp;
    }
    // Tira o DC da excitacao, senao a corda "escorrega" e estoura no limiter.
    var mean = 0;
    for (i = 0; i < N; i++) mean += line[i];
    mean /= N;
    for (i = 0; i < N; i++) line[i] -= mean;

    var idx = 0, apIn = 0, apOut = 0;
    for (i = 0; i < n; i++) {
      var cur = line[idx];
      out[i] = cur;

      var nxt = line[(idx + 1) % N];
      var avg = 0.5 * (cur + nxt);
      var loopIn = damp * (bright * cur + (1 - bright) * avg);

      // allpass de 1a ordem: y[n] = c*x[n] + x[n-1] - c*y[n-1]
      var y = c * loopIn + apIn - c * apOut;
      apIn = loopIn; apOut = y;

      line[idx] = y;
      idx = (idx + 1) % N;
    }

    // Transiente de palheta: raspada curtissima e brilhante somada no ataque.
    var clickN = Math.floor(sr * 0.0035);
    var clp = 0, aClick = onePoleCoef(9000, sr);
    for (i = 0; i < clickN && i < n; i++) {
      var cw = rnd() * 2 - 1;
      clp = cw * (1 - aClick) + clp * aClick;
      out[i] += clp * (opt.pickNoise || 0.35) * (1 - i / clickN);
    }

    // Normaliza e aplica fades (1 ms na entrada, 12 ms na saida) — sem cliques.
    // O pico e medido AQUI, depois do transiente somado: medir antes deixaria a
    // palhetada estourar acima de 1.0 e sujar o limitador do master.
    var peak = 1e-9;
    for (i = 0; i < n; i++) {
      var av = out[i] < 0 ? -out[i] : out[i];
      if (av > peak) peak = av;
    }
    var g = 0.92 / peak;
    var fadeIn = Math.floor(sr * 0.001);
    var fadeOut = Math.floor(sr * 0.012);
    for (i = 0; i < n; i++) {
      var a = 1;
      if (i < fadeIn) a = i / fadeIn;
      if (i > n - fadeOut) a *= (n - i) / fadeOut;
      out[i] = out[i] * g * a;
    }

    var buf = ctx.createBuffer(1, n, sr);
    buf.getChannelData(0).set(out);
    return buf;
  }

  function buildPlucks() {
    // Afinacao das raias: mi maior pentatonico ascendente (E4 G#4 B4 C#5 E5).
    // Verde -> laranja sobe de tom, entao o proprio ato de acertar a sequencia
    // ja soa musical, e o acorde (varias raias juntas) fecha um mi maior 6.
    var freqs = [329.63, 415.30, 493.88, 554.37, 659.25];
    pluckBuf.length = 0;
    for (var i = 0; i < 5; i++) {
      pluckBuf.push(renderPluck(freqs[i], 0.62, {
        damp: 0.9915 - i * 0.0006,      // agudo decai um pouco mais rapido
        bright: 0.42 + i * 0.05,
        pickTone: 4800 + i * 700,
        pickNoise: 0.34,
        seed: 7001 + i * 137
      }));
    }
    // Nota aberta: corda grave (E2) com sustain longo e timbre escuro.
    pluckOpen = renderPluck(82.41, 1.05, {
      damp: 0.9968, bright: 0.22, pickTone: 2600, pickNoise: 0.5, seed: 4242
    });
  }

  /* --------------------------------------------------------------------------
   * WAVESHAPER — curva de saturacao (tanh macio, sem alias grosseiro)
   * ------------------------------------------------------------------------ */
  /* Curva do SOFT-CLIPPER DE SEGURANCA (ultimo estagio do master).
   *
   * Por que ele existe: o DynamicsCompressorNode do WebAudio nao tem lookahead.
   * Com attack de 2 ms, um transiente muito rapido (cinco gems batendo juntas)
   * escapa por cima do teto do limitador e sai acima de 0 dBFS — o conversor
   * corta em quadrado e o resultado e um estalo feio. Medido: +1.8 dBFS num
   * acorde de cinco notas.
   *
   * A solucao e a mesma de qualquer cadeia de masterizacao seria: depois do
   * limitador, um saturador macio que por CONSTRUCAO nao consegue passar do
   * teto. Ate 'knee' (-2.5 dBFS) ele e a identidade exata — transparente no uso
   * normal; acima disso a tangente hiperbolica dobra o sinal e o valor tende
   * assintoticamente a 'ceiling'.
   *
   * O WaveShaper mapeia SEMPRE a entrada [-1,1] sobre a tabela e trava fora
   * disso. Por isso a cadeia atenua por 1/S antes e recupera S depois: assim a
   * tabela cobre picos de ate +-3 (+9,5 dBFS) sem achatar nas pontas.
   */
  var SAFE_SCALE = 3;
  function safetyClipCurve() {
    var n = 4097;                       // impar: o centro cai exatamente em 0
    var curve = new Float32Array(n);
    var knee = 0.75, ceiling = 0.985, span = ceiling - knee;
    for (var i = 0; i < n; i++) {
      var u = (i / (n - 1)) * 2 - 1;    // posicao na tabela, -1..1
      var v = u * SAFE_SCALE;           // sinal real correspondente
      var a = v < 0 ? -v : v, y;
      if (a <= knee) y = a;
      else y = knee + span * Math.tanh((a - knee) / span);
      curve[i] = (v < 0 ? -y : y) / SAFE_SCALE;
    }
    return curve;
  }

  function shaperCurve(amount) {
    var key = String(Math.round(amount * 100));
    if (shaperCurves[key]) return shaperCurves[key];
    var n = 2048, curve = new Float32Array(n), k = Math.max(0.01, amount) * 12;
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    shaperCurves[key] = curve;
    return curve;
  }

  /* --------------------------------------------------------------------------
   * MONTAGEM DO GRAFO
   * ------------------------------------------------------------------------ */
  function buildGraph() {
    masterGain = ctx.createGain();
    masterGain.gain.value = volume.master;

    // ---- COLA DE MIXAGEM (bus glue) ----------------------------------------
    // Compressao leve e lenta, do tipo que se usa no bus da bateria/master:
    //  threshold -18 dBFS  -> so age nos picos da mistura, nao no corpo
    //  ratio 2:1           -> 2 dB entram, 1 dB sai. Compressao de "cola",
    //                         nao de controle de dinamica
    //  knee 24 dB          -> joelho muito macio: a compressao entra
    //                         gradualmente, sem "porta" audivel
    //  attack 12 ms        -> deixa passar o transiente do bumbo/caixa e da
    //                         palhetada; se fosse rapido, mataria o ataque
    //  release 220 ms      -> ~1 tempo a 130 bpm: solta junto com a musica em
    //                         vez de bombear contra ela
    glueComp = ctx.createDynamicsCompressor();
    glueComp.threshold.value = -18;
    glueComp.knee.value = 24;
    glueComp.ratio.value = 2;
    glueComp.attack.value = 0.012;
    glueComp.release.value = 0.22;

    // ---- LIMITADOR (teto de seguranca) -------------------------------------
    //  threshold -1.5 dBFS -> headroom de 1.5 dB: nenhum pico chega no conversor
    //                         em 0 dBFS (inter-sample peaks nao clipam)
    //  ratio 20            -> maximo do no; com knee 0 vira praticamente
    //                         "parede", que e o que um limiter tem que ser
    //  knee 0              -> joelho duro: abaixo do teto, transparente;
    //                         acima, segura seco
    //  attack 0.002        -> o DynamicsCompressorNode nao tem lookahead, entao
    //                         2 ms e o compromisso: rapido o bastante pra pegar
    //                         o pico, lento o bastante pra nao distorcer grave
    //  release 0.09        -> solta rapido, sem "respiracao" audivel
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.09;

    // ---- REDE DE SEGURANCA (soft clip) -------------------------------------
    // Rede de protecao final: garante matematicamente |saida| < 0.985.
    clipIn = ctx.createGain();
    clipIn.gain.value = 1 / SAFE_SCALE;
    safetyClip = ctx.createWaveShaper();
    safetyClip.curve = safetyClipCurve();
    safetyClip.oversample = '4x';       // a nao-linearidade so age em picos;
                                        // 4x evita alias quando ela age
    clipOut = ctx.createGain();
    clipOut.gain.value = SAFE_SCALE;

    // Makeup unitario: o teto de -1,5 dBFS do limitador tem que valer de fato.
    // Qualquer ganho aqui simplesmente desfaria o trabalho dele.
    outGain = ctx.createGain();
    outGain.gain.value = 1;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    analyserBytes = new Uint8Array(analyser.frequencyBinCount);

    masterGain.connect(glueComp);
    glueComp.connect(limiter);
    limiter.connect(clipIn);
    clipIn.connect(safetyClip);
    safetyClip.connect(clipOut);
    clipOut.connect(outGain);
    outGain.connect(analyser);
    outGain.connect(ctx.destination);

    buildReverb();
    buildDelay();

    // ---- Barramentos --------------------------------------------------------
    var names = ['music', 'guitar', 'drums', 'sfx', 'crowd'];
    for (var i = 0; i < names.length; i++) {
      var nm = names[i];
      var g = ctx.createGain();
      g.gain.value = volume[nm];
      g.connect(masterGain);
      buses[nm] = g;

      // Envios pos-fader: baixar o volume do barramento baixa junto o efeito,
      // que e como uma mesa de verdade se comporta.
      var sr = ctx.createGain(); sr.gain.value = DEFAULT_SEND[nm].reverb;
      var sd = ctx.createGain(); sd.gain.value = DEFAULT_SEND[nm].delay;
      g.connect(sr); sr.connect(fx.reverbIn);
      g.connect(sd); sd.connect(fx.delayIn);
      busSends[nm] = { reverb: sr, delay: sd };

      // Envios pontuais das vozes (sendFrom) saem ANTES do fader do
      // barramento; sem este estagio, plateia no volume 0 continuava soando
      // pelo reverb. Ele anda junto com o fader (setVolume).
      var vr = ctx.createGain(); vr.gain.value = volume[nm]; vr.connect(fx.reverbIn);
      var vd = ctx.createGain(); vd.gain.value = volume[nm]; vd.connect(fx.delayIn);
      voiceSends[nm] = { reverb: vr, delay: vd };
    }

    graphOk = true;
  }

  function buildReverb() {
    fx.reverbIn = ctx.createGain();
    fx.reverbIn.gain.value = 1;

    // Passa-alta antes do convolver: grave nao deve entrar no reverb, senao a
    // mistura vira lama. Classico de estudio.
    fx.reverbHP = ctx.createBiquadFilter();
    fx.reverbHP.type = 'highpass';
    fx.reverbHP.frequency.value = 190;
    fx.reverbHP.Q.value = 0.6;

    // Passa-baixa suave: corta o "chiado" que a cauda de ruido poderia trazer.
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 9500;
    lp.Q.value = 0.5;

    fx.reverbConv = ctx.createConvolver();
    fx.reverbConv.normalize = false;   // ja normalizamos por energia na geracao
    // A IR so existe depois de buildBuffers(); atribuimos la. Nunca setamos
    // 'undefined' aqui — alguns navegadores reclamam.
    if (irs[currentIR]) fx.reverbConv.buffer = irs[currentIR];

    fx.reverbReturn = ctx.createGain();
    fx.reverbReturn.gain.value = 1.0;   // o nivel util e definido pelos envios

    fx.reverbIn.connect(fx.reverbHP);
    fx.reverbHP.connect(lp);
    lp.connect(fx.reverbConv);
    fx.reverbConv.connect(fx.reverbReturn);
    fx.reverbReturn.connect(masterGain);
  }

  function buildDelay() {
    // DELAY PING-PONG: o eco pula esquerda/direita. Estrutura classica:
    //   entrada -> dL -> (pan esquerda) -> saida
    //                 \-> dR -> (pan direita) -> saida
    //                        \-> filtro -> feedback -> dL   (fecha o laco)
    // Cada volta do laco passa pelo filtro, entao cada repeticao fica mais
    // escura e mais estreita — exatamente o slapback de fita da guitarrada.
    fx.delayIn = ctx.createGain();
    fx.delayIn.gain.value = 1;

    fx.delayL = ctx.createDelay(2.0);
    fx.delayR = ctx.createDelay(2.0);
    fx.delayL.delayTime.value = 0.24;
    fx.delayR.delayTime.value = 0.24;

    fx.delayHP = ctx.createBiquadFilter();
    fx.delayHP.type = 'highpass';
    fx.delayHP.frequency.value = 260;   // tira grave acumulado no laco
    fx.delayHP.Q.value = 0.7;

    fx.delayLP = ctx.createBiquadFilter();
    fx.delayLP.type = 'lowpass';
    fx.delayLP.frequency.value = 3400;  // cada repeticao mais abafada (fita)
    fx.delayLP.Q.value = 0.6;

    fx.delayFb = ctx.createGain();
    fx.delayFb.gain.value = 0.42;       // ~6 repeticoes audiveis; < 1 = estavel

    fx.delayPanL = makePanner(-0.92);
    fx.delayPanR = makePanner(0.92);

    fx.delayReturn = ctx.createGain();
    fx.delayReturn.gain.value = 0.9;

    fx.delayIn.connect(fx.delayL);
    fx.delayL.connect(fx.delayR);
    fx.delayR.connect(fx.delayHP);
    fx.delayHP.connect(fx.delayLP);
    fx.delayLP.connect(fx.delayFb);
    fx.delayFb.connect(fx.delayL);

    fx.delayL.connect(fx.delayPanL.input);
    fx.delayR.connect(fx.delayPanR.input);
    fx.delayPanL.output.connect(fx.delayReturn);
    fx.delayPanR.output.connect(fx.delayReturn);
    fx.delayReturn.connect(masterGain);
  }

  // StereoPannerNode com fallback (navegadores antigos ou contextos exoticos).
  function makePanner(pan) {
    if (ctx.createStereoPanner) {
      var p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      return { input: p, output: p, pan: p.pan, node: p };
    }
    // Fallback: dois ganhos com lei de potencia constante num ChannelMerger.
    var g = ctx.createGain();
    var merger = ctx.createChannelMerger(2);
    var gl = ctx.createGain(), gr = ctx.createGain();
    var a = (clamp(pan, -1, 1) + 1) * 0.25 * Math.PI;
    gl.gain.value = Math.cos(a);
    gr.gain.value = Math.sin(a);
    g.connect(gl); g.connect(gr);
    gl.connect(merger, 0, 0);
    gr.connect(merger, 0, 1);
    return { input: g, output: merger, pan: null, node: merger };
  }

  function buildBuffers() {
    var sr = ctx.sampleRate;

    // TODOS os ruidos daqui sao tocados em laco, entao todos passam pelo
    // cruzamento de cauda sobre cabeca (ver `seamlessNoise`). A duracao
    // nominal fica igual a de sempre: o cruzamento consome amostras EXTRAS.

    // Branco: 2 s mono. Serve de materia-prima pra percussao e raspadas.
    var nW = Math.floor(sr * 2);
    var wb = ctx.createBuffer(1, nW, sr);
    wb.getChannelData(0).set(seamlessNoise(fillWhite, nW, 1337));
    noiseBuf.white = wb;

    // Rosa: 4 s ESTEREO com canais descorrelacionados (Kellett na esquerda,
    // Voss na direita) — a plateia precisa ser larga, nao um ponto no centro.
    var nP = Math.floor(sr * 4);
    var pb = ctx.createBuffer(2, nP, sr);
    pb.getChannelData(0).set(seamlessNoise(fillPinkKellett, nP, 90210));
    pb.getChannelData(1).set(seamlessNoise(fillPinkVoss, nP, 555111));
    noiseBuf.pink = pb;

    // Marrom: 3 s mono. Corpo grave de multidao, bumbo e trovao.
    var nB = Math.floor(sr * 3);
    var bb = ctx.createBuffer(1, nB, sr);
    bb.getChannelData(0).set(seamlessNoise(fillBrown, nB, 24680));
    noiseBuf.brown = bb;

    buildIRs();
    if (fx.reverbConv) fx.reverbConv.buffer = irs[currentIR] || irs.clube;
    buildPlucks();
  }

  /* --------------------------------------------------------------------------
   * Deteccao de modo mudo
   * ------------------------------------------------------------------------ */
  function isCaptureMode() {
    try {
      if (window.__GH_CAP) return true;
      var s = (window.location && window.location.search) || '';
      if (/[?&]cap=/.test(s)) return true;
    } catch (e) { /* file:// paranoico */ }
    return false;
  }

  /* --------------------------------------------------------------------------
   * Gerencia de vozes de SFX
   * ------------------------------------------------------------------------ */
  function takeVoice() {
    if (voices >= MAX_VOICES) { droppedVoices++; return false; }
    if (liveNodes >= MAX_SFX_NODES) { droppedNodes++; return false; }
    voices++;
    if (voices > peakVoices) peakVoices = voices;
    return true;
  }

  // Agenda a desconexao de um conjunto de nos. Um unico setTimeout por voz;
  // nada de vazar nos no grafo (que no Chrome custa CPU mesmo em silencio).
  function releaseAt(nodes, whenCtxTime) {
    var ms = Math.max(0, (whenCtxTime - ctx.currentTime) * 1000) + 90;
    var done = false;
    liveNodes += nodes.length;
    if (liveNodes > peakNodes) peakNodes = liveNodes;
    setTimeout(function () {
      if (done) return;
      done = true;
      for (var i = 0; i < nodes.length; i++) {
        try { nodes[i].disconnect(); } catch (e) { /* ja desconectado */ }
      }
      liveNodes -= nodes.length;
      if (liveNodes < 0) liveNodes = 0;
      voices--;
      if (voices < 0) voices = 0;
    }, ms);
  }

  function now() { return ctx ? ctx.currentTime : 0; }

  // Destino padrao de um efeito: barramento sfx.
  function sfxOut() { return buses.sfx || masterGain; }

  // Envio pontual pra reverb/delay a partir de um no qualquer. `bus` e o
  // barramento em que a voz toca: o envio passa pelo fader dele, entao
  // volume 0 cala o som E o eco. Sem `bus`, vai direto para o efeito.
  function sendFrom(node, target, amount, bus) {
    if (!ctx || !node || amount <= 0) return null;
    var which = (target === 'delay') ? 'delay' : 'reverb';
    var dest = (bus && voiceSends[bus]) ? voiceSends[bus][which]
             : (which === 'delay' ? fx.delayIn : fx.reverbIn);
    var g = ctx.createGain();
    g.gain.value = amount;
    node.connect(g);
    g.connect(dest);
    return g;
  }

  /* Envelope percussivo padrao: ataque linear curtissimo + queda exponencial.
   *
   * A rampa exponencial NUNCA chega a zero (por isso o alvo e 0,0001): ela so
   * se aproxima. Sem o remate abaixo, o ganho fica parado em 0,0001 ate a
   * fonte ser parada e o no desconectado — e um `stop()`/`disconnect()` sobre
   * um valor diferente de zero e, por definicao, um degrau. 0,0001 e -80 dBFS
   * e sozinho ninguem ouve, mas a regra "toda voz termina em zero exato" e o
   * que impede a classe inteira de estalo, e custa quatro milissegundos que
   * ficam 80 dB abaixo do som. Ver `ZERO_TAIL`. */
  var ZERO_TAIL = 0.004;
  function perc(param, t0, peak, attack, decay) {
    param.cancelScheduledValues(t0);
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    param.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    param.linearRampToValueAtTime(0, t0 + attack + decay + ZERO_TAIL);
  }

  // Remate de silencio para os envelopes escritos a mao (os que nao usam
  // perc): fecha em zero exato `ZERO_TAIL` depois do fim da queda.
  function zeroAt(param, tEnd) {
    try { param.linearRampToValueAtTime(0, tEnd + ZERO_TAIL); } catch (e) {}
  }

  function osc(type, freq, t0) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    return o;
  }

  function filt(type, freq, q) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q === undefined ? 1 : q;
    return f;
  }

  function noiseSrc(kind, loop) {
    var b = noiseBuf[kind] || noiseBuf.white;
    var s = ctx.createBufferSource();
    s.buffer = b;
    s.loop = !!loop;
    return s;
  }

  // Posicao estereo de uma raia: usa GH.Layout se ja existir (util.js carrega
  // antes), com fallback pra formula canonica do contrato.
  function lanePan(lane) {
    var x;
    try {
      if (GH.Layout && typeof GH.Layout.laneX === 'function') x = GH.Layout.laneX(lane);
      else x = (lane - 2) * 0.72;
    } catch (e) { x = (lane - 2) * 0.72; }
    return clamp(x / 1.8, -1, 1) * 0.72;
  }

  /* ==========================================================================
   * EFEITOS SONOROS — tudo sintetizado no instante do disparo
   * ========================================================================== */

  // Afinacao das cordas do acerto, em MIDI (as `freqs` de buildPlucks).
  var PLUCK_MIDI = [64, 68, 71, 73, 76];

  /* Quanto reafinar uma corda para tocar a nota `midi` da melodia: a nota e
     dobrada em oitavas para cair a no maximo meio oitava da corda, assim o
     timbre (Karplus-Strong) quase nao muda. 1 = sem nota (afinacao da raia). */
  function retune(stringMidi, midi) {
    if (!(midi > 0)) return 1;
    var d = midi - stringMidi;
    d = ((d % 12) + 12) % 12;
    if (d > 6) d -= 12;
    return Math.pow(2, d / 12);
  }

  // Acerto de nota: corda pincada + brilho por qualidade. Com `midi`, a corda
  // toca a NOTA DA MELODIA (no registro dela); sem, a afinacao fixa da raia —
  // que e mi pentatonico e brigava com musicas em outros tons.
  function sfxHit(lane, quality, midi) {
    if (!ctx || !graphOk || !takeVoice()) return;
    var t = now();
    var i = clamp(lane | 0, 0, 4);
    var buf = pluckBuf[i];
    if (!buf) { voices--; return; }
    var perfect = (quality === 'perfect');

    var src = ctx.createBufferSource();
    src.buffer = buf;
    // Micro-variacao de afinacao: duas notas iguais nunca soam identicas.
    src.playbackRate.value = retune(PLUCK_MIDI[i], midi) *
      (1 + (Math.random() - 0.5) * 0.012 + (perfect ? 0.004 : 0));

    // Corpo: realce medio-baixo simulando a caixa da guitarra.
    var body = filt('peaking', 420, 1.1);
    body.gain.value = 3.5;

    // Brilho: acerto perfeito abre o filtro; acerto "bom" fica mais fechado.
    var tone = filt('lowpass', perfect ? 7200 : 4600, 0.8);

    // Nivel modesto de proposito: o "som do acerto" e um verniz por cima da
    // nota que a GUITARRA ja esta tocando (GH.Synth). Se ele dominar, um acorde
    // de cinco gems engole a musica inteira.
    //
    // Envelope de corda de verdade, em DOIS estagios: a energia da palhetada
    // cai rapido nos primeiros 60 ms (e o transiente) e depois a corda segue
    // soando bem mais baixo por uns 300 ms. Uma exponencial unica ate zero
    // transformaria a corda num "tec" seco e jogaria fora o Karplus-Strong.
    var peakG = perfect ? 0.55 : 0.42;
    var durG = perfect ? 0.46 : 0.33;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peakG, t + 0.002);
    g.gain.exponentialRampToValueAtTime(peakG * 0.34, t + 0.065);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durG);
    zeroAt(g.gain, t + durG);

    var pan = makePanner(lanePan(i));

    src.connect(body); body.connect(tone); tone.connect(g);
    // SECA de proposito: sem envio proprio de reverb/delay. O delay de 18%
    // repetia cada palhetada ("ping... ping") e o jogador pediu sem eco; o
    // que sobra de ambiente vem so do toque minimo do barramento sfx.
    g.connect(pan.input); pan.output.connect(sfxOut());

    src.start(t);
    src.stop(t + 0.7);
    releaseAt([src, body, tone, g, pan.input, pan.output], t + 0.75);
  }

  /* DICA SONORA DE TEMPO — o jogador tem que OUVIR como foi o acerto, sem
     tirar o olho da pista:
       perfeito  -> "plim": sino curto afinado na nota tocada (duas oitavas
                    acima, fica dentro do tom da musica);
       adiantado -> "bip" curto SUBINDO: chegou antes;
       atrasado  -> "bup" curto DESCENDO: chegou depois.
     Baixo e seco, por cima da corda do acerto. Numa rajada de HOPO/tap o
     sino nao metralha: no maximo um a cada 90 ms. */
  var lastJudgeAt = -1;
  function sfxJudge(kind, midi) {
    if (!ctx || !graphOk) return;
    var t = now();
    if (kind === 'perfect' && t - lastJudgeAt < 0.09) return;
    if (!takeVoice()) return;
    lastJudgeAt = t;
    var g = ctx.createGain(), nodes = [g], end;
    g.gain.setValueAtTime(0.0001, t);
    g.connect(sfxOut());
    if (kind === 'perfect') {
      var m = (midi > 0) ? midi : 76;
      while (m < 84) m += 12;
      while (m > 96) m -= 12;
      var f = 440 * Math.pow(2, (m - 69) / 12);
      var a = osc('sine', f, t);
      var b = osc('sine', f * 2.01, t);          /* parcial de sino, um tico fora */
      var gb = ctx.createGain(); gb.gain.value = 0.35;
      a.connect(g); b.connect(gb); gb.connect(g);
      end = t + 0.38;
      g.gain.linearRampToValueAtTime(0.18, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      a.start(t); b.start(t); a.stop(end + 0.02); b.stop(end + 0.02);
      nodes.push(a, b, gb);
    } else {
      /* uma oitava e meia de deslize em 110 ms: a direcao fica obvia */
      var up = (kind === 'early');
      var o = osc('triangle', up ? 620 : 1500, t);
      o.frequency.exponentialRampToValueAtTime(up ? 1600 : 520, t + 0.11);
      var lp = filt('lowpass', up ? 6000 : 2800, 0.7);
      o.connect(lp); lp.connect(g);
      end = t + 0.13;
      g.gain.linearRampToValueAtTime(0.15, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      o.start(t); o.stop(end + 0.02);
      nodes.push(o, lp);
    }
    zeroAt(g.gain, end);
    releaseAt(nodes, end + 0.1);
  }

  // Erro: corda abafada raspada. Tem que ser DESAGRADAVEL sem ser estridente —
  // ruido com pitch caindo, banda estreita varrendo pra baixo e um pouco de
  // saturacao suja por cima.
  function sfxMiss() {
    if (!ctx || !graphOk || !takeVoice()) return;
    var t = now();
    var dur = 0.22;

    var src = noiseSrc('white', true);
    src.playbackRate.setValueAtTime(1.5, t);
    src.playbackRate.exponentialRampToValueAtTime(0.42, t + dur);

    var bp = filt('bandpass', 1500, 7.5);
    bp.frequency.setValueAtTime(1900, t);
    bp.frequency.exponentialRampToValueAtTime(320, t + dur);

    var shaper = ctx.createWaveShaper();
    shaper.curve = shaperCurve(0.55);
    shaper.oversample = '2x';

    // Camada de "thud": a mao esquerda batendo na corda morta.
    var thud = noiseSrc('brown', true);
    var thLP = filt('lowpass', 260, 1.4);
    var thG = ctx.createGain();
    perc(thG.gain, t, 0.35, 0.004, 0.11);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.11, t + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    zeroAt(g.gain, t + dur);

    src.connect(bp); bp.connect(shaper); shaper.connect(g);
    thud.connect(thLP); thLP.connect(thG); thG.connect(sfxOut());
    g.connect(sfxOut());
    var sR = sendFrom(g, 'reverb', 0.05, 'sfx');

    src.start(t, Math.random() * 1.2);
    src.stop(t + dur + 0.05);
    thud.start(t, Math.random() * 1.2);
    thud.stop(t + 0.2);
    var nodes = [src, bp, shaper, g, thud, thLP, thG];
    if (sR) nodes.push(sR);
    releaseAt(nodes, t + dur + 0.1);
  }

  // Nota aberta (o bastao): uma PALHETADA de verdade. As cinco cordas das
  // raias soam de verde a laranja, 14 ms uma da outra, e juntas fecham o mi
  // maior 6 da afinacao das raias, por cima da corda solta grave. Limpo e
  // afinado de proposito: a versao anterior (corda grave com drive e um sub
  // que CAIA de tom) soava como erro justo no acerto mais vistoso da pista.
  // Com `midi` (a fundamental do acorde naquele compasso), a palhetada inteira
  // e transposta para ele: um mi maior 6 fixo brigava com acorde de la ou re.
  var OPEN_STRUM_GAP = 0.014;
  function sfxOpenHit(midi) {
    if (!ctx || !graphOk || !takeVoice()) return;
    var t = now();
    var nodes = [];
    var key = retune(40, midi);   /* a palhetada nasce em mi (E2 / E4) */

    // soma das cordas: os envios saem daqui, uma vez so
    var mix = ctx.createGain();
    mix.connect(sfxOut());
    nodes.push(mix);

    for (var i = 0; i < 5; i++) {
      if (!pluckBuf[i]) continue;
      var t0 = t + i * OPEN_STRUM_GAP;
      var src = ctx.createBufferSource();
      src.buffer = pluckBuf[i];
      src.playbackRate.value = key * (1 + (Math.random() - 0.5) * 0.008);
      var tone = filt('lowpass', 6400, 0.7);
      // a palheta perde um pouco de forca atravessando as cordas
      var pk = 0.40 - i * 0.022;
      var g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(pk, t0 + 0.002);
      g.gain.exponentialRampToValueAtTime(pk * 0.38, t0 + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.58);
      zeroAt(g.gain, t0 + 0.58);
      var pan = makePanner(lanePan(i) * 0.7);
      src.connect(tone); tone.connect(g); g.connect(pan.input); pan.output.connect(mix);
      src.start(t0);
      src.stop(t0 + 0.62);
      nodes.push(src, tone, g, pan.input, pan.output);
    }

    // corda solta grave (E2), limpa: da o "peso" do bastao sem sujeira
    var low = ctx.createBufferSource();
    low.buffer = pluckOpen || pluckBuf[0];
    low.playbackRate.value = key;
    var lowTone = filt('lowpass', 2400, 0.7);
    var lowG = ctx.createGain();
    perc(lowG.gain, t, 0.42, 0.003, 0.80);
    low.connect(lowTone); lowTone.connect(lowG); lowG.connect(mix);
    low.start(t); low.stop(t + 1.0);
    nodes.push(low, lowTone, lowG);

    // seca, como o acerto normal (sem eco na palhetada)
    releaseAt(nodes, t + 1.1);
  }

  // Star Power ligado: varredura ascendente + cintilancia harmonica + sub drop.
  function sfxStarPowerOn() {
    if (!ctx || !graphOk || !takeVoice()) return;
    var t = now();
    var out = sfxOut();

    // 1) Varredura: dois dentes-de-serra desafinados subindo, filtro ressonante
    //    acompanhando. E o "carregou" do power-up.
    var swG = ctx.createGain();
    swG.gain.setValueAtTime(0.0001, t);
    swG.gain.linearRampToValueAtTime(0.30, t + 0.10);
    swG.gain.exponentialRampToValueAtTime(0.0001, t + 0.72);
    zeroAt(swG.gain, t + 0.72);

    var lp = filt('lowpass', 300, 9);
    lp.frequency.setValueAtTime(280, t);
    lp.frequency.exponentialRampToValueAtTime(9000, t + 0.52);

    var swNodes = [swG, lp];
    lp.connect(swG); swG.connect(out);
    for (var k = 0; k < 2; k++) {
      var o = osc('sawtooth', 120 * (k ? 1.006 : 1), t);
      o.frequency.exponentialRampToValueAtTime(960, t + 0.52);
      var og = ctx.createGain();
      og.gain.value = 0.5;
      o.connect(og); og.connect(lp);
      o.start(t); o.stop(t + 0.8);
      swNodes.push(o, og);
    }

    // 2) Cintilancia: parciais harmonicos entrando escalonados, bem agudos, com
    //    muito reverb. E a "poeira magica" por cima da varredura.
    var shimG = ctx.createGain();
    shimG.gain.value = 0.10;
    shimG.connect(out);
    var sR = sendFrom(shimG, 'reverb', 0.85, 'sfx');
    var sD = sendFrom(shimG, 'delay', 0.35, 'sfx');
    var base = 659.25;
    var mult = [1, 1.5, 2, 3, 4, 5.04, 6];
    for (var i = 0; i < mult.length; i++) {
      var t0 = t + 0.06 + i * 0.035;
      var so = osc('sine', base * mult[i] * (1 + (Math.random() - 0.5) * 0.004), t0);
      var sg = ctx.createGain();
      perc(sg.gain, t0, 0.30 / (1 + i * 0.55), 0.012, 0.55 + i * 0.06);
      so.connect(sg); sg.connect(shimG);
      so.start(t0); so.stop(t0 + 1.1);
      swNodes.push(so, sg);
    }

    // 3) Sub drop: o "peso" do momento.
    var sub = osc('sine', 220, t);
    sub.frequency.exponentialRampToValueAtTime(44, t + 0.55);
    var subG = ctx.createGain();
    perc(subG.gain, t, 0.38, 0.008, 0.6);
    sub.connect(subG); subG.connect(out);
    sub.start(t); sub.stop(t + 0.7);
    swNodes.push(sub, subG, shimG);
    if (sR) swNodes.push(sR);
    if (sD) swNodes.push(sD);

    releaseAt(swNodes, t + 1.5);
  }

  // Star Power desligado: varredura descendente curta e um sino apagando.
  function sfxStarPowerOff() {
    if (!ctx || !graphOk || !takeVoice()) return;
    var t = now();
    var out = sfxOut();

    var lp = filt('lowpass', 7000, 6);
    /* ⚠ DEFEITO CONHECIDO, DELIBERADAMENTE NAO CORRIGIDO NESTA RODADA.
     *
     * Esta rampa nao tem ancora: `filt()` faz `frequency.value = 7000`, e
     * `.value` NAO e um evento de automacao. Uma rampa exponencial parte do
     * evento anterior; sem evento anterior, o navegador a trata como tendo
     * comecado no instante ZERO do contexto.
     *
     * MEDIDO em shots/_sfxramp.html — rampa 7000 -> 420 Hz agendada em
     * t=1,00 s com alvo em t=1,38 s:
     *     t=1,00 s   sem ancora 911 Hz   com ancora 7000 Hz
     *     t=1,05 s   sem ancora 823 Hz   com ancora 4834 Hz
     * Ou seja: a varredura NAO ACONTECE. No jogo, onde o contexto ja anda ha
     * minutos quando o Star Power desliga, o filtro ja esta parado em 420 Hz
     * na primeira amostra. O mesmo vale para o `lp` do sfxFail.
     *
     * Consertar e uma linha (`setValueAtTime(7000, t)`) e foi testado: muda o
     * som — a varredura passa a existir. Como esta rodada e sobre TIRAR
     * ESTALO sem mexer no que o jogador ja ouve, a correcao fica registrada
     * aqui e nao entra. Quem for mexer no timbre destes dois efeitos comeca
     * por isto. */
    lp.frequency.exponentialRampToValueAtTime(420, t + 0.38);
    var g = ctx.createGain();
    /* Este ganho entra CHEIO na primeira amostra, sem rampa de ataque — a
     * unica voz de SFX assim. Parece um estalo esperando para acontecer, e
     * chegou a ganhar 3 ms de rampa nesta rodada. A medicao desfez a suspeita
     * e a rampa foi tirada: o sinal que passa por aqui e um `sawtooth` que
     * COMECA no mesmo instante `t`, e um oscilador do WebAudio parte da fase
     * zero. Nao ha degrau porque nao ha sinal para degrau nenhum — a contagem
     * de saltos > 0,20 no render deste efeito e ZERO, antes e depois
     * (tools/sfxab.sh, teste `spoff`). Rampa que nao conserta nada e so
     * mudanca de som, e o som nao e nosso para mudar. */
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    zeroAt(g.gain, t + 0.42);
    lp.connect(g); g.connect(out);

    var o = osc('sawtooth', 780, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.36);
    o.connect(lp);
    o.start(t); o.stop(t + 0.45);

    var bell = osc('triangle', 987.77, t);
    var bg = ctx.createGain();
    perc(bg.gain, t, 0.16, 0.005, 0.55);
    bell.connect(bg); bg.connect(out);
    var sR = sendFrom(bg, 'reverb', 0.5, 'sfx');
    bell.start(t); bell.stop(t + 0.7);

    var nodes = [lp, g, o, bell, bg];
    if (sR) nodes.push(sR);
    releaseAt(nodes, t + 0.8);
  }

  // Sequencia subiu de patamar: arpejo curto que sobe conforme o multiplicador.
  function sfxStreakUp(n) {
    if (!ctx || !graphOk || !takeVoice()) return;
    var t = now();
    var out = sfxOut();
    var level = clamp(Math.floor((n || 10) / 10) - 1, 0, 5);
    // Mi maior pentatonico deslocado por patamar — sempre consonante com o hit.
    var scale = [329.63, 415.30, 493.88, 554.37, 659.25, 830.61, 987.77, 1108.73];
    var g = ctx.createGain();
    g.gain.value = 0.24;
    g.connect(out);
    var sR = sendFrom(g, 'reverb', 0.30, 'sfx');
    var sD = sendFrom(g, 'delay', 0.22, 'sfx');
    var nodes = [g];
    if (sR) nodes.push(sR);
    if (sD) nodes.push(sD);

    for (var i = 0; i < 3; i++) {
      var t0 = t + i * 0.052;
      var f = scale[clamp(level + i, 0, scale.length - 1)];
      var o1 = osc('triangle', f, t0);
      var o2 = osc('square', f * 2.002, t0);
      var g1 = ctx.createGain(); perc(g1.gain, t0, 0.55, 0.004, 0.16);
      var g2 = ctx.createGain(); perc(g2.gain, t0, 0.13, 0.004, 0.10);
      var lp = filt('lowpass', 5200, 0.9);
      o1.connect(g1); o2.connect(g2);
      g1.connect(lp); g2.connect(lp); lp.connect(g);
      o1.start(t0); o1.stop(t0 + 0.28);
      o2.start(t0); o2.stop(t0 + 0.22);
      nodes.push(o1, o2, g1, g2, lp);
    }
    releaseAt(nodes, t + 0.5);
  }

  // Falhou: queda desafinada + prato sujo + reverb longo. Momento de derrota.
  function sfxFail() {
    if (!ctx || !graphOk || !takeVoice()) return;
    var t = now();
    var out = sfxOut();
    var dur = 1.5;

    var lp = filt('lowpass', 2600, 4);
    // ⚠ Mesma rampa sem ancora do sfxStarPowerOff — ver o comentario longo la.
    // A varredura de filtro deste efeito tambem nao acontece no jogo. Nao
    // corrigido aqui de proposito: mudaria o som.
    lp.frequency.exponentialRampToValueAtTime(180, t + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    zeroAt(g.gain, t + dur);
    var drive = ctx.createWaveShaper();
    drive.curve = shaperCurve(0.42);
    drive.oversample = '2x';
    lp.connect(drive); drive.connect(g); g.connect(out);
    var sR = sendFrom(g, 'reverb', 0.55, 'sfx');

    var nodes = [lp, g, drive];
    if (sR) nodes.push(sR);

    // Dois dentes-de-serra desafinados caindo uma oitava e meia: o classico
    // "power down" que soa como a fita perdendo velocidade.
    for (var k = 0; k < 2; k++) {
      var o = osc('sawtooth', 233.08 * (k ? 0.995 : 1.005), t);
      o.frequency.exponentialRampToValueAtTime(58 * (k ? 0.99 : 1.01), t + dur * 0.85);
      var og = ctx.createGain(); og.gain.value = 0.5;
      o.connect(og); og.connect(lp);
      o.start(t); o.stop(t + dur);
      nodes.push(o, og);
    }

    // Prato: tres camadas de ruido em bandas altas com decaimentos diferentes.
    var bands = [[3200, 0.9, 0.30], [6100, 0.6, 0.55], [9800, 0.4, 0.85]];
    for (var b = 0; b < bands.length; b++) {
      var ns = noiseSrc('white', true);
      var bp = filt('bandpass', bands[b][0], 0.8);
      var ng = ctx.createGain();
      perc(ng.gain, t, 0.16 * bands[b][1], 0.004, bands[b][2]);
      ns.connect(bp); bp.connect(ng); ng.connect(out);
      var nR = sendFrom(ng, 'reverb', 0.4, 'sfx');
      ns.start(t, Math.random());
      ns.stop(t + 1.0);
      nodes.push(ns, bp, ng);
      if (nR) nodes.push(nR);
    }
    releaseAt(nodes, t + dur + 0.3);
  }

  // Bipes de interface. Curtos, limpos, com um harmonico pra nao soar chato.
  function uiBlip(f0, f1, dur, level, type) {
    if (!ctx || !graphOk || !takeVoice()) return;
    var t = now();
    var o = osc(type || 'triangle', f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.9);
    var o2 = osc('sine', f0 * 2, t);
    o2.frequency.exponentialRampToValueAtTime(f1 * 2, t + dur * 0.9);
    var g = ctx.createGain();
    perc(g.gain, t, level, 0.004, dur);
    var g2 = ctx.createGain();
    perc(g2.gain, t, level * 0.28, 0.004, dur * 0.6);
    var hp = filt('highpass', 220, 0.7);
    o.connect(g); o2.connect(g2);
    g.connect(hp); g2.connect(hp); hp.connect(sfxOut());
    var sR = sendFrom(hp, 'reverb', 0.16, 'sfx');
    o.start(t); o.stop(t + dur + 0.05);
    o2.start(t); o2.stop(t + dur + 0.05);
    var nodes = [o, o2, g, g2, hp];
    if (sR) nodes.push(sR);
    releaseAt(nodes, t + dur + 0.12);
  }

  function sfxUiMove() { uiBlip(660, 880, 0.075, 0.16, 'triangle'); }
  function sfxUiSelect() {
    uiBlip(880, 1320, 0.10, 0.22, 'triangle');
    if (!ctx || !graphOk) return;
    var self = ctx;
    // segunda nota, um pouco depois: confirma a escolha com um intervalo justo
    setTimeout(function () { if (ctx === self) uiBlip(1320, 1760, 0.13, 0.17, 'sine'); }, 70);
  }
  function sfxUiBack() { uiBlip(560, 380, 0.11, 0.17, 'triangle'); }

  // PLATEIA — ruido rosa em banda + camada de "sss" + modulacao lenta + palmas.
  // Multidao de verdade nao e "chiado": e um corpo grave que respira, um medio
  // que carrega as vozes e picos aleatorios de palma e assobio por cima.
  function sfxCrowdCheer(intensity) {
    if (!ctx || !graphOk || !takeVoice()) return;
    var t = now();
    var lv = clamp(intensity === undefined ? 0.7 : intensity, 0, 1);
    var out = buses.crowd || sfxOut();
    var dur = 1.2 + lv * 2.2;

    /* ENVELOPE E RESPIRACAO EM SERIE, NAO SOMADOS NO MESMO PARAMETRO.
     *
     * Antes, o LFO da respiracao era ligado direto em `main.gain`, ou seja, o
     * ganho final era `envelope(t) + lfo(t)*profundidade`. Uma soma. E uma
     * soma nao consegue fechar: o envelope podia descer ate 0,0001 que o
     * ganho continuava oscilando com a amplitude inteira do LFO. Quando as
     * fontes eram paradas, o que se cortava nao era silencio — era sinal.
     *
     * MEDIDO (shots/_sfxloop.html, caso CHEER, crowdCheer(1.0)): o envelope
     * chega a 0,0001 em t=3,60 s, mas o RMS nos 100 ms SEGUINTES era 0,02417
     * — MAIOR que os 0,02097 dos 100 ms anteriores. E no `stop()`, em
     * t=3,80 s, havia um salto de 0,02637, 3,05x a inclinacao tipica do sinal
     * ali. Isso e um corte seco, nao um fim de som.
     *
     * Agora sao dois estagios em serie: `breath` carrega a modulacao (1 +
     * lfo*profundidade_RELATIVA) e `main` carrega so o envelope. O produto no
     * patamar e IDENTICO ao que era — a profundidade relativa e exatamente
     * D/P, entao P*(1 + lfo*D/P) = P + lfo*D. A diferenca aparece so nas
     * bordas, onde agora a modulacao encolhe junto com o envelope e o som
     * chega de fato a zero (que e, alias, como uma plateia de verdade some). */
    var peakG = 0.35 + lv * 0.55;
    var lfoDepth = 0.16 + lv * 0.12;

    var main = ctx.createGain();
    main.gain.setValueAtTime(0.0001, t);
    main.gain.linearRampToValueAtTime(peakG, t + 0.16 + (1 - lv) * 0.2);
    main.gain.setValueAtTime(peakG, t + dur * 0.45);
    main.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    zeroAt(main.gain, t + dur);
    main.connect(out);
    var sR = sendFrom(main, 'reverb', 0.45, 'crowd');

    var breath = ctx.createGain();
    breath.gain.value = 1;
    breath.connect(main);

    var nodes = [main, breath];
    if (sR) nodes.push(sR);

    // Corpo (vozes): rosa filtrado numa banda larga em torno de 900 Hz.
    var body = noiseSrc('pink', true);
    var bodyBP = filt('bandpass', 780 + lv * 260, 0.55);
    var bodyG = ctx.createGain(); bodyG.gain.value = 0.85;
    body.connect(bodyBP); bodyBP.connect(bodyG); bodyG.connect(breath);
    body.start(t, Math.random() * 2);
    body.stop(t + dur + 0.2);

    // Ar (assobios e "sss"): banda alta, mais fraca, so pra dar presenca.
    var air = noiseSrc('pink', true);
    var airHP = filt('highpass', 2600, 0.7);
    var airG = ctx.createGain(); airG.gain.value = 0.14 + lv * 0.20;
    air.connect(airHP); airHP.connect(airG); airG.connect(breath);
    air.start(t, Math.random() * 2);
    air.stop(t + dur + 0.2);

    // Peito (o "uuuh" grave da massa): marrom bem filtrado.
    var chest = noiseSrc('brown', true);
    var chestLP = filt('lowpass', 300, 0.8);
    var chestG = ctx.createGain(); chestG.gain.value = 0.22 + lv * 0.18;
    chest.connect(chestLP); chestLP.connect(chestG); chestG.connect(breath);
    chest.start(t, Math.random() * 1.5);
    chest.stop(t + dur + 0.2);

    // Respiracao: LFO lento modulando o estagio em serie. Sem isso soa a
    // maquina de vento.
    var lfo = osc('sine', 0.55 + Math.random() * 0.5, t);
    var lfoG = ctx.createGain();
    lfoG.gain.value = lfoDepth / peakG;     // profundidade RELATIVA
    lfo.connect(lfoG); lfoG.connect(breath.gain);
    lfo.start(t); lfo.stop(t + dur + 0.2);

    nodes.push(body, bodyBP, bodyG, air, airHP, airG, chest, chestLP, chestG, lfo, lfoG);

    // Palmas: rajadas curtas de ruido em banda, distribuidas com jitter. A
    // quantidade cresce com a intensidade.
    var claps = Math.floor(6 + lv * 22);
    for (var i = 0; i < claps; i++) {
      var ct = t + 0.05 + Math.pow(Math.random(), 0.7) * dur * 0.8;
      var cs = noiseSrc('white', true);
      var cbp = filt('bandpass', 1100 + Math.random() * 2600, 1.1 + Math.random());
      var cg = ctx.createGain();
      perc(cg.gain, ct, 0.05 + Math.random() * 0.06 * (0.4 + lv), 0.001, 0.035 + Math.random() * 0.05);
      var cp = makePanner((Math.random() * 2 - 1) * 0.85);
      cs.connect(cbp); cbp.connect(cg); cg.connect(cp.input); cp.output.connect(out);
      cs.start(ct, Math.random() * 1.5);
      cs.stop(ct + 0.14);
      nodes.push(cs, cbp, cg, cp.input, cp.output);
    }

    releaseAt(nodes, t + dur + 0.4);
  }

  /* --------------------------------------------------------------------------
   * LEITO DE PLATEIA CONTINUO (menus e palco) — liga/desliga com crossfade
   * ------------------------------------------------------------------------ */
  function setAmbience(on, level) {
    if (!ctx || !graphOk) return;
    var t = now();
    var lv = clamp(level === undefined ? 0.35 : level, 0, 1);
    if (on) {
      if (!ambience) {
        var out = buses.crowd || masterGain;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.connect(out);
        var sR = sendFrom(g, 'reverb', 0.5, 'crowd');

        /* Mesmo conserto do crowdCheer, e aqui ele importa mais: este leito
         * fica ligado do countdown ao fim da musica. As duas LFOs somavam
         * +-0,19 ABSOLUTOS no proprio `g.gain`. Duas consequencias:
         *   1. o fade de saida ia para 0,0001 e o ganho continuava passeando
         *      em +-0,19 — quando o setTimeout parava as fontes, cortava som;
         *   2. a profundidade nao acompanhava o volume: com o leito baixo
         *      (`level` < 0,19) o ganho chegava a ficar NEGATIVO, invertendo
         *      a fase da plateia em vez de abaixa-la.
         * Agora a modulacao mora num estagio em serie e e RELATIVA. A
         * referencia e 0,75 — o nivel que o jogo usa do countdown em diante,
         * onde o jogador de fato escuta — entao ali a modulacao e a mesma de
         * sempre (0,16*0,75 = 0,12 e 0,0933*0,75 = 0,07). */
        var breath = ctx.createGain();
        breath.gain.value = 1;
        breath.connect(g);

        var body = noiseSrc('pink', true);
        var bp = filt('bandpass', 720, 0.5);
        var bg = ctx.createGain(); bg.gain.value = 0.8;
        body.connect(bp); bp.connect(bg); bg.connect(breath);

        var chest = noiseSrc('brown', true);
        var clp = filt('lowpass', 250, 0.7);
        var cg2 = ctx.createGain(); cg2.gain.value = 0.3;
        chest.connect(clp); clp.connect(cg2); cg2.connect(breath);

        var air = noiseSrc('pink', true);
        var ahp = filt('highpass', 3000, 0.7);
        var ag = ctx.createGain(); ag.gain.value = 0.10;
        air.connect(ahp); ahp.connect(ag); ag.connect(breath);

        // Duas LFOs incomensuraveis: a modulacao nunca repete o mesmo padrao.
        var l1 = osc('sine', 0.13, t), l1g = ctx.createGain(); l1g.gain.value = 0.12 / 0.75;
        var l2 = osc('sine', 0.071, t), l2g = ctx.createGain(); l2g.gain.value = 0.07 / 0.75;
        l1.connect(l1g); l1g.connect(breath.gain);
        l2.connect(l2g); l2g.connect(breath.gain);

        body.start(t, Math.random() * 2);
        chest.start(t, Math.random() * 1.5);
        air.start(t, Math.random() * 2);
        l1.start(t); l2.start(t);

        ambience = {
          g: g,
          nodes: [g, breath, body, bp, bg, chest, clp, cg2, air, ahp, ag, l1, l1g, l2, l2g]
        };
        if (sR) ambience.nodes.push(sR);
      }
      holdParamAt(ambience.g.gain, t);
      ambience.g.gain.setValueAtTime(Math.max(0.0001, ambience.g.gain.value), t);
      ambience.g.gain.linearRampToValueAtTime(Math.max(0.0002, lv), t + 1.2);
    } else if (ambience) {
      var amb = ambience;
      ambience = null;
      holdParamAt(amb.g.gain, t);
      amb.g.gain.setValueAtTime(Math.max(0.0001, amb.g.gain.value), t);
      amb.g.gain.linearRampToValueAtTime(0.0001, t + 0.8);
      // Zero exato antes de qualquer stop(): agora que a modulacao saiu do
      // caminho do envelope, esta rampa realmente chega ao silencio.
      amb.g.gain.linearRampToValueAtTime(0, t + 0.82);
      setTimeout(function () {
        for (var i = 0; i < amb.nodes.length; i++) {
          try { if (amb.nodes[i].stop) amb.nodes[i].stop(); } catch (e) {}
          try { amb.nodes[i].disconnect(); } catch (e2) {}
        }
      }, 1100);
    }
  }

  /* --------------------------------------------------------------------------
   * API publica
   * ------------------------------------------------------------------------ */

  function init() {
    if (built) return GH.Audio;
    built = true;

    if (isCaptureMode()) {
      // Headless nao tem placa de som: entramos mudos de proposito. A API
      // inteira continua existindo, so que sem efeito colateral.
      muted = true; ctx = null;
      return GH.Audio;
    }

    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { muted = true; ctx = null; return GH.Audio; }

    // MIGRACAO DE QUEM JA CALIBROU.
    // Ate esta rodada o contexto era criado com 'interactive', fixo. Quem ja
    // passou pela calibracao ajustou o audioOffsetMs COM aquele buffer. Se
    // trocarmos o padrao para 'balanced' sem mais nada, a calibracao dele
    // passa a estar errada pela diferenca de latencia — e o jogador nao teria
    // como saber por que "o jogo ficou injusto".
    // Entao, na primeira vez, medimos a latencia que 'interactive' daria
    // NESTA maquina, e guardamos como referencia. `recalibrateOffset()` logo
    // abaixo compensa a diferenca sozinho. Custa um AudioContext descartavel,
    // uma unica vez na vida da instalacao.
    if (stabRefMs < 0) {
      try {
        var ref = new AC({ latencyHint: 'interactive' });
        if (typeof ref.baseLatency === 'number' && isFinite(ref.baseLatency)) {
          stabRefMs = ref.baseLatency * 1000;
          stabSave();
        }
        try { ref.close(); } catch (eR) {}
      } catch (eR2) { /* sem referencia: recalibrateOffset() nao mexe em nada */ }
    }

    try {
      // Ver o bloco "ESTABILIDADE DE AUDIO" no topo: o hint NAO muda o DSP,
      // muda quanto tempo a thread de audio tem de folga antes de furar o
      // prazo. Era fixo em 'interactive' (folga minima). Agora e escolha do
      // jogador, com padrao 'playback' (o unico que da folga extra no Chromium).
      ctx = new AC({ latencyHint: stability });
      stabActive = stability;
    } catch (e) {
      try { ctx = new AC(); stabActive = 'padrão do navegador'; } catch (e2) { ctx = null; }
    }
    if (!ctx) { muted = true; return GH.Audio; }
    // Corrige audioOffsetMs pela DIFERENCA de latencia em relacao a
    // referencia guardada — o jogador nao refaz a calibracao.
    recalibrateOffset();

    try {
      buildGraph();
      buildBuffers();
    } catch (e3) {
      // Qualquer falha montando o grafo derruba o AUDIO, nunca o JOGO.
      try { ctx.close(); } catch (e4) {}
      ctx = null; graphOk = false; muted = true;
      buses.music = buses.guitar = buses.drums = buses.sfx = buses.crowd = null;
      return GH.Audio;
    }

    applySettings();
    return GH.Audio;
  }

  // Le GH.Settings (criado em conductor.js) se ele ja existir. Defensivo: este
  // arquivo carrega ANTES do conductor, entao nunca assumimos que existe.
  function applySettings() {
    try {
      var s = GH.Settings;
      if (!s || !s.volumes) return;
      for (var k in s.volumes) {
        if (Object.prototype.hasOwnProperty.call(s.volumes, k)) setVolume(k, s.volumes[k]);
      }
      if (s.reverbIR) setReverbIR(s.reverbIR);
    } catch (e) { /* configuracao invalida nao pode derrubar o audio */ }
  }

  /* Troca a cauda de uma automacao sem criar um degrau. A leitura no fallback
     precisa acontecer ANTES de cancelScheduledValues(), pois o cancelamento
     pode restaurar imediatamente o valor anterior da timeline. */
  function holdParamAt(param, when) {
    if (!param) return;
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(when);
      return;
    }
    var v = param.value;
    param.cancelScheduledValues(when);
    param.setValueAtTime(v, when);
  }

  // Destrava o contexto no primeiro gesto do usuario (politica de autoplay).
  function unlock() {
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      // Um buffer de 1 amostra "acorda" o pipeline no iOS/Safari.
      var b = ctx.createBuffer(1, 1, ctx.sampleRate);
      var s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
    } catch (e) { return false; }
    return ctx.state === 'running';
  }

  function setVolume(bus, v) {
    var val = clamp(typeof v === 'number' && isFinite(v) ? v : 0, 0, 1.5);
    if (bus === 'master') {
      volume.master = val;
      if (masterGain) rampGain(masterGain.gain, val);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(volume, bus)) return;
    volume[bus] = val;
    if (buses[bus]) rampGain(buses[bus].gain, val);
    if (voiceSends[bus]) {
      rampGain(voiceSends[bus].reverb.gain, val);
      rampGain(voiceSends[bus].delay.gain, val);
    }
  }

  function getVolume(bus) {
    return Object.prototype.hasOwnProperty.call(volume, bus) ? volume[bus] : 0;
  }

  // Rampa curtissima em vez de setar direto: evita clique ao mexer no slider.
  function rampGain(param, v) {
    if (!ctx) return;
    var t = ctx.currentTime;
    try {
      holdParamAt(param, t);
      param.linearRampToValueAtTime(v, t + 0.03);
    } catch (e) { try { param.value = v; } catch (e2) {} }
  }

  function setSend(bus, which, amount) {
    if (!ctx || !busSends[bus]) return;
    var node = which === 'delay' ? busSends[bus].delay : busSends[bus].reverb;
    if (node) rampGain(node.gain, clamp(amount, 0, 1.5));
  }

  function setReverbIR(name) {
    var key = (name === 'arena') ? 'arena' : 'clube';
    currentIR = key;
    if (!ctx || !fx.reverbConv || !irs[key]) return;
    try { fx.reverbConv.buffer = irs[key]; } catch (e) {}
  }

  function setReverbMix(v) { if (fx.reverbReturn) rampGain(fx.reverbReturn.gain, clamp(v, 0, 2)); }
  function setDelayMix(v) { if (fx.delayReturn) rampGain(fx.delayReturn.gain, clamp(v, 0, 2)); }
  function setDelayFeedback(v) { if (fx.delayFb) rampGain(fx.delayFb.gain, clamp(v, 0, 0.85)); }

  function setDelayTime(sec) {
    if (!ctx || !fx.delayL) return;
    var t = clamp(sec, 0.01, 1.8);
    var when = ctx.currentTime;
    try {
      // Rampa de 80 ms: mudar delayTime de supetao produz um "zip" de fita.
      holdParamAt(fx.delayL.delayTime, when);
      fx.delayL.delayTime.linearRampToValueAtTime(t, when + 0.08);
      holdParamAt(fx.delayR.delayTime, when);
      fx.delayR.delayTime.linearRampToValueAtTime(t, when + 0.08);
    } catch (e) {
      try { fx.delayL.delayTime.value = t; fx.delayR.delayTime.value = t; } catch (e2) {}
    }
  }

  // Ajusta o delay a uma subdivisao do andamento (padrao: colcheia pontuada,
  // que e o eco classico do slapback de guitarrada).
  function syncDelayToTempo(bpm, division) {
    if (!(bpm > 0)) return;
    var beat = 60 / bpm;
    setDelayTime(beat * (division || 0.75));
  }

  // Abafa temporariamente um barramento (ex.: abaixar a musica num anuncio).
  function duck(bus, amount, seconds) {
    if (!ctx) return;
    var node = (bus === 'master') ? masterGain : buses[bus];
    if (!node) return;
    var base = (bus === 'master') ? volume.master : (volume[bus] || 0);
    var t = ctx.currentTime;
    var dur = seconds > 0 ? seconds : 0.5;
    try {
      holdParamAt(node.gain, t);
      node.gain.linearRampToValueAtTime(base * clamp(amount, 0, 1), t + 0.05);
      node.gain.linearRampToValueAtTime(base, t + dur);
    } catch (e) {}
  }

  // Nivel RMS aproximado do master (0..1) — util pro palco reagir a musica.
  function getLevel() {
    if (!ctx || !analyser || !analyserBytes) return 0;
    try {
      analyser.getByteFrequencyData(analyserBytes);
      var sum = 0, n = analyserBytes.length;
      for (var i = 0; i < n; i++) sum += analyserBytes[i] * analyserBytes[i];
      return clamp(Math.sqrt(sum / n) / 160, 0, 1);
    } catch (e) { return 0; }
  }

  // Espectro em bandas (preenche o array recebido, sem alocar no loop quente).
  function getSpectrum(outArr) {
    if (!outArr || !outArr.length) return outArr;
    var n = outArr.length, i;
    if (!ctx || !analyser || !analyserBytes) {
      for (i = 0; i < n; i++) outArr[i] = 0;
      return outArr;
    }
    try {
      analyser.getByteFrequencyData(analyserBytes);
      var bins = analyserBytes.length;
      for (i = 0; i < n; i++) {
        // Distribuicao logaritmica: o ouvido nao ouve em escala linear.
        var a = Math.floor(Math.pow(i / n, 2) * bins);
        var b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / n, 2) * bins));
        var s = 0, c = 0;
        for (var j = a; j < b && j < bins; j++) { s += analyserBytes[j]; c++; }
        outArr[i] = c ? (s / c) / 255 : 0;
      }
    } catch (e) {
      for (i = 0; i < n; i++) outArr[i] = 0;
    }
    return outArr;
  }

  function suspend() { if (ctx && ctx.suspend) { try { ctx.suspend(); } catch (e) {} } }
  function resume() { if (ctx && ctx.resume) { try { ctx.resume(); } catch (e) {} } }

  function noiseBuffer(kind) { return noiseBuf[kind] || null; }
  function pluckBuffer(lane) {
    if (lane === 'open') return pluckOpen;
    return pluckBuf[clamp(lane | 0, 0, 4)] || null;
  }

  /* --------------------------------------------------------------------------
   * Objeto exportado
   * ------------------------------------------------------------------------ */
  var sfxApi = {
    hit: function (lane, quality, midi) { try { sfxHit(lane, quality, midi); } catch (e) {} },
    miss: function () { try { sfxMiss(); } catch (e) {} },
    openHit: function (midi) { try { sfxOpenHit(midi); } catch (e) {} },
    judge: function (kind, midi) { try { sfxJudge(kind, midi); } catch (e) {} },
    starPowerOn: function () { try { sfxStarPowerOn(); } catch (e) {} },
    starPowerOff: function () { try { sfxStarPowerOff(); } catch (e) {} },
    streakUp: function (n) { try { sfxStreakUp(n); } catch (e) {} },
    fail: function () { try { sfxFail(); } catch (e) {} },
    uiMove: function () { try { sfxUiMove(); } catch (e) {} },
    uiSelect: function () { try { sfxUiSelect(); } catch (e) {} },
    uiBack: function () { try { sfxUiBack(); } catch (e) {} },
    crowdCheer: function (intensity) { try { sfxCrowdCheer(intensity); } catch (e) {} }
  };

  GH.Audio = {
    init: function () { try { return init(); } catch (e) { muted = true; ctx = null; return GH.Audio; } },
    unlock: function () { try { return unlock(); } catch (e) { return false; } },
    setVolume: function (bus, v) { try { setVolume(bus, v); } catch (e) {} },
    getVolume: getVolume,
    setSend: function (bus, which, amount) { try { setSend(bus, which, amount); } catch (e) {} },
    setReverbIR: function (n) { try { setReverbIR(n); } catch (e) {} },
    setReverbMix: function (v) { try { setReverbMix(v); } catch (e) {} },
    setDelayMix: function (v) { try { setDelayMix(v); } catch (e) {} },
    setDelayTime: function (v) { try { setDelayTime(v); } catch (e) {} },
    setDelayFeedback: function (v) { try { setDelayFeedback(v); } catch (e) {} },
    syncDelayToTempo: function (bpm, div) { try { syncDelayToTempo(bpm, div); } catch (e) {} },
    duck: function (bus, amount, sec) { try { duck(bus, amount, sec); } catch (e) {} },
    ambience: function (on, level) { try { setAmbience(on, level); } catch (e) {} },
    suspend: suspend,
    resume: resume,
    getLevel: function () { try { return getLevel(); } catch (e) { return 0; } },
    getSpectrum: function (a) { try { return getSpectrum(a); } catch (e) { return a; } },

    // Ferramentas para o agente de musica (GH.Synth)
    now: now,
    send: function (node, target, amount, bus) { try { return sendFrom(node, target, amount, bus); } catch (e) { return null; } },
    noiseBuffer: noiseBuffer,
    pluckBuffer: pluckBuffer,
    makePanner: function (pan) { try { return ctx ? makePanner(pan) : null; } catch (e) { return null; } },
    shaperCurve: function (amount) { try { return ctx ? shaperCurve(amount) : null; } catch (e) { return null; } },
    impulseResponse: function (name) { return irs[name] || null; },

    buses: buses,
    fx: fx,

    /* DIAGNOSTICO DO CAMINHO DO CLIQUE — mede, NA MAQUINA DO JOGADOR, o que
     * as bancadas so conseguem medir no headless: quantas vozes e quantos nos
     * de SFX estao vivos agora, o pico ja visto na partida e quantas vozes
     * foram recusadas por cada um dos dois tetos. Se `dropVoices` ou
     * `dropNodes` sairem de zero em jogo normal, o orcamento e que esta
     * errado — nao o som. Espelha GH.Synth.diag()/GH.Conductor.schedDiag(). */
    sfxDiag: function () {
      return {
        voices: voices, maxVoices: MAX_VOICES, peakVoices: peakVoices,
        nodes: liveNodes, maxNodes: MAX_SFX_NODES, peakNodes: peakNodes,
        dropVoices: droppedVoices, dropNodes: droppedNodes
      };
    },
    sfxDiagReset: function () {
      peakVoices = voices; peakNodes = liveNodes;
      droppedVoices = 0; droppedNodes = 0;
    },

    /* ---- ESTABILIDADE DE AUDIO (ver o bloco no topo do arquivo) --------
     * 'interactive' menor latencia, MENOS folga contra underrun
     * 'balanced'    no Chromium/Windows da o mesmo buffer do 'interactive'
     * 'playback'    o padrao: o dobro da folga (20 ms medidos no Edge)
     *
     * O `latencyHint` so pode ser escolhido na CRIACAO do AudioContext, e
     * derrubar o contexto no meio da musica cortaria o som e desancoraria o
     * relogio mestre (GH.Conductor). Entao a troca vale a partir do proximo
     * boot — e devolvemos `false` justamente para o menu poder avisar isso
     * em vez de fingir que ja mudou. Na volta, `recalibrateOffset()` corrige
     * `GH.Settings.audioOffsetMs` pela diferenca medida de `baseLatency`,
     * sozinho: o jogador nao refaz a calibracao por ter mudado de opcao. */
    setStability: function (name) {
      try {
        if (!VALID_STAB[name] || name === stability) return false;
        stability = name;
        stabChosen = true;
        stabSave();
        return !ctx;   // true = ja vale agora (contexto ainda nao existe)
      } catch (e) { return false; }
    },
    stabilityOptions: function () { return ['interactive', 'balanced', 'playback']; },

    /* SONDA DE CAPACIDADE DE DSP — mede, NA MAQUINA DO JOGADOR, quanto
     * custa processar o audio deste jogo. Renderiza um grafo-modelo com a
     * mesma forma de uma voz de guitarra (oscilador + saturador com
     * sobreamostragem + filtro ressonante + linha de atraso realimentada) e
     * devolve a RAZAO DE TEMPO REAL: tempo de parede / segundos de audio.
     *
     * Existe porque o headless nao e a maquina do jogador — e a unica fonte
     * de verdade sobre underrun e o hardware onde o jogo roda. O resultado
     * alimenta GH.Synth.dspDiag() e o overlay de diagnostico.
     *
     * `voices` diz quantas copias do modelo renderizar; o custo cresce junto
     * e e assim que se descobre quantas vozes a maquina aguenta. Assincrono
     * (startRendering devolve promessa) e sem efeito nenhum no audio que
     * esta tocando: o OfflineAudioContext e um mundo a parte. */
    probeDsp: function (voices, cb) {
      var done = typeof cb === 'function' ? cb : function () {};
      try {
        var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!OAC) { done(null); return; }
        var n = voices > 0 ? (voices | 0) : 24;
        var sr = ctx ? (ctx.sampleRate || 48000) : 48000;
        var secs = 0.5;
        var oc = new OAC(2, Math.round(sr * secs), sr);
        var out = oc.createGain(); out.gain.value = 0.02; out.connect(oc.destination);
        for (var i = 0; i < n; i++) {
          var f = 110 * Math.pow(2, (i % 24) / 12);
          var o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
          var g = oc.createGain(); g.gain.value = 0.3;
          var ws = oc.createWaveShaper();
          ws.curve = shaperCurve ? shaperCurve(2) : null;
          ws.oversample = '2x';
          var bq = oc.createBiquadFilter();
          bq.type = 'lowpass'; bq.frequency.value = f * 4; bq.Q.value = 6;
          // Linha de atraso realimentada: e o que o Karplus-Strong faz por voz.
          var dl = oc.createDelay(0.05); dl.delayTime.value = 1 / f * 4;
          var fb = oc.createGain(); fb.gain.value = 0.7;
          var dp = oc.createBiquadFilter();
          dp.type = 'lowpass'; dp.frequency.value = 3000; dp.Q.value = -6;
          o.connect(g); g.connect(ws); ws.connect(bq); bq.connect(out);
          bq.connect(dl); dl.connect(dp); dp.connect(fb); fb.connect(dl);
          dl.connect(out);
          o.start(0); o.stop(secs);
        }
        var w0 = (window.performance && performance.now) ? performance.now() : 0;
        oc.startRendering().then(function () {
          var wall = ((window.performance && performance.now) ? performance.now() : 0) - w0;
          var ratio = wall / 1000 / secs;
          done({
            voices: n, seconds: secs, wallMs: Math.round(wall * 100) / 100,
            ratio: Math.round(ratio * 10000) / 10000,
            perVoice: Math.round(ratio / n * 1000000) / 1000000,
            sampleRate: sr,
            verdict: ratio < 0.10 ? 'folgado'
                   : (ratio < 0.30 ? 'aceitavel'
                   : (ratio < 0.60 ? 'arriscado' : 'RISCO DE UNDERRUN'))
          });
        }, function () { done(null); });
      } catch (e) { done(null); }
    }
  };

  Object.defineProperty(GH.Audio, 'stability', { get: function () { return stability; } });
  Object.defineProperty(GH.Audio, 'stabilityActive', { get: function () { return stabActive; } });
  // Folga da thread de audio, em blocos de 128 amostras. E ISTO que decide se
  // um soluco vira estalo: 2 blocos de folga furam com 5 ms de atraso; 16 nao.
  Object.defineProperty(GH.Audio, 'slackBlocks', {
    get: function () {
      if (!ctx || typeof ctx.baseLatency !== 'number' || !isFinite(ctx.baseLatency)) return -1;
      return Math.round(ctx.baseLatency * (ctx.sampleRate || 48000) / 128 * 10) / 10;
    }
  });
  Object.defineProperty(GH.Audio, 'baseLatency', {
    get: function () {
      if (!ctx || typeof ctx.baseLatency !== 'number' || !isFinite(ctx.baseLatency)) return -1;
      return ctx.baseLatency;
    }
  });

  Object.defineProperty(GH.Audio, 'ctx', { get: function () { return ctx; } });
  Object.defineProperty(GH.Audio, 'master', { get: function () { return masterGain; } });
  Object.defineProperty(GH.Audio, 'analyser', { get: function () { return analyser; } });
  Object.defineProperty(GH.Audio, 'sampleRate', { get: function () { return ctx ? ctx.sampleRate : 0; } });
  Object.defineProperty(GH.Audio, 'suspended', { get: function () { return !!(ctx && ctx.state === 'suspended'); } });
  Object.defineProperty(GH.Audio, 'muted', { get: function () { return muted || !ctx; } });
  Object.defineProperty(GH.Audio, 'ready', { get: function () { return !!(ctx && graphOk); } });
  Object.defineProperty(GH.Audio, 'reverbIR', { get: function () { return currentIR; } });
  // Latencia de saida real (quando o navegador informa) — o menu de calibracao
  // usa isto como palpite inicial pro audioOffsetMs.
  Object.defineProperty(GH.Audio, 'outputLatency', {
    get: function () {
      if (!ctx) return 0;
      var l = 0;
      if (typeof ctx.outputLatency === 'number' && isFinite(ctx.outputLatency)) l = ctx.outputLatency;
      if (typeof ctx.baseLatency === 'number' && isFinite(ctx.baseLatency)) l += ctx.baseLatency;
      return l;
    }
  });

  GH.Audio.sfx = sfxApi;

})(window.GH = window.GH || {});

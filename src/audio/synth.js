/* ==========================================================================
 * GUITARRADA HERO  —  src/audio/synth.js
 * Dono: agente AUDIO-MUSICA.   Contrato: ARCHITECTURE.md, secao 6.
 *
 * Nao existe um unico arquivo de audio neste projeto. TUDO que se ouve de
 * musica nasce aqui, em WebAudio, em tempo real, com precisao de amostra.
 *
 * A referencia sonora e a GUITARRADA PARAENSE — Mestre Vieira, Ximbinha,
 * Aldo Sena, Beto Metralha: guitarra limpa e brilhante, muito ataque de
 * palheta, frases melodicas rapidas, bend/slide/vibrato largo, delay
 * slapback curto, reverb de mola e um filtro que abre e fecha feito wah.
 * Embaixo disso, a cozinha brasileira: curimbo, ganza, agogo, triangulo,
 * pandeiro, reco-reco — o que faz a musica soar do Para e nao de lugar
 * nenhum.
 *
 * Organizacao do arquivo:
 *   0. Utilitarios de matematica, RNG deterministico e normalizacao
 *   1. GH.Synth.theory  — motor de escalas, acordes e progressoes
 *   2. Fabricas de curvas de saturacao, buffers de ruido e IRs de reverb
 *   3. Grafo de audio: buses, cadeia da guitarra, efeitos
 *   4. Vozes melodicas: guitarra, baixo, orgao, metais, cavaquinho
 *   5. Bateria e percussao brasileira
 *   6. Arranjador: mapa harmonico, grooves por genero, geracao de partes
 *   7. Agendador com precisao de amostra (idempotente na janela)
 *   8. API publica GH.Synth
 *
 * Regras do ambiente respeitadas: IIFE classico (sem import/export), zero
 * fetch, zero CDN, zero asset externo, tudo procedural.
 * ========================================================================== */
(function (GH) {
  'use strict';

  /* ======================================================================
   * 0. UTILITARIOS
   * ==================================================================== */

  var TAU = Math.PI * 2;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dbToGain(db) { return Math.pow(10, db / 20); }

  /* Conversoes de altura. Tudo internamente e MIDI (60 = C4, 69 = A4). */
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function freqToMidi(f) { return 69 + 12 * Math.log(Math.max(1e-6, f) / 440) / Math.LN2; }

  /* Gerador pseudoaleatorio deterministico proprio (mulberry32).
     Serve de rede de seguranca: o modo captura exige render identico a cada
     execucao, entao NUNCA se usa Math.random neste arquivo. */
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Adaptador para GH.Util.RNG: o contrato diz que ele existe e e
     deterministico, mas nao fixa se e funcao, construtor ou objeto com
     .next(). Aceitamos as tres formas e caimos no mulberry32 se nada servir. */
  function makeRNG(seed) {
    var f = null;
    try {
      if (GH.Util && GH.Util.RNG) {
        var r = null;
        try { r = GH.Util.RNG(seed); } catch (e1) { r = null; }
        if (!r) { try { r = new GH.Util.RNG(seed); } catch (e2) { r = null; } }
        if (typeof r === 'function') { f = r; }
        else if (r && typeof r.next === 'function') { f = function () { return r.next(); }; }
        else if (r && typeof r.random === 'function') { f = function () { return r.random(); }; }
        else if (r && typeof r.nextFloat === 'function') { f = function () { return r.nextFloat(); }; }
        if (f) {
          var v = f();
          if (!(typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1)) { f = null; }
        }
      }
    } catch (e) { f = null; }
    return f || mulberry32(seed);
  }

  /* Hash de string -> inteiro. Usado para semear o RNG a partir do id da
     musica, para que o mesmo song sempre gere o mesmo arranjo. */
  function hashStr(s) {
    s = String(s == null ? '' : s);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* Tira acento e normaliza para comparar genero/secao sem depender de
     como o agente de conteudo escreveu ("Forro", "Forró", "FORRO"). */
  function slug(s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), ''); }
    catch (e) { /* engine sem normalize: segue com a string crua */ }
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  /* Distribuicao levemente centrada, deterministica: media de dois sorteios.
     Usada em humanizacao para que o desvio tipico seja pequeno e o extremo
     seja raro — soa como musico, nao como ruido branco. */
  function bell(rng) { return (rng() + rng()) * 0.5; }
  function around(rng, amount) { return (bell(rng) * 2 - 1) * amount; }

  /* ======================================================================
   * 1. MOTOR DE HARMONIA  (GH.Synth.theory)
   *
   * Existe para que baixo, teclado, metais e guitarra caiam TODOS na mesma
   * harmonia. Sem isto a trilha soa aleatoria; com isto, soa composta.
   * ==================================================================== */

  var PC_BY_LETTER = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  var SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /* Escalas em semitons a partir da tonica. A guitarrada vive em menor
     natural, dorio e mixolidio; o V7 puxa o frigio dominante (aquele
     "espanhol" que o Mestre Vieira usava a rodo). */
  var SCALES = {
    major:            [0, 2, 4, 5, 7, 9, 11],
    ionian:           [0, 2, 4, 5, 7, 9, 11],
    minor:            [0, 2, 3, 5, 7, 8, 10],
    naturalMinor:     [0, 2, 3, 5, 7, 8, 10],
    aeolian:          [0, 2, 3, 5, 7, 8, 10],
    dorian:           [0, 2, 3, 5, 7, 9, 10],
    mixolydian:       [0, 2, 4, 5, 7, 9, 10],
    lydian:           [0, 2, 4, 6, 7, 9, 11],
    phrygian:         [0, 1, 3, 5, 7, 8, 10],
    locrian:          [0, 1, 3, 5, 6, 8, 10],
    harmonicMinor:    [0, 2, 3, 5, 7, 8, 11],
    melodicMinor:     [0, 2, 3, 5, 7, 9, 11],
    phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
    pentatonicMajor:  [0, 2, 4, 7, 9],
    pentatonicMinor:  [0, 3, 5, 7, 10],
    blues:            [0, 3, 5, 6, 7, 10],
    wholeTone:        [0, 2, 4, 6, 8, 10]
  };

  /* Acordes em intervalos a partir da fundamental. */
  var CHORDS = {
    'M':      [0, 4, 7],
    'm':      [0, 3, 7],
    '5':      [0, 7],
    '7':      [0, 4, 7, 10],
    'maj7':   [0, 4, 7, 11],
    'm7':     [0, 3, 7, 10],
    'm7b5':   [0, 3, 6, 10],
    'dim':    [0, 3, 6],
    'dim7':   [0, 3, 6, 9],
    'aug':    [0, 4, 8],
    'sus4':   [0, 5, 7],
    'sus2':   [0, 2, 7],
    '7sus4':  [0, 5, 7, 10],
    '6':      [0, 4, 7, 9],
    'm6':     [0, 3, 7, 9],
    '9':      [0, 4, 7, 10, 14],
    'm9':     [0, 3, 7, 10, 14],
    'maj9':   [0, 4, 7, 11, 14],
    'add9':   [0, 4, 7, 14],
    '11':     [0, 4, 7, 10, 14, 17],
    '13':     [0, 4, 7, 10, 14, 21],
    'm11':    [0, 3, 7, 10, 14, 17],
    '7b9':    [0, 4, 7, 10, 13],
    '7s9':    [0, 4, 7, 10, 15]
  };

  /* Apelidos que o agente de conteudo pode escrever ("Am", "A-", "Amin"...). */
  var Q_ALIAS = {
    '': 'M', 'M': 'M', 'maj': 'M', 'major': 'M', 'Maj': 'M',
    'm': 'm', 'min': 'm', 'mi': 'm', '-': 'm', 'minor': 'm',
    '5': '5', 'no3': '5', 'power': '5',
    '7': '7', 'dom': '7', 'dom7': '7',
    'maj7': 'maj7', 'M7': 'maj7', 'ma7': 'maj7', 'j7': 'maj7', 'Maj7': 'maj7',
    'm7': 'm7', 'min7': 'm7', 'mi7': 'm7', '-7': 'm7',
    'm7b5': 'm7b5', 'min7b5': 'm7b5', 'hdim': 'm7b5', 'halfdim': 'm7b5',
    'dim': 'dim', 'o': 'dim', '0': 'dim',
    'dim7': 'dim7', 'o7': 'dim7',
    'aug': 'aug', '+': 'aug', 'aug5': 'aug',
    'sus': 'sus4', 'sus4': 'sus4', 'sus2': 'sus2',
    '7sus4': '7sus4', '7sus': '7sus4',
    '6': '6', 'maj6': '6', 'M6': '6',
    'm6': 'm6', 'min6': 'm6', '-6': 'm6',
    '9': '9', 'dom9': '9',
    'm9': 'm9', 'min9': 'm9', '-9': 'm9',
    'maj9': 'maj9', 'M9': 'maj9',
    'add9': 'add9', '2': 'add9',
    '11': '11', 'm11': 'm11', '13': '13',
    '7b9': '7b9', '7s9': '7s9', '7#9': '7s9'
  };

  /* Grau romano -> semitons acima da tonica (referencia: escala maior).
     Assim "bVII" em La menor devolve Sol, e "V7" devolve Mi7, sem depender
     de qual escala esta em uso. */
  var ROMAN_SEMI = { i: 0, ii: 2, iii: 4, iv: 5, v: 7, vi: 9, vii: 11 };

  var theory = {
    SCALES: SCALES,
    CHORDS: CHORDS,
    NAMES: SHARP_NAMES,
    midiToFreq: midiToFreq,
    freqToMidi: freqToMidi,

    /* "A#3" / "Bb2" / "C" -> MIDI. Sem oitava assume a 4a. */
    parseNote: function (s) {
      if (typeof s === 'number') { return s; }
      var m = /^\s*([A-Ga-g])([#b]*)(-?\d+)?\s*$/.exec(String(s || ''));
      if (!m) { return 69; }
      var pc = PC_BY_LETTER[m[1].toLowerCase()];
      var acc = m[2] || '';
      for (var i = 0; i < acc.length; i++) { pc += (acc.charAt(i) === '#') ? 1 : -1; }
      var oct = (m[3] == null) ? 4 : parseInt(m[3], 10);
      return (oct + 1) * 12 + pc;
    },

    /* Somente a classe de altura (0..11) de "F#", "Bb", "a". */
    parsePc: function (s) {
      if (typeof s === 'number') { return ((s % 12) + 12) % 12; }
      var m = /^\s*([A-Ga-g])([#b]*)/.exec(String(s || ''));
      if (!m) { return 9; }
      var pc = PC_BY_LETTER[m[1].toLowerCase()];
      var acc = m[2] || '';
      for (var i = 0; i < acc.length; i++) { pc += (acc.charAt(i) === '#') ? 1 : -1; }
      return ((pc % 12) + 12) % 12;
    },

    /* "F#m7b5", "C/E", "G7" -> { rootPc, quality, intervals, bassPc }. */
    parseChord: function (name) {
      var s = String(name == null ? '' : name).trim();
      var bassPc = null;
      var slash = s.indexOf('/');
      if (slash > 0) {
        bassPc = theory.parsePc(s.slice(slash + 1));
        s = s.slice(0, slash);
      }
      var m = /^([A-Ga-g])([#b]*)(.*)$/.exec(s);
      if (!m) {
        return { rootPc: 9, quality: 'm', intervals: CHORDS.m.slice(), bassPc: null };
      }
      var pc = PC_BY_LETTER[m[1].toLowerCase()];
      var acc = m[2] || '';
      for (var i = 0; i < acc.length; i++) { pc += (acc.charAt(i) === '#') ? 1 : -1; }
      pc = ((pc % 12) + 12) % 12;
      var rest = (m[3] || '').replace(/\s+/g, '');
      var q = Q_ALIAS[rest];
      if (q == null) { q = Q_ALIAS[rest.toLowerCase()]; }
      if (q == null) {
        /* Sufixo desconhecido: deduz o basico pelo comeco da string. */
        if (/^mi?n?7b5/.test(rest)) { q = 'm7b5'; }
        else if (/^dim7/.test(rest)) { q = 'dim7'; }
        else if (/^dim/.test(rest)) { q = 'dim'; }
        else if (/^(maj|M)7/.test(rest)) { q = 'maj7'; }
        else if (/^(m|min|-)7/.test(rest)) { q = 'm7'; }
        else if (/^(m|min|-)/.test(rest)) { q = 'm'; }
        else if (/^7/.test(rest)) { q = '7'; }
        else { q = 'M'; }
      }
      return {
        rootPc: pc,
        quality: q,
        intervals: (CHORDS[q] || CHORDS.M).slice(),
        bassPc: bassPc
      };
    },

    /* "bVII7", "iv", "V7", "IIm7" -> acorde absoluto na tonalidade dada. */
    parseRoman: function (roman, keyPc) {
      var s = String(roman == null ? '' : roman).trim();
      var alter = 0;
      while (s.length && (s.charAt(0) === 'b' || s.charAt(0) === '#')) {
        alter += (s.charAt(0) === '#') ? 1 : -1;
        s = s.slice(1);
      }
      var m = /^([ivIV]+)(.*)$/.exec(s);
      if (!m) { return theory.parseChord(s); }
      var num = m[1];
      var rest = (m[2] || '').replace(/\s+/g, '');
      var isMinorNumeral = (num === num.toLowerCase());
      var semi = ROMAN_SEMI[num.toLowerCase()];
      if (semi == null) { semi = 0; }
      var pc = (((keyPc + semi + alter) % 12) + 12) % 12;

      /* Sufixo manda; se nao houver, minuscula = menor, maiuscula = maior. */
      var q = Q_ALIAS[rest];
      if (q == null) { q = Q_ALIAS[rest.toLowerCase()]; }
      if (q == null) {
        if (/^dim7/.test(rest)) { q = 'dim7'; }
        else if (/^(dim|o)/.test(rest)) { q = 'dim'; }
        else if (/^(m7b5|hdim)/.test(rest)) { q = 'm7b5'; }
        else if (/^maj7/.test(rest)) { q = 'maj7'; }
        else if (/^7/.test(rest)) { q = isMinorNumeral ? 'm7' : '7'; }
        else if (/^6/.test(rest)) { q = isMinorNumeral ? 'm6' : '6'; }
        else if (/^9/.test(rest)) { q = isMinorNumeral ? 'm9' : '9'; }
        else if (/^sus4/.test(rest)) { q = 'sus4'; }
        else if (/^sus2/.test(rest)) { q = 'sus2'; }
        else { q = isMinorNumeral ? 'm' : 'M'; }
      } else if (isMinorNumeral && (q === 'M')) {
        q = 'm';
      } else if (isMinorNumeral && q === '7') {
        q = 'm7';
      }
      return { rootPc: pc, quality: q, intervals: (CHORDS[q] || CHORDS.M).slice(), bassPc: null };
    },

    /* Classes de altura do acorde, sem oitava. */
    chordPcs: function (ch) {
      var out = [];
      for (var i = 0; i < ch.intervals.length; i++) {
        out.push((((ch.rootPc + ch.intervals[i]) % 12) + 12) % 12);
      }
      return out;
    },

    /* Escada ascendente de MIDIs de uma escala dentro de uma tessitura.
       E a "regua" sobre a qual a melodia da guitarra anda. */
    scaleLadder: function (rootPc, scaleName, lo, hi) {
      var sc = SCALES[scaleName] || SCALES.minor;
      var out = [];
      var startOct = Math.floor(lo / 12) - 1;
      for (var o = startOct; o <= Math.floor(hi / 12) + 1; o++) {
        for (var i = 0; i < sc.length; i++) {
          var m = o * 12 + (((rootPc + sc[i]) % 12) + 12) % 12;
          if (m >= lo && m <= hi) { out.push(m); }
        }
      }
      out.sort(function (a, b) { return a - b; });
      /* remove duplicatas geradas pela varredura de oitavas */
      var clean = [];
      for (var k = 0; k < out.length; k++) {
        if (k === 0 || out[k] !== out[k - 1]) { clean.push(out[k]); }
      }
      return clean;
    },

    /* MIDI mais proximo de um alvo com a classe de altura pedida. */
    nearestPcMidi: function (pc, target, lo, hi) {
      pc = ((pc % 12) + 12) % 12;
      var best = null, bd = 1e9;
      for (var m = lo; m <= hi; m++) {
        if ((((m % 12) + 12) % 12) !== pc) { continue; }
        var d = Math.abs(m - target);
        if (d < bd) { bd = d; best = m; }
      }
      return (best == null) ? clamp(Math.round(target), lo, hi) : best;
    },

    /* Indice na escada cuja nota esta mais perto do alvo. */
    nearestIndex: function (ladder, midi) {
      var bi = 0, bd = 1e9;
      for (var i = 0; i < ladder.length; i++) {
        var d = Math.abs(ladder[i] - midi);
        if (d < bd) { bd = d; bi = i; }
      }
      return bi;
    },

    /* Conducao de vozes: aproveita o acorde anterior para mover pouco.
       E o que evita aquele salto feio de teclado quando o acorde muda. */
    voiceChord: function (pcs, prev, lo, hi) {
      var out = [];
      var i;
      for (i = 0; i < pcs.length; i++) {
        var anchor = (prev && prev.length) ? prev[Math.min(i, prev.length - 1)] : (lo + hi) * 0.5;
        out.push(theory.nearestPcMidi(pcs[i], anchor, lo, hi));
      }
      out.sort(function (a, b) { return a - b; });
      var clean = [];
      for (i = 0; i < out.length; i++) {
        if (i === 0 || out[i] !== out[i - 1]) { clean.push(out[i]); }
      }
      return clean;
    },

    /* Escala que combina com o acorde dentro da tonalidade. Um V7 dentro de
       um tom menor puxa o frigio dominante — assinatura da guitarrada. */
    scaleForChord: function (keyPc, keyScale, ch) {
      var rel = (((ch.rootPc - keyPc) % 12) + 12) % 12;
      var minorKey = (keyScale === 'minor' || keyScale === 'naturalMinor' ||
                      keyScale === 'aeolian' || keyScale === 'dorian' ||
                      keyScale === 'harmonicMinor' || keyScale === 'phrygian');
      var q = ch.quality;
      var dominant = (q === '7' || q === '9' || q === '13' || q === '7sus4' ||
                      q === '7b9' || q === '7s9' || q === '11');
      if (minorKey && dominant && rel === 7) { return 'phrygianDominant'; }
      if (minorKey && dominant && rel === 4) { return 'phrygianDominant'; }
      if (dominant && rel === 0) { return 'mixolydian'; }
      if (q === 'dim' || q === 'dim7') { return 'harmonicMinor'; }
      if (q === 'aug') { return 'wholeTone'; }
      return keyScale;
    }
  };

  /* ======================================================================
   * 2. FABRICAS DE CURVAS, RUIDO E IMPULSE RESPONSES
   * ==================================================================== */

  /* Curva de valvula escrita a mao: tanh assimetrico.
     A assimetria (termo quadratico antes do tanh) e o que gera harmonicos
     PARES — o calor de valvula. Simetria pura so gera impares e soa a
     fuzz/transistor. O segundo tanh, mais suave, arredonda o joelho para
     que a saturacao entre gradualmente conforme a palhetada ataca.
     No fim removemos o offset DC introduzido pela assimetria. */
  function makeTubeCurve(drive, asym, n) {
    n = n || 2048;
    var curve = new Float32Array(n);
    var norm = Math.tanh(drive);
    var i, x, b, y;
    for (i = 0; i < n; i++) {
      x = (i / (n - 1)) * 2 - 1;
      b = x + asym * x * x * 0.42;                       /* pre-distorcao par */
      y = Math.tanh(b * drive) / norm;                   /* joelho principal */
      y = y * 0.82 + 0.18 * Math.tanh(b * drive * 0.32); /* joelho macio */
      curve[i] = y;
    }
    /* Centraliza: tira o DC medio para nao empurrar o cone do alto-falante. */
    var dc = 0;
    for (i = 0; i < n; i++) { dc += curve[i]; }
    dc /= n;
    for (i = 0; i < n; i++) { curve[i] = clamp(curve[i] - dc, -1, 1); }
    return curve;
  }

  /* Saturacao suave de bus (cola de mixagem): quase linear no centro,
     comprime so os picos. Usada em bateria e baixo. */
  function makeGlueCurve(amount, n) {
    n = n || 1024;
    var curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = clamp(Math.tanh(x * amount) / Math.tanh(amount) * 0.92 + x * 0.08, -1, 1);
    }
    return curve;
  }

  /* Curva de "fold" leve, usada no orgao para dar aquele corpo sujo de
     valvula do Leslie sem virar distorcao de rock. */
  function makeOrganCurve(n) {
    n = n || 1024;
    var curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      var y = Math.sin(x * 1.35) / Math.sin(1.35);
      curve[i] = clamp(y * 0.9 + x * 0.1, -1, 1);
    }
    return curve;
  }

  /* ======================================================================
   * 3. ESTADO GLOBAL DO MODULO
   * ==================================================================== */

  var ctx = null;              /* AudioContext (nulo no modo captura) */
  var _audio = null;           /* referencia a GH.Audio */
  var _ready = false;          /* grafo montado? */
  var _sr = 48000;             /* taxa de amostragem */
  var MIN_DELAY = 130 / 48000; /* piso do DelayNode dentro de ciclo (1 quantum) */

  var nodes = {};              /* todos os nos fixos do grafo */
  var noiseBuf = null;         /* ruido branco compartilhado */
  var pinkBuf = null;          /* ruido rosa (peles de tambor, chocalho) */
  var metalBuf = null;         /* ruido metalico filtrado (pratos) */
  var curves = {};             /* curvas de waveshaper compartilhadas */

  var _muted = false;          /* guitarra mutada (erro do jogador) */
  var _sp = false;             /* star power ativo */
  var _bpm = 120;              /* bpm corrente, usado nos tempos de efeito */
  var _live = [];              /* vozes vivas para coleta */
  var _sweepTimer = 0;
  var _voiceCount = 0;         /* limitador de polifonia */
  var MAX_VOICES = 72;
  var _pendingTempo = null;    /* andamento pedido antes do grafo existir */

  /* Trim geral da trilha, calibrado por medicao offline (render de 10 s de
     cada genero num OfflineAudioContext). Sem ele a soma das familias
     chegava a +2 dBFS no barramento e obrigava o limitador do master de
     GH.Audio a trabalhar o tempo todo, achatando a dinamica. Com 0.55 a
     musica entrega pico proximo de -4 dBFS e RMS perto de -16 dBFS, que e
     onde sobra espaco para os SFX de acerto e a torcida. */
  var MIX = 0.55;

  /* ---------------------------------------------------------------------
   * Coleta de lixo de nos. Cada voz registra seus nos e o instante em que
   * termina; um varredor leve (nao musical — pode ser setInterval) faz o
   * disconnect. Sem isto o grafo cresce e o audio comeca a estalar.
   * ------------------------------------------------------------------- */
  function retire(list, endTime) {
    _live.push({ e: endTime, n: list });
    _voiceCount++;
    if (!_sweepTimer && typeof setInterval === 'function') {
      _sweepTimer = setInterval(sweep, 220);
    }
  }

  function sweep() {
    if (!ctx) { return; }
    var now = ctx.currentTime;
    for (var i = _live.length - 1; i >= 0; i--) {
      if (_live[i].e <= now) {
        var arr = _live[i].n;
        for (var j = 0; j < arr.length; j++) {
          try { arr[j].disconnect(); } catch (e) { /* ja desconectado */ }
        }
        _live.splice(i, 1);
        _voiceCount = Math.max(0, _voiceCount - 1);
      }
    }
    if (!_live.length && _sweepTimer) {
      clearInterval(_sweepTimer);
      _sweepTimer = 0;
    }
  }

  /* ---------------------------------------------------------------------
   * Envelopes. Sempre terminam em zero absoluto (rampa linear final),
   * porque exponentialRamp nunca chega a 0 e deixaria uma cauda de DC.
   * ------------------------------------------------------------------- */

  /* ADSR completo. Devolve o instante em que a voz morre. */
  function adsr(param, t0, peak, a, d, s, holdUntil, r) {
    var floor = 1e-4;
    var pk = Math.max(floor, peak);
    var sus = Math.max(floor, peak * s);
    var tA = t0 + a;
    var tD = tA + d;
    var tS = Math.max(tD, holdUntil);
    var tR = tS + r;
    param.setValueAtTime(floor, t0);
    param.linearRampToValueAtTime(pk, tA);
    param.exponentialRampToValueAtTime(sus, tD);
    if (tS > tD + 1e-4) { param.setValueAtTime(sus, tS); }
    param.exponentialRampToValueAtTime(floor, tR);
    param.linearRampToValueAtTime(0, tR + 0.006);
    return tR + 0.02;
  }

  /* Envelope percussivo: ataque quase instantaneo + decaimento exponencial. */
  function perc(param, t0, peak, a, d) {
    var floor = 1e-4;
    param.setValueAtTime(floor, t0);
    param.linearRampToValueAtTime(Math.max(floor, peak), t0 + a);
    param.exponentialRampToValueAtTime(floor, t0 + a + d);
    param.linearRampToValueAtTime(0, t0 + a + d + 0.008);
    return t0 + a + d + 0.03;
  }

  /* Rampa exponencial segura (evita valor 0 que a API rejeita). */
  function expTo(param, value, when) {
    param.exponentialRampToValueAtTime(Math.max(1e-4, value), when);
  }

  /* ---------------------------------------------------------------------
   * Buffers de ruido. Gerados uma vez, reaproveitados por todas as vozes
   * com deslocamento de leitura deterministico.
   * ------------------------------------------------------------------- */
  function buildNoiseBuffers() {
    var len = Math.floor(_sr * 3.0);
    var rng = mulberry32(0x9E3779B9);
    var i, ch, data;

    /* Ruido branco puro: chimbal, snap de caixa, ar. */
    noiseBuf = ctx.createBuffer(2, len, _sr);
    for (ch = 0; ch < 2; ch++) {
      data = noiseBuf.getChannelData(ch);
      for (i = 0; i < len; i++) { data[i] = rng() * 2 - 1; }
    }

    /* Ruido rosa (Voss-McCartney simplificado): peles de tambor e chocalho
       precisam de mais energia grave que o branco, senao soam a "chiado". */
    pinkBuf = ctx.createBuffer(2, len, _sr);
    for (ch = 0; ch < 2; ch++) {
      data = pinkBuf.getChannelData(ch);
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (i = 0; i < len; i++) {
        var w = rng() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        var p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
        data[i] = clamp(p * 0.11, -1, 1);
      }
    }

    /* Ruido "metalico": ruido branco somado a um banco de senoides
       inarmonicas. E a base dos pratos, agogo e triangulo — metal nao tem
       espectro harmonico, tem modos espalhados. */
    var mlen = Math.floor(_sr * 1.2);
    metalBuf = ctx.createBuffer(1, mlen, _sr);
    data = metalBuf.getChannelData(0);
    var ratios = [1.0, 1.4142, 1.7321, 2.0, 2.2361, 2.6458, 3.0, 3.3166, 3.873, 4.123];
    var phase = [];
    for (i = 0; i < ratios.length; i++) { phase.push(rng() * TAU); }
    var base = 260 / _sr * TAU;
    for (i = 0; i < mlen; i++) {
      var s = (rng() * 2 - 1) * 0.35;
      for (var k = 0; k < ratios.length; k++) {
        s += Math.sin(phase[k] + base * ratios[k] * i) * (0.09 / (1 + k * 0.22));
      }
      data[i] = clamp(s, -1, 1);
    }
  }

  /* Fonte de ruido com offset deterministico, para que dois chimbais
     seguidos nao sejam recortes identicos do mesmo buffer. */
  function noiseSource(buf, offset01, rate) {
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate || 1;
    src.loopStart = 0;
    src.loopEnd = buf.duration;
    return src;
  }

  /* ---------------------------------------------------------------------
   * Impulse responses procedurais.
   * ------------------------------------------------------------------- */

  /* Reverb de MOLA (spring): a assinatura do amp de guitarrada.
     Nao e um "salao": e um transdutor mecanico. Modelamos com
     (a) varios chirps dispersivos — a mola atrasa o agudo em relacao ao
     grave, dando aquele "boing", e (b) uma cauda de ruido com forte enfase
     de medios (1.2k-3k) e pouquissimo grave/agudo extremo. */
  function makeSpringIR(seconds, decay, seed) {
    var len = Math.max(1, Math.floor(_sr * seconds));
    var buf = ctx.createBuffer(2, len, _sr);
    var rng = mulberry32(seed || 4242);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var i;
      for (i = 0; i < len; i++) { d[i] = 0; }

      /* (a) Chirps dispersivos — 5 reflexoes da mola, cada uma varrendo de
         grave para agudo, com atraso e polaridade alternada. */
      var bounces = 5;
      for (var b = 0; b < bounces; b++) {
        var start = Math.floor((0.004 + b * 0.031 + rng() * 0.006 + ch * 0.0018) * _sr);
        var dur = Math.floor((0.055 + b * 0.012) * _sr);
        var amp = Math.pow(0.62, b) * (0.5 + rng() * 0.2) * (b % 2 ? -1 : 1);
        var f0 = 420 + rng() * 120;
        var f1 = 2600 + rng() * 900;
        var ph = 0;
        for (i = 0; i < dur && start + i < len; i++) {
          var u = i / dur;
          var f = f0 * Math.pow(f1 / f0, u * u);
          ph += TAU * f / _sr;
          d[start + i] += Math.sin(ph) * amp * Math.exp(-u * 4.2);
        }
      }

      /* (b) Cauda densa com enfase de medios e decaimento exponencial. */
      var lp = 0, hp = 0, prev = 0;
      for (i = 0; i < len; i++) {
        var u2 = i / len;
        var n = (rng() * 2 - 1);
        lp += (n - lp) * 0.35;            /* corta agudo extremo */
        hp = 0.985 * (hp + lp - prev);    /* corta grave */
        prev = lp;
        var envv = Math.pow(1 - u2, decay) * Math.exp(-u2 * 3.1);
        d[i] += hp * envv * 0.55;
      }

      /* Normaliza para nao estourar o convolver. */
      var pk = 0;
      for (i = 0; i < len; i++) { pk = Math.max(pk, Math.abs(d[i])); }
      if (pk > 0) { for (i = 0; i < len; i++) { d[i] = d[i] / pk * 0.86; } }
    }
    return buf;
  }

  /* Reverb de sala/palco: cauda difusa curta, para colar bateria,
     percussao e teclado sem embarrar. Reflexoes iniciais explicitas +
     cauda gaussiana com filtro passa-baixa progressivo. */
  function makeRoomIR(seconds, seed) {
    var len = Math.max(1, Math.floor(_sr * seconds));
    var buf = ctx.createBuffer(2, len, _sr);
    var rng = mulberry32(seed || 1337);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var i;
      for (i = 0; i < len; i++) { d[i] = 0; }

      /* Reflexoes iniciais: dao o tamanho do palco. */
      var er = 14;
      for (var k = 0; k < er; k++) {
        var pos = Math.floor((0.006 + rng() * 0.055) * _sr);
        if (pos < len) { d[pos] += (rng() * 2 - 1) * 0.42 * Math.pow(0.86, k); }
      }

      /* Cauda: ruido com passa-baixa que fecha com o tempo (o ar absorve
         agudo antes do grave — sem isso o reverb soa a lata). */
      var lp = 0;
      for (i = 0; i < len; i++) {
        var u = i / len;
        var coef = lerp(0.6, 0.12, u);
        lp += ((rng() * 2 - 1) - lp) * coef;
        d[i] += lp * Math.pow(1 - u, 2.4) * 0.6;
      }
      var pk = 0;
      for (i = 0; i < len; i++) { pk = Math.max(pk, Math.abs(d[i])); }
      if (pk > 0) { for (i = 0; i < len; i++) { d[i] = d[i] / pk * 0.8; } }
    }
    return buf;
  }

  /* ======================================================================
   * 3. GRAFO DE AUDIO
   *
   * Cada familia de instrumento tem seu proprio bus, por dois motivos:
   * (1) mutar a guitarra no erro do jogador nao pode calar a banda;
   * (2) cada familia precisa de compressao e EQ diferentes.
   * ==================================================================== */

  /* --- acucar sintatico para montar nos sem poluir o codigo ------------- */
  function gain(v) { var g = ctx.createGain(); g.gain.value = v; return g; }

  function filt(type, freq, q, gainDb) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q != null) { f.Q.value = q; }
    if (gainDb != null) { f.gain.value = gainDb; }
    return f;
  }

  function shaper(curve, oversample) {
    var w = ctx.createWaveShaper();
    w.curve = curve;
    w.oversample = oversample || '4x';
    return w;
  }

  /* StereoPanner com plano B: se o engine nao tiver, devolve um Gain neutro
     com um .pan falso, para o codigo chamador nao precisar saber. */
  function panner(v) {
    if (ctx.createStereoPanner) {
      var p = ctx.createStereoPanner();
      p.pan.value = clamp(v || 0, -1, 1);
      return p;
    }
    var g = ctx.createGain();
    g.pan = { value: 0, setValueAtTime: function () {}, linearRampToValueAtTime: function () {} };
    return g;
  }

  function comp(threshold, ratio, attack, release, knee) {
    var c = ctx.createDynamicsCompressor();
    c.threshold.value = threshold;
    c.ratio.value = ratio;
    c.attack.value = attack;
    c.release.value = release;
    c.knee.value = (knee == null) ? 6 : knee;
    return c;
  }

  /* Destino externo: usa o bus de GH.Audio quando existe, senao master,
     senao a saida crua. Nunca falha por o agente de audio-core nao ter
     montado ainda. */
  function busOut(name) {
    var a = _audio;
    try {
      if (a && a.buses && a.buses[name]) { return a.buses[name]; }
      if (a && a.master) { return a.master; }
    } catch (e) { /* segue para o destino */ }
    return ctx.destination;
  }

  /* GH.Audio nao expoe o AudioContext diretamente, mas TODO AudioNode
     carrega `.context` por especificacao. Entao descobrimos o contexto a
     partir dos proprios barramentos — caminho garantido e que so funciona
     depois de GH.Audio.init(), que e exatamente quando queremos montar. */
  function resolveCtx(a) {
    if (!a) { return null; }
    if (a.ctx && typeof a.ctx.createGain === 'function') { return a.ctx; }
    if (a.context && typeof a.context.createGain === 'function') { return a.context; }
    var probes = [];
    if (a.buses) {
      probes.push(a.buses.music, a.buses.guitar, a.buses.drums, a.buses.sfx, a.buses.crowd);
    }
    if (a.fx) { probes.push(a.fx.reverbIn, a.fx.delayIn, a.fx.reverbReturn); }
    probes.push(a.master, a.masterGain);
    for (var i = 0; i < probes.length; i++) {
      var n = probes[i];
      if (n && n.context && typeof n.context.createGain === 'function') { return n.context; }
    }
    return null;
  }

  /* So montamos o grafo quando existe barramento de verdade para plugar.
     Se GH.Synth.init() correr antes de GH.Audio.init(), o schedule() tenta
     de novo a cada janela e o grafo nasce sozinho no momento certo. */
  function audioReady(a) {
    return !!(a && a.buses && (a.buses.music || a.buses.guitar || a.buses.drums));
  }

  /* O barramento `guitar` de GH.Audio ja tem envios proprios de reverb
     (0,22) e delay (0,30). Como a nossa cadeia entrega a guitarra JA com
     slapback e mola — que sao parte da identidade da guitarrada e precisam
     ficar ANTES do mute, para sumirem junto no erro — baixamos os envios
     externos. Sem isso ficariam dois delays diferentes brigando. */
  function trimExternalGuitarSends() {
    var a = _audio;
    if (!a || typeof a.setSend !== 'function') { return; }
    try {
      a.setSend('guitar', 'delay', 0.05);
      a.setSend('guitar', 'reverb', 0.13);
    } catch (e) { /* versao sem setSend: nossa cadeia ja se basta */ }
  }

  /* ---------------------------------------------------------------------
   * CHORUS — dois delays curtos modulados por LFOs incomensuraveis,
   * espalhados no estereo. Na guitarra e um veu discreto que engrossa sem
   * borrar o ataque; no orgao e a metade "de baixo" do Leslie.
   * ------------------------------------------------------------------- */
  function makeChorus(depthSec, rateA, rateB, wet, spread) {
    var input = gain(1);
    var output = gain(1);
    var dry = gain(1);
    var wetG = gain(wet);

    var d1 = ctx.createDelay(0.12); d1.delayTime.value = 0.0121;
    var d2 = ctx.createDelay(0.12); d2.delayTime.value = 0.0187;

    var lfoA = ctx.createOscillator(); lfoA.type = 'sine';     lfoA.frequency.value = rateA;
    var lfoB = ctx.createOscillator(); lfoB.type = 'triangle'; lfoB.frequency.value = rateB;
    var ampA = gain(depthSec);
    var ampB = gain(depthSec * 0.78);
    lfoA.connect(ampA); ampA.connect(d1.delayTime);
    lfoB.connect(ampB); ampB.connect(d2.delayTime);

    var pL = panner(-(spread == null ? 0.6 : spread));
    var pR = panner(+(spread == null ? 0.6 : spread));

    input.connect(dry); dry.connect(output);
    input.connect(d1); d1.connect(pL); pL.connect(wetG);
    input.connect(d2); d2.connect(pR); pR.connect(wetG);
    wetG.connect(output);

    try { lfoA.start(); lfoB.start(); } catch (e) { /* ja iniciado */ }

    return {
      input: input, output: output, wet: wetG, dry: dry,
      depthA: ampA, depthB: ampB, lfoA: lfoA, lfoB: lfoB
    };
  }

  /* ---------------------------------------------------------------------
   * TREMOLO — modulacao de amplitude. Nao e ornamento na guitarrada, e
   * assinatura: quase todo disco de Mestre Vieira tem o tremolo do amp
   * ligado. A taxa e sincronizada ao BPM (colcheia) para pulsar com a
   * banda em vez de brigar com ela.
   * ------------------------------------------------------------------- */
  function makeTremolo(rate, depth) {
    var node = gain(1 - depth * 0.5);
    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rate;
    var amt = gain(depth * 0.5);
    lfo.connect(amt);
    amt.connect(node.gain);
    try { lfo.start(); } catch (e) { /* ja iniciado */ }
    return { node: node, lfo: lfo, amt: amt, depth: depth };
  }

  /* ---------------------------------------------------------------------
   * DELAY SLAPBACK — o eco curtinho, quase um duplo da nota. Realimentacao
   * baixa (2 a 3 repeticoes) e passa-baixa no loop: cada repeticao volta
   * mais escura, como fita. Passa-alta tira o grave para o eco nao brigar
   * com o baixo.
   * ------------------------------------------------------------------- */
  function makeSlapback(timeSec, feedback) {
    var input = gain(1);
    var output = gain(1);
    var d = ctx.createDelay(1.2);
    d.delayTime.value = clamp(timeSec, 0.02, 1.1);
    var fb = gain(feedback);
    /* Q em dB negativo tambem aqui: sao filtros DENTRO do laco de
       realimentacao e nao podem ter pico de ganho (ver karplusString). */
    var lp = filt('lowpass', 3100, -6);
    var hp = filt('highpass', 340, -6);
    var wob = ctx.createOscillator();   /* micro-wow de fita */
    wob.type = 'sine';
    wob.frequency.value = 0.27;
    var wobAmt = gain(0.0009);
    wob.connect(wobAmt); wobAmt.connect(d.delayTime);
    try { wob.start(); } catch (e) { /* ja iniciado */ }

    input.connect(d);
    d.connect(lp); lp.connect(hp); hp.connect(fb); fb.connect(d);
    d.connect(output);
    return { input: input, output: output, delay: d, fb: fb, lp: lp };
  }

  /* ---------------------------------------------------------------------
   * Montagem do grafo completo. Roda uma unica vez, no primeiro uso.
   * ------------------------------------------------------------------- */
  function buildGraph() {
    if (_ready || !ctx) { return _ready; }

    _sr = ctx.sampleRate || 48000;
    MIN_DELAY = 130 / _sr;

    buildNoiseBuffers();
    buildWaves();

    /* Curvas compartilhadas — imutaveis, entao um WaveShaper por bus basta. */
    curves.tubeSoft  = makeTubeCurve(1.9, 0.22, 2048);   /* palhetada limpa */
    curves.tubeAmp   = makeTubeCurve(3.1, 0.34, 4096);   /* amp da guitarra */
    curves.tubeHot   = makeTubeCurve(5.2, 0.40, 4096);   /* star power */
    curves.bassDrive = makeTubeCurve(2.3, 0.30, 2048);   /* harmonicos do baixo */
    curves.glue      = makeGlueCurve(1.6, 1024);         /* cola de bateria */
    curves.organ     = makeOrganCurve(1024);

    /* ============ REVERB DE SALA (bateria, percussao, teclas) ============ */
    var roomSend = gain(0.0);
    var roomConv = ctx.createConvolver();
    roomConv.normalize = true;
    roomConv.buffer = makeRoomIR(1.35, 20260730);
    var roomPre = filt('highpass', 200, 0.7);   /* nao joga grave no reverb */
    var roomTone = filt('lowpass', 6800, 0.6);
    var roomOut = gain(0.34 * MIX);
    roomSend.connect(roomPre); roomPre.connect(roomConv);
    roomConv.connect(roomTone); roomTone.connect(roomOut);
    roomOut.connect(busOut('music'));
    roomSend.gain.value = 1;

    /* ============ CADEIA DA GUITARRA (o coracao do jogo) ============ */
    /* Ordem de pedais/amp, exatamente como um guitarrista montaria:
       guitarra -> corte de grave -> wah -> amp valvulado -> tone stack ->
       chorus -> tremolo -> delay -> mola -> compressor -> saida. */
    var gtrIn   = gain(0.9);
    var gtrHP   = filt('highpass', 95, 0.7);           /* tira o barro do braco */
    var gtrWah  = filt('lowpass', 2100, 4.2);          /* filtro que abre/fecha */
    var gtrPre  = gain(1.1);                            /* volume de entrada do amp */
    var gtrAmp  = shaper(curves.tubeAmp, '4x');
    var gtrDC   = filt('highpass', 62, 0.5);           /* mata o DC da assimetria */
    var gtrMid  = filt('peaking', 820, 0.9, 2.6);      /* medio nasal do Para */
    var gtrScoop= filt('peaking', 380, 1.1, -3.4);     /* tira a lama */
    var gtrPres = filt('peaking', 2750, 1.4, 5.2);     /* presenca/brilho */
    var gtrAir  = filt('highshelf', 6200, 0.7, 2.0);   /* ar */
    var gtrCab  = filt('lowpass', 7400, 0.9);          /* falante 12" corta o agudo */

    /* LFO do wah: sincronizado ao compasso, varredura ampla mas lenta. Nao
       e um wah de funk, e o filtro respirando ao longo da frase. */
    var wahLFO = ctx.createOscillator();
    wahLFO.type = 'sine';
    wahLFO.frequency.value = 0.42;
    var wahAmt = gain(620);                             /* profundidade em Hz */
    wahLFO.connect(wahAmt); wahAmt.connect(gtrWah.frequency);
    try { wahLFO.start(); } catch (e) { /* ja iniciado */ }

    var gtrChorus = makeChorus(0.0022, 0.31, 0.47, 0.34, 0.62);
    var gtrTrem   = makeTremolo(5.4, 0.30);
    var gtrPostFX = gain(1);

    /* Envios paralelos: seco + slapback + mola. */
    var slap = makeSlapback(0.115, 0.30);
    var slapSend = gain(0.30);
    var slapRet  = gain(0.62);

    var springConv = ctx.createConvolver();
    springConv.normalize = true;
    springConv.buffer = makeSpringIR(1.9, 2.6, 815);
    var springPre = filt('highpass', 420, 0.7);   /* mola nao pega grave */
    var springTone= filt('lowpass', 4600, 0.8);
    var springSend = gain(0.20);
    var springRet  = gain(0.55);

    var gtrSum   = gain(1);
    var gtrComp  = comp(-19, 3.4, 0.004, 0.16, 8);
    var gtrBright= filt('highshelf', 3400, 0.7, 0.0);   /* sobe no star power */
    var gtrMute  = gain(1);                              /* corte no erro */
    var gtrOut   = gain(0.62 * MIX);

    gtrIn.connect(gtrHP);
    gtrHP.connect(gtrWah);
    gtrWah.connect(gtrPre);
    gtrPre.connect(gtrAmp);
    gtrAmp.connect(gtrDC);
    gtrDC.connect(gtrScoop);
    gtrScoop.connect(gtrMid);
    gtrMid.connect(gtrPres);
    gtrPres.connect(gtrAir);
    gtrAir.connect(gtrCab);
    gtrCab.connect(gtrChorus.input);
    gtrChorus.output.connect(gtrTrem.node);
    gtrTrem.node.connect(gtrPostFX);

    gtrPostFX.connect(gtrSum);                              /* seco */
    gtrPostFX.connect(slapSend); slapSend.connect(slap.input);
    slap.output.connect(slapRet); slapRet.connect(gtrSum);
    gtrPostFX.connect(springSend); springSend.connect(springPre);
    springPre.connect(springConv); springConv.connect(springTone);
    springTone.connect(springRet); springRet.connect(gtrSum);
    /* o eco tambem molha a mola: e assim que soa um amp de verdade */
    slap.output.connect(springSend);

    gtrSum.connect(gtrComp);
    gtrComp.connect(gtrBright);
    gtrBright.connect(gtrMute);
    gtrMute.connect(gtrOut);
    gtrOut.connect(busOut('guitar'));

    /* O ambiente compartilhado vem do proprio barramento `guitar` de
       GH.Audio (que ja envia para o reverb global); aqui so equilibramos o
       nivel para os dois nao somarem sopa. */
    trimExternalGuitarSends();

    /* ============ BAIXO ============
       Passa-baixa fixo (o baixo nao precisa de agudo), saturacao leve para
       criar harmonicos que fazem o grave aparecer em caixinha de notebook,
       e compressao rapida para a linha "andar" com nivel constante. */
    var bassIn    = gain(0.9);
    var bassSat   = shaper(curves.bassDrive, '2x');
    var bassSatMix= gain(0.42);
    var bassDry   = gain(0.78);
    var bassSum   = gain(1);
    var bassHP    = filt('highpass', 34, 0.7);
    var bassLP    = filt('lowpass', 2600, 0.8);
    var bassBody  = filt('peaking', 92, 1.0, 3.0);
    var bassGrowl = filt('peaking', 760, 1.2, 2.2);   /* onde o baixo aparece */
    var bassComp  = comp(-21, 5.0, 0.006, 0.13, 5);
    var bassOut   = gain(0.72 * MIX);
    bassIn.connect(bassDry); bassDry.connect(bassSum);
    bassIn.connect(bassSat); bassSat.connect(bassSatMix); bassSatMix.connect(bassSum);
    bassSum.connect(bassHP); bassHP.connect(bassBody); bassBody.connect(bassGrowl);
    bassGrowl.connect(bassLP); bassLP.connect(bassComp); bassComp.connect(bassOut);
    bassOut.connect(busOut('music'));

    /* ============ TECLADO / ORGAO (Leslie simulado) ============
       Leslie = rotor grave (chorus/doppler) + corneta aguda (tremolo).
       Somando os dois com taxas ligeiramente diferentes ja convence. */
    var keysIn    = gain(0.7);
    var keysSat   = shaper(curves.organ, '2x');
    var keysLes   = makeChorus(0.0016, 5.9, 6.7, 0.5, 0.8);
    var keysTrem  = makeTremolo(6.3, 0.34);
    var keysTone  = filt('peaking', 1500, 0.9, 2.0);
    var keysHP    = filt('highpass', 130, 0.7);
    var keysOut   = gain(0.42 * MIX);
    var keysRev   = gain(0.20);
    keysIn.connect(keysSat); keysSat.connect(keysHP); keysHP.connect(keysLes.input);
    keysLes.output.connect(keysTrem.node); keysTrem.node.connect(keysTone);
    keysTone.connect(keysOut); keysOut.connect(busOut('music'));
    keysTone.connect(keysRev); keysRev.connect(roomSend);

    /* ============ NAIPE DE METAIS ============
       Compressao lenta e um peaking em 1.5k: e ali que o metal "brilha"
       sem virar sopro estridente. */
    var brassIn   = gain(0.62);
    var brassEQ   = filt('peaking', 1450, 1.1, 3.6);
    var brassHP   = filt('highpass', 180, 0.7);
    var brassLP   = filt('lowpass', 6200, 0.8);
    var brassComp = comp(-18, 4.0, 0.010, 0.22, 8);
    var brassOut  = gain(0.5 * MIX);
    var brassRev  = gain(0.26);
    brassIn.connect(brassHP); brassHP.connect(brassEQ); brassEQ.connect(brassLP);
    brassLP.connect(brassComp); brassComp.connect(brassOut);
    brassOut.connect(busOut('music'));
    brassComp.connect(brassRev); brassRev.connect(roomSend);

    /* ============ CORDAS DEDILHADAS (cavaquinho / violao) ============
       Um peaking no corpo de madeira (240 Hz) e outro no ataque (3 kHz):
       e o que separa "corda sintetica" de "instrumento de madeira". */
    var pluckIn   = gain(0.7);
    var pluckHP   = filt('highpass', 135, 0.7);
    var pluckBody = filt('peaking', 245, 1.3, 3.2);
    var pluckSnap = filt('peaking', 3050, 1.1, 2.4);
    var pluckOut  = gain(0.44 * MIX);
    var pluckRev  = gain(0.22);
    pluckIn.connect(pluckHP); pluckHP.connect(pluckBody);
    pluckBody.connect(pluckSnap); pluckSnap.connect(pluckOut);
    pluckOut.connect(busOut('music'));
    pluckSnap.connect(pluckRev); pluckRev.connect(roomSend);

    /* ============ BATERIA ============
       Cola: saturacao suave + compressor de ataque medio (deixa o transiente
       do bumbo passar antes de agarrar). */
    var drumIn   = gain(0.9);
    var drumGlue = shaper(curves.glue, '2x');
    var drumComp = comp(-16, 4.2, 0.008, 0.14, 6);
    var drumTone = filt('peaking', 4200, 0.8, 1.6);
    var drumOut  = gain(0.78 * MIX);
    var drumRev  = gain(0.13);
    drumIn.connect(drumGlue); drumGlue.connect(drumComp);
    drumComp.connect(drumTone); drumTone.connect(drumOut);
    drumOut.connect(busOut('drums'));
    drumTone.connect(drumRev); drumRev.connect(roomSend);

    /* ============ PERCUSSAO BRASILEIRA ============
       Bus separado da bateria: a percussao precisa de mais ambiente e menos
       compressao, senao o ganza vira ruido chapado. */
    var percIn   = gain(0.85);
    var percHP   = filt('highpass', 42, 0.7);   /* zabumba/surdo passam inteiros */
    var percComp = comp(-15, 2.6, 0.010, 0.18, 10);
    var percAir  = filt('highshelf', 7200, 0.7, 1.8);
    var percOut  = gain(0.66 * MIX);
    var percRev  = gain(0.26);
    percIn.connect(percHP); percHP.connect(percComp);
    percComp.connect(percAir); percAir.connect(percOut);
    percOut.connect(busOut('drums'));
    percAir.connect(percRev); percRev.connect(roomSend);

    nodes = {
      /* guitarra */
      gtrIn: gtrIn, gtrWah: gtrWah, gtrPre: gtrPre, gtrAmp: gtrAmp,
      gtrPres: gtrPres, gtrAir: gtrAir, gtrCab: gtrCab, gtrBright: gtrBright,
      gtrMute: gtrMute, gtrOut: gtrOut, gtrChorus: gtrChorus, gtrTrem: gtrTrem,
      wahLFO: wahLFO, wahAmt: wahAmt, slap: slap, slapSend: slapSend, slapRet: slapRet,
      springSend: springSend, springRet: springRet,
      /* demais familias */
      bassIn: bassIn, bassLP: bassLP, bassOut: bassOut,
      keysIn: keysIn, keysOut: keysOut, keysLes: keysLes, keysTrem: keysTrem,
      brassIn: brassIn, brassOut: brassOut,
      pluckIn: pluckIn, pluckOut: pluckOut,
      drumIn: drumIn, drumOut: drumOut,
      percIn: percIn, percOut: percOut,
      roomSend: roomSend, roomOut: roomOut
    };

    _ready = true;

    /* Reaplica o que foi pedido antes do grafo existir: mute, star power e
       o andamento (prepare() costuma rodar antes de GH.Audio.init()). */
    applyMute(_muted, true);
    applyStarPower(_sp, true);
    if (_pendingTempo) {
      try { tuneFxToTempo(_pendingTempo.bpm, _pendingTempo.genre); } catch (e) {}
      _pendingTempo = null;
    }
    return true;
  }

  /* Alvo de conexao por nome de instrumento. */
  function targetFor(inst) {
    switch (inst) {
      case 'guitar':  return nodes.gtrIn;
      case 'bass':    return nodes.bassIn;
      case 'organ':   return nodes.keysIn;
      case 'brass':   return nodes.brassIn;
      case 'pluck':   return nodes.pluckIn;
      case 'kick': case 'snare': case 'hatC': case 'hatO':
      case 'ride': case 'crash': case 'tom': case 'rim':
        return nodes.drumIn;
      default:        return nodes.percIn;
    }
  }

  /* ---------------------------------------------------------------------
   * Mute da guitarra e Star Power.
   * ------------------------------------------------------------------- */

  /* O mute fica no FIM da cadeia, depois do delay e da mola: quando o
     jogador erra, some tambem a cauda — e exatamente o "corte" seco que o
     Guitar Hero faz e que o ouvido reconhece como punicao. */
  function applyMute(on, instant) {
    if (!_ready || !ctx) { return; }
    var t = ctx.currentTime;
    var g = nodes.gtrMute.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    if (instant) { g.setValueAtTime(on ? 0.0 : 1.0, t); return; }
    /* Corte rapido (12 ms) e volta um pouco mais lenta (35 ms): cortar
       rapido soa proposital, voltar rapido soa a clique. */
    g.linearRampToValueAtTime(on ? 0.0 : 1.0, t + (on ? 0.012 : 0.035));
  }

  /* Star Power muda o TIMBRE, nao so o volume: o filtro abre, o brilho
     sobe, a mola cresce e o chorus alarga. As camadas de oitava/quinta
     entram nota a nota (ver playGuitar). */
  function applyStarPower(on, instant) {
    if (!_ready || !ctx) { return; }
    var t = ctx.currentTime;
    var ramp = instant ? 0.001 : 0.22;

    var wah = nodes.gtrWah.frequency;
    wah.cancelScheduledValues(t);
    wah.setValueAtTime(wah.value, t);
    wah.linearRampToValueAtTime(on ? 3350 : 2100, t + ramp);

    var wahDepth = nodes.wahAmt.gain;
    wahDepth.cancelScheduledValues(t);
    wahDepth.setValueAtTime(wahDepth.value, t);
    wahDepth.linearRampToValueAtTime(on ? 980 : 620, t + ramp);

    var br = nodes.gtrBright.gain;
    br.cancelScheduledValues(t);
    br.setValueAtTime(br.value, t);
    br.linearRampToValueAtTime(on ? 5.5 : 0.0, t + ramp);

    var sp = nodes.springRet.gain;
    var spBase = 0.55;
    sp.cancelScheduledValues(t);
    sp.setValueAtTime(sp.value, t);
    sp.linearRampToValueAtTime(on ? spBase * 1.75 : spBase, t + ramp);

    var ch = nodes.gtrChorus.wet.gain;
    ch.cancelScheduledValues(t);
    ch.setValueAtTime(ch.value, t);
    ch.linearRampToValueAtTime(on ? 0.52 : 0.34, t + ramp);

    var cab = nodes.gtrCab.frequency;
    cab.cancelScheduledValues(t);
    cab.setValueAtTime(cab.value, t);
    cab.linearRampToValueAtTime(on ? 9200 : 7400, t + ramp);

    /* Amp mais quente: mais compressao natural e sustain. */
    nodes.gtrAmp.curve = on ? curves.tubeHot : curves.tubeAmp;

    var pre = nodes.gtrPre.gain;
    pre.cancelScheduledValues(t);
    pre.setValueAtTime(pre.value, t);
    pre.linearRampToValueAtTime(on ? 1.32 : 1.1, t + ramp);
  }

  /* Ajusta os tempos de efeito ao andamento da musica. Feito em prepare().
     Slapback = uma semicolcheia, limitado a 90-140 ms como manda o genero. */
  function tuneFxToTempo(bpm, genre) {
    if (!_ready) { return; }
    _bpm = bpm;
    var beat = 60 / Math.max(40, bpm);
    var slapTime = clamp(beat / 4, 0.088, 0.142);
    var t = ctx.currentTime;
    nodes.slap.delay.delayTime.cancelScheduledValues(t);
    nodes.slap.delay.delayTime.setValueAtTime(slapTime, t);

    /* Tremolo em colcheia; no frevo, mais rapido e mais raso (a levada ja
       e agitada, tremolo profundo atrapalharia). */
    var tremRate = (1 / beat) * 2;
    var tremDepth = 0.30;
    if (genre === 'frevo') { tremRate = (1 / beat) * 3; tremDepth = 0.16; }
    if (genre === 'brega') { tremRate = (1 / beat) * 1; tremDepth = 0.34; }
    if (genre === 'carimbo') { tremDepth = 0.36; }
    nodes.gtrTrem.lfo.frequency.setValueAtTime(clamp(tremRate, 2.2, 9.5), t);
    nodes.gtrTrem.amt.gain.setValueAtTime(tremDepth * 0.5, t);
    nodes.gtrTrem.node.gain.setValueAtTime(1 - tremDepth * 0.5, t);

    /* Wah respirando a cada dois compassos. */
    nodes.wahLFO.frequency.setValueAtTime(clamp(1 / (beat * 8), 0.08, 1.2), t);

    /* O delay global de GH.Audio (usado tambem pelos SFX) passa a andar no
       tempo da musica: eco fora do compasso e o que mais suja um jogo de
       ritmo. A API existe justamente para o agente de musica chamar. */
    if (_audio && typeof _audio.syncDelayToTempo === 'function') {
      try { _audio.syncDelayToTempo(bpm); } catch (e) {}
    }

    /* Leslie um pouco mais rapido em musica rapida. */
    var les = nodes.keysLes;
    les.lfoA.frequency.setValueAtTime(clamp(5.2 + bpm / 90, 4.5, 7.6), t);
    les.lfoB.frequency.setValueAtTime(clamp(5.9 + bpm / 84, 5.0, 8.4), t);
  }

  /* ======================================================================
   * 4. VOZES MELODICAS
   * ==================================================================== */

  /* Orcamento de polifonia: em trechos densos preferimos perder um chocalho
     a perder a guitarra. Prioridade 3 = guitarra/baixo/bumbo/caixa. */
  function budgetOK(prio) {
    if (_voiceCount < MAX_VOICES) { return true; }
    return prio >= 3;
  }

  /* Contador deterministico para variar offsets de ruido sem Math.random. */
  var _noiseTick = 0;
  function noiseOffset() {
    _noiseTick = (_noiseTick * 1103515245 + 12345) & 0x7fffffff;
    return (_noiseTick / 0x7fffffff);
  }

  /* ---------------------------------------------------------------------
   * KARPLUS-STRONG DE VERDADE
   *
   * Um DelayNode dentro de um ciclo com um BiquadFilter no caminho de
   * realimentacao. E literalmente uma corda: a excitacao (um estalo de
   * ruido) circula pelo atraso; o filtro passa-baixa dentro do loop faz o
   * agudo morrer antes do grave, que e exatamente o que uma corda real faz.
   *
   * Detalhe pratico: a Web Audio obriga um atraso minimo de um quantum de
   * render (128 amostras) dentro de um ciclo. Isso limitaria a corda a uns
   * 370 Hz. A solucao e afinar o loop num MULTIPLO do periodo (k/f): o
   * pente resultante ainda tem ressonancia exata em f, e excitamos com um
   * passa-banda centrado em f para que a altura percebida seja f.
   * ------------------------------------------------------------------- */
  function karplusString(t0, freq, tHold, opts) {
    opts = opts || {};
    var k = Math.max(1, Math.ceil(MIN_DELAY * freq));
    var loopTime = k / freq;
    var t60 = opts.t60 || 1.1;

    /* Ganho de realimentacao a partir do tempo de decaimento desejado:
       fb = 10^(-3 * loopTime / T60). */
    var fbg = clamp(Math.pow(10, -3 * loopTime / Math.max(0.05, t60)), 0.05, 0.985);

    var dly = ctx.createDelay(0.6);
    dly.delayTime.value = loopTime;
    /* Amortecimento: quanto mais grave o brilho, mais "abafada" a corda. */
    var damp = clamp(opts.damp || (freq * 9 + 900), 800, Math.min(11000, _sr * 0.45));

    /* ATENCAO — ARMADILHA DA WEB AUDIO: para os tipos `lowpass` e
       `highpass`, o parametro Q e interpretado em DECIBEIS, nao como fator
       de qualidade linear. Um Q de 0.35 nao e "quase sem ressonancia": e
       +0,35 dB de realce, ou seja, Q linear ~1,04 — acima de 0,707 — e o
       filtro passa a ter um PICO de ganho de ate ~1,19 perto do corte.
       Dentro de um laco de realimentacao isso e fatal: o ganho do laco
       passa de 1 na regiao do pico e a corda vira um oscilador que cresce
       sem limite (medido: 6 milhoes de amplitude em 1 segundo).
       Usando Q negativo em dB (Q linear < 0,707) o passa-baixa fica
       monotonico, com ganho maximo 1 em DC, e o laco fica estavel POR
       CONSTRUCAO: ganho do laco <= fbg < 1. */
    var lp = filt('lowpass', damp, -6);
    var fb = gain(fbg);
    var out = gain(opts.level == null ? 1 : opts.level);
    var hp = filt('highpass', clamp(freq * 0.6, 40, 700), 0.5);

    dly.connect(lp);
    lp.connect(fb);
    fb.connect(dly);          /* <- o ciclo; o DelayNode o torna legal */
    dly.connect(hp);
    hp.connect(out);

    /* Excitacao: estalo de ruido rosa por um passa-banda centrado na nota.
       Ruido rosa (e nao branco) porque a palheta poe mais energia em medios
       e graves; branco soa a "psh".

       PONTO CRITICO: a excitacao tem de durar NO MAXIMO um periodo do laco.
       O Karplus-Strong classico PREENCHE a linha de atraso uma vez e deixa
       o conteudo circular. Se continuarmos injetando por varios periodos,
       o pente (que tem ganho ressonante de 1/(1-fb), aqui perto de 60x)
       soma em fase e a nota estoura. Foi exatamente o que aconteceu antes
       desta correcao: o cavaquinho passava de +12 dBFS. */
    var burstLen = clamp(loopTime, 0.0012, 0.020);

    var src = noiseSource(pinkBuf, 0, 1);
    var bp = filt('bandpass', clamp(freq * 1.9, 90, 8000), 0.62);
    var burst = gain(0);
    src.connect(bp); bp.connect(burst); burst.connect(dly);
    burst.gain.setValueAtTime(0, t0);
    burst.gain.linearRampToValueAtTime(opts.exciteLevel || 0.9, t0 + burstLen * 0.18);
    burst.gain.exponentialRampToValueAtTime(1e-4, t0 + burstLen);
    burst.gain.linearRampToValueAtTime(0, t0 + burstLen + 0.0008);

    /* Ping senoidal de um unico periodo: ancora a altura percebida quando
       k > 1 e da a definicao de ataque que so ruido nao entrega. Tambem
       limitado a um periodo, pelo mesmo motivo. */
    var pingLen = clamp(loopTime, 0.0012, 0.020);
    var ping = ctx.createOscillator();
    ping.type = 'sine';
    ping.frequency.value = freq;
    var pingG = gain(0);
    ping.connect(pingG); pingG.connect(dly);
    pingG.gain.setValueAtTime(0, t0);
    pingG.gain.linearRampToValueAtTime((opts.exciteLevel || 0.9) * 0.45, t0 + pingLen * 0.2);
    pingG.gain.exponentialRampToValueAtTime(1e-4, t0 + pingLen);
    pingG.gain.linearRampToValueAtTime(0, t0 + pingLen + 0.0008);

    try { src.start(t0, safeOffset(pinkBuf)); src.stop(t0 + burstLen + 0.01); } catch (e) {}
    try { ping.start(t0); ping.stop(t0 + pingLen + 0.01); } catch (e) {}

    /* Abafamento no fim da nota: derruba a realimentacao (a mao encostando
       na corda) em vez de cortar o audio, que estalaria. */
    var tStop = t0 + Math.max(0.05, tHold);
    var tail = opts.tail == null ? 0.18 : opts.tail;
    fb.gain.setValueAtTime(fbg, tStop);
    fb.gain.linearRampToValueAtTime(0.0, tStop + tail);
    out.gain.setValueAtTime(out.gain.value, tStop);
    out.gain.setTargetAtTime(0.0001, tStop, Math.max(0.02, tail * 0.4));

    var end = tStop + tail + 0.12;
    return {
      out: out,
      end: end,
      nodes: [dly, lp, fb, out, hp, src, bp, burst, ping, pingG]
    };
  }

  /* ---------------------------------------------------------------------
   * GUITARRA DA GUITARRADA — a voz mais importante do jogo.
   *
   * Receita:
   *   dente-de-serra (corpo) + quadrada desafinada (o "nasal" tipico) +
   *   sub-oitava discreta (peso) + estalo de palheta + corda Karplus-Strong
   *   -> saturacao leve de valvula -> passa-baixa ressonante com envelope
   *   (o "quack" da palhetada) -> ADSR de ataque curtissimo com cauda.
   * O resto do carater (amp, wah, chorus, tremolo, slapback, mola) esta no
   * bus, porque num rig real e o amplificador que faz isso, nao a corda.
   * ------------------------------------------------------------------- */
  function playGuitar(ev, when) {
    if (!budgetOK(3)) { return; }
    var art = ev.a || {};
    var vel = clamp(ev.v == null ? 0.8 : ev.v, 0.05, 1.2);
    var midi = ev.m;
    var freq = midiToFreq(midi);
    var hold = Math.max(0.055, ev.d || 0.13);
    var t0 = when;
    var legato = !!art.hopo;
    var palm = !!art.palm;
    var N = [];

    var mix = gain(1);

    /* --- osciladores --------------------------------------------------- */
    /* O leve desafino entre serra e quadrada cria batimento: e o que faz a
       nota parecer tocada por uma corda de aco e nao por um gerador. */
    var o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = freq;
    var o2 = ctx.createOscillator(); o2.type = 'square';   o2.frequency.value = freq;
    var o3 = ctx.createOscillator(); o3.type = 'triangle'; o3.frequency.value = freq * 0.5;
    var d1 = -6.5, d2 = 7.5, d3 = -2.0;

    var g1 = gain(0.62);
    var g2 = gain(palm ? 0.20 : 0.30);
    var g3 = gain(palm ? 0.30 : 0.17);      /* sub-oitava: peso sem lama */
    o1.connect(g1); g1.connect(mix);
    o2.connect(g2); g2.connect(mix);
    o3.connect(g3); g3.connect(mix);
    N.push(o1, o2, o3, g1, g2, g3);

    /* --- camadas de Star Power ----------------------------------------- */
    /* Oitava acima + quinta acima da oitava: o acorde de potencia que faz o
       solo "acender" quando o Star Power entra. */
    var spOscs = [];
    if (_sp) {
      var so1 = ctx.createOscillator(); so1.type = 'sawtooth'; so1.frequency.value = freq * 2;
      var so2 = ctx.createOscillator(); so2.type = 'square';   so2.frequency.value = freq * 3;
      var sg1 = gain(0.26), sg2 = gain(0.13);
      so1.connect(sg1); sg1.connect(mix);
      so2.connect(sg2); sg2.connect(mix);
      spOscs.push(so1, so2);
      N.push(so1, so2, sg1, sg2);
    }

    /* --- estalo de palheta --------------------------------------------- */
    /* 5 ms de ruido bem agudo somado ao ataque. Sem isso a nota "aparece"
       em vez de ser tocada. Hammer-on nao tem palhetada, entao pulamos. */
    if (!legato) {
      var pk = noiseSource(noiseBuf, 0, 1);
      var pkHP = filt('highpass', clamp(freq * 3.5, 900, 5200), 0.8);
      var pkG = gain(0);
      pk.connect(pkHP); pkHP.connect(pkG); pkG.connect(mix);
      pkG.gain.setValueAtTime(0, t0);
      pkG.gain.linearRampToValueAtTime(0.30 * vel * (palm ? 0.6 : 1), t0 + 0.0008);
      pkG.gain.exponentialRampToValueAtTime(1e-4, t0 + 0.0055);
      pkG.gain.linearRampToValueAtTime(0, t0 + 0.008);
      try { pk.start(t0, noiseOffset() * 2.6); pk.stop(t0 + 0.02); } catch (e) {}
      N.push(pk, pkHP, pkG);
    }

    /* --- ressonancia de corda (Karplus-Strong) ------------------------- */
    /* Misturada baixa, so para dar corpo e aquele "rabo" metalico entre o
       ataque e o sustain. Em palm mute nao entra: a mao esta abafando. */
    var ks = null;
    if (!palm && _voiceCount < MAX_VOICES - 12) {
      ks = karplusString(t0, freq, Math.min(hold, 0.9), {
        t60: legato ? 0.55 : 0.85,
        damp: clamp(freq * 7.5 + 1200, 1200, 9000),
        exciteLevel: 0.55 * vel,
        level: 0.34,
        tail: 0.14
      });
      ks.out.connect(mix);
      N = N.concat(ks.nodes);
    }

    /* --- articulacoes de altura ---------------------------------------- */
    var oscAll = [o1, o2, o3].concat(spOscs);
    var mult = [1, 1, 0.5, 2, 3];
    var base = [d1, d2, d3, d1 - 3, d2 + 3];
    var i, o, sp;

    /* SLIDE: portamento a partir da nota anterior. E o glissando que define
       o fraseado paraense — a nota chega deslizando, nao pousa seca. */
    if (art.slideFrom != null) {
      var fFrom = midiToFreq(art.slideFrom);
      var slideT = clamp(art.slideTime || 0.075, 0.02, 0.22);
      for (i = 0; i < oscAll.length; i++) {
        o = oscAll[i];
        o.frequency.setValueAtTime(fFrom * mult[i], t0);
        o.frequency.exponentialRampToValueAtTime(freq * mult[i], t0 + slideT);
      }
    } else if (legato && art.legatoFrom != null && art.legatoFrom !== midi) {
      /* HAMMER-ON / PULL-OFF: um portamento curtissimo (25 ms) liga as
         notas sem re-atacar. */
      var fL = midiToFreq(art.legatoFrom);
      for (i = 0; i < oscAll.length; i++) {
        o = oscAll[i];
        o.frequency.setValueAtTime(fL * mult[i], t0);
        o.frequency.exponentialRampToValueAtTime(freq * mult[i], t0 + 0.026);
      }
    }

    /* BEND: sobe a afinacao dentro da nota (detune em cents). */
    for (i = 0; i < oscAll.length; i++) {
      o = oscAll[i];
      sp = base[i];
      if (art.bend) {
        var bAmt = art.bend;                       /* em cents, ex.: 200 = 1 tom */
        var bDelay = clamp(art.bendDelay == null ? 0.06 : art.bendDelay, 0, 0.4);
        var bTime = clamp(art.bendTime || 0.13, 0.03, 0.5);
        o.detune.setValueAtTime(sp + (art.bendFrom || 0), t0);
        o.detune.setValueAtTime(sp + (art.bendFrom || 0), t0 + bDelay);
        o.detune.linearRampToValueAtTime(sp + bAmt, t0 + bDelay + bTime);
        if (art.bendRelease) {
          o.detune.linearRampToValueAtTime(sp, t0 + bDelay + bTime * 2.1);
        }
      } else if (!legato) {
        /* Micro-scoop de palhetada: a corda chega ~18 cents baixa e sobe em
           25 ms. Detalhe pequeno, mas e o que soa "tocado por gente". */
        o.detune.setValueAtTime(sp - 18 * vel, t0);
        o.detune.linearRampToValueAtTime(sp, t0 + 0.025);
      } else {
        o.detune.setValueAtTime(sp, t0);
      }
    }

    /* VIBRATO: LFO de altura que so ENTRA depois de um atraso. Vibrato
       imediato soa a sintetizador; vibrato que cresce soa a dedo. */
    if (art.vib !== false && hold > 0.20) {
      var vLfo = ctx.createOscillator();
      vLfo.type = 'sine';
      vLfo.frequency.value = art.vibRate || (5.1 + (midi % 5) * 0.14);
      var vAmt = gain(0);
      vLfo.connect(vAmt);
      for (i = 0; i < oscAll.length; i++) { vAmt.connect(oscAll[i].detune); }
      var vDelay = clamp(art.vibDelay == null ? 0.16 : art.vibDelay, 0, 1.2);
      var vDepth = art.vibDepth || (palm ? 6 : 26);   /* cents */
      vAmt.gain.setValueAtTime(0, t0);
      vAmt.gain.setValueAtTime(0, t0 + vDelay);
      vAmt.gain.linearRampToValueAtTime(vDepth, t0 + vDelay + 0.22);
      try { vLfo.start(t0); vLfo.stop(t0 + hold + 0.6); } catch (e) {}
      N.push(vLfo, vAmt);
    }

    /* --- saturacao leve na propria corda -------------------------------- */
    var sat = shaper(curves.tubeSoft, '2x');
    var satIn = gain(0.85 + vel * 0.25);
    mix.connect(satIn); satIn.connect(sat);
    N.push(mix, satIn, sat);

    /* --- filtro com envelope: o "quack" da palhetada -------------------- */
    /* O corte salta para cima no ataque e desaba em ~150 ms. Com Q alto,
       essa queda produz o miado curto que caracteriza a guitarra limpa
       palhetada com forca. */
    var vf = filt('lowpass', 1400, palm ? 2.2 : 6.4);
    var cutBase = clamp(freq * 2.4 + 340, 380, 4200);
    var cutPeak = palm ? clamp(cutBase * 1.5, 400, 2200)
                       : clamp(cutBase * (2.5 + vel * 2.3), 900, 11000);
    var cutRest = palm ? clamp(cutBase * 0.55, 240, 1300) : clamp(cutBase * 1.05, 300, 6200);
    vf.frequency.setValueAtTime(cutBase * 0.7, t0);
    vf.frequency.linearRampToValueAtTime(cutPeak, t0 + (legato ? 0.020 : 0.010));
    vf.frequency.exponentialRampToValueAtTime(cutRest, t0 + (palm ? 0.07 : 0.19));
    if (hold > 0.4) {
      vf.frequency.exponentialRampToValueAtTime(Math.max(240, cutRest * 0.72), t0 + hold);
    }
    sat.connect(vf);
    N.push(vf);

    /* --- envelope de amplitude ------------------------------------------ */
    /* Ataque de 2,5 ms (3 ms em legato, que e mais macio). O decaimento
       leva a nota a 45% e a cauda de release e longa: corda de aco em amp
       limpo continua soando bem depois do dedo sair. */
    var amp = gain(0);
    vf.connect(amp);
    var atk = legato ? 0.009 : 0.0025;
    var dec = palm ? 0.045 : 0.11;
    var sus = palm ? 0.10 : 0.46;
    var rel = palm ? 0.055 : (0.19 + Math.min(0.25, hold * 0.3));
    var peak = 0.30 * vel * (legato ? 0.82 : 1.0);
    var end = adsr(amp.gain, t0, peak, atk, dec, sus, t0 + hold, rel);
    N.push(amp);

    /* --- panorama leve por altura --------------------------------------- */
    /* Notas agudas um tico a direita: abre o estereo sem descolar a
       guitarra do centro. */
    var pn = panner(clamp(((midi - 66) / 26) * 0.16, -0.2, 0.2));
    amp.connect(pn);
    pn.connect(targetFor('guitar'));
    N.push(pn);

    try {
      o1.start(t0); o2.start(t0); o3.start(t0);
      o1.stop(end); o2.stop(end); o3.stop(end);
      for (i = 0; i < spOscs.length; i++) { spOscs[i].start(t0); spOscs[i].stop(end); }
    } catch (e) { /* contexto fechado */ }

    retire(N, Math.max(end, ks ? ks.end : 0) + 0.05);
  }

  /* ---------------------------------------------------------------------
   * BAIXO — senoide (fundamental limpa) + triangulo levemente desafinado
   * (corpo) + estalo de dedo. A saturacao harmonica esta no bus, o que
   * mantem a fundamental intacta e ainda faz o grave aparecer em caixinha.
   * ------------------------------------------------------------------- */
  function playBass(ev, when) {
    if (!budgetOK(3)) { return; }
    var vel = clamp(ev.v == null ? 0.85 : ev.v, 0.05, 1.2);
    var midi = ev.m;
    var freq = midiToFreq(midi);
    var hold = Math.max(0.07, ev.d || 0.22);
    var art = ev.a || {};
    var t0 = when;
    var N = [];

    var mix = gain(1);

    var o1 = ctx.createOscillator(); o1.type = 'sine';     o1.frequency.value = freq;
    var o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = freq;
    o2.detune.value = 6;
    var o3 = ctx.createOscillator(); o3.type = 'sawtooth'; o3.frequency.value = freq * 2;
    var g1 = gain(0.75), g2 = gain(0.34), g3 = gain(0.10);
    o1.connect(g1); g1.connect(mix);
    o2.connect(g2); g2.connect(mix);
    o3.connect(g3); g3.connect(mix);
    N.push(o1, o2, o3, g1, g2, g3, mix);

    /* Slide de baixo (aquele arrasto de dedo entre acordes). */
    if (art.slideFrom != null) {
      var ff = midiToFreq(art.slideFrom);
      o1.frequency.setValueAtTime(ff, t0);
      o1.frequency.exponentialRampToValueAtTime(freq, t0 + 0.07);
      o2.frequency.setValueAtTime(ff, t0);
      o2.frequency.exponentialRampToValueAtTime(freq, t0 + 0.07);
      o3.frequency.setValueAtTime(ff * 2, t0);
      o3.frequency.exponentialRampToValueAtTime(freq * 2, t0 + 0.07);
    } else {
      /* Pitch drop de 40 cents em 30 ms: o "puxao" da corda grossa. */
      o1.detune.setValueAtTime(38 * vel, t0);
      o1.detune.linearRampToValueAtTime(0, t0 + 0.032);
      o2.detune.setValueAtTime(6 + 34 * vel, t0);
      o2.detune.linearRampToValueAtTime(6, t0 + 0.032);
    }

    /* Estalo de dedo/palheta: ruido curtissimo passa-banda em 1.8 kHz. */
    var ns = noiseSource(noiseBuf, 0, 1);
    var nbp = filt('bandpass', 1750, 1.1);
    var ng = gain(0);
    ns.connect(nbp); nbp.connect(ng); ng.connect(mix);
    ng.gain.setValueAtTime(0, t0);
    ng.gain.linearRampToValueAtTime(0.16 * vel, t0 + 0.001);
    ng.gain.exponentialRampToValueAtTime(1e-4, t0 + 0.022);
    ng.gain.linearRampToValueAtTime(0, t0 + 0.026);
    try { ns.start(t0, noiseOffset() * 2.2); ns.stop(t0 + 0.05); } catch (e) {}
    N.push(ns, nbp, ng);

    /* Filtro com envelope curto: define a "abertura" do dedilhado. */
    var vf = filt('lowpass', 900, 2.6);
    var cb = clamp(freq * 6 + 220, 260, 2400);
    vf.frequency.setValueAtTime(cb * 2.4, t0);
    vf.frequency.exponentialRampToValueAtTime(cb, t0 + 0.09);
    vf.frequency.exponentialRampToValueAtTime(Math.max(180, cb * 0.62), t0 + hold + 0.1);
    mix.connect(vf);
    N.push(vf);

    var amp = gain(0);
    vf.connect(amp);
    var end = adsr(amp.gain, t0, 0.44 * vel, 0.004, 0.09, 0.62, t0 + hold, 0.10);
    amp.connect(targetFor('bass'));
    N.push(amp);

    try {
      o1.start(t0); o2.start(t0); o3.start(t0);
      o1.stop(end); o2.stop(end); o3.stop(end);
    } catch (e) {}
    retire(N, end + 0.05);
  }

  /* ---------------------------------------------------------------------
   * ORGAO ELETRONICO — usa uma PeriodicWave montada com os "drawbars"
   * classicos. A onda e gerada na frequencia f/2 para que o harmonico 1
   * seja a sub-oitava de 16 pes, o 2 seja a fundamental, o 3 seja a quinta
   * de 5 1/3 pes e assim por diante. Uma unica PeriodicWave substitui oito
   * osciladores — economia que permite tocar acordes de verdade.
   * O clique de tecla e a percussao de 3o harmonico vem por cima.
   * ------------------------------------------------------------------- */
  var waves = {};
  function buildWaves() {
    /* Drawbars: 16', 8', 5 1/3', 4', 2 2/3', 2', 1 3/5', 1 1/3', 1'. */
    var draw = { 1: 0.44, 2: 1.0, 3: 0.30, 4: 0.60, 6: 0.22, 8: 0.34, 10: 0.10, 12: 0.12, 16: 0.16 };
    var n = 20;
    var real = new Float32Array(n), imag = new Float32Array(n);
    for (var k in draw) {
      if (Object.prototype.hasOwnProperty.call(draw, k)) {
        var idx = parseInt(k, 10);
        if (idx < n) { imag[idx] = draw[k]; }
      }
    }
    waves.organ = ctx.createPeriodicWave(real, imag);

    /* Metais: espectro de sopro — decai devagar ate o 8o harmonico e depois
       cai rapido; o formante fica por conta do filtro. */
    var bn = 14;
    var br = new Float32Array(bn), bi = new Float32Array(bn);
    for (var h = 1; h < bn; h++) {
      bi[h] = (h <= 8 ? 1 / Math.pow(h, 0.82) : 1 / Math.pow(h, 1.9)) * (h % 2 ? 1 : 0.86);
    }
    waves.brass = ctx.createPeriodicWave(br, bi);

    /* Cavaquinho: corpo pequeno, muitos harmonicos impares. */
    var cn = 16;
    var cr = new Float32Array(cn), ci = new Float32Array(cn);
    for (var j = 1; j < cn; j++) { ci[j] = (1 / Math.pow(j, 1.25)) * (j % 2 ? 1 : 0.55); }
    waves.cavaco = ctx.createPeriodicWave(cr, ci);
  }

  function playOrgan(ev, when) {
    if (!budgetOK(1)) { return; }
    var vel = clamp(ev.v == null ? 0.7 : ev.v, 0.05, 1.2);
    var freq = midiToFreq(ev.m);
    var hold = Math.max(0.08, ev.d || 0.4);
    var t0 = when;
    var N = [];

    var mix = gain(1);
    var o = ctx.createOscillator();
    o.setPeriodicWave(waves.organ);
    o.frequency.value = freq * 0.5;      /* ver comentario do buildWaves */
    var og = gain(0.5);
    o.connect(og); og.connect(mix);
    N.push(o, og);

    /* Percussao de 3o harmonico: aquele "ping" que o Hammond dispara so na
       primeira tecla de cada frase. Decaimento de 200 ms. */
    var pOsc = ctx.createOscillator();
    pOsc.type = 'sine';
    pOsc.frequency.value = freq * 3;
    var pG = gain(0);
    pOsc.connect(pG); pG.connect(mix);
    pG.gain.setValueAtTime(0, t0);
    pG.gain.linearRampToValueAtTime(0.20 * vel, t0 + 0.004);
    pG.gain.exponentialRampToValueAtTime(1e-4, t0 + 0.21);
    pG.gain.linearRampToValueAtTime(0, t0 + 0.23);
    N.push(pOsc, pG);

    /* Clique de tecla: 4 ms de ruido. Sem ele o orgao soa a flauta. */
    var ns = noiseSource(noiseBuf, 0, 1);
    var nhp = filt('highpass', 2400, 0.9);
    var ng = gain(0);
    ns.connect(nhp); nhp.connect(ng); ng.connect(mix);
    ng.gain.setValueAtTime(0, t0);
    ng.gain.linearRampToValueAtTime(0.085 * vel, t0 + 0.0006);
    ng.gain.exponentialRampToValueAtTime(1e-4, t0 + 0.0045);
    ng.gain.linearRampToValueAtTime(0, t0 + 0.007);
    try { ns.start(t0, noiseOffset() * 2.0); ns.stop(t0 + 0.02); } catch (e) {}
    N.push(ns, nhp, ng);

    var lp = filt('lowpass', clamp(freq * 8 + 1800, 1800, 9000), 0.6);
    mix.connect(lp);
    var amp = gain(0);
    lp.connect(amp);
    /* Orgao nao tem decaimento: e liga-desliga. Ataque e release de 8-30 ms
       so para evitar clique. */
    var end = adsr(amp.gain, t0, 0.36 * vel, 0.010, 0.05, 0.92, t0 + hold, 0.075);
    amp.connect(targetFor('organ'));
    N.push(mix, lp, amp);

    try { o.start(t0); o.stop(end); pOsc.start(t0); pOsc.stop(t0 + 0.25); } catch (e) {}
    retire(N, end + 0.05);
  }

  /* ---------------------------------------------------------------------
   * NAIPE DE METAIS — dois osciladores desafinados com espectro de sopro,
   * filtro passa-baixa cujo corte SOBE junto com a amplitude (e assim que
   * um metal se comporta: quanto mais forte, mais brilhante), sopro de ar
   * no ataque e vibrato tardio. Para brega e frevo.
   * ------------------------------------------------------------------- */
  function playBrass(ev, when) {
    if (!budgetOK(1)) { return; }
    var vel = clamp(ev.v == null ? 0.8 : ev.v, 0.05, 1.2);
    var freq = midiToFreq(ev.m);
    var hold = Math.max(0.09, ev.d || 0.3);
    var art = ev.a || {};
    var t0 = when;
    var N = [];

    var mix = gain(1);
    var o1 = ctx.createOscillator(); o1.setPeriodicWave(waves.brass); o1.frequency.value = freq;
    var o2 = ctx.createOscillator(); o2.setPeriodicWave(waves.brass); o2.frequency.value = freq;
    o1.detune.value = -9; o2.detune.value = 10;
    var g1 = gain(0.5), g2 = gain(0.42);
    o1.connect(g1); g1.connect(mix);
    o2.connect(g2); g2.connect(mix);
    N.push(o1, o2, g1, g2);

    /* Ar do bocal: 30 ms de ruido passa-banda alto, so no ataque. */
    var ns = noiseSource(noiseBuf, 0, 1);
    var nbp = filt('bandpass', 2600, 0.8);
    var ng = gain(0);
    ns.connect(nbp); nbp.connect(ng); ng.connect(mix);
    ng.gain.setValueAtTime(0, t0);
    ng.gain.linearRampToValueAtTime(0.075 * vel, t0 + 0.012);
    ng.gain.exponentialRampToValueAtTime(1e-4, t0 + 0.075);
    ng.gain.linearRampToValueAtTime(0, t0 + 0.085);
    try { ns.start(t0, noiseOffset() * 2.8); ns.stop(t0 + 0.12); } catch (e) {}
    N.push(ns, nbp, ng);

    /* Envelope de sopro no filtro: sobe em 45 ms (mais lento que corda) e
       assenta. E o "ataque de bocal". */
    var vf = filt('lowpass', 900, 1.9);
    var cb = clamp(freq * 3.2 + 700, 700, 4200);
    vf.frequency.setValueAtTime(cb * 0.42, t0);
    vf.frequency.linearRampToValueAtTime(cb * (1.5 + vel), t0 + 0.045);
    vf.frequency.exponentialRampToValueAtTime(cb, t0 + 0.22);
    mix.connect(vf);
    N.push(mix, vf);

    /* Queda de afinacao no fim (o "fall" do frevo). */
    if (art.fall) {
      o1.detune.setValueAtTime(-9, t0 + hold * 0.7);
      o1.detune.linearRampToValueAtTime(-9 - 700, t0 + hold + 0.14);
      o2.detune.setValueAtTime(10, t0 + hold * 0.7);
      o2.detune.linearRampToValueAtTime(10 - 700, t0 + hold + 0.14);
    } else if (hold > 0.35) {
      var vl = ctx.createOscillator(); vl.type = 'sine'; vl.frequency.value = 5.6;
      var va = gain(0);
      vl.connect(va); va.connect(o1.detune); va.connect(o2.detune);
      va.gain.setValueAtTime(0, t0);
      va.gain.setValueAtTime(0, t0 + 0.20);
      va.gain.linearRampToValueAtTime(14, t0 + 0.5);
      try { vl.start(t0); vl.stop(t0 + hold + 0.4); } catch (e) {}
      N.push(vl, va);
    }

    var amp = gain(0);
    vf.connect(amp);
    var end = adsr(amp.gain, t0, 0.28 * vel, 0.022, 0.07, 0.72, t0 + hold, art.fall ? 0.16 : 0.10);
    amp.connect(targetFor('brass'));
    N.push(amp);
    try { o1.start(t0); o2.start(t0); o1.stop(end); o2.stop(end); } catch (e) {}
    retire(N, end + 0.05);
  }

  /* ---------------------------------------------------------------------
   * CAVAQUINHO / VIOLAO DEDILHADO — Karplus-Strong puro (a corda) somado a
   * uma pitada de oscilador com espectro de caixa pequena, para dar
   * definicao de altura nos agudos. Usado no samba-rock e nas comps.
   * ------------------------------------------------------------------- */
  function playPluck(ev, when) {
    if (!budgetOK(1)) { return; }
    var vel = clamp(ev.v == null ? 0.7 : ev.v, 0.05, 1.2);
    var freq = midiToFreq(ev.m);
    var hold = Math.max(0.06, ev.d || 0.18);
    var art = ev.a || {};
    var t0 = when;
    var N = [];

    var mix = gain(1);
    var ks = karplusString(t0, freq, hold, {
      t60: art.mute ? 0.16 : (0.9 + (80 - clamp(ev.m, 40, 90)) * 0.02),
      damp: clamp(freq * 11 + 900, 1100, 10000),
      exciteLevel: 1.15 * vel,
      level: 0.9,
      tail: art.mute ? 0.05 : 0.2
    });
    ks.out.connect(mix);
    N = N.concat(ks.nodes);

    /* Camada de oscilador curta: reforca a fundamental nos primeiros 120 ms
       (a corda sintetica sozinha soa fina no agudo). */
    var o = ctx.createOscillator();
    o.setPeriodicWave(waves.cavaco);
    o.frequency.value = freq;
    var og = gain(0);
    o.connect(og); og.connect(mix);
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(0.13 * vel, t0 + 0.003);
    og.gain.exponentialRampToValueAtTime(1e-4, t0 + (art.mute ? 0.06 : 0.16));
    og.gain.linearRampToValueAtTime(0, t0 + (art.mute ? 0.08 : 0.19));
    N.push(o, og);

    /* Nivel calibrado por medicao offline: uma corda dedilhada sozinha
       chega a ~-15 dBFS, que e onde ela divide bem com a guitarra solista. */
    var amp = gain(1.7 * vel);
    mix.connect(amp);
    var pn = panner(art.pan || 0);
    amp.connect(pn);
    pn.connect(targetFor('pluck'));
    N.push(mix, amp, pn);

    try { o.start(t0); o.stop(t0 + 0.25); } catch (e) {}
    retire(N, ks.end + 0.06);
  }

  /* ======================================================================
   * 5. BATERIA E PERCUSSAO BRASILEIRA
   *
   * Nenhuma amostra. Cada peca e um modelo fisico simplificado:
   *   - tambor  = modo(s) de membrana com envelope de altura + ruido de pele
   *   - prato   = ruido inarmonico com passa-alta e cauda longa
   *   - metal   = poucos parciais NAO harmonicos (metal nao tem serie
   *               harmonica; e isso que separa "sino" de "flauta")
   *   - chocalho= ruido de banda estreita com envelope de 20-40 ms
   * ==================================================================== */

  /* Banco de parciais inarmonicos: a base de agogo, triangulo e sinos.
     Os "ratios" nao sao inteiros de proposito. */
  function bellPartials(t0, base, ratios, amps, decay, vel, dest, N) {
    var end = t0;
    for (var i = 0; i < ratios.length; i++) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = base * ratios[i];
      var g = gain(0);
      o.connect(g); g.connect(dest);
      /* parciais agudos morrem antes dos graves — como no metal real */
      var d = decay * (1 / (1 + i * 0.55));
      var e = perc(g.gain, t0, amps[i] * vel, 0.0008, d);
      if (e > end) { end = e; }
      try { o.start(t0); o.stop(e + 0.02); } catch (er) {}
      N.push(o, g);
    }
    return end;
  }

  /* Deslocamento de leitura seguro: nunca alem da duracao do buffer, senao
     a fonte em loop comeca fora da regiao valida. */
  function safeOffset(buf) {
    return noiseOffset() * ((buf && buf.duration) ? buf.duration * 0.85 : 0);
  }

  /* Ruido com envelope, o tijolo de chimbais, caixas e chocalhos. */
  function noiseHit(t0, buf, filters, level, atk, dec, dest, N, rate) {
    var src = noiseSource(buf, 0, rate || 1);
    var last = src;
    for (var i = 0; i < filters.length; i++) {
      last.connect(filters[i]);
      last = filters[i];
      N.push(filters[i]);
    }
    var g = gain(0);
    last.connect(g); g.connect(dest);
    var end = perc(g.gain, t0, level, atk, dec);
    try { src.start(t0, safeOffset(buf)); src.stop(end + 0.02); } catch (e) {}
    N.push(src, g);
    return end;
  }

  /* ------------------------------- BUMBO ------------------------------- */
  /* Senoide com envelope de altura descendo de ~150 Hz para ~46 Hz em 55 ms
     (o "thump"), um sub estatico para o peso, e um click de batedor.
     A saturacao do bus faz o resto aparecer em caixa pequena. */
  function playKick(ev, when) {
    if (!budgetOK(3)) { return; }
    var vel = clamp(ev.v == null ? 0.9 : ev.v, 0.05, 1.3);
    var t0 = when;
    var N = [];
    var dest = targetFor('kick');
    var deep = (ev.a && ev.a.deep) ? 1 : 0;

    var o = ctx.createOscillator();
    o.type = 'sine';
    var f0 = (deep ? 118 : 152) * (0.92 + vel * 0.14);
    var f1 = deep ? 39 : 47;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + (deep ? 0.075 : 0.052));
    var og = gain(0);
    o.connect(og);
    var decay = deep ? 0.46 : 0.30;
    var end = perc(og.gain, t0, 0.9 * vel, 0.0015, decay);

    /* Sub separado: fica depois do transiente e sustenta o grave. */
    var s = ctx.createOscillator();
    s.type = 'sine';
    s.frequency.value = deep ? 41 : 52;
    var sg = gain(0);
    s.connect(sg);
    perc(sg.gain, t0 + 0.004, 0.42 * vel, 0.006, decay * 1.25);

    /* Click do batedor: 4 ms de ruido agudo. Sem ele o bumbo some na
       mixagem de laptop. */
    var ck = noiseSource(noiseBuf, 0, 1);
    var ckf = filt('highpass', 1600, 0.8);
    var ckg = gain(0);
    ck.connect(ckf); ckf.connect(ckg);
    perc(ckg.gain, t0, 0.11 * vel, 0.0005, 0.006);
    try { ck.start(t0, noiseOffset() * 2.1); ck.stop(t0 + 0.03); } catch (e) {}

    var sat = shaper(curves.glue, '2x');
    og.connect(sat); sg.connect(sat); ckg.connect(sat);
    var out = gain(0.95);
    sat.connect(out); out.connect(dest);

    try { o.start(t0); o.stop(end + 0.05); s.start(t0); s.stop(end + 0.2); } catch (e) {}
    N.push(o, og, s, sg, ck, ckf, ckg, sat, out);
    retire(N, end + 0.3);
  }

  /* ------------------------------- CAIXA ------------------------------- */
  /* Tres camadas: (1) dois modos de casco afinados em 185/258 Hz,
     (2) a esteira, que e ruido passa-banda em 1.9 kHz, (3) o "snap" de
     6 kHz com 25 ms. Trocar as proporcoes muda de caixa de rock para
     caixa de frevo. */
  function playSnare(ev, when) {
    if (!budgetOK(3)) { return; }
    var a = ev.a || {};
    var vel = clamp(ev.v == null ? 0.85 : ev.v, 0.03, 1.3);
    var t0 = when;
    var N = [];
    var dest = targetFor('snare');
    var tight = a.frevo ? 1 : 0;              /* caixa de frevo: mais aguda e seca */
    var ghost = vel < 0.4;

    var shellF = tight ? 246 : 188;
    var d1 = ctx.createOscillator(); d1.type = 'triangle'; d1.frequency.value = shellF;
    var d2 = ctx.createOscillator(); d2.type = 'triangle'; d2.frequency.value = shellF * 1.38;
    d1.frequency.exponentialRampToValueAtTime(shellF * 0.82, t0 + 0.06);
    d2.frequency.exponentialRampToValueAtTime(shellF * 1.15, t0 + 0.05);
    var gd1 = gain(0), gd2 = gain(0);
    d1.connect(gd1); d2.connect(gd2);
    var shellDec = tight ? 0.055 : 0.085;
    perc(gd1.gain, t0, 0.30 * vel, 0.0008, shellDec);
    perc(gd2.gain, t0, 0.17 * vel, 0.0008, shellDec * 0.8);

    var sum = gain(1);
    gd1.connect(sum); gd2.connect(sum);

    /* Esteira. */
    var wireDec = tight ? 0.075 : (ghost ? 0.055 : 0.135);
    var end = noiseHit(t0, noiseBuf,
      [filt('bandpass', tight ? 2400 : 1900, 0.75), filt('highpass', tight ? 420 : 300, 0.7)],
      0.55 * vel, 0.0008, wireDec, sum, N, 1);

    /* Snap: o estalo que faz a caixa "cortar" a mixagem. */
    var e2 = noiseHit(t0, noiseBuf, [filt('highpass', 6200, 0.9)],
      0.24 * vel, 0.0004, tight ? 0.020 : 0.028, sum, N, 1);
    if (e2 > end) { end = e2; }

    var out = gain(0.62);
    sum.connect(out); out.connect(dest);
    try { d1.start(t0); d1.stop(t0 + shellDec + 0.06); d2.start(t0); d2.stop(t0 + shellDec + 0.06); } catch (e) {}
    N.push(d1, d2, gd1, gd2, sum, out);
    retire(N, end + 0.15);
  }

  /* ---------------------- ARO / CROSS-STICK (rim) ---------------------- */
  /* Baqueta na borda: um passa-banda muito ressonante em 880 Hz sobre um
     estalo de 3 ms. Som seco, curtinho, otimo para marcar contratempo. */
  function playRim(ev, when) {
    if (!budgetOK(1)) { return; }
    var vel = clamp(ev.v == null ? 0.7 : ev.v, 0.03, 1.2);
    var N = [];
    var dest = targetFor('rim');
    var sum = gain(0.8);
    sum.connect(dest);
    var end = noiseHit(when, noiseBuf,
      [filt('bandpass', 880, 9.0), filt('highpass', 400, 0.7)],
      0.85 * vel, 0.0005, 0.045, sum, N, 1);
    var e2 = noiseHit(when, noiseBuf, [filt('bandpass', 2600, 3.0)],
      0.28 * vel, 0.0004, 0.018, sum, N, 1);
    N.push(sum);
    retire(N, Math.max(end, e2) + 0.1);
  }

  /* ------------------------------ CHIMBAL ------------------------------ */
  /* Ruido metalico (buffer inarmonico) por um passa-alta bem alto. O
     fechado morre em 45 ms; o aberto tem cauda de 350 ms com um leve
     fechamento do filtro, que e o prato "respirando". */
  function playHat(ev, when, open) {
    if (!budgetOK(open ? 2 : 1)) { return; }
    var vel = clamp(ev.v == null ? 0.7 : ev.v, 0.03, 1.2);
    var N = [];
    var dest = targetFor('hatC');
    var dec = open ? 0.34 : 0.045;
    var hp = filt('highpass', open ? 7200 : 8600, 0.7);
    var bp = filt('bandpass', open ? 9500 : 11200, 0.5);
    if (open) {
      hp.frequency.setValueAtTime(7200, when);
      hp.frequency.exponentialRampToValueAtTime(10500, when + dec);
    }
    var out = gain(0.62);
    out.connect(dest);
    var end = noiseHit(when, metalBuf, [hp, bp], 0.85 * vel, 0.0005, dec, out, N, 1.6 + (open ? 0.2 : 0));
    var e2 = noiseHit(when, noiseBuf, [filt('highpass', 9000, 0.7)], 0.30 * vel, 0.0004, dec * 0.55, out, N, 1);
    N.push(out);
    retire(N, Math.max(end, e2) + 0.1);
  }

  /* --------------------------- PRATO DE CONDUCAO ------------------------ */
  /* Duas partes: o "ping" (a baqueta batendo, curto e definido) e o
     "wash" (a cupula ressoando por mais de um segundo). */
  function playRide(ev, when) {
    if (!budgetOK(1)) { return; }
    var a = ev.a || {};
    var vel = clamp(ev.v == null ? 0.6 : ev.v, 0.03, 1.2);
    var N = [];
    var out = gain(0.5);
    out.connect(targetFor('ride'));
    var bell = a.bell ? 1 : 0;
    var end = noiseHit(when, metalBuf,
      [filt('bandpass', bell ? 2400 : 3700, 0.55), filt('highpass', 1400, 0.7)],
      0.40 * vel, 0.0008, bell ? 1.5 : 1.15, out, N, 1.1);
    var e2 = noiseHit(when, metalBuf,
      [filt('bandpass', bell ? 5400 : 6600, 2.2)],
      0.45 * vel, 0.0004, bell ? 0.35 : 0.10, out, N, 1.35);
    N.push(out);
    retire(N, Math.max(end, e2) + 0.2);
  }

  /* ------------------------------ PRATO CRASH --------------------------- */
  /* Ataque com 6 ms de subida (prato nao "estala", ele explode) e cauda de
     mais de 2 s com o agudo caindo antes do medio. */
  function playCrash(ev, when) {
    if (!budgetOK(2)) { return; }
    var vel = clamp(ev.v == null ? 0.9 : ev.v, 0.03, 1.3);
    var N = [];
    var out = gain(0.5);
    out.connect(targetFor('crash'));
    var hp = filt('highpass', 1500, 0.6);
    hp.frequency.setValueAtTime(1500, when);
    hp.frequency.exponentialRampToValueAtTime(3400, when + 1.8);
    var end = noiseHit(when, metalBuf, [hp, filt('lowpass', 13000, 0.5)],
      0.8 * vel, 0.006, 1.9, out, N, 0.85);
    var e2 = noiseHit(when, noiseBuf, [filt('highpass', 5200, 0.7)],
      0.34 * vel, 0.003, 0.85, out, N, 1);
    N.push(out);
    retire(N, Math.max(end, e2) + 0.3);
  }

  /* -------------------------------- TONS -------------------------------- */
  function playTom(ev, when) {
    if (!budgetOK(2)) { return; }
    var vel = clamp(ev.v == null ? 0.85 : ev.v, 0.03, 1.3);
    var f = ev.m ? midiToFreq(ev.m) : 150;
    var N = [];
    var out = gain(0.8);
    out.connect(targetFor('tom'));

    /* Membrana: modo fundamental + primeiro modo circular (1,59). */
    var o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.32, when);
    o.frequency.exponentialRampToValueAtTime(f, when + 0.07);
    var o2 = ctx.createOscillator(); o2.type = 'sine';
    o2.frequency.setValueAtTime(f * 1.59 * 1.25, when);
    o2.frequency.exponentialRampToValueAtTime(f * 1.59, when + 0.05);
    var g1 = gain(0), g2 = gain(0);
    o.connect(g1); g1.connect(out);
    o2.connect(g2); g2.connect(out);
    var end = perc(g1.gain, when, 0.75 * vel, 0.001, 0.34);
    perc(g2.gain, when, 0.22 * vel, 0.001, 0.16);
    /* Pele: 25 ms de ruido, o barulho da baqueta no couro. */
    noiseHit(when, pinkBuf, [filt('bandpass', f * 5, 0.9)], 0.22 * vel, 0.0008, 0.03, out, N, 1);
    try { o.start(when); o.stop(end + 0.05); o2.start(when); o2.stop(end + 0.05); } catch (e) {}
    N.push(o, o2, g1, g2, out);
    retire(N, end + 0.2);
  }

  /* ============================ PERCUSSAO BRASILEIRA ==================== */

  /* ------------------------------ CURIMBO ------------------------------- */
  /* O tambor de tronco escavado coberto de couro do carimbo paraense. E
     grande, grave e MUITO seco — o tocador senta em cima e abafa o casco
     com o corpo. Modelamos os primeiros modos circulares (1 / 1,59 / 2,14)
     com envelope de altura e uma boa dose de ruido de couro.
     Tres articulacoes: grave (mao aberta no centro), aberto (na borda) e
     tapa (mao rigida, quase so ruido). */
  function playCurimbo(ev, when) {
    if (!budgetOK(2)) { return; }
    var a = ev.a || {};
    var mode = a.mode || 'open';
    var vel = clamp(ev.v == null ? 0.85 : ev.v, 0.03, 1.3);
    var N = [];
    var out = gain(0.9);
    out.connect(targetFor('curimbo'));

    var f = (mode === 'bass') ? 78 : (mode === 'slap' ? 165 : 118);
    var dec = (mode === 'bass') ? 0.62 : (mode === 'slap' ? 0.13 : 0.36);
    var toneLvl = (mode === 'slap') ? 0.32 : 0.85;
    var skinLvl = (mode === 'slap') ? 0.7 : (mode === 'bass' ? 0.16 : 0.30);

    var ratios = [1, 1.593, 2.135];
    var amps = [toneLvl, toneLvl * 0.28, toneLvl * 0.12];
    var end = when;
    for (var i = 0; i < ratios.length; i++) {
      var o = ctx.createOscillator();
      o.type = i === 0 ? 'sine' : 'triangle';
      /* envelope de altura: a pele estica no impacto e relaxa */
      o.frequency.setValueAtTime(f * ratios[i] * 1.28, when);
      o.frequency.exponentialRampToValueAtTime(f * ratios[i], when + 0.045);
      var g = gain(0);
      o.connect(g); g.connect(out);
      var e = perc(g.gain, when, amps[i] * vel, 0.0012, dec / (1 + i * 0.9));
      if (e > end) { end = e; }
      try { o.start(when); o.stop(e + 0.03); } catch (er) {}
      N.push(o, g);
    }

    /* Couro: ruido rosa passa-banda. No tapa e a estrela do som. */
    var e3 = noiseHit(when, pinkBuf,
      [filt('bandpass', mode === 'slap' ? 1500 : 620, mode === 'slap' ? 0.9 : 1.3),
       filt('highpass', 180, 0.7)],
      skinLvl * vel, 0.0008, mode === 'slap' ? 0.075 : 0.035, out, N, 1);
    if (e3 > end) { end = e3; }

    N.push(out);
    retire(N, end + 0.2);
  }

  /* ------------------------------- SURDO -------------------------------- */
  /* O tambor grave que sustenta o samba. Bem mais longo que o curimbo e com
     a mao abafando na alternancia. */
  function playSurdo(ev, when) {
    if (!budgetOK(2)) { return; }
    var a = ev.a || {};
    var vel = clamp(ev.v == null ? 0.9 : ev.v, 0.03, 1.3);
    var muted = !!a.muted;
    var N = [];
    var out = gain(0.95);
    out.connect(targetFor('surdo'));
    var f = 68;
    var o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.5, when);
    o.frequency.exponentialRampToValueAtTime(f, when + 0.06);
    var g = gain(0);
    o.connect(g); g.connect(out);
    var end = perc(g.gain, when, 1.0 * vel, 0.0015, muted ? 0.14 : 0.78);
    var o2 = ctx.createOscillator(); o2.type = 'triangle';
    o2.frequency.value = f * 1.593;
    var g2 = gain(0);
    o2.connect(g2); g2.connect(out);
    perc(g2.gain, when, 0.16 * vel, 0.0015, muted ? 0.07 : 0.22);
    noiseHit(when, pinkBuf, [filt('bandpass', 420, 1.2)], 0.18 * vel, 0.001, 0.04, out, N, 1);
    try { o.start(when); o.stop(end + 0.05); o2.start(when); o2.stop(end + 0.05); } catch (e) {}
    N.push(o, g, o2, g2, out);
    retire(N, end + 0.25);
  }

  /* ------------------------- GANZA / CHOCALHO --------------------------- */
  /* Um tubo cheio de sementes. Espectro: banda estreita e alta (4-9 kHz),
     ataque instantaneo, decaimento de 25-50 ms. O que da vida e a variacao
     de acento em semicolcheia — o ganza NUNCA toca tudo igual. */
  function playGanza(ev, when) {
    if (!budgetOK(0)) { return; }
    var a = ev.a || {};
    var vel = clamp(ev.v == null ? 0.5 : ev.v, 0.03, 1.2);
    var N = [];
    var out = gain(0.72);   /* o ganza e o motor ritmico do genero: presente */
    out.connect(targetFor('ganza'));
    var dec = a.long ? 0.085 : (0.020 + vel * 0.028);
    var bp = filt('bandpass', 5600 + vel * 2200, 1.05);
    var hp = filt('highpass', 3000, 0.7);
    var end = noiseHit(when, pinkBuf, [hp, bp], 1.15 * vel, 0.0006, dec, out, N, 1.4);
    /* Corpo de madeira/lata: um toque de medio para nao ser so "chiado". */
    var e2 = noiseHit(when, pinkBuf, [filt('bandpass', 1500, 1.6)], 0.16 * vel, 0.0008, dec * 0.7, out, N, 1);
    N.push(out);
    retire(N, Math.max(end, e2) + 0.08);
  }

  /* --------------------------------- AGOGO ------------------------------ */
  /* Duas campanas de metal afinadas a uma terca. Parciais inarmonicos
     (1 / 2,41 / 3,95 / 5,12) + um click de baqueta. E o instrumento que
     mais "denuncia" que a musica e brasileira. */
  function playAgogo(ev, when) {
    if (!budgetOK(1)) { return; }
    var a = ev.a || {};
    var vel = clamp(ev.v == null ? 0.7 : ev.v, 0.03, 1.2);
    var N = [];
    var out = gain(0.42);
    var pn = panner(a.low ? -0.22 : 0.24);
    out.connect(pn); pn.connect(targetFor('agogo'));
    var base = a.low ? 645 : 810;
    var end = bellPartials(when, base, [1, 2.41, 3.95, 5.12],
      [0.65, 0.30, 0.16, 0.09], a.mute ? 0.10 : 0.42, vel, out, N);
    var e2 = noiseHit(when, noiseBuf, [filt('bandpass', base * 4, 2.5)],
      0.18 * vel, 0.0004, 0.010, out, N, 1);
    N.push(out, pn);
    retire(N, Math.max(end, e2) + 0.15);
  }

  /* ------------------------------- TRIANGULO ---------------------------- */
  /* Barra de aco dobrada: parciais muito altos e MUITO longos quando o
     triangulo esta solto, e quase nada quando a mao aperta. A alternancia
     solto/abafado e o que cria o desenho ritmico no forro. */
  function playTriangle(ev, when) {
    if (!budgetOK(0)) { return; }
    var a = ev.a || {};
    var vel = clamp(ev.v == null ? 0.55 : ev.v, 0.03, 1.2);
    var muted = !!a.mute;
    var N = [];
    var out = gain(0.30);
    out.connect(targetFor('triangle'));
    var end = bellPartials(when, 2050,
      [1, 1.72, 2.63, 3.41, 4.55, 5.89],
      [0.40, 0.34, 0.28, 0.22, 0.16, 0.11],
      muted ? 0.055 : 1.35, vel, out, N);
    var e2 = noiseHit(when, metalBuf, [filt('highpass', 6500, 0.7)],
      0.22 * vel, 0.0004, muted ? 0.02 : 0.14, out, N, 2.2);
    N.push(out);
    retire(N, Math.max(end, e2) + 0.2);
  }

  /* ------------------------------- RECO-RECO ---------------------------- */
  /* Raspador: uma vareta correndo sobre ranhuras. Nao e um golpe, e uma
     SERIE de micro-impactos. Modelamos com setValueCurveAtTime desenhando
     os "dentes" do raspador na amplitude, enquanto o passa-banda desce
     (a mao afasta do corpo do instrumento). */
  function playRecoReco(ev, when) {
    if (!budgetOK(0)) { return; }
    var a = ev.a || {};
    var vel = clamp(ev.v == null ? 0.6 : ev.v, 0.03, 1.2);
    var dur = clamp(a.dur || 0.15, 0.05, 0.6);
    var up = !!a.up;
    var N = [];
    var out = gain(0.78);
    out.connect(targetFor('recoreco'));

    var src = noiseSource(pinkBuf, 0, 1.25);
    var bp = filt('bandpass', 2000, 1.4);
    bp.frequency.setValueAtTime(up ? 1400 : 2600, when);
    bp.frequency.exponentialRampToValueAtTime(up ? 2900 : 1300, when + dur);
    var hp = filt('highpass', 700, 0.7);
    var g = gain(0);
    src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(out);

    /* Desenho dos dentes: 24 pontos, cada ranhura um pico. */
    var steps = 24;
    var curve = new Float32Array(steps);
    var teeth = up ? 9 : 11;
    for (var i = 0; i < steps; i++) {
      var u = i / (steps - 1);
      var tooth = 0.55 + 0.45 * Math.abs(Math.sin(u * Math.PI * teeth));
      var shape = Math.sin(Math.min(1, u * 1.6) * Math.PI * 0.5) * (1 - u * 0.55);
      curve[i] = 0.95 * vel * tooth * shape;
    }
    curve[steps - 1] = 0;
    try { g.gain.setValueCurveAtTime(curve, when, dur); }
    catch (e) { perc(g.gain, when, 0.8 * vel, 0.002, dur); }
    try { src.start(when, noiseOffset() * 2.0); src.stop(when + dur + 0.05); } catch (e) {}

    N.push(src, hp, bp, g, out);
    retire(N, when + dur + 0.15);
  }

  /* -------------------------------- PANDEIRO ---------------------------- */
  /* Pele + platinelas. Tres toques: grave (polegar no centro), tapa (dedos
     na borda) e chacoalhada (so as platinelas). As platinelas sao ruido
     bem agudo com dois decaimentos somados — um curto e um longo. */
  function playPandeiro(ev, when) {
    if (!budgetOK(1)) { return; }
    var a = ev.a || {};
    var mode = a.mode || 'tap';
    var vel = clamp(ev.v == null ? 0.6 : ev.v, 0.03, 1.2);
    var N = [];
    var out = gain(0.55);
    var pn = panner(a.pan == null ? 0.18 : a.pan);
    out.connect(pn); pn.connect(targetFor('pandeiro'));
    var end = when;

    if (mode !== 'shake') {
      /* Pele: um modo so, curto. Grave e mais baixo e mais longo. */
      var f = (mode === 'bass') ? 138 : (mode === 'slap' ? 290 : 205);
      var o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f * 1.35, when);
      o.frequency.exponentialRampToValueAtTime(f, when + 0.03);
      var g = gain(0);
      o.connect(g); g.connect(out);
      end = perc(g.gain, when, (mode === 'bass' ? 0.62 : 0.30) * vel, 0.001,
                 mode === 'bass' ? 0.20 : 0.075);
      try { o.start(when); o.stop(end + 0.03); } catch (e) {}
      N.push(o, g);
      var e1 = noiseHit(when, pinkBuf, [filt('bandpass', mode === 'slap' ? 2300 : 1100, 1.1)],
        (mode === 'slap' ? 0.55 : 0.25) * vel, 0.0006, mode === 'slap' ? 0.05 : 0.028, out, N, 1);
      if (e1 > end) { end = e1; }
    }

    /* Platinelas. */
    var jingLvl = (mode === 'bass') ? 0.18 : (mode === 'shake' ? 0.55 : 0.42);
    var jingDec = (mode === 'shake') ? 0.11 : 0.055;
    var e2 = noiseHit(when, metalBuf, [filt('highpass', 5200, 0.7), filt('bandpass', 8200, 0.7)],
      jingLvl * vel, 0.0006, jingDec, out, N, 1.9);
    var e3 = noiseHit(when, metalBuf, [filt('highpass', 7800, 0.7)],
      jingLvl * 0.45 * vel, 0.0008, jingDec * 2.6, out, N, 2.4);
    end = Math.max(end, e2, e3);

    N.push(out, pn);
    retire(N, end + 0.15);
  }

  /* -------------------------------- TAMBORIM ---------------------------- */
  /* Tamborzinho de 6 polegadas batido com baqueta de nylon. Agudo, seco e
     cortante — e ele que faz o "teleco-teco" do samba. */
  function playTamborim(ev, when) {
    if (!budgetOK(0)) { return; }
    var vel = clamp(ev.v == null ? 0.7 : ev.v, 0.03, 1.2);
    var N = [];
    var out = gain(0.5);
    var pn = panner(-0.3);
    out.connect(pn); pn.connect(targetFor('tamborim'));
    var o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(520, when);
    o.frequency.exponentialRampToValueAtTime(390, when + 0.03);
    var g = gain(0);
    o.connect(g); g.connect(out);
    var end = perc(g.gain, when, 0.34 * vel, 0.0008, 0.055);
    var e2 = noiseHit(when, noiseBuf, [filt('bandpass', 3200, 1.2), filt('highpass', 900, 0.7)],
      0.42 * vel, 0.0004, 0.030, out, N, 1);
    try { o.start(when); o.stop(end + 0.03); } catch (e) {}
    N.push(o, g, out, pn);
    retire(N, Math.max(end, e2) + 0.1);
  }

  /* ---------------------------- CAIXA DE FREVO -------------------------- */
  /* A caixa do frevo pernambucano: afinacao alta, esteira bem apertada e
     muita semicolcheia. Reaproveita playSnare com o flag "frevo". */
  function playCaixa(ev, when) {
    var e2 = { m: ev.m, v: ev.v, d: ev.d, a: { frevo: true } };
    playSnare(e2, when);
  }

  /* -------------------------------- ZABUMBA ----------------------------- */
  /* Bumbo do forro, tocado dos dois lados: a marreta bate o grave na pele
     da frente e a bacalhau (vareta fina) responde agudo atras. Sao dois
     timbres completamente diferentes no mesmo instrumento. */
  function playZabumba(ev, when) {
    if (!budgetOK(2)) { return; }
    var a = ev.a || {};
    var vel = clamp(ev.v == null ? 0.9 : ev.v, 0.03, 1.3);
    var N = [];
    var out = gain(0.9);
    out.connect(targetFor('zabumba'));

    if (a.stick) {
      /* Bacalhau: quase so ruido de vareta na pele fina. */
      var end = noiseHit(when, noiseBuf,
        [filt('bandpass', 2100, 1.1), filt('highpass', 800, 0.7)],
        0.55 * vel, 0.0004, 0.042, out, N, 1);
      var ot = ctx.createOscillator(); ot.type = 'triangle';
      ot.frequency.setValueAtTime(430, when);
      ot.frequency.exponentialRampToValueAtTime(330, when + 0.03);
      var gt = gain(0);
      ot.connect(gt); gt.connect(out);
      var e0 = perc(gt.gain, when, 0.20 * vel, 0.0008, 0.05);
      try { ot.start(when); ot.stop(e0 + 0.03); } catch (e) {}
      N.push(ot, gt, out);
      retire(N, Math.max(end, e0) + 0.1);
      return;
    }

    /* Marreta: grave curto e abafado (a pele e frouxa e a mao abafa). */
    var o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(128, when);
    o.frequency.exponentialRampToValueAtTime(52, when + 0.055);
    var g = gain(0);
    o.connect(g); g.connect(out);
    var e1 = perc(g.gain, when, 1.0 * vel, 0.0015, 0.24);
    noiseHit(when, pinkBuf, [filt('lowpass', 900, 0.8)], 0.20 * vel, 0.0008, 0.035, out, N, 1);
    try { o.start(when); o.stop(e1 + 0.05); } catch (e) {}
    N.push(o, g, out);
    retire(N, e1 + 0.2);
  }

  /* ------------------------- CLAVE / BLOCO DE MADEIRA ------------------- */
  function playClave(ev, when) {
    if (!budgetOK(0)) { return; }
    var vel = clamp(ev.v == null ? 0.6 : ev.v, 0.03, 1.2);
    var N = [];
    var out = gain(0.34);
    out.connect(targetFor('clave'));
    var end = bellPartials(when, 2450, [1, 2.9], [0.5, 0.16], 0.055, vel, out, N);
    var e2 = noiseHit(when, noiseBuf, [filt('bandpass', 2450, 6)], 0.3 * vel, 0.0004, 0.012, out, N, 1);
    N.push(out);
    retire(N, Math.max(end, e2) + 0.08);
  }

  /* Tabela de despacho: nome do instrumento -> funcao de voz. */
  var VOICES = {
    guitar:   playGuitar,
    bass:     playBass,
    organ:    playOrgan,
    brass:    playBrass,
    pluck:    playPluck,
    kick:     playKick,
    snare:    playSnare,
    rim:      playRim,
    hatC:     function (e, w) { playHat(e, w, false); },
    hatO:     function (e, w) { playHat(e, w, true); },
    ride:     playRide,
    crash:    playCrash,
    tom:      playTom,
    curimbo:  playCurimbo,
    surdo:    playSurdo,
    ganza:    playGanza,
    agogo:    playAgogo,
    triangle: playTriangle,
    recoreco: playRecoReco,
    pandeiro: playPandeiro,
    tamborim: playTamborim,
    caixa:    playCaixa,
    zabumba:  playZabumba,
    clave:    playClave
  };

  /* ======================================================================
   * 6. ARRANJADOR
   *
   * A partir de song.genre + song.bpm + song.sections + song.arrangement +
   * o chart 'guitarrada', monta uma lista de eventos com tempo absoluto.
   * Se o arranjo vier vazio (o agente de conteudo pode deixar enxuto), tudo
   * e gerado aqui de forma deterministica.
   * ==================================================================== */

  /* Padroes ritmicos escritos como texto de 16 semicolcheias por compasso.
     Ler o groove como desenho e MUITO mais legivel do que como array de
     numeros, e permite ver a levada de olho.
       X = acento   x = normal   o = fraco   g = fantasma   . = silencio
       B = grave    S/s = tapa   T/t = toque  H/h = campana aguda
       L/l = campana grave       - = aberto/solto   = = bem aberto
       m = abafado  r = rufo     b = campana do prato                    */
  var VEL_BY_CHAR = {
    'X': 1.00, 'x': 0.76, 'o': 0.46, 'g': 0.26,
    'B': 0.98, 'S': 1.00, 's': 0.72, 'T': 0.82, 't': 0.50,
    'H': 0.95, 'h': 0.68, 'L': 0.95, 'l': 0.68,
    '-': 0.86, '=': 1.00, 'm': 0.62, 'r': 0.48, 'R': 0.80, 'b': 0.90
  };

  function parsePat(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '.' || c === ' ' || c === '|') { continue; }
      var v = VEL_BY_CHAR[c];
      out.push({ s: i, c: c, v: (v == null ? 0.7 : v) });
    }
    return out;
  }

  /* Aceita string ou array de strings (ciclo de N compassos). */
  function normPat(p) {
    if (!p) { return null; }
    var arr = (typeof p === 'string') ? [p] : p;
    var out = [];
    for (var i = 0; i < arr.length; i++) { out.push(parsePat(arr[i])); }
    return out;
  }

  function patForBar(pat, barIdx) {
    if (!pat || !pat.length) { return null; }
    return pat[((barIdx % pat.length) + pat.length) % pat.length];
  }

  /* ---------------------------------------------------------------------
   * TABELA DE GENEROS. Cada entrada e uma "carteira de identidade" ritmica
   * e harmonica. E aqui que mora o brasileiro do projeto.
   * ------------------------------------------------------------------- */
  var GENRES = {

    /* ---- GUITARRADA -------------------------------------------------
       A levada paraense: bumbo sincopado de lambada/merengue, contratempo
       na caixa, ganza correndo em semicolcheia e o curimbo por baixo.
       Harmonia em menor com cadencia frigia (o V7 "espanhol"). */
    guitarrada: {
      key: 'A', scale: 'minor', chordBars: 1, micro4: [0, 0.030, 0.000, 0.018],
      swing: 0.07, swingUnit: 16,
      prog: [
        ['i', 'bVII', 'bVI', 'V7'],
        ['i', 'iv', 'bVII', 'bIII'],
        ['i', 'bVII', 'i', 'V7'],
        ['I7', 'bVII', 'IV', 'I7']
      ],
      drums: {
        kick:  ['X.....x.X.....x.', 'X.....x.X...x.x.'],
        snare: ['....X..g....X..g', '....X..g..g.X.gx'],
        hat:   ['X.x.x.x.X.x.x.x.', 'X.x.x.x.X.x.x-x.'],
        ride:  ['X.x.x.x.X.x.x.x.']
      },
      perc: [
        { i: 'ganza',    p: ['XoxoXoxoXoxoXoxo', 'XoxoXoxxXoxoXoxo'], min: 0.00 },
        { i: 'curimbo',  p: ['B..x.s..B..x.s..', 'B..x.s..B.sx.s.x'], min: 0.30 },
        { i: 'agogo',    p: ['..H...l.H...l...'], min: 0.50 },
        { i: 'triangle', p: ['-.x.-.x.-.x.-.x.'], min: 0.45 },
        { i: 'pandeiro', p: ['T.sTt.sTT.sTt.sT'], min: 0.78 },
        { i: 'recoreco', p: ['.......-........'], min: 0.65 }
      ],
      bass:  { p: ['X..x..x.X..x..x.', 'X..x..x.X..x.x.o'], style: 'walk' },
      keys:  { style: 'comp', p: ['..x...x...x...x.'], min: 0.40 },
      brass: { p: ['....X.......X...'], min: 0.82 },
      pluck: { p: ['..x.x...x.x...x.'], min: 0.58 }
    },

    /* ---- CARIMBO ----------------------------------------------------
       O tambor manda. Bateria discreta, curimbo em primeiro plano, agogo
       marcando e ganza sem parar. Harmonia simples e maior, de roda. */
    carimbo: {
      key: 'D', scale: 'major', chordBars: 1, micro4: [0, 0.040, -0.010, 0.030],
      swing: 0.12, swingUnit: 16,
      prog: [
        ['I', 'IV', 'V', 'I'],
        ['I', 'V', 'V', 'I'],
        ['I', 'vi', 'IV', 'V'],
        ['I', 'I', 'IV', 'V7']
      ],
      drums: {
        kick:  ['X.......X.......', 'X.......X.....x.'],
        snare: ['....o.......o...'],
        hat:   ['x.x.x.x.x.x.x.x.'],
        ride:  ['X.x.x.x.X.x.x.x.']
      },
      perc: [
        { i: 'curimbo',  p: ['B..S..x.B..S..x.', 'B..S..x.B.sS.sx.'], min: 0.00 },
        { i: 'ganza',    p: ['XoxoXoxoXoxoXoxo'], min: 0.00 },
        { i: 'agogo',    p: ['L...H.l.L...H...', 'L...H.l.L.H.l.h.'], min: 0.25 },
        { i: 'triangle', p: ['-.x.-.x.-.x.-.x.'], min: 0.40 },
        { i: 'recoreco', p: ['-.......-.......'], min: 0.55 },
        { i: 'pandeiro', p: ['T.tTs.tTT.tTs.tT'], min: 0.70 }
      ],
      bass:  { p: ['X.....x.X.....x.', 'X.....x.X...x...'], style: 'root5' },
      keys:  { style: 'comp', p: ['..x...x...x...x.'], min: 0.45 },
      brass: { p: ['............X...'], min: 0.85 },
      pluck: { p: ['..x...x...x...x.'], min: 0.50 }
    },

    /* ---- BREGA ------------------------------------------------------
       Romantico, mais lento, bateria de rock, orgao segurando o colchao e
       naipe de metais respondendo a melodia. Cadencia pop bem resolvida. */
    brega: {
      key: 'G', scale: 'major', chordBars: 1, micro4: [0, 0.045, 0.000, 0.028],
      swing: 0.14, swingUnit: 16,
      prog: [
        ['vi', 'IV', 'I', 'V'],
        ['I', 'vi', 'ii7', 'V7'],
        ['i', 'bVI', 'bIII', 'bVII'],
        ['IV', 'V', 'iii', 'vi']
      ],
      drums: {
        kick:  ['X.....x.X.......', 'X.....x.X.....x.'],
        snare: ['....X.......X...', '....X.......X..x'],
        hat:   ['x.x.x.x.x.x.x.x.', 'x.x.x.x.x.x.x-x.'],
        ride:  ['X.x.x.x.X.x.x.x.']
      },
      perc: [
        { i: 'ganza',    p: ['x.o.x.o.x.o.x.o.'], min: 0.35 },
        { i: 'agogo',    p: ['........H...l...'], min: 0.70 },
        { i: 'triangle', p: ['-...-...-...-...'], min: 0.55 },
        { i: 'surdo',    p: ['....X.......X...'], min: 0.60 }
      ],
      bass:  { p: ['X.....x.X.....x.', 'X.....x.X...x..o'], style: 'root5' },
      keys:  { style: 'pad', p: ['X...............'], min: 0.20 },
      brass: { p: ['........X..x....', '............X..x'], min: 0.62 },
      pluck: { p: ['X...x...X...x...'], min: 0.45 }
    },

    /* ---- LAMBADA ----------------------------------------------------
       Prima direta da guitarrada: mais rapida, mais dancante, com o
       contratempo bem marcado e a harmonia em menor harmonico. */
    lambada: {
      key: 'E', scale: 'minor', chordBars: 1, micro4: [0, 0.025, 0.000, 0.015],
      swing: 0.05, swingUnit: 16,
      prog: [
        ['i', 'V7', 'i', 'V7'],
        ['i', 'bVII', 'bVI', 'V7'],
        ['i', 'iv', 'V7', 'i'],
        ['bIII', 'bVII', 'iv', 'V7']
      ],
      drums: {
        kick:  ['X..x..X.X..x..X.', 'X..x..X.X..x.x..'],
        snare: ['....X..g....X..x'],
        hat:   ['X.x.x.x.X.x.x.x.', 'X.x.x-x.X.x.x-x.'],
        ride:  ['X.x.x.x.X.x.x.x.']
      },
      perc: [
        { i: 'ganza',    p: ['XoxxXoxoXoxxXoxo'], min: 0.00 },
        { i: 'curimbo',  p: ['B..x.s.xB..x.s..'], min: 0.35 },
        { i: 'agogo',    p: ['..H.l...H.l.h...'], min: 0.45 },
        { i: 'triangle', p: ['-.x.-.x.-.x.-.x.'], min: 0.40 },
        { i: 'pandeiro', p: ['T.sTt.sTT.sTt.sT'], min: 0.70 }
      ],
      bass:  { p: ['X..x..x.X..x..x.', 'X..x..x.X..x.x.x'], style: 'walk' },
      keys:  { style: 'comp', p: ['..x...x...x...x.'], min: 0.40 },
      brass: { p: ['....X.......X..x'], min: 0.78 },
      pluck: { p: ['..x.x...x.x...x.'], min: 0.55 }
    },

    /* ---- FORRO / BAIAO ----------------------------------------------
       A zabumba faz o desenho: marreta no 1 e no "e" do 2, bacalhau
       respondendo agudo. O triangulo alterna solto e abafado o tempo todo,
       e e ele que carrega o balanco. */
    forro: {
      key: 'D', scale: 'mixolydian', chordBars: 1, micro4: [0, 0.035, 0.005, 0.022],
      swing: 0.10, swingUnit: 16,
      prog: [
        ['I', 'I', 'V7', 'I'],
        ['I', 'bVII', 'IV', 'I'],
        ['i', 'bVII', 'bVI', 'V7'],
        ['I', 'IV', 'V7', 'I']
      ],
      drums: {
        kick:  ['X.....x.........'],
        snare: ['..............g.'],
        hat:   ['..x...x...x...x.'],
        ride:  ['X.x.x.x.X.x.x.x.']
      },
      perc: [
        /* Baiao classico: marreta no 1, bacalhau na 4a semicolcheia, marreta
           de novo na 6a e resposta do bacalhau logo em seguida. */
        { i: 'zabumba',  p: ['B..t.Bt.B..t.Bt.', 'B..t.Bt.B..t.BtT'], min: 0.00 },
        /* Triangulo alternando solto e abafado: e ele que carrega o balanco. */
        { i: 'triangle', p: ['=.x.-.x.=.x.-.x.'], min: 0.00 },
        { i: 'ganza',    p: ['x.o.x.o.x.o.x.o.'], min: 0.45 },
        { i: 'agogo',    p: ['....H...l...H...'], min: 0.75 },
        { i: 'caixa',    p: ['..g...g...g...g.'], min: 0.62 }
      ],
      bass:  { p: ['X.....x.X.....x.', 'X.....x.X...x.x.'], style: 'baiao' },
      keys:  { style: 'comp', p: ['X.....x.X.....x.'], min: 0.40 },
      brass: { p: ['....X...........'], min: 0.85 },
      pluck: { p: ['..x...x...x...x.'], min: 0.60 }
    },

    /* ---- SAMBA-ROCK -------------------------------------------------
       Surdo na segunda, caixa em semicolcheia, tamborim no teleco-teco e
       cavaquinho picotando os contratempos. Harmonia com setimas. */
    sambarock: {
      key: 'C', scale: 'major', chordBars: 1, micro4: [0, 0.060, 0.000, -0.025],
      swing: 0.16, swingUnit: 16,
      prog: [
        ['ii7', 'V7', 'Imaj7', 'VI7'],
        ['Imaj7', 'VI7', 'ii7', 'V7'],
        ['i7', 'IV7', 'bVII', 'bIII'],
        ['Imaj7', 'bIII', 'ii7', 'V7']
      ],
      drums: {
        kick:  ['X.......X.......', 'X.......X.....x.'],
        snare: ['..g.x.g...g.x.gx'],
        hat:   ['x.x.x.x.x.x.x.x.'],
        ride:  ['X.x.x.x.X.x.x.x.']
      },
      perc: [
        { i: 'surdo',    p: ['....X.......X...', '....X...m...X...'], min: 0.00 },
        { i: 'tamborim', p: ['..x.x..x..x.x..x'], min: 0.30 },
        { i: 'ganza',    p: ['XoxoXoxoXoxoXoxo'], min: 0.00 },
        { i: 'pandeiro', p: ['T.tSt.tTT.tSt.tT'], min: 0.45 },
        { i: 'agogo',    p: ['..H.h...L.l.h...'], min: 0.62 },
        { i: 'recoreco', p: ['-.......-.......'], min: 0.70 }
      ],
      bass:  { p: ['X.....x.X.....x.', 'X.....x.X..x..x.'], style: 'walk' },
      keys:  { style: 'comp', p: ['..x..x..x..x..x.'], min: 0.45 },
      brass: { p: ['..X.......x.....'], min: 0.75 },
      pluck: { p: ['..x.x..x..x.x..x'], min: 0.20 }
    },

    /* ---- FREVO ------------------------------------------------------
       Marcha rapida de Pernambuco. Caixa em semicolcheia continua, surdo
       marcando a marcha, metais gritando o tempo todo e a guitarra fazendo
       corridas cromaticas. Nada de swing: e reto e afobado. */
    frevo: {
      key: 'Bb', scale: 'major', chordBars: 1, micro4: [0, 0.010, 0.000, 0.008],
      swing: 0.0, swingUnit: 16,
      prog: [
        ['I', 'VI7', 'ii7', 'V7'],
        ['I', 'V7', 'I', 'V7'],
        ['I', 'IV', 'I', 'V7'],
        ['vi', 'II7', 'ii7', 'V7']
      ],
      drums: {
        kick:  ['X...x...X...x...', 'X...x...X...x.x.'],
        snare: ['xgxgxgxgxgxgxgxg', 'xgxgXgxgxgxgXgxx'],
        hat:   ['x.x.x.x.x.x.x.x.'],
        ride:  ['X.x.x.x.X.x.x.x.']
      },
      perc: [
        { i: 'caixa',    p: ['XgxgxgxgXgxgxgxg', 'XgxgxgxxXgxgXgxx'], min: 0.00 },
        { i: 'surdo',    p: ['X...m...X...m...'], min: 0.00 },
        { i: 'ganza',    p: ['XoxoXoxoXoxoXoxo'], min: 0.30 },
        { i: 'agogo',    p: ['H.l.H.l.H.l.H.l.'], min: 0.55 },
        { i: 'clave',    p: ['..x...x...x...x.'], min: 0.70 }
      ],
      bass:  { p: ['X...x...X...x...', 'X...x...X...x.x.'], style: 'marcha' },
      keys:  { style: 'comp', p: ['..x...x...x...x.'], min: 0.45 },
      brass: { p: ['X...x...X..x....', 'X...x...X.x.X...'], min: 0.30 },
      pluck: { p: ['..x...x...x...x.'], min: 0.65 }
    }
  };

  /* Aliases: a partir do que o agente de conteudo escrever em song.genre. */
  function genreKey(genreStr) {
    var s = slug(genreStr);
    if (!s) { return 'guitarrada'; }
    if (s.indexOf('guitarrada') >= 0) { return 'guitarrada'; }
    if (s.indexOf('carimb') >= 0 || s.indexOf('siria') >= 0) { return 'carimbo'; }
    if (s.indexOf('brega') >= 0 || s.indexOf('calypso') >= 0 ||
        s.indexOf('tecnobrega') >= 0 || s.indexOf('bolero') >= 0) { return 'brega'; }
    if (s.indexOf('lambada') >= 0 || s.indexOf('merengue') >= 0 ||
        s.indexOf('zouk') >= 0 || s.indexOf('cumbia') >= 0) { return 'lambada'; }
    if (s.indexOf('forro') >= 0 || s.indexOf('baiao') >= 0 ||
        s.indexOf('xote') >= 0 || s.indexOf('xaxado') >= 0 ||
        s.indexOf('arrasta') >= 0) { return 'forro'; }
    if (s.indexOf('samba') >= 0 || s.indexOf('partido') >= 0 ||
        s.indexOf('pagode') >= 0 || s.indexOf('bossa') >= 0) { return 'sambarock'; }
    if (s.indexOf('frevo') >= 0 || s.indexOf('marcha') >= 0 ||
        s.indexOf('maracatu') >= 0 || s.indexOf('caboclinho') >= 0) { return 'frevo'; }
    if (s.indexOf('rock') >= 0) { return 'sambarock'; }
    return 'guitarrada';
  }

  /* ---------------------------------------------------------------------
   * GRADE DE TEMPO. Traduz bpm/tempoMap em uma lista de compassos com
   * tempos absolutos. Tudo depois disso raciocina em "compasso + passo".
   * ------------------------------------------------------------------- */
  function bpmFromSong(song) {
    if (typeof song.bpm === 'number' && song.bpm > 20) { return song.bpm; }
    if (song.bpm && song.bpm.length) {
      var b0 = song.bpm[0];
      if (typeof b0 === 'number') { return b0; }
      if (b0 && typeof b0.bpm === 'number') { return b0.bpm; }
    }
    if (song.tempoMap && song.tempoMap.length && typeof song.tempoMap[0].bpm === 'number') {
      return song.tempoMap[0].bpm;
    }
    return 124;
  }

  function buildGrid(song) {
    var map = [];
    if (song.tempoMap && song.tempoMap.length) {
      for (var i = 0; i < song.tempoMap.length; i++) {
        var e = song.tempoMap[i];
        if (e && typeof e.bpm === 'number') { map.push({ t: e.t || 0, bpm: e.bpm }); }
      }
    }
    if (!map.length) { map.push({ t: 0, bpm: bpmFromSong(song) }); }
    map.sort(function (a, b) { return a.t - b.t; });

    var sig = song.timeSig && song.timeSig.length ? song.timeSig : [4, 4];
    var beatsPerBar = clamp(sig[0] || 4, 1, 12);
    var dur = song.durationSec || 120;

    var bars = [];
    var t = 0;
    var bi = 0;
    var mi = 0;
    while (t < dur + 8 && bars.length < 3000) {
      while (mi + 1 < map.length && map[mi + 1].t <= t + 1e-6) { mi++; }
      var bpm = clamp(map[mi].bpm, 30, 300);
      var spb = 60 / bpm;
      var len = spb * beatsPerBar;
      bars.push({ i: bi, t0: t, len: len, spb: spb, bpm: bpm, beats: beatsPerBar });
      t += len;
      bi++;
    }
    return {
      bars: bars,
      beatsPerBar: beatsPerBar,
      bpm0: map[0].bpm,
      map: map,
      /* posicao em batidas de um instante qualquer (para acentos) */
      beatAt: function (tt) {
        var b = this.barAt(tt);
        if (!b) { return 0; }
        return b.i * beatsPerBar + (tt - b.t0) / b.spb;
      },
      barAt: function (tt) {
        var lo = 0, hi = bars.length - 1;
        if (!bars.length || tt < bars[0].t0) { return bars[0] || null; }
        while (lo < hi) {
          var mid = (lo + hi + 1) >> 1;
          if (bars[mid].t0 <= tt) { lo = mid; } else { hi = mid - 1; }
        }
        return bars[lo];
      }
    };
  }

  /* Instante absoluto de um passo de semicolcheia, ja com swing e a
     microtemporizacao do genero. E aqui que a levada deixa de ser "quadrada
     de computador" e passa a ter balanco. */
  function stepTime(bar, step, cfg, humanize, rng) {
    var six = bar.len / 16;
    var t = bar.t0 + step * six;

    /* Swing: atrasa as semicolcheias impares (ou as colcheias fracas). */
    if (cfg.swing) {
      if (cfg.swingUnit === 8) {
        if (step % 4 === 2) { t += cfg.swing * six * 2; }
      } else if (step % 2 === 1) {
        t += cfg.swing * six;
      }
    }
    /* Microtemporizacao propria do genero, por posicao dentro da batida. */
    if (cfg.micro4) { t += (cfg.micro4[step % 4] || 0) * six; }
    /* Humanizacao deterministica: +/- alguns milissegundos. */
    var hs = (cfg.humanScale == null) ? 1 : cfg.humanScale;
    if (humanize && rng && hs > 0) { t += around(rng, humanize * hs); }
    return t;
  }

  /* ---------------------------------------------------------------------
   * SECOES. Usa song.sections; se nao houver, inventa uma forma coerente
   * (intro / verso / refrao / solo / refrao / final) sobre a duracao.
   * ------------------------------------------------------------------- */
  var INTENSITY_BY_NAME = {
    intro: 0.42, abertura: 0.42, entrada: 0.45,
    verso: 0.62, verse: 0.62, estrofe: 0.62, tema: 0.66,
    pre: 0.74, prerefrao: 0.74, prechorus: 0.74, subida: 0.78,
    refrao: 0.96, chorus: 0.96, estribilho: 0.96,
    solo: 1.00, guitarrada: 1.00, improviso: 1.00,
    ponte: 0.72, bridge: 0.72, interludio: 0.60,
    quebra: 0.40, breque: 0.35, break: 0.40, parada: 0.30,
    virada: 0.88, turnaround: 0.80,
    final: 0.78, outro: 0.66, coda: 0.70, fim: 0.60
  };

  function intensityForName(name, arr) {
    var s = slug(name);
    if (arr && arr.intensityByName) {
      for (var k in arr.intensityByName) {
        if (Object.prototype.hasOwnProperty.call(arr.intensityByName, k) && slug(k) === s) {
          return clamp(arr.intensityByName[k], 0, 1);
        }
      }
    }
    if (INTENSITY_BY_NAME[s] != null) { return INTENSITY_BY_NAME[s]; }
    /* casamento por prefixo, para "Refrao 2", "Solo de guitarra"... */
    for (var key in INTENSITY_BY_NAME) {
      if (Object.prototype.hasOwnProperty.call(INTENSITY_BY_NAME, key) &&
          s.indexOf(key) === 0) {
        return INTENSITY_BY_NAME[key];
      }
    }
    return 0.7;
  }

  function buildSections(song, arr, grid) {
    var dur = song.durationSec || 120;
    var raw = [];
    var i;
    if (arr && arr.sections && arr.sections.length) {
      for (i = 0; i < arr.sections.length; i++) {
        var a = arr.sections[i];
        raw.push({ t: a.t || 0, name: a.name || ('S' + i), src: a });
      }
    } else if (song.sections && song.sections.length) {
      for (i = 0; i < song.sections.length; i++) {
        var s = song.sections[i];
        raw.push({ t: s.t || 0, name: s.name || ('S' + i), src: s });
      }
    }

    if (!raw.length) {
      /* Forma padrao em blocos de 8 compassos: da uma narrativa a musica
         mesmo quando o conteudo nao definiu secoes. */
      var names = ['Intro', 'Verso', 'Refrao', 'Verso', 'Refrao', 'Solo', 'Refrao', 'Final'];
      var bars = grid.bars;
      var per = 8;
      var n = 0;
      for (i = 0; i < bars.length && bars[i].t0 < dur; i += per) {
        raw.push({ t: bars[i].t0, name: names[n % names.length], src: null });
        n++;
      }
      if (!raw.length) { raw.push({ t: 0, name: 'Tema', src: null }); }
    }

    raw.sort(function (x, y) { return x.t - y.t; });
    var out = [];
    for (i = 0; i < raw.length; i++) {
      var t0 = raw[i].t;
      var t1 = (i + 1 < raw.length) ? raw[i + 1].t : dur + 0.001;
      var src = raw[i].src || {};
      var inten = (typeof src.intensity === 'number')
        ? clamp(src.intensity, 0, 1)
        : intensityForName(raw[i].name, arr);
      out.push({
        i: i, t0: t0, t1: t1, name: raw[i].name, slug: slug(raw[i].name),
        intensity: inten, src: src
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------------
   * MAPA HARMONICO. Um "slot" por acorde, com escala associada. Todos os
   * instrumentos consultam este mapa — e o que garante que baixo, teclado
   * e guitarra estejam na MESMA musica.
   * ------------------------------------------------------------------- */
  function progressionFor(cfg, section, rng, arr) {
    /* 1) progressao explicita da secao */
    if (section.src && section.src.progression && section.src.progression.length) {
      return section.src.progression;
    }
    if (section.src && section.src.chords && section.src.chords.length) {
      return section.src.chords;
    }
    /* 2) progressao global do arranjo */
    if (arr && arr.progression && arr.progression.length) { return arr.progression; }
    if (arr && arr.chords && arr.chords.length && typeof arr.chords[0] === 'string') {
      return arr.chords;
    }
    /* 3) escolha deterministica no repertorio do genero. O refrao ganha a
       progressao 0 (a mais "forte"), o solo a 1, e o resto varia. */
    var list = cfg.prog;
    var s = section.slug;
    if (s.indexOf('refrao') === 0 || s.indexOf('chorus') === 0) { return list[0]; }
    if (s.indexOf('solo') === 0) { return list[Math.min(1, list.length - 1)]; }
    if (s.indexOf('intro') === 0) { return list[0]; }
    return list[Math.floor(rng() * list.length) % list.length];
  }

  function buildHarmony(song, arr, grid, sections, cfg, rng) {
    var keyPc = theory.parsePc(
      (arr && (arr.key || arr.tonic)) || song.key || cfg.key
    );
    var scaleName = (arr && arr.scale && SCALES[arr.scale]) ? arr.scale : cfg.scale;

    var slots = [];

    /* Caminho A: linha do tempo de acordes explicita, com tempos. */
    if (arr && arr.chordTimeline && arr.chordTimeline.length) {
      var ct = arr.chordTimeline.slice().sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
      for (var q = 0; q < ct.length; q++) {
        var chq = (typeof ct[q].name === 'string')
          ? theory.parseChord(ct[q].name)
          : theory.parseRoman(ct[q].roman || 'i', keyPc);
        var tq0 = ct[q].t || 0;
        var tq1 = (q + 1 < ct.length) ? (ct[q + 1].t || 0) : (song.durationSec || 120) + 0.001;
        slots.push(makeSlot(tq0, tq1, chq, keyPc, scaleName));
      }
      return { keyPc: keyPc, scaleName: scaleName, slots: slots };
    }

    /* Caminho B: progressao por secao, um acorde a cada chordBars compassos. */
    var chordBars = clamp((arr && arr.chordBars) || cfg.chordBars || 1, 1, 8);
    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      var prog = progressionFor(cfg, sec, rng, arr);
      var pi = 0;
      var bars = grid.bars;
      var b = 0;
      /* primeiro compasso da secao */
      while (b < bars.length && bars[b].t0 + 1e-4 < sec.t0) { b++; }
      while (b < bars.length && bars[b].t0 < sec.t1 - 1e-4) {
        var spec = prog[pi % prog.length];
        var ch = (typeof spec === 'string')
          ? (/^[A-Ga-g]/.test(spec) && !/^[iIvV]+$/.test(spec) && !/^[b#]?[iIvV]/.test(spec)
              ? theory.parseChord(spec)
              : theory.parseRoman(spec, keyPc))
          : (spec && spec.roman ? theory.parseRoman(spec.roman, keyPc)
              : (spec && spec.name ? theory.parseChord(spec.name)
                  : theory.parseRoman('i', keyPc)));
        var t0 = bars[b].t0;
        var nb = Math.min(b + chordBars, bars.length);
        var t1 = (nb < bars.length) ? bars[nb].t0 : t0 + bars[b].len * chordBars;
        if (t1 > sec.t1) { t1 = sec.t1; }
        slots.push(makeSlot(t0, t1, ch, keyPc, scaleName));
        b += chordBars;
        pi++;
      }
    }

    if (!slots.length) {
      slots.push(makeSlot(0, (song.durationSec || 120) + 0.001,
        theory.parseRoman('i', keyPc), keyPc, scaleName));
    }
    slots.sort(function (a, b2) { return a.t0 - b2.t0; });
    return { keyPc: keyPc, scaleName: scaleName, slots: slots };
  }

  function makeSlot(t0, t1, ch, keyPc, scaleName) {
    var sc = theory.scaleForChord(keyPc, scaleName, ch);
    return {
      t0: t0, t1: t1, ch: ch,
      pcs: theory.chordPcs(ch),
      rootPc: ch.rootPc,
      bassPc: (ch.bassPc == null ? ch.rootPc : ch.bassPc),
      scaleName: sc,
      /* Quando a escala continua sendo a da musica, a escada melodica nasce
         na TONICA (a melodia fica no tom). Quando o acorde PEDIU outra
         escala — o V7 puxando o frigio dominante, por exemplo — a escada
         passa a nascer na fundamental do acorde, que e onde aquela cor
         existe. Sem essa distincao, um iv em tom menor harmonico geraria
         notas fora do tom. */
      scaleRootPc: (sc === scaleName) ? keyPc : ch.rootPc,
      keyPc: keyPc
    };
  }

  function slotAt(harm, t) {
    var s = harm.slots;
    if (!s.length) { return null; }
    var lo = 0, hi = s.length - 1;
    if (t <= s[0].t0) { return s[0]; }
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (s[mid].t0 <= t) { lo = mid; } else { hi = mid - 1; }
    }
    return s[lo];
  }

  /* ---------------------------------------------------------------------
   * Tessituras. Cada instrumento tem a sua; e o que impede o baixo de
   * invadir o teclado e a guitarra de sumir embaixo dos metais.
   * ------------------------------------------------------------------- */
  var BASS_LO = 33, BASS_HI = 55;
  var KEYS_LO = 55, KEYS_HI = 79;
  var BRASS_LO = 62, BRASS_HI = 86;
  var PLUCK_LO = 52, PLUCK_HI = 76;
  var LEAD_LO = 55, LEAD_HI = 88, LEAD_CENTER = 71;

  function pushEv(events, t, inst, midi, vel, dur, art) {
    if (!(t >= 0) || !isFinite(t)) { return; }
    events.push({ t: t, i: inst, m: midi, v: vel, d: dur, a: art || null });
  }

  /* Traduz o caractere do padrao na articulacao de cada percussao. */
  function percArt(inst, c) {
    switch (inst) {
      case 'curimbo':
        if (c === 'B' || c === 'b') { return { mode: 'bass' }; }
        if (c === 'S' || c === 's') { return { mode: 'slap' }; }
        return { mode: 'open' };
      case 'pandeiro':
        if (c === 'B' || c === 'b') { return { mode: 'bass' }; }
        if (c === 'S' || c === 's') { return { mode: 'slap' }; }
        if (c === '-' || c === '=') { return { mode: 'shake' }; }
        return { mode: 'tap' };
      case 'agogo':
        if (c === 'L' || c === 'l') { return { low: true }; }
        if (c === 'm') { return { low: false, mute: true }; }
        return { low: false };
      case 'triangle':
        return { mute: !(c === '-' || c === '=') };
      case 'ganza':
        return (c === '-' || c === '=') ? { long: true } : {};
      case 'recoreco':
        return (c === '-') ? { up: true, dur: 0.19 } : { up: false, dur: 0.15 };
      case 'surdo':
        return (c === 'm') ? { muted: true } : {};
      case 'zabumba':
        return (c === 't' || c === 's' || c === 'x') ? { stick: true } : {};
      case 'ride':
        return (c === 'b') ? { bell: true } : {};
      default:
        return {};
    }
  }

  /* ---------------------------------------------------------------------
   * BATERIA. Segue o padrao do genero, escala a dinamica pela intensidade
   * da secao e troca chimbal por prato de conducao quando a musica abre.
   * ------------------------------------------------------------------- */
  function emitDrums(events, bar, cfg, inten, rng, isFill, secStart) {
    var d = cfg.drums;
    var bi = bar.i;
    var e, t, k;

    /* Prato de virada na entrada de secao forte: e o sinal sonoro de que
       algo mudou, e o jogador sente antes de ver. */
    if (secStart && inten >= 0.5) {
      pushEv(events, bar.t0 + around(rng, 0.006), 'crash', 0,
        clamp(0.55 + inten * 0.5, 0.4, 1.15), 0, null);
    }

    /* Bumbo. */
    var kickPat = patForBar(d.kickP, bi);
    if (kickPat) {
      for (k = 0; k < kickPat.length; k++) {
        e = kickPat[k];
        t = stepTime(bar, e.s, cfg, 0.006, rng);
        pushEv(events, t, 'kick', 0,
          clamp(e.v * (0.66 + inten * 0.42) + around(rng, 0.05), 0.12, 1.25), 0,
          (inten < 0.5 ? { deep: true } : null));
      }
    }

    /* Caixa — substituida pela virada no ultimo compasso de cada frase. */
    if (isFill && inten >= 0.45) {
      emitFill(events, bar, cfg, inten, rng);
    } else {
      var snPat = patForBar(d.snareP, bi);
      if (snPat) {
        for (k = 0; k < snPat.length; k++) {
          e = snPat[k];
          if (e.v < 0.35 && inten < 0.5) { continue; }   /* sem fantasmas no baixo volume */
          t = stepTime(bar, e.s, cfg, 0.007, rng);
          var isRim = (inten < 0.5 && e.v >= 0.9);
          pushEv(events, t, isRim ? 'rim' : 'snare', 0,
            clamp(e.v * (0.6 + inten * 0.5) + around(rng, 0.06), 0.08, 1.25), 0, null);
        }
      }
    }

    /* Chimbal ou conducao. */
    var useRide = inten >= 0.86;
    var hPat = patForBar(useRide ? d.rideP : d.hatP, bi);
    if (hPat && inten > 0.22) {
      for (k = 0; k < hPat.length; k++) {
        e = hPat[k];
        t = stepTime(bar, e.s, cfg, 0.005, rng);
        var inst = useRide ? 'ride' : (e.c === '-' ? 'hatO' : 'hatC');
        pushEv(events, t, inst, 0,
          clamp(e.v * (0.34 + inten * 0.42) + around(rng, 0.06), 0.06, 1.0), 0,
          percArt(inst, e.c));
      }
    }
  }

  /* Viradas: corrida de tons descendo, com a densidade crescendo. Uma
     virada bem colocada e o que separa "loop" de "musica tocada". */
  function emitFill(events, bar, cfg, inten, rng) {
    var shape = Math.floor(rng() * 4);
    var six = bar.len / 16;
    var k, t, i;
    /* Primeira metade mantem a levada, para a virada ter contraste. */
    pushEv(events, bar.t0, 'snare', 0, clamp(0.5 + inten * 0.4, 0.2, 1.1), 0, null);

    if (shape === 0) {
      /* Quatro tons descendo na ultima batida. */
      var toms = [196, 165, 139, 116];
      for (i = 0; i < 4; i++) {
        t = bar.t0 + (12 + i) * six + around(rng, 0.004);
        pushEv(events, t, 'tom', freqToMidi(toms[i]),
          clamp(0.7 + i * 0.08 + inten * 0.2, 0.3, 1.2), 0, null);
      }
    } else if (shape === 1) {
      /* Semicolcheias de caixa acelerando nos dois ultimos tempos. */
      for (i = 8; i < 16; i++) {
        t = stepTime(bar, i, cfg, 0.004, rng);
        pushEv(events, t, 'snare', 0,
          clamp(0.30 + (i - 8) * 0.09 + inten * 0.2, 0.15, 1.2), 0, null);
      }
    } else if (shape === 2) {
      /* Tresquinas de tom + caixa: a virada "brasileira", mais melodica. */
      var seq = [[8, 'snare', 175], [10, 'tom', 175], [11, 'tom', 147],
                 [12, 'snare', 0], [13, 'tom', 131], [14, 'tom', 117], [15, 'snare', 0]];
      for (i = 0; i < seq.length; i++) {
        t = stepTime(bar, seq[i][0], cfg, 0.005, rng);
        pushEv(events, t, seq[i][1], seq[i][2] ? freqToMidi(seq[i][2]) : 0,
          clamp(0.62 + inten * 0.35 + around(rng, 0.08), 0.2, 1.2), 0, null);
      }
    } else {
      /* Rufo crescente: 12 golpes fracos virando um acento. */
      for (i = 0; i < 12; i++) {
        t = bar.t0 + (10 + i * 0.5) * six;
        if (t >= bar.t0 + bar.len) { break; }
        pushEv(events, t, 'snare', 0,
          clamp(0.16 + i * 0.062 + inten * 0.15, 0.08, 1.2), 0, null);
      }
    }
    /* O bumbo acompanha o fim da virada. */
    pushEv(events, bar.t0 + 8 * six, 'kick', 0, clamp(0.6 + inten * 0.3, 0.2, 1.1), 0, null);
  }

  /* ---------------------------------------------------------------------
   * PERCUSSAO. Cada peca entra so acima de um limiar de intensidade, o que
   * cria uma progressao natural: intro so com ganza, refrao com tudo.
   * ------------------------------------------------------------------- */
  function emitPerc(events, bar, cfg, inten, rng) {
    var list = cfg.percP;
    if (!list) { return; }
    for (var p = 0; p < list.length; p++) {
      var entry = list[p];
      if (inten < entry.min) { continue; }
      var pat = patForBar(entry.pat, bar.i);
      if (!pat) { continue; }
      var inst = entry.i;
      /* Ganza e triangulo tem humanizacao maior: sao tocados a mao solta. */
      var hum = (inst === 'ganza' || inst === 'triangle' || inst === 'pandeiro') ? 0.010 : 0.007;
      for (var k = 0; k < pat.length; k++) {
        var e = pat[k];
        var t = stepTime(bar, e.s, cfg, hum, rng);
        var v = e.v * (0.42 + inten * 0.46) + around(rng, 0.075);
        /* Chocalho e pandeiro vivem da variacao de acento: sem isso viram
           metronomo. */
        if (inst === 'ganza' || inst === 'pandeiro') { v *= (0.82 + bell(rng) * 0.36); }
        pushEv(events, t, inst, 0, clamp(v, 0.06, 1.2), 0, percArt(inst, e.c));
      }
    }
  }

  /* ---------------------------------------------------------------------
   * BAIXO. Nao toca "a fundamental e pronto": escolhe tercas, quintas e
   * setimas conforme a posicao no compasso e prepara a proxima harmonia com
   * nota de aproximacao. E o que faz a linha ANDAR.
   * ------------------------------------------------------------------- */
  function bassPcFor(step, isLast, slot, nextSlot, style, rng, state) {
    var pcs = slot.pcs;
    var root = slot.bassPc;
    var fifth = (pcs.length > 2) ? pcs[2] : ((root + 7) % 12);
    var third = (pcs.length > 1) ? pcs[1] : ((root + 4) % 12);
    var sev = (pcs.length > 3) ? pcs[3] : null;

    /* Nota de aproximacao: cromatica ou pela quinta, um passo antes da
       mudanca de acorde. E o truque mais barato e mais eficaz de baixo. */
    if (isLast && nextSlot && nextSlot.rootPc !== root) {
      var r = rng();
      if (r < 0.45) { return (nextSlot.bassPc + 11) % 12; }   /* cromatica de baixo */
      if (r < 0.65) { return (nextSlot.bassPc + 1) % 12; }    /* cromatica de cima */
      if (r < 0.85) { return fifth; }
      return root;
    }

    if (style === 'root5') {
      if (step % 8 === 0) { return root; }
      return (rng() < 0.72) ? fifth : root;
    }
    if (style === 'baiao') {
      /* Baiao anda entre fundamental, quinta e oitava, quase sem terca. */
      if (step === 0) { return root; }
      if (step === 6 || step === 8) { return (rng() < 0.62) ? fifth : root; }
      return (rng() < 0.5) ? root : fifth;
    }
    if (style === 'marcha') {
      /* Frevo: alternancia dura fundamental/quinta, sem firula. */
      return (step % 8 === 0) ? root : fifth;
    }
    /* walk: caminha pelo acorde com um pouco de terca e setima. */
    if (step === 0) { return root; }
    var q = rng();
    if (q < 0.34) { return fifth; }
    if (q < 0.52) { return root; }
    if (q < 0.72) { return third; }
    if (q < 0.85 && sev != null) { return sev; }
    return (root + 12) % 12;
  }

  function emitBass(events, bar, cfg, inten, rng, harm, state) {
    var pat = patForBar(cfg.bassP, bar.i);
    if (!pat || inten < 0.18) { return; }
    var six = bar.len / 16;
    for (var k = 0; k < pat.length; k++) {
      var e = pat[k];
      var t = stepTime(bar, e.s, cfg, 0.008, rng);
      var slot = slotAt(harm, t);
      if (!slot) { continue; }
      var nextSlot = slotAt(harm, t + six * 2.5);
      var isLast = (k === pat.length - 1);
      var pc = bassPcFor(e.s, isLast, slot, nextSlot, cfg.bass.style, rng, state);

      /* Registro: a fundamental do compasso ancora grave; o resto conduz a
         partir da nota anterior, sem saltos maiores que uma quinta. */
      var midi;
      if (e.s === 0) {
        midi = theory.nearestPcMidi(pc, BASS_LO + 6, BASS_LO, BASS_LO + 12);
      } else {
        midi = theory.nearestPcMidi(pc, state.prev == null ? BASS_LO + 7 : state.prev, BASS_LO, BASS_HI);
        if (state.prev != null && Math.abs(midi - state.prev) > 8) {
          var alt = midi > state.prev ? midi - 12 : midi + 12;
          if (alt >= BASS_LO && alt <= BASS_HI) { midi = alt; }
        }
      }

      /* Duracao: ate o proximo evento, um pouco articulada (staccato leve). */
      var nextStep = (k + 1 < pat.length) ? pat[k + 1].s : 16;
      var dur = clamp((nextStep - e.s) * six * 0.82, 0.07, 1.2);

      var art = null;
      /* Slide ocasional entre notas distantes: o dedo arrastando no braco. */
      if (state.prev != null && Math.abs(midi - state.prev) >= 5 && rng() < 0.13) {
        art = { slideFrom: state.prev };
      }
      pushEv(events, t, 'bass', midi,
        clamp(e.v * (0.5 + inten * 0.45) + around(rng, 0.055), 0.1, 1.15), dur, art);
      state.prev = midi;
    }
  }

  /* ---------------------------------------------------------------------
   * TECLADO / ORGAO. Dois modos: colchao (pad) sustentado por acorde, ou
   * comping em contratempo. Conducao de vozes ativa nos dois.
   * ------------------------------------------------------------------- */
  function emitKeys(events, bar, cfg, inten, rng, harm, state) {
    var kcfg = cfg.keys;
    if (!kcfg || inten < (kcfg.min || 0.35)) { return; }
    var six = bar.len / 16;

    if (kcfg.style === 'pad') {
      /* Um acorde por slot harmonico, tocado no comeco do slot. Segurar o
         acorde inteiro e o que da o "colchao" do brega. */
      var slot = slotAt(harm, bar.t0 + 0.001);
      if (!slot) { return; }
      if (state.lastSlotT === slot.t0) { return; }
      state.lastSlotT = slot.t0;
      var voic = theory.voiceChord(slot.pcs, state.prevVoicing, KEYS_LO, KEYS_HI);
      state.prevVoicing = voic;
      var dur = clamp(slot.t1 - slot.t0 - 0.03, 0.2, 8);
      for (var i = 0; i < voic.length; i++) {
        pushEv(events, slot.t0 + around(rng, 0.008) + i * 0.006, 'organ', voic[i],
          clamp((0.34 + inten * 0.4) * (i === 0 ? 1 : 0.85), 0.08, 1.0), dur, null);
      }
      return;
    }

    var pat = patForBar(cfg.keysP, bar.i);
    if (!pat) { return; }
    for (var k = 0; k < pat.length; k++) {
      var e = pat[k];
      var t = stepTime(bar, e.s, cfg, 0.007, rng);
      var s2 = slotAt(harm, t);
      if (!s2) { continue; }
      var v2 = theory.voiceChord(s2.pcs.slice(0, 4), state.prevVoicing, KEYS_LO, KEYS_HI);
      state.prevVoicing = v2;
      var nextStep = (k + 1 < pat.length) ? pat[k + 1].s : 16;
      var d2 = clamp((nextStep - e.s) * six * 0.65, 0.07, 0.6);
      for (var j = 0; j < v2.length; j++) {
        pushEv(events, t + j * 0.004, 'organ', v2[j],
          clamp(e.v * (0.34 + inten * 0.38) + around(rng, 0.05), 0.07, 1.0), d2, null);
      }
    }
  }

  /* ---------------------------------------------------------------------
   * NAIPE DE METAIS. Sopros curtos e afirmativos em cima da harmonia. No
   * frevo entram sempre; no brega e guitarrada so nos pontos altos.
   * ------------------------------------------------------------------- */
  function emitBrass(events, bar, cfg, inten, rng, harm, state) {
    var bcfg = cfg.brass;
    if (!bcfg || inten < (bcfg.min || 0.7)) { return; }
    var pat = patForBar(cfg.brassP, bar.i);
    if (!pat) { return; }
    var six = bar.len / 16;
    for (var k = 0; k < pat.length; k++) {
      var e = pat[k];
      var t = stepTime(bar, e.s, cfg, 0.009, rng);
      var slot = slotAt(harm, t);
      if (!slot) { continue; }
      /* Voicing de tres vozes: fundamental, terca e quinta, fechado, no
         registro de trompete/trombone. */
      var pcs = slot.pcs.slice(0, 3);
      var voic = theory.voiceChord(pcs, state.prevVoicing, BRASS_LO, BRASS_HI);
      state.prevVoicing = voic;
      var nextStep = (k + 1 < pat.length) ? pat[k + 1].s : 16;
      var dur = clamp((nextStep - e.s) * six * 0.72, 0.10, 0.9);
      var fall = (k === pat.length - 1) && (rng() < 0.28) && dur > 0.2;
      for (var j = 0; j < voic.length; j++) {
        pushEv(events, t + j * 0.005, 'brass', voic[j],
          clamp(e.v * (0.42 + inten * 0.45) + around(rng, 0.06), 0.1, 1.15),
          dur, fall ? { fall: true } : null);
      }
    }
  }

  /* ---------------------------------------------------------------------
   * CAVAQUINHO / VIOLAO. Rasqueado de verdade: as cordas nao soam juntas,
   * soam com 13-18 ms entre elas, e a direcao alterna. Sem esse atraso o
   * acorde soa a orgao, nao a corda dedilhada.
   * ------------------------------------------------------------------- */
  function emitPluck(events, bar, cfg, inten, rng, harm, state) {
    var pcfg = cfg.pluck;
    if (!pcfg || inten < (pcfg.min || 0.5)) { return; }
    var pat = patForBar(cfg.pluckP, bar.i);
    if (!pat) { return; }
    var six = bar.len / 16;
    for (var k = 0; k < pat.length; k++) {
      var e = pat[k];
      var t = stepTime(bar, e.s, cfg, 0.008, rng);
      var slot = slotAt(harm, t);
      if (!slot) { continue; }
      var voic = theory.voiceChord(slot.pcs.slice(0, 4), state.prevVoicing, PLUCK_LO, PLUCK_HI);
      state.prevVoicing = voic;
      var down = (k % 2 === 0);
      var spread = 0.013 + rng() * 0.005;
      var nextStep = (k + 1 < pat.length) ? pat[k + 1].s : 16;
      var dur = clamp((nextStep - e.s) * six * 0.9, 0.08, 0.7);
      var muted = (e.v < 0.5);
      for (var j = 0; j < voic.length; j++) {
        var idx = down ? j : (voic.length - 1 - j);
        pushEv(events, t + j * spread, 'pluck', voic[idx],
          clamp(e.v * (0.36 + inten * 0.4) * (1 - j * 0.07) + around(rng, 0.05), 0.07, 1.0),
          dur, { mute: muted, pan: (idx - voic.length * 0.5) * 0.07 });
      }
    }
  }

  /* ======================================================================
   * A GUITARRA — mapeamento chart -> notas reais
   *
   * Regra de ouro: a guitarra toca EXATAMENTE as notas do chart
   * 'guitarrada'. A raia nao vira uma altura fixa (isso soaria a
   * xilofone); a raia vira MOVIMENTO. Subir uma raia sobe um grau da
   * escala. Assim o desenho que o jogador ve na pista e o desenho que ele
   * ouve, e mutar no erro faz sentido musical.
   *
   * Em tempo forte ou depois de uma pausa, a nota e puxada para a nota de
   * acorde mais proxima — e isso que impede a melodia de sair do tom.
   * ==================================================================== */
  function pickChart(song) {
    var c = song.charts || {};
    return c.guitarrada || c.dificil || c.expert || c.medio || c.facil ||
           (Array.isArray(song.chart) ? song.chart : null) || null;
  }

  function chordToneIndices(ladder, slot) {
    var idx = [];
    for (var i = 0; i < ladder.length; i++) {
      var pc = ((ladder[i] % 12) + 12) % 12;
      for (var j = 0; j < slot.pcs.length; j++) {
        if (slot.pcs[j] === pc) { idx.push(i); break; }
      }
    }
    return idx;
  }

  function nearestFrom(list, v) {
    if (!list.length) { return v; }
    var best = list[0], bd = Math.abs(list[0] - v);
    for (var i = 1; i < list.length; i++) {
      var d = Math.abs(list[i] - v);
      if (d < bd) { bd = d; best = list[i]; }
    }
    return best;
  }

  /* ---------------------------------------------------------------------
   * CAMINHO PREFERENCIAL: o arranjo ja traz a linha de lead pronta.
   *
   * O agente de conteudo pode entregar `arrangement.lead.events` com as
   * alturas EXATAS que ele compos, nos mesmos tempos do chart 'guitarrada'.
   * Quando isso existe, e ele quem manda: ele conhece a propria harmonia e
   * escreveu a melodia de proposito. Nosso trabalho aqui vira o de
   * instrumentista — colocar palhetada, vibrato, bend, slide e ligado por
   * cima das notas que ja vieram escritas.
   *
   * Formato consumido: { t, dur, midi, midis[], vel, artic }, com artic em
   * 'pick' | 'accent' | 'tap' | 'open'.
   * ------------------------------------------------------------------- */
  function buildGuitarFromLead(arr, cfg, grid, harm, sections, rng, events) {
    var lead = arr && arr.lead && arr.lead.events;
    if (!lead || !lead.length) { return false; }

    var prevMidi = -1;
    var prevT = -99;
    var used = 0;

    for (var i = 0; i < lead.length; i++) {
      var e = lead[i];
      var t = e.t;
      if (typeof t !== 'number' || !isFinite(t) || t < 0) { continue; }

      var midis = (e.midis && e.midis.length) ? e.midis.slice() : [e.midi];
      if (typeof midis[0] !== 'number' || !isFinite(midis[0])) { continue; }
      midis.sort(function (a, b) { return a - b; });

      var nextT = (i + 1 < lead.length && typeof lead[i + 1].t === 'number')
        ? lead[i + 1].t : t + 0.6;
      var hold = (typeof e.dur === 'number' && e.dur > 0.02)
        ? e.dur : clamp(Math.max(0.05, nextT - t) * 1.1, 0.11, 0.55);

      var artic = e.artic || 'pick';
      var open = (artic === 'open');
      var tap = (artic === 'tap');
      var vel = clamp((e.vel == null ? 0.8 : e.vel) * (artic === 'accent' ? 1.14 : 1),
                      0.35, 1.15);

      var rest = t - prevT;
      var art = {};

      /* Ligado: tap/hopo logo depois de outra nota nao releva palhetada. */
      if (tap && prevMidi >= 0 && rest < 0.42) {
        art.hopo = true;
        art.legatoFrom = prevMidi;
      } else if (!open && prevMidi >= 0 && rest < 0.30 &&
                 Math.abs(midis[0] - prevMidi) >= 4 && rng() < 0.20) {
        /* Slide: o dedo arrasta ate a nota nos saltos ligados. */
        art.slideFrom = prevMidi;
        art.slideTime = clamp(rest * 0.5, 0.03, 0.12);
      }

      /* Bend nas notas seguradas — a assinatura do fraseado paraense. */
      if (!open && hold >= 0.34 && rng() < 0.42) {
        art.bend = (rng() < 0.68) ? 200 : 100;
        art.bendFrom = 0;
        art.bendDelay = clamp(hold * 0.18, 0.03, 0.2);
        art.bendTime = clamp(hold * 0.3, 0.06, 0.25);
        art.bendRelease = (rng() < 0.4);
      }
      art.vib = hold > 0.22;
      art.vibDelay = clamp(hold * 0.3, 0.10, 0.4);
      art.vibDepth = 20 + Math.floor(rng() * 16);

      pushEv(events, t, 'guitar', midis[0], vel, hold, art);
      used++;

      /* Vozes de cima do voicing entram um fio depois: e um rasqueado, nao
         um acorde de teclado. */
      for (var j = 1; j < midis.length && j < 4; j++) {
        pushEv(events, t + j * 0.004, 'guitar', midis[j],
          clamp(vel * (0.84 - (j - 1) * 0.08), 0.2, 1.1), hold,
          { vib: art.vib, vibDelay: art.vibDelay, vibDepth: art.vibDepth });
      }

      /* Nota aberta ganha a quinta por baixo: peso de acorde de potencia
         atravessando a pista inteira. */
      if (open) {
        pushEv(events, t + 0.008, 'guitar', midis[0] + 7,
          clamp(vel * 0.8, 0.2, 1.1), Math.max(hold, 0.28), { vib: false });
      }

      prevMidi = midis[midis.length - 1];
      prevT = t;
    }
    return used > 0;
  }

  function buildGuitarPart(song, cfg, grid, harm, sections, rng, events) {
    var chart = pickChart(song);
    if (!chart || !chart.length) { return false; }

    /* Agrupa notas simultaneas (acordes). */
    var groups = [];
    var i, n;
    var sorted = chart.slice().sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
    for (i = 0; i < sorted.length; i++) {
      var nt = sorted[i];
      var t = nt.t || 0;
      var g = groups.length ? groups[groups.length - 1] : null;
      if (g && Math.abs(t - g.t) < 0.014) {
        g.notes.push(nt);
        if (nt.open) { g.open = true; }
        if (nt.dur > g.dur) { g.dur = nt.dur || 0; }
        if (nt.hopo) { g.hopo = true; }
        if (nt.tap) { g.tap = true; }
      } else {
        groups.push({
          t: t, notes: [nt], open: !!nt.open, dur: nt.dur || 0,
          hopo: !!nt.hopo, tap: !!nt.tap
        });
      }
    }

    var ladderCache = {};
    var chordIdxCache = {};
    var cursor = -1;
    var prevLane = -1;
    var prevMidi = -1;
    var prevT = -99;
    var repeatCount = 0;
    var secIdx = 0;

    for (i = 0; i < groups.length; i++) {
      var grp = groups[i];
      var gt = grp.t;
      var slot = slotAt(harm, gt);
      if (!slot) { continue; }

      while (secIdx + 1 < sections.length && sections[secIdx + 1].t0 <= gt) { secIdx++; }
      var sec = sections[secIdx] || { intensity: 0.8 };

      var lkey = slot.scaleRootPc + '|' + slot.scaleName;
      var ladder = ladderCache[lkey];
      if (!ladder) {
        ladder = theory.scaleLadder(slot.scaleRootPc, slot.scaleName, LEAD_LO, LEAD_HI);
        ladderCache[lkey] = ladder;
      }
      var ckey = lkey + '|' + slot.rootPc + slot.ch.quality;
      var cIdx = chordIdxCache[ckey];
      if (!cIdx) { cIdx = chordToneIndices(ladder, slot); chordIdxCache[ckey] = cIdx; }
      if (!ladder.length) { continue; }
      var scaleLen = (SCALES[slot.scaleName] || SCALES.minor).length;

      /* Espaco desde a nota anterior e forca metrica: as duas variaveis que
         decidem se a nota "pousa" num acorde ou continua a corrida. */
      var rest = gt - prevT;
      var beatPos = grid.beatAt(gt);
      var strong = Math.abs(beatPos - Math.round(beatPos)) < 0.08 &&
                   (Math.round(beatPos) % 2 === 0);

      /* Duracao audivel: sustains do chart mandam; notas simples soam ate
         um pouco antes da proxima. */
      var nextT = (i + 1 < groups.length) ? groups[i + 1].t : gt + 0.6;
      var gap = Math.max(0.05, nextT - gt);
      var hold = (grp.dur && grp.dur > 0.02)
        ? grp.dur
        : clamp(gap * 1.12, 0.11, 0.55);

      var vel = clamp(
        0.70 + (strong ? 0.16 : 0) + (grp.notes.length > 1 ? 0.06 : 0) +
        (sec.intensity - 0.7) * 0.22 + around(rng, 0.055),
        0.42, 1.12
      );

      /* ---- NOTA ABERTA: acorde de potencia grave atravessando a pista ---- */
      if (grp.open) {
        var rootLow = theory.nearestPcMidi(slot.rootPc, 45, 38, 54);
        pushEv(events, gt, 'guitar', rootLow, clamp(vel * 1.06, 0.4, 1.2), Math.max(hold, 0.28),
          { vib: hold > 0.5, vibDelay: 0.24 });
        pushEv(events, gt + 0.008, 'guitar', rootLow + 7, clamp(vel * 0.82, 0.3, 1.1),
          Math.max(hold, 0.28), { vib: false });
        prevMidi = rootLow;
        prevLane = -1;
        prevT = gt;
        cursor = theory.nearestIndex(ladder, rootLow + 12);
        repeatCount = 0;
        continue;
      }

      /* ---- posicao inicial na escada ---- */
      var lanes = [];
      for (n = 0; n < grp.notes.length; n++) {
        var ln = grp.notes[n].lane;
        if (typeof ln === 'number') { lanes.push(clamp(ln | 0, 0, 4)); }
      }
      if (!lanes.length) { lanes.push(2); }
      lanes.sort(function (a, b) { return a - b; });

      if (cursor < 0) {
        cursor = theory.nearestIndex(ladder, LEAD_CENTER);
        cursor = nearestFrom(cIdx, cursor);
      }

      /* ---- movimento melodico: delta de raia = delta de grau ---- */
      var lane0 = lanes[0];
      var stepDelta = (prevLane < 0) ? 0 : (lane0 - prevLane);
      var idx = cursor + stepDelta;

      /* Repeticao demais cansa: depois de tres notas iguais, borda a
         melodia um grau acima ou abaixo. */
      if (stepDelta === 0) {
        repeatCount++;
        if (repeatCount >= 2 && rng() < 0.55) {
          idx += (rng() < 0.5 ? 1 : -1);
          repeatCount = 0;
        }
      } else {
        repeatCount = 0;
      }

      /* Ancoragem harmonica: em tempo forte ou apos pausa, cai em nota do
         acorde. E o que faz a melodia soar composta e nao vagando. */
      if (rest > 0.28 || strong || i === 0) {
        idx = nearestFrom(cIdx, idx);
      }

      /* Mantem a melodia dentro da tessitura, corrigindo por oitava. */
      while (idx < 0) { idx += scaleLen; }
      while (idx >= ladder.length) { idx -= scaleLen; }
      idx = clamp(idx, 0, ladder.length - 1);
      /* Evita ficar preso nas pontas: se estiver a menos de dois graus do
         extremo, puxa uma oitava para o centro. */
      if (idx < 2 && idx + scaleLen < ladder.length) { idx += scaleLen; }
      if (idx > ladder.length - 3 && idx - scaleLen >= 0) { idx -= scaleLen; }

      var midi = ladder[idx];
      cursor = idx;

      /* ---- articulacoes ---- */
      var art = {};
      var legato = (grp.hopo || grp.tap) && prevMidi >= 0 && rest < 0.42;
      if (legato) {
        art.hopo = true;
        art.legatoFrom = prevMidi;
      }
      /* Slide: salto grande e ligado -> o dedo arrasta ate a nota. */
      if (!legato && prevMidi >= 0 && rest < 0.30 &&
          Math.abs(midi - prevMidi) >= 4 && rng() < 0.20) {
        art.slideFrom = prevMidi;
        art.slideTime = clamp(rest * 0.5, 0.03, 0.12);
      }
      /* Bend nas notas longas: a marca registrada do fraseado paraense. */
      if (hold >= 0.34 && rng() < 0.42) {
        art.bend = (rng() < 0.68) ? 200 : 100;   /* um tom ou meio tom */
        art.bendFrom = 0;
        art.bendDelay = clamp(hold * 0.18, 0.03, 0.2);
        art.bendTime = clamp(hold * 0.3, 0.06, 0.25);
        art.bendRelease = (rng() < 0.4);
      }
      /* Vibrato entra sozinho nas notas seguradas (ver playGuitar). */
      art.vib = hold > 0.22;
      art.vibDelay = clamp(hold * 0.3, 0.10, 0.4);
      art.vibDepth = 20 + Math.floor(rng() * 16);
      /* Abafado com a mao nas passagens graves e de baixa intensidade. */
      if (!legato && midi < 62 && hold < 0.18 && sec.intensity < 0.6 && rng() < 0.35) {
        art.palm = true;
      }

      pushEv(events, gt, 'guitar', midi, vel, hold, art);

      /* ---- acordes: terca/sexta ou triade ---- */
      if (lanes.length === 2) {
        /* Duas raias = dobra em tercas (ou sextas), o clichê da guitarrada. */
        var iv = (rng() < 0.72) ? 2 : 5;   /* graus da escala */
        var j2 = clamp(idx + iv, 0, ladder.length - 1);
        pushEv(events, gt + 0.004, 'guitar', ladder[j2], clamp(vel * 0.80, 0.3, 1.05),
          hold, { vib: art.vib, vibDelay: art.vibDelay, vibDepth: art.vibDepth });
      } else if (lanes.length >= 3) {
        /* Tres ou mais = triade do acorde vigente, subindo a partir da nota. */
        var used = 1;
        for (var c2 = 0; c2 < cIdx.length && used < Math.min(lanes.length, 4); c2++) {
          if (cIdx[c2] <= idx) { continue; }
          pushEv(events, gt + 0.004 * used, 'guitar', ladder[cIdx[c2]],
            clamp(vel * (0.82 - used * 0.08), 0.25, 1.05), hold,
            { vib: false });
          used++;
        }
      }

      prevMidi = midi;
      prevLane = lanes[lanes.length - 1];
      prevT = gt;
    }
    return true;
  }

  /* Sem chart? A guitarra ainda precisa existir. Gera frases melodicas
     coerentes com a harmonia, com respiros entre elas — uma guitarrada
     sintetica, mas com forma de frase. */
  function generateLead(events, cfg, grid, harm, sections, rng) {
    var bars = grid.bars;
    var ladderCache = {};
    var cursor = -1;
    for (var b = 0; b < bars.length; b++) {
      var bar = bars[b];
      var sec = null;
      for (var s = 0; s < sections.length; s++) {
        if (bar.t0 >= sections[s].t0 - 1e-6 && bar.t0 < sections[s].t1) { sec = sections[s]; break; }
      }
      if (!sec || sec.intensity < 0.5) { continue; }
      var slot = slotAt(harm, bar.t0 + 0.01);
      if (!slot) { continue; }
      var key = slot.scaleRootPc + '|' + slot.scaleName;
      var ladder = ladderCache[key];
      if (!ladder) {
        ladder = theory.scaleLadder(slot.scaleRootPc, slot.scaleName, LEAD_LO, LEAD_HI);
        ladderCache[key] = ladder;
      }
      if (!ladder.length) { continue; }
      var cIdx = chordToneIndices(ladder, slot);
      if (cursor < 0) { cursor = nearestFrom(cIdx, theory.nearestIndex(ladder, LEAD_CENTER)); }

      /* Densidade: refrao e solo tocam mais nota. */
      var density = clamp(0.30 + sec.intensity * 0.55, 0.2, 0.9);
      var six = bar.len / 16;
      var lastStep = -3;
      for (var st = 0; st < 16; st++) {
        if (rng() > density) { continue; }
        if (st - lastStep < 1) { continue; }
        var t = stepTime(bar, st, cfg, 0.006, rng);
        var move = Math.floor(rng() * 5) - 2;
        var idx = clamp(cursor + move, 0, ladder.length - 1);
        if (st % 4 === 0) { idx = nearestFrom(cIdx, idx); }
        if (idx < 2) { idx += 7; }
        if (idx > ladder.length - 3) { idx -= 7; }
        idx = clamp(idx, 0, ladder.length - 1);
        var hold = (st % 8 === 0 && rng() < 0.4) ? six * 5 : six * 1.6;
        pushEv(events, t, 'guitar', ladder[idx],
          clamp(0.72 + (st % 4 === 0 ? 0.14 : 0) + around(rng, 0.06), 0.4, 1.1),
          hold, { vib: hold > 0.25, vibDelay: 0.16 });
        cursor = idx;
        lastStep = st;
      }
    }
  }

  /* ---------------------------------------------------------------------
   * Configuracao efetiva: genero + o que o arranjo da musica sobrescrever.
   * Os padroes de texto sao convertidos aqui, uma vez por musica.
   * ------------------------------------------------------------------- */
  function buildConfig(gk, arr) {
    var base = GENRES[gk] || GENRES.guitarrada;
    var cfg = {
      genre: gk,
      key: base.key, scale: base.scale, chordBars: base.chordBars,
      micro4: base.micro4, swing: base.swing, swingUnit: base.swingUnit,
      prog: base.prog,
      drums: base.drums, bass: base.bass, keys: base.keys,
      brass: base.brass, pluck: base.pluck, perc: base.perc
    };

    /* Escala da humanizacao. 1 = a do genero. O arranjo pode zerar. */
    cfg.humanScale = 1;

    /* Sobrescritas vindas de song.arrangement (todas opcionais). */
    if (arr) {
      if (typeof arr.swing === 'number') {
        cfg.swing = clamp(arr.swing, 0, 0.4);
        /* Um arranjo que fixa swing = 0 esta dizendo, explicitamente, que o
           chart foi escrito numa grade reta e que a base nao pode balancar,
           senao a banda descola das gems. Nesse caso a microtemporizacao do
           genero tambem sai — ela e swing por outro nome. */
        if (cfg.swing === 0) { cfg.micro4 = null; }
      }
      if (arr.swingUnit === 8 || arr.swingUnit === 16) { cfg.swingUnit = arr.swingUnit; }
      if (arr.micro4 && arr.micro4.length === 4) { cfg.micro4 = arr.micro4; }
      /* timing.humanizeMs = 0 significa "quero a base cravada na grade". */
      if (arr.timing && typeof arr.timing.humanizeMs === 'number') {
        cfg.humanScale = clamp(arr.timing.humanizeMs / 8, 0, 2);
      }
      if (arr.patterns) {
        var p = arr.patterns;
        if (p.kick || p.snare || p.hat || p.ride) {
          cfg.drums = {
            kick: p.kick || base.drums.kick,
            snare: p.snare || base.drums.snare,
            hat: p.hat || base.drums.hat,
            ride: p.ride || base.drums.ride
          };
        }
        if (p.bass) { cfg.bass = { p: p.bass, style: (arr.bassStyle || base.bass.style) }; }
        if (p.keys) { cfg.keys = { style: arr.keysStyle || base.keys.style, p: p.keys, min: base.keys.min }; }
        if (p.brass) { cfg.brass = { p: p.brass, min: base.brass.min }; }
        if (p.pluck) { cfg.pluck = { p: p.pluck, min: base.pluck.min }; }
        if (p.perc && p.perc.length) { cfg.perc = p.perc; }
      }
    }

    /* Instrumentos que o arranjo pediu para silenciar. */
    var off = {};
    var offList = (arr && (arr.mute || arr.without)) || null;
    if (offList && offList.length) {
      for (var oi = 0; oi < offList.length; oi++) { off[slug(offList[oi])] = true; }
    }

    /* Conversao texto -> eventos de padrao.
       O clone e obrigatorio: sem ele, gravariamos os padroes ja compilados
       dentro da tabela GENERO compartilhada e a segunda musica do mesmo
       genero herdaria os silenciamentos da primeira. */
    var srcDrums = cfg.drums || {};
    cfg.drums = {
      kick: srcDrums.kick, snare: srcDrums.snare,
      hat: srcDrums.hat, ride: srcDrums.ride
    };
    cfg.drums.kickP  = off.kick ? null : normPat(cfg.drums.kick);
    cfg.drums.snareP = off.snare ? null : normPat(cfg.drums.snare);
    cfg.drums.hatP   = off.hat ? null : normPat(cfg.drums.hat);
    cfg.drums.rideP  = off.ride ? null : normPat(cfg.drums.ride);
    cfg.bassP  = off.bass ? null : normPat(cfg.bass && cfg.bass.p);
    cfg.keysP  = (off.keys || off.organ) ? null : normPat(cfg.keys && cfg.keys.p);
    cfg.brassP = (off.brass || off.metais) ? null : normPat(cfg.brass && cfg.brass.p);
    cfg.pluckP = (off.pluck || off.cavaquinho) ? null : normPat(cfg.pluck && cfg.pluck.p);

    cfg.percP = [];
    if (cfg.perc) {
      for (var i = 0; i < cfg.perc.length; i++) {
        var e = cfg.perc[i];
        if (!e || !e.i || off[slug(e.i)] || off.perc) { continue; }
        cfg.percP.push({ i: e.i, pat: normPat(e.p), min: (e.min == null ? 0.4 : e.min) });
      }
    }
    return cfg;
  }

  /* ---------------------------------------------------------------------
   * MONTAGEM DO PLANO COMPLETO.
   * ------------------------------------------------------------------- */
  function buildPlan(song) {
    var arr = (song.arrangement && typeof song.arrangement === 'object') ? song.arrangement : null;
    var gk = genreKey((arr && arr.genre) || song.genre);
    var cfg = buildConfig(gk, arr);
    var grid = buildGrid(song);
    var seed = hashStr((song.id || '') + '|' + (song.title || '') + '|' + gk);

    var sections = buildSections(song, arr, grid);
    var harm = buildHarmony(song, arr, grid, sections, cfg, makeRNG(seed ^ 0x9e3779b9));

    var events = [];

    /* 1) A guitarra primeiro: ela e a razao de tudo existir.
       Ordem de preferencia:
         a) a linha de lead composta pelo agente de conteudo (alturas exatas);
         b) o chart 'guitarrada', mapeando raia -> grau da escala;
         c) na falta dos dois, uma melodia gerada sobre a harmonia. */
    var rngG = makeRNG(seed ^ 0xa5a5a5a5);
    var leadSource = 'gerada';
    var hasChart = buildGuitarFromLead(arr, cfg, grid, harm, sections, rngG, events);
    if (hasChart) {
      leadSource = 'arranjo';
    } else {
      hasChart = buildGuitarPart(song, cfg, grid, harm, sections, rngG, events);
      if (hasChart) { leadSource = 'chart'; }
      else { generateLead(events, cfg, grid, harm, sections, rngG); }
    }

    /* 2) A banda, compasso a compasso. RNG separado por naipe para que
       mexer num nao mude o outro (determinismo estavel). */
    var rngD = makeRNG(seed ^ 0x1b873593);
    var rngP = makeRNG(seed ^ 0x85ebca6b);
    var rngB = makeRNG(seed ^ 0xc2b2ae35);
    var rngK = makeRNG(seed ^ 0x27d4eb2f);
    var rngBr = makeRNG(seed ^ 0x165667b1);
    var rngPl = makeRNG(seed ^ 0x9e3779b1);

    var stBass = { prev: null };
    var stKeys = { prevVoicing: null, lastSlotT: -1 };
    var stBrass = { prevVoicing: null };
    var stPluck = { prevVoicing: null };

    var bars = grid.bars;
    var dur = song.durationSec || 120;
    var si = 0;
    var barInSection = 0;

    for (var b = 0; b < bars.length; b++) {
      var bar = bars[b];
      if (bar.t0 >= dur) { break; }

      /* Secao vigente e se este compasso a inaugura. */
      var secStart = false;
      while (si + 1 < sections.length && sections[si + 1].t0 <= bar.t0 + 1e-4) {
        si++;
        barInSection = 0;
        secStart = true;
      }
      if (b === 0) { secStart = true; }
      var sec = sections[si] || { intensity: 0.7, t0: 0, t1: dur };
      var inten = sec.intensity;

      /* Rampa de entrada: os dois primeiros compassos de uma secao forte
         entram um pouco mais contidos, o que cria respiro entre blocos. */
      if (barInSection === 0 && inten > 0.8) { inten -= 0.10; }

      /* Virada: no ultimo compasso antes de trocar de secao, ou de 8 em 8. */
      var nextBarT = bar.t0 + bar.len;
      var isSectionEnd = (si + 1 < sections.length) && (nextBarT >= sections[si + 1].t0 - 1e-3);
      var isFill = isSectionEnd || (barInSection > 0 && (barInSection + 1) % 8 === 0 && inten >= 0.6);

      emitDrums(events, bar, cfg, inten, rngD, isFill, secStart);
      emitPerc(events, bar, cfg, inten, rngP);
      emitBass(events, bar, cfg, inten, rngB, harm, stBass);
      emitKeys(events, bar, cfg, inten, rngK, harm, stKeys);
      emitBrass(events, bar, cfg, inten, rngBr, harm, stBrass);
      emitPluck(events, bar, cfg, inten, rngPl, harm, stPluck);

      barInSection++;
    }

    /* 3) Ordena por tempo — o agendador depende disso para a busca binaria. */
    events.sort(function (x, y) { return x.t - y.t; });

    /* Descarta o que caiu fora da musica (viradas podem passar do fim). */
    var clean = [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].t >= -0.001 && events[i].t <= dur + 2.5) { clean.push(events[i]); }
    }

    return {
      song: song,
      id: song.id || song.title || 'song',
      genre: gk,
      cfg: cfg,
      grid: grid,
      sections: sections,
      harmony: harm,
      hasChart: hasChart,
      leadSource: leadSource,
      bpm: bpmFromSong(song),
      events: clean,
      done: new Uint8Array(clean.length),
      cursorFrom: -1e9
    };
  }

  /* ======================================================================
   * 7. AGENDAMENTO COM PRECISAO DE AMOSTRA
   *
   * Nada de setTimeout para eventos musicais: cada nota recebe um instante
   * absoluto do AudioContext. O relogio da musica vem de GH.Conductor.
   * ==================================================================== */

  var _plans = {};
  var _anchorCtx = 0;      /* ctx.currentTime no instante da ancora */
  var _anchorSong = 0;     /* tempo de musica correspondente */

  function ensureCtx() {
    if (ctx && _ready) { return true; }
    var a = _audio || GH.Audio || null;
    if (!audioReady(a)) { return false; }
    if (!ctx) {
      var c = resolveCtx(a);
      if (!c) { return false; }
      _audio = a;
      ctx = c;
    }
    if (!_ready) {
      try { buildGraph(); } catch (e) { return false; }
    }
    return _ready;
  }

  /* ---------------------------------------------------------------------
   * CONVERSAO TEMPO DE MUSICA -> TEMPO DO HARDWARE
   *
   * GH.Conductor expoe `ctxTimeAt(rawSongTime)`, que e o cambio OFICIAL
   * entre o segundo da musica e o instante absoluto do AudioContext. E
   * obrigatorio usa-lo: `Conductor.time` ja vem compensado por
   * audioOffsetMs + videoOffsetMs, e esses offsets existem para alinhar
   * julgamento e imagem ao que se ouve — nao para deslocar a musica. Usar
   * `time` aqui deslocaria a trilha inteira em relacao ao chart.
   *
   * A ancora local so entra como plano B (sem conductor, ou valor fora de
   * faixa por a musica ainda nao ter comecado).
   * ------------------------------------------------------------------- */
  var _useConductorClock = false;

  function syncAnchor(fromSec) {
    var C = null;
    try { C = GH.Conductor; } catch (e) { C = null; }

    _useConductorClock = false;
    if (C && typeof C.ctxTimeAt === 'function') {
      var probe = C.ctxTimeAt(fromSec);
      var now = ctx.currentTime;
      /* Sanidade: o instante devolvido tem de cair perto do agora. Se a
         musica ainda nao comecou, o epoch e lixo e caimos no plano B. */
      if (isFinite(probe) && probe > 0 && probe > now - 5 && probe < now + 30) {
        _useConductorClock = true;
        return;
      }
    }

    var songNow = fromSec;
    try {
      if (C && typeof C.rawTime === 'number' && isFinite(C.rawTime)) {
        songNow = C.rawTime;
      } else if (C && typeof C.time === 'number' && isFinite(C.time)) {
        songNow = C.time;
      }
    } catch (e2) { /* sem conductor: a janela e a propria referencia */ }
    _anchorCtx = ctx.currentTime;
    _anchorSong = songNow;
  }

  function ctxTimeForSong(tSong) {
    if (_useConductorClock) {
      var v = GH.Conductor.ctxTimeAt(tSong);
      if (isFinite(v)) { return v; }
    }
    return _anchorCtx + (tSong - _anchorSong);
  }

  function lowerBound(events, t) {
    var lo = 0, hi = events.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (events[mid].t < t) { lo = mid + 1; } else { hi = mid; }
    }
    return lo;
  }

  function resetFrom(plan, t) {
    var i = lowerBound(plan.events, t - 0.0005);
    for (; i < plan.done.length; i++) { plan.done[i] = 0; }
  }

  function fire(e, when) {
    var v = VOICES[e.i];
    if (!v) { return; }
    /* Uma voz que explode nunca pode derrubar a musica inteira. */
    try { v(e, when); } catch (err) { /* segue o baile */ }
  }

  function prepare(song) {
    if (!song || typeof song !== 'object') { return null; }
    var key = song.id || song.title || 'gh-song';
    var p = _plans[key];
    if (p && p.song === song && !song.__synthDirty) { return p; }
    try {
      p = buildPlan(song);
    } catch (e) {
      /* Plano vazio e melhor que jogo quebrado. */
      p = {
        song: song, id: key, genre: 'guitarrada', events: [],
        done: new Uint8Array(0), cursorFrom: -1e9, bpm: bpmFromSong(song)
      };
    }
    _plans[key] = p;
    if (_ready) {
      try { tuneFxToTempo(p.bpm, p.genre); } catch (e2) {}
    } else {
      _pendingTempo = { bpm: p.bpm, genre: p.genre };
    }
    return p;
  }

  function schedule(song, fromSec, toSec) {
    if (!ensureCtx()) { return; }
    var plan = prepare(song);
    if (!plan || !plan.events.length) { return; }
    if (!(fromSec >= 0)) { fromSec = 0; }
    if (!(toSec > fromSec)) { toSec = fromSec + 0.1; }

    /* Busca para tras (rebobinou, reiniciou, saiu da pausa): reabilita os
       eventos daquele ponto em diante. Assim schedule e idempotente na
       janela mas ainda responde a saltos do relogio. */
    if (fromSec < plan.cursorFrom - 0.25) { resetFrom(plan, fromSec); }
    plan.cursorFrom = fromSec;

    syncAnchor(fromSec);
    var now = ctx.currentTime;
    var ev = plan.events;
    var done = plan.done;
    var i = lowerBound(ev, fromSec);

    for (; i < ev.length; i++) {
      var e = ev[i];
      if (e.t >= toSec) { break; }
      if (done[i]) { continue; }
      done[i] = 1;
      var when = ctxTimeForSong(e.t);
      /* Se a aba travou e o evento ja passou, descarta em vez de disparar
         uma avalanche de notas atrasadas de uma vez. */
      if (when < now - 0.05) { continue; }
      fire(e, when < now + 0.004 ? now + 0.004 : when);
    }
  }

  function stopAll() {
    var k;
    for (k in _plans) {
      if (Object.prototype.hasOwnProperty.call(_plans, k)) {
        var p = _plans[k];
        if (p && p.done) {
          for (var i = 0; i < p.done.length; i++) { p.done[i] = 0; }
          p.cursorFrom = -1e9;
        }
      }
    }
    if (!ctx) { return; }
    var now = ctx.currentTime;
    for (var j = 0; j < _live.length; j++) {
      var arr = _live[j].n;
      for (var m = 0; m < arr.length; m++) {
        var nd = arr[m];
        /* Fecha em 50 ms em vez de cortar: corte seco estala. */
        try {
          if (nd.gain && typeof nd.gain.linearRampToValueAtTime === 'function') {
            nd.gain.cancelScheduledValues(now);
            nd.gain.setValueAtTime(nd.gain.value, now);
            nd.gain.linearRampToValueAtTime(0, now + 0.05);
          }
        } catch (e) {}
        try { if (typeof nd.stop === 'function') { nd.stop(now + 0.07); } } catch (e2) {}
      }
      _live[j].e = now + 0.12;
    }
  }

  /* ======================================================================
   * 8. API PUBLICA  (ARCHITECTURE.md, secao 6)
   * ==================================================================== */

  GH.Synth = {

    /* Recebe GH.Audio. No modo captura nao ha AudioContext: tudo vira
       no-op silencioso e o jogo segue normalmente. */
    init: function (audio) {
      _audio = audio || GH.Audio || null;
      /* Devolver false aqui NAO e falha: pode ser modo captura (sem audio)
         ou GH.Audio.init() ainda nao ter rodado. No segundo caso o grafo
         nasce sozinho na primeira janela de schedule(). */
      try { return ensureCtx(); } catch (e) { return false; }
    },

    /* Pre-computa o arranjo inteiro (harmonia, groove, guitarra do chart).
       Pode ser chamado sem audio — e so processamento de dados. */
    prepare: function (song) { return prepare(song); },

    /* Agenda a janela [fromSec, toSec) em tempo de musica. Idempotente. */
    schedule: function (song, fromSec, toSec) {
      try { schedule(song, fromSec, toSec); } catch (e) { /* nunca quebra o loop */ }
    },

    /* Corta SO o bus da guitarra — a banda continua tocando. E o feedback
       classico de Guitar Hero quando o jogador erra. */
    setGuitarMuted: function (on) {
      _muted = !!on;
      applyMute(_muted, false);
    },

    /* Star Power: filtro aberto, brilho, mola maior e camadas de oitava e
       quinta nas notas novas. */
    setStarPower: function (on) {
      var v = !!on;
      if (v === _sp) { return; }
      _sp = v;
      applyStarPower(_sp, false);
    },

    stopAll: function () {
      try { stopAll(); } catch (e) {}
    },

    /* ---- extras uteis para os outros agentes (nao quebram o contrato) --- */

    /* Motor de harmonia, exposto para quem quiser afinar algo com a musica. */
    theory: theory,

    /* Toca uma nota avulsa (previews de menu, metronomo, testes de timbre).
       `when` e opcional e, quando dado, e um instante ABSOLUTO do
       AudioContext — permite agendar a nota adiante em vez de "agora". */
    noteOn: function (inst, midi, vel, dur, art, when) {
      if (!ensureCtx()) { return; }
      var v = VOICES[inst];
      if (!v) { return; }
      var t = (typeof when === 'number' && isFinite(when)) ? when : (ctx.currentTime + 0.01);
      if (t < ctx.currentTime) { t = ctx.currentTime + 0.005; }
      try {
        v({ m: midi == null ? 69 : midi, v: vel == null ? 0.8 : vel,
            d: dur == null ? 0.3 : dur, a: art || null }, t);
      } catch (e) {}
    },

    /* Lista de instrumentos disponiveis (menus de teste, creditos). */
    instruments: function () {
      var out = [];
      for (var k in VOICES) {
        if (Object.prototype.hasOwnProperty.call(VOICES, k)) { out.push(k); }
      }
      return out;
    },

    /* Devolve o plano montado (eventos com tempo absoluto). O agente de
       palco pode usar para animar a banda em sincronia real. */
    getPlan: function (song) { return prepare(song); },

    /* Estado, para HUD/depuracao. */
    get isMuted() { return _muted; },
    get starPowerActive() { return _sp; },
    get ready() { return _ready; },
    get voices() { return _voiceCount; },

    /* Ajuste fino de volume por familia, caso a mixagem precise ceder
       espaco para narracao/SFX em algum momento. */
    setBusGain: function (name, v) {
      if (!_ready) { return; }
      var map = {
        guitar: nodes.gtrOut, bass: nodes.bassOut, keys: nodes.keysOut,
        brass: nodes.brassOut, pluck: nodes.pluckOut,
        drums: nodes.drumOut, perc: nodes.percOut, reverb: nodes.roomOut
      };
      var n = map[name];
      if (!n) { return; }
      var t = ctx.currentTime;
      n.gain.cancelScheduledValues(t);
      n.gain.setValueAtTime(n.gain.value, t);
      n.gain.linearRampToValueAtTime(clamp(v, 0, 2), t + 0.05);
    },

    /* Limpa o cache de arranjos (troca de setlist, recarga de conteudo). */
    clearCache: function () { _plans = {}; }
  };

})(window.GH = window.GH || {});

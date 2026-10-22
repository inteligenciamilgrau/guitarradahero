/* =============================================================================
   GUITARRADA HERO — src/content/songs.js
   -----------------------------------------------------------------------------
   Direcao musical + charting.

   Seis composicoes ORIGINAIS (nenhuma obra de terceiros), inspiradas em generos
   brasileiros: guitarrada paraense, carimbo, lambada, brega/calypso, frevo e
   samba-rock. Nomes de artistas reais aparecem SOMENTE no campo 'tribute', como
   homenagem textual. Projeto didatico, sem fins comerciais.

   Como isto funciona (leia antes de mexer):

   1. Cada musica e descrita de forma DECLARATIVA (secoes, compassos, cifras).
   2. A partir dessa descricao o arquivo COMPOE uma linha de guitarra de verdade:
      padroes ritmicos por genero (grade de semicolcheias), motivos melodicos
      (contornos em graus da escala), harmonia por compasso e cadencias de frase.
   3. A melodia (eventos com altura MIDI) e entao TRANSCRITA para a pista:
      contorno melodico -> movimento de raias (escadinhas, ancoragens, saltos
      controlados), acordes de 2/3 notas, HOPOs, taps, sustains e notas abertas.
   4. As dificuldades menores sao REDUCOES musicais do chart Expert ("guitarrada"),
      escolhendo as notas mais fortes do compasso — exatamente como um charter
      profissional faz.
   5. Tudo e deterministico: GH.Util.RNG com semente fixa por musica (com fallback
      mulberry32 interno, caso o modulo CORE ainda nao esteja carregado).
   6. Um validador interno roda em cada chart e CONSERTA automaticamente:
      ordenacao, duplicatas, raias fora do intervalo, sustain colidindo, HOPO fora
      da convencao, acorde grande demais, nota aberta convivendo com raia, etc.

   Contrato com GH.Synth: 'song.arrangement' traz secoes, harmonia compasso a
   compasso e a linha de lead (arrangement.lead.events) com os MESMOS tempos do
   chart 'guitarrada'. Timing e reto (swing 0) — o chart depende disso.
   ============================================================================= */

(function (GH) {
  'use strict';

  /* ===========================================================================
     1. RNG DETERMINISTICO
     Preferimos GH.Util.RNG (contrato do agente CORE). Se ele ainda nao existir
     ou tiver assinatura diferente, caimos num mulberry32 local — o resultado
     continua 100% reproduzivel, que e o que o modo captura exige.
     =========================================================================== */

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

  // Descobre uma vez qual estrategia usar para o RNG do CORE.
  var rngStrategy = null;

  function probeCoreRng() {
    if (rngStrategy) return rngStrategy;
    rngStrategy = 'local';
    try {
      if (GH.Util && typeof GH.Util.RNG === 'function') {
        var probe = coreRngInstance(12345);
        if (probe) {
          var ok = true;
          for (var i = 0; i < 4; i++) {
            var v = probe();
            if (typeof v !== 'number' || !isFinite(v) || v < 0 || v >= 1) { ok = false; break; }
          }
          if (ok) rngStrategy = 'core';
        }
      }
    } catch (e) { rngStrategy = 'local'; }
    return rngStrategy;
  }

  // Aceita RNG como fabrica (retorna funcao) ou como construtor (objeto .next/.random).
  function coreRngInstance(seed) {
    var r;
    try { r = GH.Util.RNG(seed); } catch (e1) { r = null; }
    if (typeof r !== 'function' && !(r && (typeof r.next === 'function' || typeof r.random === 'function'))) {
      try { r = new GH.Util.RNG(seed); } catch (e2) { r = null; }
    }
    if (typeof r === 'function') return r;
    if (r && typeof r.next === 'function') return function () { return r.next(); };
    if (r && typeof r.random === 'function') return function () { return r.random(); };
    return null;
  }

  // Envelope com utilitarios (inteiro, escolha em array, chance, faixa).
  function makeRng(seed) {
    var next = null;
    if (probeCoreRng() === 'core') next = coreRngInstance(seed >>> 0);
    if (!next) next = mulberry32(seed >>> 0);
    return {
      f: function () { return next(); },
      i: function (n) { return Math.floor(next() * n) % Math.max(1, n); },
      pick: function (arr) { return arr[Math.floor(next() * arr.length) % arr.length]; },
      chance: function (p) { return next() < p; },
      range: function (a, b) { return a + next() * (b - a); }
    };
  }

  /* ===========================================================================
     2. TEORIA MUSICAL
     =========================================================================== */

  var PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function parseNoteName(name) {
    var pc = PITCH_CLASS[name.charAt(0).toUpperCase()];
    if (pc === undefined) pc = 0;
    for (var i = 1; i < name.length; i++) {
      var c = name.charAt(i);
      if (c === '#') pc += 1;
      else if (c === 'b') pc -= 1;
      else break;
    }
    return ((pc % 12) + 12) % 12;
  }

  var SCALES = {
    major:        [0, 2, 4, 5, 7, 9, 11],
    ionian:       [0, 2, 4, 5, 7, 9, 11],
    mixolydian:   [0, 2, 4, 5, 7, 9, 10],
    dorian:       [0, 2, 3, 5, 7, 9, 10],
    aeolian:      [0, 2, 3, 5, 7, 8, 10],
    minor:        [0, 2, 3, 5, 7, 8, 10],
    harmonicMinor:[0, 2, 3, 5, 7, 8, 11],
    lydian:       [0, 2, 4, 6, 7, 9, 11],
    phrygian:     [0, 1, 3, 5, 7, 8, 10],
    majorPent:    [0, 2, 4, 7, 9],
    minorPent:    [0, 3, 5, 7, 10],
    blues:        [0, 3, 5, 6, 7, 10],
    mixoBlues:    [0, 2, 3, 4, 5, 7, 9, 10]
  };

  // Qualidades de acorde -> intervalos em semitons a partir da fundamental.
  var CHORD_QUALITY = {
    '':      [0, 4, 7],
    'maj':   [0, 4, 7],
    '5':     [0, 7],
    '6':     [0, 4, 7, 9],
    'maj7':  [0, 4, 7, 11],
    'maj9':  [0, 4, 7, 11, 14],
    '7':     [0, 4, 7, 10],
    '9':     [0, 4, 7, 10, 14],
    '13':    [0, 4, 7, 10, 21],
    '7#9':   [0, 4, 7, 10, 15],
    'sus4':  [0, 5, 7],
    'sus2':  [0, 2, 7],
    '7sus4': [0, 5, 7, 10],
    'add9':  [0, 4, 7, 14],
    'm':     [0, 3, 7],
    'm6':    [0, 3, 7, 9],
    'm7':    [0, 3, 7, 10],
    'm9':    [0, 3, 7, 10, 14],
    'mmaj7': [0, 3, 7, 11],
    'm7b5':  [0, 3, 6, 10],
    'dim':   [0, 3, 6],
    'dim7':  [0, 3, 6, 9],
    'aug':   [0, 4, 8]
  };

  var chordCache = {};

  function parseChord(symbol) {
    if (chordCache[symbol]) return chordCache[symbol];
    var m = /^([A-Ga-g][#b]?)(.*)$/.exec(symbol);
    var rootPc = 0, suffix = '';
    if (m) { rootPc = parseNoteName(m[1]); suffix = m[2] || ''; }
    var ivs = CHORD_QUALITY[suffix];
    if (!ivs) ivs = CHORD_QUALITY[suffix.replace(/[0-9]+$/, '')] || CHORD_QUALITY[''];
    var pcs = [];
    for (var i = 0; i < ivs.length; i++) pcs.push((rootPc + ivs[i]) % 12);
    var info = {
      symbol: symbol,
      rootPc: rootPc,
      intervals: ivs.slice(),
      pcs: pcs,
      minor: ivs.indexOf(3) >= 0,
      dominant: ivs.indexOf(10) >= 0 && ivs.indexOf(4) >= 0
    };
    chordCache[symbol] = info;
    return info;
  }

  // Dobra uma nota para dentro de uma faixa de registro, por oitavas.
  function foldToRange(midi, lo, hi) {
    while (midi < lo) midi += 12;
    while (midi > hi) midi -= 12;
    if (midi < lo) midi += 12;
    return midi;
  }

  // Nota mais proxima que pertenca ao acorde (busca em espiral por semitons).
  var SNAP_ORDER = [0, -1, 1, -2, 2, 3, -3, 4, -4, 5, -5, 6];

  function nearestChordTone(midi, pcs) {
    for (var i = 0; i < SNAP_ORDER.length; i++) {
      var m = midi + SNAP_ORDER[i];
      var pc = ((m % 12) + 12) % 12;
      if (pcs.indexOf(pc) >= 0) return m;
    }
    return midi;
  }

  // Converte MIDI -> indice de grau absoluto da escala (usado para o contorno).
  function stepOfMidi(midi, rootMidi, scale) {
    var rel = midi - rootMidi;
    var oct = Math.floor(rel / 12);
    var semi = rel - oct * 12;
    var idx = 0;
    for (var i = 0; i < scale.length; i++) if (scale[i] <= semi) idx = i;
    return oct * scale.length + idx;
  }

  function midiOfStep(step, rootMidi, scale) {
    var len = scale.length;
    var oct = Math.floor(step / len);
    var idx = step - oct * len;
    return rootMidi + oct * 12 + scale[idx];
  }

  // Voicing simples de acorde para teclado/naipe (dentro de uma faixa).
  function voiceChord(info, lo, hi) {
    var out = [], base = lo + ((info.rootPc - (lo % 12)) + 12) % 12;
    for (var i = 0; i < info.intervals.length; i++) {
      var m = base + info.intervals[i];
      while (m > hi) m -= 12;
      if (out.indexOf(m) < 0) out.push(m);
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /* ===========================================================================
     3. PADROES RITMICOS
     Cada padrao e um compasso 4/4 em grade de 16 semicolcheias:
       'X' ataque acentuado | 'x' ataque normal | '-' sustenta | '.' silencio
     Os nomes dos conjuntos seguem os generos do jogo.
     =========================================================================== */

  var RHYTHM = {

    guitarrada: {
      // riff: frase curta e sincopada que se transpoe com o acorde (blues paraense)
      riff: [
        'X..x..x.x..x..x.',
        'X.xx..x.x.xx.x..',
        'X..x.x.xX..x.x.x',
        'X-..x.x.X-..x.x.',
        'X.x.xx.xX.x.xx..',
        'X..x..x.x.xx..x.'
      ],
      // melody: tema cantavel, com respiros e notas longas
      melody: [
        'X---..x.X---..x.',
        'X..x..X-x..x..x-',
        'X-..X-..x.x.X---',
        'X..x.x.xX--x....',
        'X-x-..x.X---..x.',
        'X..x..x.X.xx..x.',
        'X.x..x.xX--x..x.'
      ],
      // solo: corridas de semicolcheia
      solo: [
        'Xxxx.xxxXxxx.xxx',
        'X.xxxxx.X.xxxxx.',
        'Xxx.xxx.Xxx.xxx.',
        'X.xxxxxxX.xxxxx.',
        'X.xxx.xxX.xxx.xx',
        'XxxxxxxxXxxx.xx.',
        'X.xx.xxxXxxx.xxx'
      ],
      sparse: [
        'X-------X-------',
        'X-----..X---....',
        'X---..x.X---..x.',
        'X..x..x.X---....',
        'X...X...X...X...',
        'X--x....X---....'
      ]
    },

    carimbo: {
      riff: [
        'X.xx..x.X.xx..x.',
        'X..xx..xX..xx..x',
        'X.x.xx..X.x.xx..',
        'X.xx..x.X..x.xx.',
        'X..x.x.xX.xx..x.'
      ],
      melody: [
        'X--x..x.X--x..x.',
        'X.x..x..X---..x.',
        'X-..x.x.X--x....',
        'X..x..x-X---....',
        'X.xx..x.X--x..x.',
        'X--x..x.X..x.xx.',
        'X.xx..x.X.xx..x.',
        'X..x.x.xX--x..x.',
        'X.x.xx..X--x....'
      ],
      solo: [
        'XxxxXxx.XxxxXxx.',
        'X.xxxxx.Xxxx.xxx',
        'Xxx.xxx.Xxx.xxx.',
        'X.xxx.xxXxxx.xx.',
        'XxxxxxxxX---....',
        'Xxxx.xxxX.xxxxx.'
      ],
      sparse: [
        'X.......X.......',
        'X---....X---....',
        'X--x..x.X--x....',
        'X.x..x..X---....',
        'X..x....X..x....',
        'X-------X-------'
      ]
    },

    lambada: {
      riff: [
        'X..x.x.xX..x.x.x',
        'X.x..xx.X.x..xx.',
        'X---x..xX---x..x',
        'X..x..x.X..x.x.x',
        'X.xx..x.X.x..xx.'
      ],
      melody: [
        'X---..x.X--x....',
        'X..x-.x.X---..x.',
        'X-x-..x.X---....',
        'X....x.xX---..x.',
        'X--x..x.X.x..x..',
        'X-..x.x.X--x..x.',
        'X..x.x.xX--x..x.',
        'X.xx..x.X.x..xx.'
      ],
      solo: [
        'Xxxx.xxxXxxx.xxx',
        'X.xxxxx.X.xxxxx.',
        'XxxxxxxxXxxx.xx.',
        'Xxx.xxx.XxxxX---',
        'X.xx.xxxX.xx.xxx',
        'X.xxx.xxXxxx.xx.'
      ],
      sparse: [
        'X-------X-------',
        'X---....X-----..',
        'X---..x.X--x....',
        'X..x..x.X---....',
        'X...X...X...X...',
        'X..x....X..x....'
      ]
    },

    brega: {
      riff: [
        'X-..x.x.X-..x.x.',
        'X..x..x.X---..x.',
        'X-x-..x.X-x-..x.',
        'X.xx..x.X.xx..x.',
        'X..x.x.xX..x.x.x',
        'X.x...x.X.x...x.'
      ],
      melody: [
        'X-..x.x.X---..x.',
        'X--x..x.X--x..x.',
        'X--x..x-X-------',
        'X.x..x.xX--x..x.',
        'X--x.x..X--x.x..',
        'X-..x...X---..x.',
        'X.xx..x.X---..x.',
        'X..x.x.xX---....',
        'X-x-.x.xX---..x.'
      ],
      solo: [
        'X.xxx.x.X.xxx.x.',
        'Xxxx.xx.X.xxxxx.',
        'X.xxxxx.X.xxxxx.',
        'Xxxxxxx.X.xxxxx.',
        'X.xx.xx.Xxxx.xx.',
        'Xxx.xxx.Xxx.xxx.'
      ],
      sparse: [
        'X-------X-------',
        'X-----..X-------',
        'X---..x.X-----..',
        'X-..x...X---....',
        'X.......X.......',
        'X---....X---....'
      ]
    },

    frevo: {
      riff: [
        'X.x.x.x.X.x.x.x.',
        'Xx.xx.x.Xx.xx.x.',
        'X.xxx.x.X.xxx.x.',
        'Xxx.xxx.Xxx.x...',
        'X.x.xx.xX.x.xx.x'
      ],
      melody: [
        'X.x.X.x.X.x.X-..',
        'X.xx.x.xX.x.X---',
        'Xx.x.x.xX--x....',
        'X.x.x.x.X-------',
        'X.xx.x.xX.xx.x.x',
        'Xx.x.x.xX.x.x.x.'
      ],
      solo: [
        'Xxxxxxx.Xxxxxxx.',
        'X.xxxxxxX.xxxxx.',
        'X.xxxxx.Xxxxxxx.',
        'XxxxxxxxX---....',
        'Xxx.xxx.Xxx.xxx.',
        'Xxxx.xxxXxxx.xxx',
        'X.xxx.xxXxxxxxx.'
      ],
      sparse: [
        'X...X...X...X...',
        'X-------X-------',
        'X.x.x...X.x.x...',
        'X.x.X.x.X-------',
        'X.x.....X.x.....',
        'X---....X---....'
      ]
    },

    sambarock: {
      riff: [
        'X..x..x.X..x..x.',
        'X.xx..x.X..xx.x.',
        'X..x.xx.X..x.xx.',
        'X..x..x.X..x.x..',
        'X.x..x.xX..x..x.'
      ],
      melody: [
        'X--x..x.X--x..x.',
        'X..x..X-x..x..x-',
        'X.xx.xx.X.xx.xx.',
        'X.x.x..xX--x....',
        'X..x.xx.X..x.xx.',
        'X-..x.x.X---..x.',
        'X.xx..x.X..x.xx.',
        'X.x.xx.xX.x.xx.x',
        'X.x.x.x.X--x..x.'
      ],
      solo: [
        'Xxx.xxx.Xxx.xxx.',
        'X.xxxxx.X.xxxxx.',
        'XxxxxxxxXxxxxxxx',
        'X.xx.xxxX.xx.xxx',
        'XxxxxxxxX---..x.',
        'Xxxx.xxxX.xxxxx.'
      ],
      sparse: [
        'X-------X-------',
        'X..x....X..x....',
        'X--x..x.X--x....',
        'X..x..x.X---....',
        'X...X...X...X...',
        'X-----..X---....'
      ]
    }
  };

  // Cadencias de fim de frase (nota longa segurando o compasso).
  var CADENCE = {
    guitarrada: ['X..x..x.X-------', 'X.xx..x.X---....', 'X..x.x.xX-------'],
    carimbo:    ['X.xx..x.X-------', 'X..x..x.X---....', 'X--x..x.X-------'],
    lambada:    ['X..x.x.xX-------', 'X---x..xX---....', 'X.x..xx.X-------'],
    brega:      ['X---..x.X-------', 'X..x..x-X-------', 'X-x-..x.X-------'],
    frevo:      ['X.x.x.x.X-------', 'Xx.xx.x.X---....', 'X.xxx.x.X-------'],
    sambarock:  ['X..x..x.X-------', 'X.xx..x.X---....', 'X..x.xx.X-------']
  };

  // Cadencias de solo: corrida desembocando em nota longa.
  var CADENCE_SOLO = [
    'XxxxxxxxX-------',
    'Xxxx.xxxX---....',
    'XxxxxxxxxxxxX---',
    'X.xxxxx.X-------'
  ];

  // Compasso de "parada": dois golpes abertos e silencio dramatico.
  var STOP_PATTERN = 'X-------X---....';

  var patternCache = {};

  function parsePattern(str) {
    if (patternCache[str]) return patternCache[str];
    var out = [], cur = null;
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if (c === 'x' || c === 'X') {
        cur = { s: i, d: 1, accent: (c === 'X') };
        out.push(cur);
      } else if (c === '-' && cur) {
        cur.d++;
      } else {
        cur = null;
      }
    }
    patternCache[str] = out;
    return out;
  }

  /* ===========================================================================
     4. MOTIVOS MELODICOS (contornos em graus da escala)
     =========================================================================== */

  var MOTIFS = {
    riff: [
      [0, 0, 2, 0, -2, 0, 0, 2],
      [0, 2, 3, 2, 0, -2, 0, 0],
      [0, 0, -2, 0, 2, 0, -1, 0],
      [0, 1, 0, -2, 0, 1, 2, 0],
      [0, 4, 2, 0, -3, 0, 2, 0],
      [0, 2, 1, 0, 2, 4, 2, 0]
    ],
    melody: [
      [0, 1, 2, 4, 2, 1, 0, -1],
      [4, 3, 2, 1, 0, 1, 2, 3],
      [0, 2, 4, 3, 2, 0, 1, 0],
      [2, 1, 0, 2, 4, 3, 2, 0],
      [0, -1, 0, 2, 3, 2, 0, -1],
      [5, 4, 2, 0, 2, 4, 5, 4],
      [0, 2, 3, 4, 2, 1, 0, 2]
    ],
    solo: [
      [0, 1, 2, 3, 4, 5, 6, 7],
      [7, 6, 5, 4, 3, 2, 1, 0],
      [0, 1, 2, 1, 2, 3, 2, 3, 4, 3, 4, 5],
      [0, 2, 1, 3, 2, 4, 3, 5],
      [0, 4, 3, 2, 1, 0, -1, -2],
      [7, 5, 6, 4, 5, 3, 4, 2],
      [0, 1, 2, 3, 2, 3, 4, 5, 4, 5, 6, 7],
      [0, -1, 1, 0, 2, 1, 3, 2],
      [5, 4, 3, 2, 3, 4, 5, 6, 7, 6, 5, 4]
    ],
    sparse: [
      [0, 2, 4, 2],
      [4, 2, 0, -1],
      [0, -2, 0, 2],
      [2, 4, 5, 4],
      [0, 3, 2, 0]
    ]
  };

  // Deslocamentos de grau por compasso dentro de uma frase (sequencias).
  var PHRASE_SHIFTS = [
    [0, 0, 0, 0],
    [0, 0, 1, 0],
    [0, 1, 2, 0],
    [0, -1, 0, 1],
    [0, 2, 0, -1],
    [0, 0, 2, 1],
    [0, 1, -1, 0]
  ];

  /* ===========================================================================
     5. PERFIL PADRAO DAS SECOES
     =========================================================================== */

  var SECTION_PROFILE = {
    'Intro':  { role: 'riff',   dens: 0.66, intensity: 0.32, chordProb: 0.26, reg: [55, 76], leadRole: 'riff',   dyn: 'mp', phrase: 2, drums: true,  bass: true,  keys: true,  brass: false, pads: true },
    'Tema A': { role: 'melody', dens: 1.00, intensity: 0.56, chordProb: 0.34, reg: [57, 79], leadRole: 'melody', dyn: 'mf', phrase: 4, drums: true,  bass: true,  keys: true,  brass: false, pads: false },
    'Tema B': { role: 'melody', dens: 1.06, intensity: 0.64, chordProb: 0.36, reg: [59, 81], leadRole: 'melody', dyn: 'mf', phrase: 4, drums: true,  bass: true,  keys: true,  brass: true,  pads: false },
    'Solo':   { role: 'solo',   dens: 1.30, intensity: 0.86, chordProb: 0.12, reg: [62, 88], leadRole: 'solo',   dyn: 'f',  phrase: 4, drums: true,  bass: true,  keys: true,  brass: false, pads: false },
    'Ponte':  { role: 'sparse', dens: 0.86, intensity: 0.44, chordProb: 0.30, reg: [55, 74], leadRole: 'riff',   dyn: 'mp', phrase: 2, drums: true,  bass: true,  keys: true,  brass: false, pads: true },
    'Refrão': { role: 'melody', dens: 1.14, intensity: 0.80, chordProb: 0.44, reg: [59, 83], leadRole: 'melody', dyn: 'f',  phrase: 4, drums: true,  bass: true,  keys: true,  brass: true,  pads: false },
    'Solo 2': { role: 'solo',   dens: 1.40, intensity: 1.00, chordProb: 0.14, reg: [64, 91], leadRole: 'solo',   dyn: 'ff', phrase: 4, drums: true,  bass: true,  keys: true,  brass: true,  pads: false },
    'Final':  { role: 'riff',   dens: 0.94, intensity: 0.72, chordProb: 0.52, reg: [57, 79], leadRole: 'riff',   dyn: 'f',  phrase: 2, drums: true,  bass: true,  keys: true,  brass: true,  pads: true }
  };

  // Secoes que ganham "parada" (nota aberta) no ultimo compasso por padrao.
  var DEFAULT_STOP_SECTIONS = { 'Tema B': true, 'Ponte': true, 'Final': true };

  // Helper declarativo de secao.
  function S(name, bars, chords, opts) {
    opts = opts || {};
    var p = SECTION_PROFILE[name] || SECTION_PROFILE['Tema A'];
    var stops = opts.stops;
    if (!stops) stops = DEFAULT_STOP_SECTIONS[name] ? [bars - 1] : [];
    return {
      name: name,
      bars: bars,
      chords: chords,
      role: opts.role || p.role,
      dens: opts.dens !== undefined ? opts.dens : p.dens,
      intensity: opts.intensity !== undefined ? opts.intensity : p.intensity,
      chordProb: opts.chordProb !== undefined ? opts.chordProb : p.chordProb,
      reg: opts.reg || p.reg,
      leadRole: opts.leadRole || p.leadRole,
      dyn: opts.dyn || p.dyn,
      phrase: opts.phrase || p.phrase,
      scale: opts.scale || null,
      stops: stops,
      drums: opts.drums !== undefined ? opts.drums : p.drums,
      bass: opts.bass !== undefined ? opts.bass : p.bass,
      keys: opts.keys !== undefined ? opts.keys : p.keys,
      brass: opts.brass !== undefined ? opts.brass : p.brass,
      pads: opts.pads !== undefined ? opts.pads : p.pads,
      bassPattern: opts.bassPattern || null,
      percussion: opts.percussion || null,
      note: opts.note || ''
    };
  }

  /* ===========================================================================
     6. AS SEIS MUSICAS (descricao declarativa)
     =========================================================================== */

  var SONG_DEFS = [

    /* ---------------------------------------------------------------------
       1. GUITARRADA DO VER-O-PESO — 132 bpm, La mixolidio, blues paraense.
       --------------------------------------------------------------------- */
    {
      id: 'guitarrada-ver-o-peso',
      title: 'Guitarrada do Ver-o-Peso',
      artist: 'Guitarrada Hero Band',
      tribute: 'Homenagem a Ximbinha e aos mestres da guitarrada paraense',
      genre: 'Guitarrada',
      bpm: 132,
      timeSig: [4, 4],
      year: 2026,
      palette: 'para',
      seed: 0x5169A1,
      key: 'A',
      scale: 'mixolydian',
      soloScale: 'blues',
      pool: 'guitarrada',
      ornament: 0.30,
      stars: { facil: 2, medio: 4, dificil: 7, guitarrada: 9 },
      drumPattern: 'rock',
      drumVariant: 'guitarrada-marcha',
      bassPattern: 'guitarrada-drive',
      percussion: ['ganza', 'agogo', 'triangulo', 'tamborim'],
      instruments: { guitar: 'guitarrada-tremolo', bass: 'jazz-bass-pick', keys: 'organ-vibrato', brass: false },
      cover: { hue: 26, hue2: 176, motif: 'guitar-wave', subtitle: 'Maresia, feira e guitarra tremolada' },
      sections: [
        S('Intro',  6,  ['A7', 'A7', 'D9', 'D9', 'E7', 'E7']),
        S('Tema A', 12, ['A7', 'A7', 'D9', 'D9', 'A7', 'A7', 'E7', 'E7', 'A7', 'D9', 'E7', 'A7']),
        S('Tema B', 12, ['F#m7', 'F#m7', 'D9', 'D9', 'E7', 'E7', 'A7', 'A7', 'F#m7', 'D9', 'E7', 'A7']),
        S('Solo',   12, ['A7', 'A7', 'A7', 'A7', 'D9', 'D9', 'A7', 'A7', 'E7', 'D9', 'A7', 'E7']),
        S('Ponte',   6, ['Bm7', 'Bm7', 'E7', 'E7', 'D9', 'E7']),
        S('Refrão', 10, ['A7', 'D9', 'E7', 'A7', 'A7', 'D9', 'E7', 'A7', 'D9', 'E7']),
        S('Solo 2',  8, ['A7', 'A7', 'D9', 'D9', 'E7', 'D9', 'A7', 'E7']),
        S('Final',   6, ['A7', 'D9', 'E7', 'A7', 'A7', 'A7'])
      ],
      sp: [
        { sec: 1, bar: 8, bars: 2 },
        { sec: 2, bar: 8, bars: 2 },
        { sec: 3, bar: 4, bars: 2 },
        { sec: 5, bar: 4, bars: 2 },
        { sec: 6, bar: 4, bars: 2 }
      ],
      taps: [ { sec: 3, bar: 8, bars: 3 }, { sec: 6, bar: 5, bars: 3 } ]
    },

    /* ---------------------------------------------------------------------
       2. CARIMBÓ DA LUA CHEIA — 108 bpm, Mi dorico, tambor e vamp hipnotico.
       --------------------------------------------------------------------- */
    {
      id: 'carimbo-lua-cheia',
      title: 'Carimbó da Lua Cheia',
      artist: 'Guitarrada Hero Band',
      tribute: 'Homenagem a Mestre Vieira e a Pinduca',
      genre: 'Carimbó',
      bpm: 108,
      timeSig: [4, 4],
      year: 2026,
      palette: 'carimbo',
      seed: 0x2C7B03,
      key: 'E',
      scale: 'dorian',
      soloScale: 'dorian',
      pool: 'carimbo',
      ornament: 0.50,
      stars: { facil: 2, medio: 3, dificil: 6, guitarrada: 8 },
      drumPattern: 'carimbo',
      drumVariant: 'carimbo-curimbo',
      bassPattern: 'carimbo-pulse',
      percussion: ['curimbo', 'ganza', 'maracas', 'agogo', 'reco-reco'],
      instruments: { guitar: 'guitarrada-clean', bass: 'round-wound', keys: 'organ-soft', brass: false },
      cover: { hue: 208, hue2: 46, motif: 'moon-river', subtitle: 'Tambor de tronco sob a lua do rio' },
      sections: [
        S('Intro',   4, ['Em7', 'Em7', 'A7', 'A7'], { role: 'sparse', dens: 0.5, intensity: 0.24 }),
        S('Tema A', 10, ['Em7', 'Em7', 'A7', 'A7', 'Em7', 'Em7', 'Bm7', 'A7', 'Em7', 'A7']),
        S('Tema B',  8, ['G', 'D', 'Em7', 'Bm7', 'G', 'A7', 'Em7', 'Em7']),
        S('Solo',    8, ['Em7', 'A7', 'Em7', 'A7', 'G', 'D', 'Bm7', 'A7']),
        S('Ponte',   4, ['Cmaj7', 'Bm7', 'Am7', 'B7']),
        S('Refrão',  8, ['Em7', 'A7', 'G', 'D', 'Em7', 'A7', 'Bm7', 'B7']),
        S('Solo 2',  6, ['Em7', 'A7', 'G', 'A7', 'Em7', 'B7']),
        S('Final',   4, ['Em7', 'A7', 'Em7', 'Em7'])
      ],
      sp: [
        { sec: 1, bar: 6, bars: 2 },
        { sec: 2, bar: 4, bars: 2 },
        { sec: 3, bar: 3, bars: 2 },
        { sec: 5, bar: 4, bars: 2 },
        { sec: 6, bar: 2, bars: 2 }
      ],
      taps: [ { sec: 3, bar: 5, bars: 3 }, { sec: 6, bar: 3, bars: 3 } ]
    },

    /* ---------------------------------------------------------------------
       3. LAMBADA DA MARÉ — 124 bpm, Re menor, balanco de maresia.
       --------------------------------------------------------------------- */
    {
      id: 'lambada-da-mare',
      title: 'Lambada da Maré',
      artist: 'Guitarrada Hero Band',
      tribute: 'Homenagem aos mestres da lambada paraense',
      genre: 'Lambada',
      bpm: 124,
      timeSig: [4, 4],
      year: 2026,
      palette: 'para',
      seed: 0x1AB4DA,
      key: 'D',
      scale: 'aeolian',
      soloScale: 'aeolian',
      pool: 'lambada',
      ornament: 0.36,
      stars: { facil: 3, medio: 5, dificil: 7, guitarrada: 9 },
      drumPattern: 'brega',
      drumVariant: 'lambada-merengue',
      bassPattern: 'lambada-bounce',
      percussion: ['congas', 'ganza', 'triangulo', 'cowbell'],
      instruments: { guitar: 'guitarrada-tremolo', bass: 'synth-bass-round', keys: 'organ-vibrato', brass: true },
      cover: { hue: 320, hue2: 194, motif: 'tide-spiral', subtitle: 'A maré subindo e a pista girando' },
      sections: [
        S('Intro',   6, ['Dm', 'Dm', 'Gm', 'A7', 'Dm', 'A7']),
        S('Tema A', 12, ['Dm', 'Dm', 'Gm', 'Gm', 'A7', 'A7', 'Dm', 'Dm', 'F', 'C', 'Gm', 'A7']),
        S('Tema B', 10, ['F', 'C', 'Gm', 'A7', 'F', 'C', 'Dm', 'A7', 'Gm', 'A7']),
        S('Solo',   10, ['Dm', 'Gm', 'A7', 'Dm', 'F', 'C', 'Gm', 'A7', 'Dm', 'A7']),
        S('Ponte',   6, ['Bb', 'C', 'Dm', 'Bb', 'C', 'A7']),
        S('Refrão', 10, ['Dm', 'A7', 'Gm', 'Dm', 'F', 'C', 'Gm', 'A7', 'Dm', 'A7']),
        S('Solo 2',  8, ['Dm', 'Gm', 'A7', 'Dm', 'Bb', 'C', 'A7', 'A7']),
        S('Final',   4, ['Dm', 'Gm', 'A7', 'Dm'])
      ],
      sp: [
        { sec: 1, bar: 8, bars: 2 },
        { sec: 2, bar: 6, bars: 2 },
        { sec: 3, bar: 4, bars: 2 },
        { sec: 5, bar: 5, bars: 2 },
        { sec: 6, bar: 4, bars: 2 }
      ],
      taps: [ { sec: 3, bar: 6, bars: 3 }, { sec: 6, bar: 4, bars: 3 } ]
    },

    /* ---------------------------------------------------------------------
       4. BREGA DA MADRUGADA — 118 bpm, Sol maior, calypso romantico de Belem.
       --------------------------------------------------------------------- */
    {
      id: 'brega-da-madrugada',
      title: 'Brega da Madrugada',
      artist: 'Guitarrada Hero Band',
      tribute: 'Homenagem à cena brega de Belém e às aparelhagens',
      genre: 'Brega / Calypso',
      bpm: 118,
      timeSig: [4, 4],
      year: 2026,
      palette: 'brega',
      seed: 0x0B3E6A,
      key: 'G',
      scale: 'major',
      soloScale: 'majorPent',
      pool: 'brega',
      ornament: 0.60,
      stars: { facil: 2, medio: 3, dificil: 5, guitarrada: 7 },
      drumPattern: 'brega',
      drumVariant: 'calypso-caixa',
      bassPattern: 'calypso-bounce',
      percussion: ['congas', 'cowbell', 'ganza', 'triangulo', 'pandeiro'],
      instruments: { guitar: 'brega-clean-chorus', bass: 'synth-bass-round', keys: 'organ-cheesy', brass: true },
      cover: { hue: 292, hue2: 34, motif: 'neon-heart', subtitle: 'Luz de aparelhagem às quatro da manhã' },
      sections: [
        S('Intro',   6, ['G', 'Em7', 'C', 'D7', 'G', 'D7']),
        S('Tema A', 10, ['G', 'G', 'Em7', 'Em7', 'C', 'C', 'D7', 'D7', 'G', 'D7']),
        S('Tema B', 10, ['Em7', 'Em7', 'Am7', 'Am7', 'D7', 'D7', 'G', 'G', 'C', 'D7']),
        S('Solo',    8, ['G', 'Em7', 'C', 'D7', 'G', 'Em7', 'Am7', 'D7']),
        S('Ponte',   6, ['Cmaj7', 'Bm7', 'Am7', 'D7', 'B7', 'Em7']),
        S('Refrão', 10, ['G', 'D7', 'Em7', 'C', 'G', 'D7', 'C', 'D7', 'G', 'D7']),
        S('Solo 2',  6, ['Em7', 'C', 'G', 'D7', 'Am7', 'D7']),
        S('Final',   4, ['G', 'C', 'D7', 'G'])
      ],
      sp: [
        { sec: 1, bar: 6, bars: 2 },
        { sec: 2, bar: 6, bars: 2 },
        { sec: 3, bar: 3, bars: 2 },
        { sec: 5, bar: 5, bars: 2 },
        { sec: 6, bar: 2, bars: 2 }
      ],
      taps: [ { sec: 3, bar: 5, bars: 3 }, { sec: 6, bar: 3, bars: 3 } ]
    },

    /* ---------------------------------------------------------------------
       5. FREVO DE AÇO — 152 bpm, Re maior, frevo eletrico com metais.
       --------------------------------------------------------------------- */
    {
      id: 'frevo-de-aco',
      title: 'Frevo de Aço',
      artist: 'Guitarrada Hero Band',
      tribute: 'Homenagem ao Recife e ao frevo elétrico',
      genre: 'Frevo / Rock',
      bpm: 152,
      timeSig: [4, 4],
      year: 2026,
      palette: 'frevo',
      seed: 0x3F5E00,
      key: 'D',
      scale: 'major',
      soloScale: 'major',
      pool: 'frevo',
      ornament: 0.18,
      stars: { facil: 3, medio: 5, dificil: 8, guitarrada: 10 },
      drumPattern: 'frevo',
      drumVariant: 'frevo-marcha',
      bassPattern: 'frevo-march',
      percussion: ['caixa', 'surdo', 'agogo', 'tamborim'],
      instruments: { guitar: 'frevo-drive', bass: 'pick-bass-bright', keys: 'organ-stab', brass: true },
      cover: { hue: 48, hue2: 8, motif: 'umbrella-fire', subtitle: 'Sombrinha em chamas, metais de aço' },
      sections: [
        S('Intro',   6, ['D', 'D', 'A7', 'A7', 'Bm', 'A7'], { dens: 0.74, intensity: 0.44 }),
        S('Tema A', 12, ['D', 'D', 'G', 'G', 'A7', 'A7', 'D', 'D', 'Bm', 'G', 'A7', 'D']),
        S('Tema B', 10, ['Bm', 'Bm', 'F#7', 'F#7', 'Bm', 'G', 'A7', 'D', 'G', 'A7']),
        S('Solo',   12, ['D', 'A7', 'Bm', 'G', 'D', 'A7', 'G', 'A7', 'D', 'Bm', 'A7', 'D']),
        S('Ponte',   6, ['G', 'G#dim', 'A7', 'A7', 'Em7', 'A7']),
        S('Refrão', 10, ['D', 'G', 'A7', 'D', 'Bm', 'G', 'A7', 'D', 'G', 'A7']),
        S('Solo 2',  8, ['D', 'Bm', 'G', 'A7', 'D', 'G', 'A7', 'A7']),
        S('Final',   4, ['D', 'G', 'A7', 'D'])
      ],
      sp: [
        { sec: 1, bar: 7, bars: 2 },
        { sec: 2, bar: 6, bars: 2 },
        { sec: 3, bar: 5, bars: 2 },
        { sec: 5, bar: 5, bars: 2 },
        { sec: 6, bar: 4, bars: 2 }
      ],
      taps: [ { sec: 3, bar: 8, bars: 3 }, { sec: 6, bar: 4, bars: 3 } ]
    },

    /* ---------------------------------------------------------------------
       6. SAMBA-ROCK ELÉTRICO — 96 bpm, La dorico, groove de guitarra e wah.
       --------------------------------------------------------------------- */
    {
      id: 'samba-rock-eletrico',
      title: 'Samba-Rock Elétrico',
      artist: 'Guitarrada Hero Band',
      tribute: 'Homenagem a Jorge Ben e ao samba-rock brasileiro',
      genre: 'Samba-Rock',
      bpm: 96,
      timeSig: [4, 4],
      year: 2026,
      palette: 'sambarock',
      seed: 0x5A46B0,
      key: 'A',
      scale: 'dorian',
      soloScale: 'minorPent',
      pool: 'sambarock',
      ornament: 0.62,
      stars: { facil: 2, medio: 4, dificil: 6, guitarrada: 8 },
      drumPattern: 'sambarock',
      drumVariant: 'partido-alto',
      bassPattern: 'samba-partido',
      percussion: ['pandeiro', 'tamborim', 'ganza', 'agogo', 'cuica'],
      instruments: { guitar: 'sambarock-wah', bass: 'fingered-bass', keys: 'rhodes-tremolo', brass: true },
      cover: { hue: 152, hue2: 264, motif: 'sun-diamond', subtitle: 'Wah-wah, palma e sol de fim de tarde' },
      sections: [
        S('Intro',   4, ['Am7', 'D7', 'Am7', 'D7']),
        S('Tema A',  8, ['Am7', 'D7', 'Am7', 'D7', 'Fmaj7', 'E7', 'Am7', 'Am7']),
        S('Tema B',  8, ['Dm7', 'G7', 'Cmaj7', 'Fmaj7', 'Bm7b5', 'E7', 'Am7', 'Am7']),
        S('Solo',    8, ['Am7', 'D7', 'Am7', 'D7', 'Fmaj7', 'E7', 'Am7', 'E7']),
        S('Ponte',   4, ['Fmaj7', 'E7', 'Am7', 'E7']),
        S('Refrão',  8, ['Am7', 'D7', 'G7', 'Cmaj7', 'Fmaj7', 'Bm7b5', 'E7', 'Am7']),
        S('Solo 2',  6, ['Am7', 'D7', 'Fmaj7', 'E7', 'Am7', 'E7']),
        S('Final',   2, ['Am7', 'Am7'])
      ],
      sp: [
        { sec: 1, bar: 4, bars: 2 },
        { sec: 2, bar: 4, bars: 2 },
        { sec: 3, bar: 4, bars: 2 },
        { sec: 5, bar: 4, bars: 2 },
        { sec: 6, bar: 2, bars: 2 }
      ],
      taps: [ { sec: 3, bar: 5, bars: 3 }, { sec: 6, bar: 3, bars: 3 } ]
    }
  ];

  /* ===========================================================================
     7. PERFIS DE DIFICULDADE
     minGap16 = distancia minima entre ataques, medida em semicolcheias.
     nps      = alvo de gems por segundo (media da musica).
     =========================================================================== */

  var DIFF_ORDER = ['facil', 'medio', 'dificil', 'guitarrada'];

  var DIFFS = {
    facil: {
      key: 'facil', lanes: 3, nps: 1.20, minGap16: 2.6, minGapAbs: 0.26,
      maxChord: 1, hopo: false, tap: false, open: true, openEvery: 2,
      sustainMin: 0.30, sustainBeats: 0.95, sustainTrim: 0.075, maxRatio: 0.35, salt: 0x11
    },
    medio: {
      key: 'medio', lanes: 4, nps: 2.20, minGap16: 1.6, minGapAbs: 0.155,
      maxChord: 2, hopo: false, tap: false, open: true, openEvery: 1,
      sustainMin: 0.28, sustainBeats: 0.85, sustainTrim: 0.065, chordKeep: 0.70, maxRatio: 0.60, salt: 0x22
    },
    dificil: {
      key: 'dificil', lanes: 5, nps: 3.55, minGap16: 0.95, minGapAbs: 0.092,
      maxChord: 2, hopo: true, tap: false, open: true, openEvery: 1,
      sustainMin: 0.24, sustainBeats: 0.72, sustainTrim: 0.058, chordKeep: 0.85, maxRatio: 0.85, salt: 0x33
    },
    guitarrada: {
      key: 'guitarrada', lanes: 5, nps: 4.60, minGap16: 0.62, minGapAbs: 0.058,
      maxChord: 3, hopo: true, tap: true, open: true, openEvery: 1,
      sustainMin: 0.22, sustainBeats: 0.62, sustainTrim: 0.052, chordKeep: 1.0, maxRatio: 1.0, salt: 0x44
    }
  };

  var DIFF_LABELS = {
    facil: 'Fácil',
    medio: 'Médio',
    dificil: 'Difícil',
    guitarrada: 'Guitarrada'
  };

  /* ===========================================================================
     8. LINHA DO TEMPO (secoes + harmonia compasso a compasso)
     =========================================================================== */

  function buildTimeline(def) {
    var beatsPerBar = def.timeSig[0];
    var beatSec = 60 / def.bpm;
    var barSec = beatSec * beatsPerBar;
    var slotSec = barSec / 16;              // grade de semicolcheia (4/4)
    var sections = [];
    var harmony = [];
    var bar = 0;
    var i, j;

    for (i = 0; i < def.sections.length; i++) {
      var sd = def.sections[i];
      var t0 = bar * barSec;
      var sec = {
        index: i,
        name: sd.name,
        t: round4(t0),
        dur: round4(sd.bars * barSec),
        end: round4(t0 + sd.bars * barSec),
        bar0: bar,
        bars: sd.bars,
        role: sd.role,
        dens: sd.dens,
        intensity: sd.intensity,
        chordProb: sd.chordProb,
        reg: sd.reg,
        leadRole: sd.leadRole,
        dyn: sd.dyn,
        phrase: sd.phrase,
        stops: sd.stops,
        def: sd,
        scaleName: sd.scale || (sd.role === 'solo' ? (def.soloScale || def.scale) : def.scale),
        stepLo: 0,
        stepHi: 1
      };
      sections.push(sec);

      for (j = 0; j < sd.bars; j++) {
        var sym = sd.chords[j % sd.chords.length];
        var info = parseChord(sym);
        var bassRoot = 28 + ((info.rootPc - 4) % 12 + 12) % 12;   // E1..D#2
        harmony.push({
          t: round4((bar + j) * barSec),
          dur: round4(barSec),
          bar: bar + j,
          barInSection: j,
          section: i,
          sectionName: sd.name,
          symbol: sym,
          rootPc: info.rootPc,
          intervals: info.intervals.slice(),
          pcs: info.pcs.slice(),
          bassMidi: bassRoot,
          notes: voiceChord(info, 52, 76),
          minor: info.minor,
          dominant: info.dominant
        });
      }
      bar += sd.bars;
    }

    var totalBars = bar;
    var musicEnd = totalBars * barSec;
    var tail = Math.min(2.4, barSec);       // ring-out do acorde final

    // Normalizacao de densidade: garante que a media da musica bata o alvo.
    var wsum = 0;
    for (i = 0; i < sections.length; i++) wsum += sections[i].dur * sections[i].dens;
    var densNorm = wsum > 0 ? (musicEnd / wsum) : 1;

    return {
      def: def,
      beatSec: beatSec,
      barSec: barSec,
      slotSec: slotSec,
      beatsPerBar: beatsPerBar,
      sections: sections,
      harmony: harmony,
      totalBars: totalBars,
      musicEnd: musicEnd,
      durationSec: round4(musicEnd + tail),
      densNorm: densNorm,
      rootMidi: 48 + parseNoteName(def.key)
    };
  }

  function round4(v) { return Math.round(v * 10000) / 10000; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ===========================================================================
     9. COMPOSICAO DA LINHA DE GUITARRA (eventos com altura)
     =========================================================================== */

  function inWindow(list, secIdx, barInSec) {
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (w.sec === secIdx && barInSec >= w.bar && barInSec < w.bar + w.bars) return true;
    }
    return false;
  }

  // Forca ritmica da posicao na grade (usada para reduzir dificuldade).
  function slotStrength(slot) {
    var s = slot % 16;
    if (s === 0) return 10;
    if (s === 8) return 8;
    if (s === 4 || s === 12) return 6;
    if (s % 2 === 0) return 4;
    return 2;
  }

  function buildLeadEvents(def, tl, rng) {
    var events = [];
    var pool = RHYTHM[def.pool] || RHYTHM.guitarrada;
    var cadPool = CADENCE[def.pool] || CADENCE.guitarrada;
    var barSec = tl.barSec, slotSec = tl.slotSec;
    var rootMidi = tl.rootMidi;
    var si, b, k;

    for (si = 0; si < tl.sections.length; si++) {
      var sec = tl.sections[si];
      var scale = SCALES[sec.scaleName] || SCALES.mixolydian;
      var rolePool = pool[sec.role] || pool.melody;
      var motifPool = MOTIFS[sec.role] || MOTIFS.melody;
      var regLo = sec.reg[0], regHi = sec.reg[1];
      var phraseLen = sec.phrase;
      var barPlan = null, motif = null, shifts = null, motifPos = 0;
      var secStart = events.length;
      // Probabilidade de bordado: ajusta a densidade do genero sem perder o motivo.
      var ornProb = (def.ornament !== undefined ? def.ornament : 0.3) * (sec.role === 'sparse' ? 0.7 : 1);

      for (b = 0; b < sec.bars; b++) {
        var absBar = sec.bar0 + b;
        var barT = absBar * barSec;
        var pib = b % phraseLen;
        var isLastBar = (b === sec.bars - 1);
        var isStopBar = sec.stops.indexOf(b) >= 0;

        // Material novo a cada frase: dois padroes + cadencia (A A' B cad).
        if (pib === 0) {
          var pa = rng.pick(rolePool);
          var pb = rng.chance(0.62) ? pa : rng.pick(rolePool);
          var pc = rng.pick(rolePool);
          var cad = (sec.role === 'solo') ? rng.pick(CADENCE_SOLO) : rng.pick(cadPool);
          barPlan = (phraseLen === 2) ? [pa, cad] : [pa, pb, pc, cad];
          motif = rng.pick(motifPool);
          shifts = rng.pick(PHRASE_SHIFTS);
          if (sec.role === 'solo') motifPos = 0;
        }
        if (sec.role !== 'solo') motifPos = 0;

        var patStr = barPlan[pib % barPlan.length];
        if (isLastBar && !isStopBar) {
          patStr = (sec.role === 'solo') ? rng.pick(CADENCE_SOLO) : rng.pick(cadPool);
        }
        if (isStopBar) patStr = STOP_PATTERN;

        var slots = parsePattern(patStr);
        var harm = tl.harmony[absBar];
        var chordInfo = parseChord(harm.symbol);
        var shift = shifts[pib % shifts.length];

        // Ancora: riff acompanha a fundamental do acorde; tema/solo ancoram na tonica.
        var anchorMidi;
        if (sec.role === 'riff') {
          anchorMidi = foldToRange(48 + harm.rootPc, regLo, Math.min(regHi, regLo + 14));
        } else {
          anchorMidi = foldToRange(rootMidi, regLo, Math.min(regHi, regLo + 14));
        }
        var anchorStep = stepOfMidi(anchorMidi, rootMidi, scale) + shift;

        var inTapZone = inWindow(def.taps, si, b);

        for (k = 0; k < slots.length; k++) {
          var sl = slots[k];
          var t = barT + sl.s * slotSec;
          var deg = motif[motifPos % motif.length];
          motifPos++;

          var step = anchorStep + deg;
          var midi = midiOfStep(step, rootMidi, scale);
          midi = foldToRange(midi, regLo, regHi);

          var strongSlot = (sl.s % 8 === 0);
          var longNote = sl.d >= 3;
          if (strongSlot || longNote || sl.accent || rng.chance(0.24)) {
            midi = nearestChordTone(midi, chordInfo.pcs);
            midi = foldToRange(midi, regLo, regHi);
          }

          var isOpen = isStopBar;
          if (isOpen) {
            // Nota aberta = golpe de acorde inteiro; a guitarra toca a fundamental grave.
            midi = foldToRange(40 + harm.rootPc, 40, 55);
          }

          var durSec = sl.d * slotSec;
          var strength = slotStrength(sl.s)
            + (sl.accent ? 2 : 0)
            + (sl.d >= 4 ? 2 : (sl.d >= 2 ? 1 : 0))
            + (b % 4 === 0 ? 1 : 0)
            + (k === 0 ? 1 : 0);
          if (isOpen) strength += 8;
          if (isLastBar && k === slots.length - 1) strength += 4;

          // Voicing (acordes de 2/3 notas nos acentos).
          var voicing = 1, voiceDown = false;
          if (!isOpen && sl.accent && sec.role !== 'solo') {
            if (isLastBar && sl.s === 0 && rng.chance(0.8)) voicing = 3;
            else if (rng.chance(sec.chordProb)) voicing = rng.chance(0.22) ? 3 : 2;
          } else if (!isOpen && sl.accent && sec.role === 'solo' && rng.chance(sec.chordProb)) {
            voicing = 2;
          }
          if (voicing >= 2) { voiceDown = rng.chance(0.55); strength += 2; }
          if (isOpen) voicing = 1;
          if (inTapZone) voicing = 1;

          var ev = {
            t: round4(t),
            slot: sl.s,
            bar: absBar,
            barInSection: b,
            sec: si,
            midi: midi,
            step: stepOfMidi(midi, rootMidi, scale),
            durSlots: sl.d,
            durSec: round4(durSec),
            accent: sl.accent,
            open: isOpen,
            voicing: voicing,
            voiceDown: voiceDown,
            tapZone: inTapZone && !isOpen,
            strength: strength,
            scale: scale,
            chordPcs: chordInfo.pcs,
            must: isOpen || (isLastBar && sl.s === 0) || (b === 0 && sl.s === 0),
            anchor: false,
            lane: 0
          };
          events.push(ev);

          /* --------------------------------------------------------------
             Bordados (ornamentos): notas de aproximacao em semicolcheia
             logo antes do proximo ataque. E o que da o "molho" da guitarrada
             e do samba-rock — e sao as primeiras notas a cair nas
             dificuldades menores, porque nascem com forca baixa.
             -------------------------------------------------------------- */
          if (!isOpen && ornProb > 0) {
            var nextS = (k + 1 < slots.length) ? slots[k + 1].s : 16;
            var gapSlots = nextS - sl.s;
            var nOrn = 0;
            if (gapSlots >= 3 && rng.chance(ornProb)) nOrn = 1;
            if (gapSlots >= 7 && nOrn === 1 && rng.chance(ornProb * 0.7)) nOrn = 2;

            if (nOrn > 0) {
              var ornDir = rng.chance(0.55) ? 1 : -1;
              var baseStep = ev.step;
              for (var o = 0; o < nOrn; o++) {
                var oSlot = nextS - nOrn + o;
                var oStep = baseStep + ornDir * (nOrn - o);
                var oMidi = foldToRange(midiOfStep(oStep, rootMidi, scale), regLo, regHi);
                events.push({
                  t: round4(barT + oSlot * slotSec),
                  slot: oSlot,
                  bar: absBar,
                  barInSection: b,
                  sec: si,
                  midi: oMidi,
                  step: stepOfMidi(oMidi, rootMidi, scale),
                  durSlots: 1,
                  durSec: round4(slotSec),
                  accent: false,
                  open: false,
                  voicing: 1,
                  voiceDown: false,
                  tapZone: inTapZone,
                  strength: 1 + (oSlot % 2 === 0 ? 1 : 0),
                  scale: scale,
                  chordPcs: chordInfo.pcs,
                  must: false,
                  anchor: false,
                  ornament: true,
                  lane: 0
                });
              }
              // A nota principal encurta para dar lugar ao bordado.
              var newDur = Math.max(1, (nextS - nOrn) - sl.s);
              ev.durSlots = newDur;
              ev.durSec = round4(newDur * slotSec);
            }
          }
        }
      }

      // Ancoragens de raia: inicio da secao e a cada 8 compassos.
      for (k = secStart; k < events.length; k++) {
        var e = events[k];
        if (k === secStart) { e.anchor = true; continue; }
        var prev = events[k - 1];
        if (e.bar !== prev.bar && ((e.bar - sec.bar0) % 8 === 0)) e.anchor = true;
        if (e.t - prev.t > 0.95) e.anchor = true;
      }
    }

    events.sort(function (a, b2) { return a.t - b2.t; });

    // Faixa de graus por secao — serve de referencia para ancorar as raias.
    for (si = 0; si < tl.sections.length; si++) {
      var s2 = tl.sections[si];
      var lo = 1e9, hi = -1e9;
      for (k = 0; k < events.length; k++) {
        if (events[k].sec !== si || events[k].open) continue;
        if (events[k].step < lo) lo = events[k].step;
        if (events[k].step > hi) hi = events[k].step;
      }
      if (lo > hi) { lo = 0; hi = 1; }
      s2.stepLo = lo;
      s2.stepHi = hi;
    }

    return events;
  }

  /* ===========================================================================
     10. REDUCAO POR DIFICULDADE (escolhe as notas mais fortes, com espacamento)
     =========================================================================== */

  function binaryInsertPos(arr, t) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function gapOk(sorted, t, minGap) {
    var p = binaryInsertPos(sorted, t);
    if (p > 0 && t - sorted[p - 1].t < minGap) return false;
    if (p < sorted.length && sorted[p].t - t < minGap) return false;
    return true;
  }

  /*
     Reducao de dificuldade, compasso a compasso.
     A secao define QUANTAS gems cabem; a proporcao e aplicada por compasso, de
     modo que compassos densos continuem densos (a corrida do solo sobrevive) e
     os cortes fiquem distribuidos pela musica inteira, nunca so no fim.
     Dentro do compasso escolhemos sempre as posicoes ritmicas mais fortes —
     que e exatamente como um charter reduz um chart Expert para Hard/Medium.
  */
  function reduceEvents(all, tl, cfg, rng) {
    var minGap = Math.max(cfg.minGapAbs, cfg.minGap16 * tl.slotSec);
    var chosen = [];
    var si, i, e;

    var bySec = [];
    for (si = 0; si < tl.sections.length; si++) bySec.push([]);
    for (i = 0; i < all.length; i++) bySec[all[i].sec].push(all[i]);

    for (si = 0; si < tl.sections.length; si++) {
      var sec = tl.sections[si];
      var pool = bySec[si];
      if (!pool.length) continue;

      var targetGems = cfg.nps * sec.dur * sec.dens * tl.densNorm;

      // Material gerado nesta secao (em gems, ja limitado pelo tamanho de acorde).
      var genGems = 0;
      for (i = 0; i < pool.length; i++) genGems += Math.min(pool[i].voicing, cfg.maxChord);
      // maxRatio garante que cada nivel seja SEMPRE uma reducao real do nivel de
      // cima, mesmo quando a musica gera pouco material (brega, samba-rock).
      var maxRatio = cfg.maxRatio !== undefined ? cfg.maxRatio : 1;
      var ratio = genGems > 0 ? Math.min(maxRatio, targetGems / genGems) : maxRatio;

      // Agrupa por compasso preservando a ordem temporal.
      var bars = {}, barList = [];
      for (i = 0; i < pool.length; i++) {
        e = pool[i];
        if (!bars[e.bar]) { bars[e.bar] = []; barList.push(e.bar); }
        bars[e.bar].push(e);
      }
      barList.sort(function (a, b) { return a - b; });

      var picked = [];        // ordenado por t (nivel de secao)
      var openCount = 0;
      var bi;

      for (bi = 0; bi < barList.length; bi++) {
        var barEvs = bars[barList[bi]];
        var barGems = 0;
        for (i = 0; i < barEvs.length; i++) barGems += Math.min(barEvs[i].voicing, cfg.maxChord);
        var barTarget = (ratio >= 1) ? 1e9 : Math.max(1, Math.round(barGems * ratio));
        var got = 0;

        // 1) obrigatorios (paradas abertas, primeiro/ultimo compasso da secao)
        for (i = 0; i < barEvs.length; i++) {
          e = barEvs[i];
          if (!e.must) continue;
          if (e.open) {
            openCount++;
            if (openCount % cfg.openEvery !== 0) continue;   // 'facil' usa menos abertas
          }
          if (!gapOk(picked, e.t, minGap * 0.8)) continue;
          picked.splice(binaryInsertPos(picked, e.t), 0, e);
          got += 1;
        }

        // 2) o resto por forca ritmica (desempate estavel pelo tempo)
        var order = barEvs.slice();
        order.sort(function (a, b) {
          if (b.strength !== a.strength) return b.strength - a.strength;
          return a.t - b.t;
        });
        for (i = 0; i < order.length; i++) {
          var ev = order[i];
          if (ev.must) continue;
          if (got >= barTarget) break;
          if (!gapOk(picked, ev.t, minGap)) continue;
          picked.splice(binaryInsertPos(picked, ev.t), 0, ev);
          got += Math.min(ev.voicing, cfg.maxChord);
        }
      }

      for (i = 0; i < picked.length; i++) chosen.push(picked[i]);
    }

    chosen.sort(function (a, b) { return a.t - b.t; });
    return chosen;
  }

  function cloneEvent(e) {
    return {
      t: e.t, slot: e.slot, bar: e.bar, barInSection: e.barInSection, sec: e.sec,
      midi: e.midi, step: e.step, durSlots: e.durSlots, durSec: e.durSec,
      accent: e.accent, open: e.open, voicing: e.voicing, voiceDown: e.voiceDown,
      tapZone: e.tapZone, strength: e.strength, scale: e.scale, chordPcs: e.chordPcs,
      anchor: e.anchor, lane: 0, tap: false
    };
  }

  // Ajusta voicing/tap conforme a dificuldade.
  function applyDifficultyVoicing(evs, tl, cfg, rng) {
    var fastLimit = tl.slotSec * 1.6;      // ~semicolcheia, relativo ao andamento
    var i, tapRun = 0;
    for (i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e.open) { e.voicing = 1; e.tap = false; continue; }
      var v = e.voicing;
      if (v > cfg.maxChord) v = cfg.maxChord;
      if (cfg.maxChord === 1) v = 1;
      else if (v >= 2 && cfg.chordKeep !== undefined && cfg.chordKeep < 1) {
        if (!rng.chance(cfg.chordKeep)) v = 1;
      }
      e.voicing = v;

      // Taps: apenas no Expert, dentro das janelas virtuosisticas, em notas rapidas.
      e.tap = false;
      if (cfg.tap && e.tapZone && v === 1) {
        var prev = evs[i - 1];
        var fast = prev && (e.t - prev.t) < fastLimit;
        // Rajadas de tap tem comeco e fim: a primeira nota e palhetada e a
        // sequencia nao passa de dez notas (senao vira parede sem graca).
        if (fast) { tapRun++; if (tapRun >= 2 && tapRun <= 11) e.tap = true; }
        else tapRun = 0;
      } else {
        tapRun = 0;
      }
    }
  }

  /* ===========================================================================
     11. MAPEAMENTO CONTORNO -> RAIAS
     Regras: movimento por escadinha nas corridas, saltos limitados em intervalos
     curtos, ancoragem por registro no inicio de frase, rolagem de oitava em
     corridas monotonicas longas, e garantia de que grau diferente muda de raia.
     =========================================================================== */

  function assignLanes(evs, tl, cfg) {
    var maxLane = cfg.lanes - 1;
    var fastGap = tl.slotSec * 2.4;     // ~colcheia
    var lane = Math.floor(maxLane / 2);
    var prev = null;
    var i;

    for (i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e.open) { e.lane = 0; continue; }

      var sec = tl.sections[e.sec];
      var needAnchor = (!prev) || e.anchor || (e.t - prev.t) > 0.95 || prev.sec !== e.sec;

      if (needAnchor) {
        var span = Math.max(1, sec.stepHi - sec.stepLo);
        var target = clamp(Math.round((e.step - sec.stepLo) / span * maxLane), 0, maxLane);
        // Ancorar nunca pode virar teleporte: se a nota anterior esta colada,
        // limita o deslocamento a duas raias (a mao precisa alcancar).
        if (prev && (e.t - prev.t) < 0.2) {
          if (target - lane > 2) target = lane + 2;
          else if (lane - target > 2) target = lane - 2;
        }
        lane = clamp(target, 0, maxLane);
      } else {
        var ds = e.step - prev.step;
        var dt = e.t - prev.t;
        var fast = dt < fastGap;
        var maxJump = fast ? 2 : 3;
        if (cfg.lanes <= 3) maxJump = fast ? 1 : 2;
        else if (cfg.lanes === 4) maxJump = fast ? 2 : 2;

        var dl;
        if (ds === 0) dl = 0;
        else if (Math.abs(ds) <= 2 && fast) dl = (ds > 0 ? 1 : -1);          // escadinha
        else if (ds > 0) dl = Math.min(ds, maxJump);
        else dl = Math.max(ds, -maxJump);

        // Nas bordas a linha "reflete" (sobe e volta a descer). Nada de rolar de
        // uma ponta a outra da pista: isso viraria salto impossivel.
        var nl = lane + dl;
        if (nl > maxLane) nl = maxLane - (nl - maxLane);
        else if (nl < 0) nl = -nl;
        nl = clamp(nl, 0, maxLane);
        if (dl !== 0 && nl === lane) {
          nl = clamp(lane + (dl > 0 ? -1 : 1), 0, maxLane);
          if (nl === lane) nl = clamp(lane + (dl > 0 ? 1 : -1), 0, maxLane);
        }
        lane = nl;
      }

      // Acordes de 3 notas precisam de espaco em volta.
      if (e.voicing === 3) lane = clamp(lane, 1, maxLane - 1);
      else if (e.voicing === 2 && lane >= maxLane) lane = maxLane - 1;

      e.lane = lane;
      prev = e;
    }
  }

  function voiceLanes(base, n, maxLane, down) {
    if (n <= 1) return [base];
    if (n === 2) {
      if (down) return (base > 0) ? [base - 1, base] : [base, base + 1];
      return (base < maxLane) ? [base, base + 1] : [base - 1, base];
    }
    var c = clamp(base, 1, maxLane - 1);
    return [c - 1, c, c + 1];
  }

  /* ===========================================================================
     12. EVENTOS -> NOTAS DO CHART
     =========================================================================== */

  function eventsToNotes(evs, tl, cfg) {
    var notes = [];
    var maxLane = cfg.lanes - 1;
    // Limiar de sustain relativo ao andamento: vira sustain a partir da
    // colcheia pontuada, do samba lento ao frevo acelerado.
    var susMin = Math.max(cfg.sustainMin, (cfg.sustainBeats || 0.7) * tl.beatSec);
    var i, j;

    for (i = 0; i < evs.length; i++) {
      var e = evs[i];
      var sustain = e.durSec >= susMin ? round4(e.durSec - cfg.sustainTrim) : 0;
      if (sustain < 0.14) sustain = 0;

      if (e.open) {
        notes.push({
          t: e.t, lane: 0, dur: sustain, hopo: false, tap: false, open: true,
          midi: e.midi, sp: false
        });
        continue;
      }

      var lanes = voiceLanes(e.lane, e.voicing, maxLane, e.voiceDown);
      for (j = 0; j < lanes.length; j++) {
        var ln = clamp(lanes[j], 0, maxLane);
        notes.push({
          t: e.t,
          lane: ln,
          dur: sustain,
          hopo: false,
          tap: !!e.tap,
          open: false,
          midi: e.midi + (j === 0 ? 0 : 0),
          sp: false
        });
      }
    }

    notes.sort(function (a, b) { return (a.t - b.t) || (a.lane - b.lane); });
    return notes;
  }

  /* ===========================================================================
     13. HOPOs — convencao Guitar Hero
     HOPO quando a nota vem em intervalo menor que uma colcheia, e sozinha, e em
     raia diferente da anterior. Acorde nunca vira HOPO; tap tambem nao.
     =========================================================================== */

  function groupByTime(notes) {
    var groups = [], i = 0;
    while (i < notes.length) {
      var g = [notes[i]];
      var j = i + 1;
      while (j < notes.length && Math.abs(notes[j].t - notes[i].t) < 1e-4) { g.push(notes[j]); j++; }
      groups.push(g);
      i = j;
    }
    return groups;
  }

  function markHopos(notes, tl, cfg) {
    var groups = groupByTime(notes);
    // Convencao Guitar Hero: HOPO so em intervalo MENOR que uma colcheia.
    // Colcheia exata continua sendo palhetada — e o que mantem o chart honesto.
    var eighth = tl.beatSec * 0.5;
    var limit = eighth * 0.98;
    var i, k;
    for (i = 0; i < groups.length; i++) {
      var g = groups[i];
      for (k = 0; k < g.length; k++) g[k].hopo = false;
      if (!cfg.hopo || i === 0) continue;
      if (g.length !== 1) continue;
      var n = g[0];
      if (n.open || n.tap) continue;
      var pg = groups[i - 1];
      if (n.t - pg[0].t >= limit) continue;
      var sameLane = false;
      for (k = 0; k < pg.length; k++) if (pg[k].lane === n.lane) sameLane = true;
      if (sameLane || pg[0].open) continue;
      n.hopo = true;
    }
  }

  /* ===========================================================================
     14. SUSTAINS — nenhum sustain pode colidir com a proxima nota da mesma raia
     (nem com uma nota aberta, que cruza a pista inteira).
     =========================================================================== */

  function fixSustains(notes, cfg) {
    var i, j;
    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.dur <= 0) continue;
      var limitT = Infinity;
      for (j = i + 1; j < notes.length; j++) {
        var m = notes[j];
        if (m.t <= n.t + 1e-4) continue;
        if (m.open || n.open || m.lane === n.lane) { limitT = m.t; break; }
        if (m.t - n.t > n.dur + 0.5) break;
      }
      if (limitT !== Infinity) {
        var maxDur = limitT - n.t - 0.055;
        if (maxDur < n.dur) n.dur = round4(maxDur);
      }
      if (n.dur < 0.14) n.dur = 0;
      else n.dur = round4(n.dur);
    }
  }

  /* ===========================================================================
     15. STAR POWER — 4 a 6 frases por musica, sempre fechando em acorde/sustain.
     =========================================================================== */

  function isStrongGroup(g) {
    return g.length > 1 || g[0].dur >= 0.2 || g[0].open;
  }

  // Insere uma nota mantendo a ordem (t, lane) do chart.
  function insertNote(notes, note) {
    var lo = 0, hi = notes.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      var m = notes[mid];
      if (m.t < note.t - 1e-6 || (Math.abs(m.t - note.t) <= 1e-6 && m.lane < note.lane)) lo = mid + 1;
      else hi = mid;
    }
    notes.splice(lo, 0, note);
  }

  function applyStarPower(notes, tl, def, cfg) {
    if (!def.sp || !def.sp.length) return [];
    var phrases = [];
    var groups = groupByTime(notes);
    var maxLane = cfg.lanes - 1;
    var w, i, gi;

    for (w = 0; w < def.sp.length; w++) {
      var win = def.sp[w];
      var sec = tl.sections[win.sec];
      if (!sec) continue;
      var t0 = sec.t + win.bar * tl.barSec;
      var t1 = t0 + win.bars * tl.barSec;

      var first = -1, last = -1;
      for (gi = 0; gi < groups.length; gi++) {
        var gt = groups[gi][0].t;
        if (gt >= t0 - 1e-4 && gt < t1 - 1e-4) { if (first < 0) first = gi; last = gi; }
      }
      if (first < 0 || last < first) continue;

      // Nao deixa duas frases se sobrepor.
      if (phrases.length && first <= phrases[phrases.length - 1].lastGroup) {
        first = phrases[phrases.length - 1].lastGroup + 1;
        if (first > last) continue;
      }

      /* A frase de Star Power SEMPRE fecha em algo marcante — acorde, nota
         aberta ou sustain. Tentamos, em ordem:
           1) esticar ate o proximo grupo forte;
           2) transformar a ultima nota num acorde de duas notas;
           3) transformar a ultima nota num sustain curto;
           4) recuar ate o ultimo grupo forte que ja existia na frase.       */
      if (!isStrongGroup(groups[last])) {
        var ext = last;
        var deadline = groups[last][0].t + 2.5;
        while (ext + 1 < groups.length && groups[ext + 1][0].t <= deadline) {
          ext++;
          if (isStrongGroup(groups[ext])) break;
        }
        if (ext < groups.length && isStrongGroup(groups[ext])) {
          last = ext;
        } else {
          var g = groups[last];
          var nextT = (last + 1 < groups.length) ? groups[last + 1][0].t : Infinity;
          var room = (nextT === Infinity) ? 0.6 : (nextT - g[0].t - 0.06);
          var done = false;

          if (cfg.maxChord >= 2 && g.length === 1 && !g[0].open) {
            var base = g[0];
            var nl = (base.lane < maxLane) ? base.lane + 1 : base.lane - 1;
            if (nl >= 0 && nl <= maxLane) {
              var extra = {
                t: base.t, lane: nl, dur: base.dur, hopo: false, tap: false,
                open: false, midi: base.midi, sp: false
              };
              base.hopo = false; base.tap = false;
              insertNote(notes, extra);
              g.push(extra);
              g.sort(function (a, b) { return a.lane - b.lane; });
              done = true;
            }
          }
          if (!done && room > 0.24) {
            for (i = 0; i < g.length; i++) g[i].dur = round4(Math.min(0.5, room));
            done = true;
          }
          if (!done) {
            var back = last;
            while (back > first && !isStrongGroup(groups[back])) back--;
            if (back > first) last = back;
          }
        }
      }

      var count = 0;
      for (gi = first; gi <= last; gi++) {
        for (i = 0; i < groups[gi].length; i++) { groups[gi][i].sp = true; count++; }
      }
      if (!count) continue;
      phrases.push({
        tStart: groups[first][0].t,
        tLast: groups[last][0].t,
        tEnd: round4(groups[last][0].t + (groups[last][0].dur || 0)),
        count: count,
        firstGroup: first,
        lastGroup: last
      });
    }
    return phrases;
  }

  /* ===========================================================================
     15B. JANELA DE DEDOS (Facil e Medio)
     Com 3 ou 4 raias sempre a partir do verde, o iniciante so treinaria os
     dedos da esquerda. Aqui a janela anda pela pista de 5 raias, trocando
     logo depois de cada frase de Star Power:
       Facil: meio (2-4) -> direita (3-5) -> esquerda (1-3) -> direita...
       Medio: direita (2-5) -> esquerda (1-4) -> direita...
     A troca cai no primeiro respiro entre notas depois da frase; o tempo dela
     vai em song.laneWindows para a pista avisar o jogador.
     =========================================================================== */

  var LANE_WINDOWS = {
    facil: { first: 1, cycle: [2, 0] },
    medio: { first: 1, cycle: [0, 1] }
  };
  var LW_GAP = 0.45;      // respiro minimo (s) antes da primeira nota da janela nova
  var LW_SEARCH = 4.0;    // quanto procurar esse respiro depois da frase

  function groupEnd(g) {
    var e = g[0].t;
    for (var i = 0; i < g.length; i++) e = Math.max(e, g[i].t + (g[i].dur || 0));
    return e;
  }

  function applyLaneWindows(notes, phrases, tl, cfg, name) {
    var spec = LANE_WINDOWS[name];
    if (!spec || !notes.length) return null;
    var groups = groupByTime(notes);
    var wins = [{ t: 0, lo: spec.first, hi: spec.first + cfg.lanes - 1, g: 0 }];
    var gi = 0, p, k, i, j;

    for (p = 0; p < phrases.length; p++) {
      while (gi < groups.length && groups[gi][0].t <= phrases[p].tLast + 1e-4) gi++;
      if (gi < 1 || gi >= groups.length) break;
      var limitT = groups[gi][0].t + LW_SEARCH;
      if (p + 1 < phrases.length) limitT = Math.min(limitT, phrases[p + 1].tStart);
      // sem respiro bom no trecho, fica com o maior que houver
      var pick = gi, best = -Infinity;
      for (k = gi; k < groups.length && (k === gi || groups[k][0].t < limitT); k++) {
        var gap = groups[k][0].t - groupEnd(groups[k - 1]);
        if (gap > best + 0.02) { best = gap; pick = k; }
        if (gap >= LW_GAP) break;
      }
      var gt = groups[pick][0].t;
      var lead = clamp((gt - groupEnd(groups[pick - 1])) * 0.5, 0.05, 0.5);
      var lo = spec.cycle[(wins.length - 1) % spec.cycle.length];
      wins.push({ t: round4(gt - lead), lo: lo, hi: lo + cfg.lanes - 1, g: pick });
      gi = pick;
    }

    for (k = 0; k < wins.length; k++) {
      var gEnd = (k + 1 < wins.length) ? wins[k + 1].g : groups.length;
      for (i = wins[k].g; i < gEnd; i++) {
        for (j = 0; j < groups[i].length; j++) {
          if (!groups[i][j].open) groups[i][j].lane += wins[k].lo;
        }
      }
      delete wins[k].g;
    }
    fixSustains(notes, cfg);
    markHopos(notes, tl, cfg);
    return wins;
  }

  /* ===========================================================================
     16. VALIDADOR + CONSERTO AUTOMATICO
     =========================================================================== */

  function validateChart(notes, tl, cfg) {
    var issues = { dup: 0, laneFix: 0, chordTrim: 0, openMix: 0, hopoFix: 0, tapFix: 0, gap: 0, sustain: 0, order: 0 };
    var maxLane = cfg.lanes - 1;
    var i, j, k;

    // Ordena (e detecta se estava fora de ordem).
    for (i = 1; i < notes.length; i++) {
      if (notes[i].t < notes[i - 1].t - 1e-6) { issues.order++; break; }
    }
    notes.sort(function (a, b) { return (a.t - b.t) || (a.lane - b.lane); });

    // Quantiza tempo e conserta raia fora de faixa.
    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      n.t = round4(n.t);
      if (n.open) { n.lane = 0; n.tap = false; n.hopo = false; continue; }
      if (n.lane < 0 || n.lane > maxLane) { n.lane = clamp(n.lane, 0, maxLane); issues.laneFix++; }
      if (!cfg.hopo && n.hopo) { n.hopo = false; issues.hopoFix++; }
      if (!cfg.tap && n.tap) { n.tap = false; issues.tapFix++; }
    }

    // Duplicatas exatas (mesmo t + mesma raia) e mistura aberta/raia.
    var out = [];
    var groups = groupByTime(notes);
    for (i = 0; i < groups.length; i++) {
      var g = groups[i];
      var hasOpen = false;
      for (j = 0; j < g.length; j++) if (g[j].open) hasOpen = true;
      if (hasOpen) {
        // Nota aberta e exclusiva no seu instante.
        var openNote = null;
        for (j = 0; j < g.length; j++) if (g[j].open && !openNote) openNote = g[j];
        if (g.length > 1) issues.openMix += (g.length - 1);
        out.push(openNote);
        continue;
      }
      var seen = {}, keep = [];
      for (j = 0; j < g.length; j++) {
        var key = g[j].lane;
        if (seen[key]) { issues.dup++; continue; }
        seen[key] = 1;
        keep.push(g[j]);
      }
      keep.sort(function (a, b) { return a.lane - b.lane; });
      if (keep.length > cfg.maxChord) {
        issues.chordTrim += (keep.length - cfg.maxChord);
        keep = keep.slice(0, cfg.maxChord);
      }
      // Tap dentro de acorde nao existe.
      if (keep.length > 1) for (j = 0; j < keep.length; j++) { keep[j].tap = false; keep[j].hopo = false; }
      for (j = 0; j < keep.length; j++) out.push(keep[j]);
    }
    notes.length = 0;
    for (i = 0; i < out.length; i++) notes.push(out[i]);

    // Espacamento minimo entre ataques distintos (playability).
    var minGap = Math.max(cfg.minGapAbs, cfg.minGap16 * tl.slotSec) * 0.92;
    groups = groupByTime(notes);
    var kept = [], lastT = -1e9;
    for (i = 0; i < groups.length; i++) {
      var gt = groups[i][0].t;
      if (gt - lastT < minGap && lastT > -1e8) {
        // Mantem o grupo mais forte; descarta o mais fraco.
        var prevStrong = kept.length ? (kept[kept.length - 1].length + (kept[kept.length - 1][0].dur > 0 ? 1 : 0)) : 0;
        var curStrong = groups[i].length + (groups[i][0].dur > 0 ? 1 : 0);
        if (curStrong > prevStrong) { kept[kept.length - 1] = groups[i]; lastT = gt; }
        issues.gap++;
        continue;
      }
      kept.push(groups[i]);
      lastT = gt;
    }
    notes.length = 0;
    for (i = 0; i < kept.length; i++) for (j = 0; j < kept[i].length; j++) notes.push(kept[i][j]);
    notes.sort(function (a, b) { return (a.t - b.t) || (a.lane - b.lane); });

    // Sustains: revalida colisao depois de todas as remocoes.
    var before = 0;
    for (i = 0; i < notes.length; i++) if (notes[i].dur > 0) before++;
    fixSustains(notes, cfg);
    var after = 0;
    for (i = 0; i < notes.length; i++) if (notes[i].dur > 0) after++;
    issues.sustain = before - after;

    // HOPO precisa ser recalculado apos remocoes.
    markHopos(notes, tl, cfg);

    // Limpa campos auxiliares e garante tipos.
    for (i = 0; i < notes.length; i++) {
      var nn = notes[i];
      nn.lane = nn.open ? 0 : (nn.lane | 0);
      nn.dur = nn.dur > 0 ? round4(nn.dur) : 0;
      nn.hopo = !!nn.hopo;
      nn.tap = !!nn.tap;
      nn.open = !!nn.open;
      nn.sp = !!nn.sp;
    }
    for (k in issues) { if (!issues[k]) delete issues[k]; }
    return issues;
  }

  /* ===========================================================================
     17. ARRANJO PARA O GH.Synth
     =========================================================================== */

  function buildArrangement(def, tl, leadEvents) {
    var i, j;
    var secOut = [];
    var stops = [], fills = [], hits = [];

    for (i = 0; i < tl.sections.length; i++) {
      var sec = tl.sections[i];
      var sd = sec.def;
      var prog = [];
      for (j = 0; j < sec.bars; j++) prog.push(sd.chords[j % sd.chords.length]);

      // Viradas de bateria no ultimo compasso de cada frase de 4.
      for (j = 3; j < sec.bars; j += 4) {
        if (sec.intensity >= 0.4) fills.push(round4(sec.t + j * tl.barSec + tl.barSec * 0.5));
      }
      for (j = 0; j < sec.stops.length; j++) stops.push(round4(sec.t + sec.stops[j] * tl.barSec));

      secOut.push({
        index: i,
        name: sec.name,
        t: sec.t,
        dur: sec.dur,
        end: sec.end,
        bars: sec.bars,
        bar0: sec.bar0,
        barSec: round4(tl.barSec),
        key: def.key,
        scale: sec.scaleName,
        chordProgression: prog,
        // Apelidos: alguns consumidores procuram 'chords'/'progression'.
        chords: prog.slice(),
        progression: prog.slice(),
        chordsPerBar: 1,
        density: round4(clamp(sec.dens / 1.5, 0.1, 1)),
        intensity: sec.intensity,
        dynamics: sec.dyn,
        drumPattern: def.drumPattern,
        drumVariant: def.drumVariant,
        drums: sd.drums,
        bassPattern: sd.bassPattern || def.bassPattern,
        bass: sd.bass,
        percussion: (sd.percussion || def.percussion).slice(),
        leadRole: sec.leadRole,
        keys: sd.keys,
        brass: sd.brass,
        pads: sd.pads,
        stops: sec.stops.map(function (b) { return round4(sec.t + b * tl.barSec); })
      });
    }

    // Linha de lead: exatamente os eventos do chart 'guitarrada'.
    var lead = [];
    for (i = 0; i < leadEvents.length; i++) {
      var e = leadEvents[i];
      var midis = [e.midi];
      if (e.voicing >= 2 && !e.open) {
        var sc = e.scale;
        var st = stepOfMidi(e.midi, tl.rootMidi, sc);
        midis.push(midiOfStep(st + (e.voiceDown ? -2 : 2), tl.rootMidi, sc));
        if (e.voicing >= 3) midis.push(midiOfStep(st + (e.voiceDown ? -4 : 4), tl.rootMidi, sc));
        midis.sort(function (a, b) { return a - b; });
      }
      if (e.voicing >= 2) hits.push(e.t);
      lead.push({
        t: e.t,
        dur: round4(Math.max(0.06, e.durSec - 0.02)),
        midi: e.midi,
        midis: midis,
        vel: round4(clamp(0.5 + e.strength / 22, 0.45, 1)),
        artic: e.open ? 'open' : (e.tap ? 'tap' : (e.accent ? 'accent' : 'pick')),
        section: e.sec
      });
    }

    // Linha do tempo de acordes: um acorde por compasso, com tempo absoluto.
    // E o formato mais direto para o sintetizador — baixo, teclado, metais e
    // guitarra leem daqui e ficam todos na MESMA musica que o chart.
    var chordTimeline = [];
    for (i = 0; i < tl.harmony.length; i++) {
      var h = tl.harmony[i];
      chordTimeline.push({
        t: h.t, dur: h.dur, bar: h.bar, section: h.section,
        name: h.symbol, symbol: h.symbol, rootPc: h.rootPc
      });
    }

    return {
      genre: def.pool,
      key: def.key,
      scale: def.scale,
      soloScale: def.soloScale || def.scale,
      bpm: def.bpm,
      timeSig: def.timeSig.slice(),
      barSec: round4(tl.barSec),
      beatSec: round4(tl.beatSec),
      // Timing RETO de proposito: o chart foi escrito na grade reta de
      // semicolcheias. Se a base balancar, as gems saem do lugar.
      swing: 0,
      swingUnit: 16,
      chordBars: 1,
      timing: { swing: 0, humanizeMs: 0, grid: 16 },
      chordTimeline: chordTimeline,
      instruments: def.instruments,
      drumPattern: def.drumPattern,
      drumVariant: def.drumVariant,
      bassPattern: def.bassPattern,
      percussion: def.percussion.slice(),
      form: secOut.map(function (s) { return s.name; }),
      sections: secOut,
      harmony: tl.harmony,
      lead: { events: lead, instrument: def.instruments.guitar, muteOnMiss: true },
      markers: { stops: stops, fills: fills, hits: hits },
      totalBars: tl.totalBars,
      musicEnd: round4(tl.musicEnd)
    };
  }

  /* ===========================================================================
     18. REDE DE SEGURANCA
     Se algo falhar na composicao, ainda assim entregamos um chart tocavel
     derivado da harmonia (nada de tela preta / musica sem notas).
     =========================================================================== */

  function emergencyChart(tl, cfg) {
    var notes = [];
    var step = tl.beatSec * (cfg.lanes <= 3 ? 2 : 1);
    var lane = 0, dir = 1, t = 0, i = 0;
    while (t < tl.musicEnd - 0.2) {
      notes.push({ t: round4(t), lane: lane, dur: 0, hopo: false, tap: false, open: false, sp: false, midi: 60 });
      lane += dir;
      if (lane >= cfg.lanes) { lane = cfg.lanes - 2; dir = -1; }
      if (lane < 0) { lane = 1; dir = 1; }
      t += step;
      i++;
      if (i > 5000) break;
    }
    return notes;
  }

  /* ===========================================================================
     19. MONTAGEM DAS MUSICAS
     =========================================================================== */

  function statsOf(notes, durationSec) {
    var i, gems = notes.length, chords = 0, hopos = 0, taps = 0, opens = 0, sustains = 0, sp = 0;
    var groups = groupByTime(notes);
    for (i = 0; i < groups.length; i++) if (groups[i].length > 1) chords++;
    for (i = 0; i < notes.length; i++) {
      if (notes[i].hopo) hopos++;
      if (notes[i].tap) taps++;
      if (notes[i].open) opens++;
      if (notes[i].dur > 0) sustains++;
      if (notes[i].sp) sp++;
    }
    // Pico de densidade em janela deslizante de 2s.
    var peak = 0;
    var jStart = 0;
    for (i = 0; i < notes.length; i++) {
      while (notes[i].t - notes[jStart].t > 2) jStart++;
      var d = (i - jStart + 1) / 2;
      if (d > peak) peak = d;
    }
    return {
      notes: gems,
      groups: groups.length,
      nps: round4(gems / Math.max(1, durationSec)),
      peakNps: round4(peak),
      chords: chords,
      hopos: hopos,
      taps: taps,
      opens: opens,
      sustains: sustains,
      spNotes: sp
    };
  }

  function buildSong(def) {
    var tl = buildTimeline(def);
    var charts = {};
    var chartStats = {};
    var spPhrases = {};
    var validation = {};
    var leadSelection = null;
    var laneWindows = {};
    var d, i;

    var allEvents = null;
    try {
      allEvents = buildLeadEvents(def, tl, makeRng(def.seed));
    } catch (err) {
      allEvents = null;
    }

    for (d = 0; d < DIFF_ORDER.length; d++) {
      var name = DIFF_ORDER[d];
      var cfg = DIFFS[name];
      var notes;
      try {
        if (!allEvents) throw new Error('sem eventos');
        var rng = makeRng((def.seed ^ (cfg.salt * 2654435761)) >>> 0);
        var sel = reduceEvents(allEvents, tl, cfg, rng);
        var evs = [];
        for (i = 0; i < sel.length; i++) evs.push(cloneEvent(sel[i]));
        applyDifficultyVoicing(evs, tl, cfg, rng);
        assignLanes(evs, tl, cfg);
        notes = eventsToNotes(evs, tl, cfg);
        markHopos(notes, tl, cfg);
        fixSustains(notes, cfg);
        // Valida/conserta primeiro; so entao marcamos o Star Power, para que a
        // frase termine mesmo no que sobrou no chart.
        validation[name] = validateChart(notes, tl, cfg);
        spPhrases[name] = applyStarPower(notes, tl, def, cfg);
        // O fecho de frase pode ter virado acorde/sustain: revalida os dois
        // campos que dependem da vizinhanca.
        fixSustains(notes, cfg);
        markHopos(notes, tl, cfg);
        if (LANE_WINDOWS[name]) laneWindows[name] = applyLaneWindows(notes, spPhrases[name], tl, cfg, name);
        if (name === 'guitarrada') {
          // A guitarra do GH.Synth toca EXATAMENTE o chart Expert: descarta da
          // linha de lead qualquer evento que o validador tenha removido.
          var alive = {};
          for (i = 0; i < notes.length; i++) alive[notes[i].t.toFixed(4)] = 1;
          leadSelection = [];
          for (i = 0; i < evs.length; i++) {
            if (alive[evs[i].t.toFixed(4)]) leadSelection.push(evs[i]);
          }
        }
      } catch (err2) {
        notes = emergencyChart(tl, cfg);
        validation[name] = { emergency: 1, msg: String(err2 && err2.message || err2) };
        spPhrases[name] = [];
        laneWindows[name] = null;
      }
      charts[name] = notes;
      chartStats[name] = statsOf(notes, tl.musicEnd);
    }

    if (!leadSelection) leadSelection = allEvents || [];

    var song = assembleSong(def, tl, leadSelection, charts, chartStats, spPhrases, validation);
    song.laneWindows = laneWindows;
    return song;
  }

  // O objeto publico de musica — o mesmo formato para as seis musicas e para
  // as musicas sob medida de compose().
  function assembleSong(def, tl, leadSelection, charts, chartStats, spPhrases, validation) {
    var i;
    var sections = [];
    for (i = 0; i < tl.sections.length; i++) {
      var s = tl.sections[i];
      sections.push({
        t: s.t, name: s.name, dur: s.dur, end: s.end,
        index: i, bars: s.bars, bar0: s.bar0,
        intensity: s.intensity, role: s.leadRole
      });
    }

    var song = {
      id: def.id,
      title: def.title,
      artist: def.artist,
      tribute: def.tribute,
      genre: def.genre,
      bpm: def.bpm,
      tempoMap: [{ t: 0, bpm: def.bpm }],
      timeSig: def.timeSig.slice(),
      durationSec: tl.durationSec,
      year: def.year,
      palette: def.palette,
      seed: def.seed,
      key: def.key,
      scale: def.scale,
      difficultyStars: {
        facil: def.stars.facil,
        medio: def.stars.medio,
        dificil: def.stars.dificil,
        guitarrada: def.stars.guitarrada
      },
      cover: {
        hue: def.cover.hue,
        hue2: def.cover.hue2,
        motif: def.cover.motif,
        subtitle: def.cover.subtitle,
        accent: def.palette
      },
      sections: sections,
      arrangement: buildArrangement(def, tl, leadSelection),
      charts: charts,
      chartStats: chartStats,
      starPowerPhrases: spPhrases,
      validation: validation,
      notice: 'Composição original procedural — projeto didático, sem fins comerciais.'
    };

    return song;
  }

  /* ===========================================================================
     19B. MUSICA SOB MEDIDA (usada pelo tutorial)
     O tutorial precisa de notas EXATAS — quatro verdes, depois um bastao —,
     coisa que o compositor procedural nao faz. compose() monta uma musica
     completa em volta de um chart escrito a mao: linha do tempo, harmonia e o
     arranjo do GH.Synth saem do mesmo pipeline das seis musicas, e a guitarra
     toca exatamente as gems do chart (raia -> nota do acorde do compasso).

       def   = campos de musica (id, title, bpm, key, instruments...) com
               sections: [[nome, compassos, cifras, opts], ...]
       notes = [{ t, lane, dur, open, sp }] em segundos — o mesmo chart vale
               para as quatro dificuldades.
     =========================================================================== */

  function composeSong(def, notes) {
    var d = {}, k, i, j;
    for (k in def) if (Object.prototype.hasOwnProperty.call(def, k)) d[k] = def[k];
    d.sections = [];
    for (i = 0; i < def.sections.length; i++) {
      var sd = def.sections[i];
      d.sections.push(S(sd[0], sd[1], sd[2], sd[3]));
    }
    var tl = buildTimeline(d);
    var scale = SCALES[d.scale] || SCALES.major;

    var chart = [];
    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      chart.push({
        t: round4(n.t), lane: n.open ? 0 : clamp(n.lane | 0, 0, 4), dur: round4(n.dur || 0),
        hopo: false, tap: false, open: !!n.open, sp: !!n.sp, midi: 60
      });
    }
    chart.sort(function (a, b) { return a.t - b.t || a.lane - b.lane; });

    // Altura de cada ataque, pela harmonia funcional:
    //  - cada raia tem um ALVO fixo no arpejo da tonica (verde = tonica,
    //    vermelho = terca, amarelo = quinta, azul/laranja = oitava acima), entao
    //    subir de raia e sempre subir de altura e a melodia tem contorno;
    //  - em cada compasso o alvo cai na nota MAIS PROXIMA do acorde vigente:
    //    no V7 o verde vira a sensivel, que resolve na tonica no compasso
    //    seguinte. Nada de nota fora do acorde, nada de salto cromatico.
    //  - o bastao e a fundamental do acorde, no grave.
    var rootPc = parseNoteName(d.key);
    var base = foldToRange(48 + rootPc, 55, 66);
    var third = scale[2] || 4;
    var targets = [base, base + third, base + 7, base + 12, base + 12 + third];
    var laneCache = {};
    function laneMidis(h) {
      if (laneCache[h.symbol]) return laneCache[h.symbol];
      var tones = [], m, k;
      for (m = base - 6; m <= base + 24; m++) if (h.pcs.indexOf(m % 12) >= 0) tones.push(m);
      var out = [], prev = -1;
      for (k = 0; k < targets.length; k++) {
        var best = -1;
        for (var q = 0; q < tones.length; q++) {
          if (tones[q] <= prev) continue;
          if (best < 0 || Math.abs(tones[q] - targets[k]) < Math.abs(best - targets[k]) ||
              (Math.abs(tones[q] - targets[k]) === Math.abs(best - targets[k]) && tones[q] > best)) best = tones[q];
        }
        if (best < 0) best = prev + 12;
        out.push(best);
        prev = best;
      }
      laneCache[h.symbol] = out;
      return out;
    }

    var lead = [], exact = [];
    var groups = groupByTime(chart);
    for (i = 0; i < groups.length; i++) {
      var g = groups[i];
      var h = tl.harmony[clamp(Math.floor(g[0].t / tl.barSec + 1e-6), 0, tl.harmony.length - 1)];
      var lm = laneMidis(h), mids = [], dur = 0;
      for (j = 0; j < g.length; j++) {
        g[j].midi = g[j].open ? 40 + ((h.rootPc - 4) % 12 + 12) % 12 : lm[g[j].lane];
        mids.push(g[j].midi);
        dur = Math.max(dur, g[j].dur);
      }
      mids.sort(function (a, b) { return a - b; });
      exact.push(mids);
      lead.push({
        t: g[0].t, durSec: dur > 0 ? dur : tl.beatSec, midi: mids[0],
        voicing: 1, open: g[0].open, tap: false,
        accent: g.length > 1, strength: 8, sec: h.section, scale: scale, voiceDown: false
      });
    }

    var charts = {}, chartStats = {}, spPhrases = {}, validation = {};
    for (i = 0; i < DIFF_ORDER.length; i++) {
      charts[DIFF_ORDER[i]] = chart;
      chartStats[DIFF_ORDER[i]] = statsOf(chart, tl.musicEnd);
      spPhrases[DIFF_ORDER[i]] = [];
      validation[DIFF_ORDER[i]] = { custom: 1 };
    }
    var song = assembleSong(d, tl, lead, charts, chartStats, spPhrases, validation);
    // Acorde de duas cores soa EXATAMENTE as duas notas das raias (o arranjo
    // empilharia uma terca da escala por conta propria).
    var evs = song.arrangement.lead.events;
    for (i = 0; i < evs.length && i < exact.length; i++) evs[i].midis = exact[i];
    return song;
  }

  /* ===========================================================================
     20. EXPORTA GH.Songs
     =========================================================================== */

  var songs = [];
  for (var si2 = 0; si2 < SONG_DEFS.length; si2++) {
    try {
      songs.push(buildSong(SONG_DEFS[si2]));
    } catch (e) {
      if (window.__GH_fatal) window.__GH_fatal('songs.js: falha ao montar "' + SONG_DEFS[si2].id + '": ' + e.message);
    }
  }

  songs.byId = function (id) {
    for (var i = 0; i < songs.length; i++) if (songs[i].id === id) return songs[i];
    return null;
  };

  songs.difficulties = DIFF_ORDER.slice();
  songs.difficultyLabels = {
    facil: DIFF_LABELS.facil,
    medio: DIFF_LABELS.medio,
    dificil: DIFF_LABELS.dificil,
    guitarrada: DIFF_LABELS.guitarrada
  };
  songs.labelOf = function (diff) { return songs.difficultyLabels[diff] || diff; };

  // Musica sob medida em volta de um chart escrito a mao (secao 19B). Nao
  // entra na lista: quem compoe guarda a musica.
  songs.compose = composeSong;

  // Diagnostico (usado pelas ferramentas de verificacao e pelo menu de debug).
  songs.report = function () {
    var out = [];
    for (var i = 0; i < songs.length; i++) {
      var s = songs[i];
      var row = { id: s.id, title: s.title, bpm: s.bpm, dur: s.durationSec, diffs: {} };
      for (var d = 0; d < DIFF_ORDER.length; d++) {
        var k = DIFF_ORDER[d];
        row.diffs[k] = s.chartStats[k];
        row.diffs[k].issues = s.validation[k];
        row.diffs[k].spPhrases = (s.starPowerPhrases[k] || []).length;
      }
      out.push(row);
    }
    return out;
  };

  GH.Songs = songs;

})(window.GH = window.GH || {});

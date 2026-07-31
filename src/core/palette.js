/* ===========================================================================
   GUITARRADA HERO — src/core/palette.js
   ---------------------------------------------------------------------------
   TODA cor do jogo sai daqui. Ninguem hardcoda hex fora deste arquivo.
   Nao depende de nenhum outro modulo GH (so de THREE, e de forma defensiva).

   DIRECAO DE ARTE
   ---------------
   As 5 raias seguem a ordem canonica do Guitar Hero
   (0 verde, 1 vermelho, 2 amarelo, 3 azul, 4 laranja), mas com tratamento
   cromatico tropical/amazonico: mais saturadas, mais quentes, com nome e
   identidade paraense.

   LEGIBILIDADE (o jogador tem que ler a raia em 200ms, inclusive daltonico):
   alem da matiz, as raias sao separadas por LUMINANCIA (Rec.709), numa escada
   monotonica de ~0.12 por degrau:

       vermelho 0.32  <  azul 0.45  <  laranja 0.56  <  verde 0.68  <  amarelo 0.81

   Assim, mesmo em escala de cinza (protanopia/deuteranopia severa), as cinco
   raias continuam distinguiveis. Vizinhas tambem sao opostas em matiz
   (verde 145 / vermelho 353 / amarelo 48 / azul 217 / laranja 27).

   COMO CONSUMIR AS CORES
   ----------------------
   - Toda cor e um THREE.Color (use .copy(), material.color.copy(c), etc.).
   - Toda cor tem `.css` e `.hex` -> string '#rrggbb' (para HTML/CSS/canvas 2D).
   - Toda cor tem `.rgba(a)` -> 'rgba(r,g,b,a)'.
   - Toda cor faz toString() = '#rrggbb', entao
       el.style.color = GH.Palette.ui.gold;    // funciona
     e
       mat.color.copy(GH.Palette.ui.gold);     // tambem funciona.
   - CONTAINERS (lanes[i], temas, ui) tem `.hex` = MAPA de strings:
       GH.Palette.lanes[0].hex.emissive -> '#2bff86'
       GH.Palette.current.hex.neon      -> '#25e8ce'
   - lanes[i] E, ele proprio, um THREE.Color (a cor base) — atende o contrato
     `lanes:[c0..c4]` e ao mesmo tempo carrega base/emissive/rim/glow/dark.
   =========================================================================== */
(function (GH) {
  'use strict';

  /* =========================================================================
     0. INFRAESTRUTURA DE COR
     ========================================================================= */

  // Fallback minimo caso o vendor do THREE nao tenha carregado: o jogo degrada,
  // mas nao quebra (e nunca fica com tela preta silenciosa).
  function TinyColor(v) {
    this.isColor = true; this.r = 1; this.g = 1; this.b = 1;
    if (v !== undefined) this.set(v);
  }
  TinyColor.prototype.set = function (v) {
    if (v && v.isColor) { this.r = v.r; this.g = v.g; this.b = v.b; return this; }
    if (typeof v === 'number') return this.setHex(v);
    if (typeof v === 'string') return this.setStyle(v);
    return this;
  };
  TinyColor.prototype.setHex = function (hex) {
    hex = Math.floor(hex);
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
    return this;
  };
  TinyColor.prototype.setStyle = function (s) {
    s = String(s).trim();
    if (s.charAt(0) === '#') s = s.slice(1);
    if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    return this.setHex(parseInt(s, 16) || 0);
  };
  TinyColor.prototype.setRGB = function (r, g, b) { this.r = r; this.g = g; this.b = b; return this; };
  TinyColor.prototype.copy = function (c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; };
  TinyColor.prototype.clone = function () { return new TinyColor().copy(this); };
  TinyColor.prototype.getHex = function () {
    function q(v) { return Math.round(Math.max(0, Math.min(1, v)) * 255); }
    return (q(this.r) << 16) ^ (q(this.g) << 8) ^ q(this.b);
  };
  TinyColor.prototype.getHexString = function () { return ('000000' + this.getHex().toString(16)).slice(-6); };
  TinyColor.prototype.getStyle = function () { return '#' + this.getHexString(); };
  TinyColor.prototype.lerp = function (c, t) {
    this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this;
  };
  TinyColor.prototype.multiplyScalar = function (s) { this.r *= s; this.g *= s; this.b *= s; return this; };
  TinyColor.prototype.getHSL = function (t) {
    t = t || { h: 0, s: 0, l: 0 };
    var r = this.r, g = this.g, b = this.b;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (min + max) / 2;
    if (min !== max) {
      var d = max - min;
      s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    t.h = h; t.s = s; t.l = l; return t;
  };

  // Prefere THREE.Color; depois GH.Util.Color (que ja resolveu o mesmo problema);
  // por ultimo o TinyColor local. Nao e dependencia dura de nenhum modulo.
  var ColorCtor = (typeof THREE !== 'undefined' && THREE.Color) ? THREE.Color
                : ((GH.Util && GH.Util.Color) ? GH.Util.Color : TinyColor);

  var _round = Math.round, _min = Math.min, _max = Math.max, _sqrt = Math.sqrt;
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* swatch('#rrggbb') -> THREE.Color enriquecido:
       .css / .hex  -> '#rrggbb' (getters, sempre coerentes com r,g,b)
       .rgba(a)     -> 'rgba(r,g,b,a)'
       toString()   -> '#rrggbb'
     Os extras sao nao-enumeraveis: nao poluem clone/copy/JSON do THREE. */
  function swatch(value) {
    var c = new ColorCtor();
    if (typeof value === 'string') c.setStyle(value);
    else if (typeof value === 'number') c.setHex(value);
    else if (value && value.isColor) c.copy(value);
    return decorate(c);
  }

  function decorate(c) {
    Object.defineProperty(c, 'css', {
      get: function () { return '#' + this.getHexString(); },
      enumerable: false, configurable: true
    });
    Object.defineProperty(c, 'hex', {
      get: function () { return '#' + this.getHexString(); },
      enumerable: false, configurable: true
    });
    Object.defineProperty(c, 'rgba', {
      value: function (a) {
        return 'rgba(' + _round(clamp01(this.r) * 255) + ',' +
                         _round(clamp01(this.g) * 255) + ',' +
                         _round(clamp01(this.b) * 255) + ',' +
                         (a === undefined ? 1 : _round(a * 1000) / 1000) + ')';
      },
      enumerable: false, configurable: true, writable: true
    });
    Object.defineProperty(c, 'toString', {
      value: function () { return '#' + this.getHexString(); },
      enumerable: false, configurable: true, writable: true
    });
    /* Marca nao-enumeravel: deixa sampleRamp() reaproveitar um `out` sem
       redecorar a cada frame, e sem aparecer em clone()/copy()/JSON. */
    Object.defineProperty(c, '__ghDecorated', {
      value: true, enumerable: false, configurable: true, writable: true
    });
    return c;
  }

  /* O jogo roda com THREE.ColorManagement ligado (ver o bloco de decisao em
     index.html). Com ele ligado, r/g/b de uma cor JA estao em luz linear; com
     ele desligado, estao codificados em sRGB. As duas funcoes abaixo precisam
     saber disso para nao dar resposta errada num dos modos. */
  function managed() {
    return !!(typeof THREE !== 'undefined' && THREE.ColorManagement &&
              THREE.ColorManagement.legacyMode === false);
  }

  // Mistura em luz LINEAR (meio-termo brilhante, sem cinza morto). Escreve em out.
  // Gerenciado: r,g,b ja sao lineares, entao a interpolacao reta E a linear.
  // Legado: r,g,b vem codificados, e o par quadrado/raiz aproxima a mesma coisa.
  function mixLinearInto(out, a, b, t) {
    if (managed()) {
      out.r = a.r + (b.r - a.r) * t;
      out.g = a.g + (b.g - a.g) * t;
      out.b = a.b + (b.b - a.b) * t;
      return out;
    }
    out.r = _sqrt(_max(0, a.r * a.r + (b.r * b.r - a.r * a.r) * t));
    out.g = _sqrt(_max(0, a.g * a.g + (b.g * b.g - a.g * a.g) * t));
    out.b = _sqrt(_max(0, a.b * a.b + (b.b * b.b - a.b * a.b) * t));
    return out;
  }
  function lerpNum(a, b, t) { return a + (b - a) * t; }

  // Codificacao linear -> sRGB (a mesma curva do three, escrita a mao para
  // funcionar tambem no TinyColor de fallback).
  function encodeSRGB(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }

  /* Luminancia PERCEBIDA (Rec.709 sobre valores codificados em sRGB).
     E ela que sustenta a escada de legibilidade das 5 raias
     (vermelho < azul < laranja < verde < amarelo) que garante leitura para
     daltonicos. Se medissemos em luz linear, a escada mudaria de ordem quando
     o gerenciamento de cor esta ligado — foi exatamente o que aconteceu na
     integracao. Por isso normalizamos sempre para o espaco de exibicao. */
  function luma(c) {
    var r = c.r, g = c.g, b = c.b;
    if (managed()) { r = encodeSRGB(r); g = encodeSRGB(g); b = encodeSRGB(b); }
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /* =========================================================================
     1. AS 5 RAIAS
     Cada raia entrega 5 papeis:
       base     — cor difusa do corpo da gem / da raia
       emissive — nucleo luminoso (o que vira bloom)
       rim      — aro metalico anodizado (claro, dessaturado)
       glow     — halo, particula, chama, rastro (mais quente que o emissive)
       dark     — sombra/oclusao, fundo da raia, lado nao iluminado
     ========================================================================= */

  var LANE_SPECS = [
    {
      key: 'green',  name: 'Verde Guama',   hue: 145,
      base: '#16c25c', emissive: '#2bff86', rim: '#a8f8cd', glow: '#7dffbb', dark: '#032312'
    },
    {
      key: 'red',    name: 'Vermelho Urucum', hue: 353,
      base: '#e31530', emissive: '#ff2e45', rim: '#ffb0b6', glow: '#ff6b78', dark: '#3d0410'
    },
    {
      key: 'yellow', name: 'Amarelo Tucuma', hue: 48,
      base: '#e8b707', emissive: '#ffdc3a', rim: '#fff3bd', glow: '#ffe566', dark: '#261a00'
    },
    {
      key: 'blue',   name: 'Azul Marajo',   hue: 217,
      base: '#1c63de', emissive: '#3b87ff', rim: '#b3d4ff', glow: '#6fb2ff', dark: '#06133f'
    },
    {
      key: 'orange', name: 'Laranja Ver-o-Peso', hue: 27,
      base: '#e9640a', emissive: '#ff7f1e', rim: '#ffcda6', glow: '#ffa451', dark: '#3a1400'
    }
  ];

  var lanes = [];
  var laneBase = [], laneEmissive = [], laneRim = [], laneGlow = [], laneDark = [];
  var laneHex = [], laneNames = [], laneKeys = [];

  (function buildLanes() {
    for (var i = 0; i < LANE_SPECS.length; i++) {
      var s = LANE_SPECS[i];

      // A propria raia E a cor base (contrato: lanes:[c0..c4]).
      var lane = swatch(s.base);
      var em   = swatch(s.emissive);
      var rim  = swatch(s.rim);
      var glow = swatch(s.glow);
      var dark = swatch(s.dark);
      var base = swatch(s.base);   // copia independente, para quem quiser mutar

      // Sub-cores como propriedades (nao-enumeraveis para nao vazar em copy()).
      var props = { base: base, emissive: em, rim: rim, glow: glow, dark: dark };
      for (var k in props) {
        Object.defineProperty(lane, k, { value: props[k], enumerable: false, configurable: true, writable: true });
      }
      Object.defineProperty(lane, 'index', { value: i, enumerable: false, configurable: true });
      Object.defineProperty(lane, 'key',   { value: s.key, enumerable: false, configurable: true });
      Object.defineProperty(lane, 'name',  { value: s.name, enumerable: false, configurable: true });
      Object.defineProperty(lane, 'hue',   { value: s.hue, enumerable: false, configurable: true });
      Object.defineProperty(lane, 'luma',  { value: luma(lane), enumerable: false, configurable: true });

      // Em containers, `.hex` vira MAPA de strings (sobrepoe o getter do swatch).
      Object.defineProperty(lane, 'hex', {
        value: {
          base: s.base, emissive: s.emissive, rim: s.rim, glow: s.glow, dark: s.dark
        },
        enumerable: false, configurable: true, writable: true
      });

      lanes.push(lane);
      laneBase.push(base);
      laneEmissive.push(em);
      laneRim.push(rim);
      laneGlow.push(glow);
      laneDark.push(dark);
      laneHex.push(s.base);
      laneNames.push(s.name);
      laneKeys.push(s.key);
    }
  })();

  /* =========================================================================
     2. TEMAS VISUAIS
     Cada tema descreve o "mundo" atras da pista. Chaves obrigatorias do
     contrato + extras uteis para highway/stage/materials.
     ========================================================================= */

  // Chaves de cor simples presentes em TODO tema.
  var THEME_KEYS = [
    'sky',        // cupula do ceu (topo)
    'horizon',    // faixa do horizonte / luz que nasce atras do palco
    'fog',        // neblina de profundidade (a pista some nela)
    'highway',    // superficie da pista
    'highwayEdge',// trilho/borda neon da pista
    'neon',       // neon secundario (letreiros, tubos, contornos)
    'crowdTint',  // silhueta do publico
    'accent',     // destaque quente do tema (metais, brilhos, detalhes)
    'uiAccent',   // cor de destaque da interface neste tema
    'haze',       // nevoa volumetrica iluminada / feixes de luz
    'laneLine',   // linhas divisorias entre raias
    'beatLine',   // linhas de compasso que descem no ritmo
    'inlay',      // inlays do braco (marcadores de casa)
    'rail',       // moldura lateral solida da pista
    'metal',      // metal do rig/aros neste tema
    'wood',       // madeira (braco, palco, caixotes)
    'ledScreen',  // telao de LED atras da banda
    'smoke',      // fumaca/gelo seco
    'groundGlow', // brilho refletido no chao do palco
    'spotlight',  // cor do feixe dos refletores brancos
    'shadow',     // preto do tema (nunca #000 puro)
    'mirror'      // reflexo especular/bola de espelhos
  ];
  // Chaves que sao arrays de cor.
  var THEME_ARRAY_KEYS = ['stageLight', 'sunset'];

  var THEME_SPECS = {

    /* ---------------------------------------------------------------------
       PARA — Ver-o-Peso ao entardecer.
       Laranja queimado do sol na baia, magenta do ceu, turquesa do rio
       Guajara. O tema "assinatura" da guitarrada.
       --------------------------------------------------------------------- */
    para: {
      name: 'Ver-o-Peso',
      subtitle: 'Belem do Para, entardecer na baia do Guajara',
      sky: '#1e0b3a', horizon: '#ff6a1e', fog: '#301246',
      highway: '#150a20', highwayEdge: '#ff3d8a', neon: '#25e8ce',
      stageLight: ['#ff5a1e', '#ff2e9a', '#22e0c6'],
      crowdTint: '#3a1a50', accent: '#ffb03a', uiAccent: '#ff3d8a',
      sunset: ['#ffd97a', '#ff9a3c', '#ff4f6e', '#b02a86', '#3a1152'],
      haze: '#ff7a4a', laneLine: '#7a3e9c', beatLine: '#ffcb6b',
      inlay: '#f0c486', rail: '#c08a4e', metal: '#d9b98c', wood: '#4a2a18',
      ledScreen: '#ff2e9a', smoke: '#5a3070', groundGlow: '#ff6a1e',
      spotlight: '#ffd9a8', shadow: '#0a0414', mirror: '#ffe6c2',
      mood: { bloom: 1.00, exposure: 1.00, fogNear: 18, fogFar: 52, ambient: 0.42 }
    },

    /* ---------------------------------------------------------------------
       CARIMBO — noite de festa na beira do rio.
       Indigo profundo do ceu, ambar de fogueira, verde folha molhada.
       --------------------------------------------------------------------- */
    carimbo: {
      name: 'Carimbo na Beira',
      subtitle: 'Noite de festa a beira do rio, fogueira e tambor',
      sky: '#04091f', horizon: '#0f2c5e', fog: '#081536',
      highway: '#080d1c', highwayEdge: '#ffa733', neon: '#3be07a',
      stageLight: ['#ffa02a', '#2fe07c', '#3e7bff'],
      crowdTint: '#12234e', accent: '#ffb24d', uiAccent: '#3be07a',
      sunset: ['#ffc98a', '#ff8b4a', '#8e3e7a', '#2a2a6e', '#050a1e'],
      haze: '#2e6a8c', laneLine: '#1c3a6a', beatLine: '#8fe3b4',
      inlay: '#d8c79a', rail: '#8a6a3e', metal: '#b8c4d0', wood: '#3a2416',
      ledScreen: '#2fe07c', smoke: '#1a3350', groundGlow: '#ffa733',
      spotlight: '#ffe0b0', shadow: '#02060f', mirror: '#cfe8ff',
      mood: { bloom: 0.92, exposure: 1.05, fogNear: 14, fogFar: 46, ambient: 0.30 }
    },

    /* ---------------------------------------------------------------------
       BREGA — baile brega em Belem.
       Rosa choque, roxo, dourado e a bola de espelhos varrendo o salao.
       --------------------------------------------------------------------- */
    brega: {
      name: 'Baile Brega',
      subtitle: 'Salao de baile em Belem, bola de espelhos e purpurina',
      sky: '#190630', horizon: '#5c0f60', fog: '#280a42',
      highway: '#160726', highwayEdge: '#ff2e9e', neon: '#b24bff',
      stageLight: ['#ff2e9e', '#a64bff', '#ffd24a'],
      crowdTint: '#3a1150', accent: '#ffd24a', uiAccent: '#ff2e9e',
      sunset: ['#ffd2ec', '#ff5fb2', '#c22c9a', '#6a1d7a', '#22083a'],
      haze: '#b04bff', laneLine: '#59206e', beatLine: '#ffc0e4',
      inlay: '#ffd98a', rail: '#d4a03a', metal: '#e8dcf2', wood: '#3a1030',
      ledScreen: '#ff2e9e', smoke: '#4a1a62', groundGlow: '#ff2e9e',
      spotlight: '#ffe8f6', shadow: '#0c0318', mirror: '#f2ecff',
      mood: { bloom: 1.15, exposure: 1.02, fogNear: 16, fogFar: 48, ambient: 0.38 }
    },

    /* ---------------------------------------------------------------------
       FREVO — Recife no carnaval, sol a pino.
       Multicolor vibrante das sombrinhas: amarelo, ciano, vermelho, azul dia.
       --------------------------------------------------------------------- */
    frevo: {
      name: 'Frevo de Rua',
      subtitle: 'Recife no carnaval, sombrinha colorida e sol a pino',
      sky: '#0b4fa0', horizon: '#ffe14d', fog: '#134e92',
      highway: '#0a1730', highwayEdge: '#ffe14d', neon: '#22e3e8',
      stageLight: ['#ffe14d', '#22e3e8', '#ff3a3a'],
      crowdTint: '#1c4e86', accent: '#ff3a3a', uiAccent: '#ffe14d',
      sunset: ['#fff3a0', '#ffc23a', '#ff6a4a', '#e33a8e', '#6e2ed6'],
      haze: '#7fd4ff', laneLine: '#1e4c86', beatLine: '#eaf6ff',
      inlay: '#ffe9a8', rail: '#e85a2e', metal: '#dde6f0', wood: '#5a3a1e',
      ledScreen: '#ff3a3a', smoke: '#2e6ea8', groundGlow: '#ffe14d',
      spotlight: '#fffbea', shadow: '#04122a', mirror: '#e6f6ff',
      mood: { bloom: 0.85, exposure: 1.12, fogNear: 22, fogFar: 60, ambient: 0.55 }
    },

    /* ---------------------------------------------------------------------
       SAMBAROCK — clube dos anos 70.
       Sepia quente, laranja, marrom couro, verde garrafa e luz de tungstenio.
       --------------------------------------------------------------------- */
    sambarock: {
      name: 'Clube Samba-Rock',
      subtitle: 'Clube dos anos 70, couro, tungstenio e verde garrafa',
      sky: '#180e07', horizon: '#6b3a12', fog: '#231407',
      highway: '#140c06', highwayEdge: '#e08a2e', neon: '#1f9e62',
      stageLight: ['#e8952e', '#c4552a', '#2e9e68'],
      crowdTint: '#2c1a0e', accent: '#e8b457', uiAccent: '#e08a2e',
      sunset: ['#ffdca8', '#e8952e', '#b85a22', '#6b2f16', '#1c0e06'],
      haze: '#8a5a2e', laneLine: '#4a2e14', beatLine: '#e8c88a',
      inlay: '#c9a46a', rail: '#7a4a22', metal: '#c0b49a', wood: '#3e2210',
      ledScreen: '#e8952e', smoke: '#3a2614', groundGlow: '#e08a2e',
      spotlight: '#ffe2b0', shadow: '#080402', mirror: '#f0e2c8',
      mood: { bloom: 0.80, exposure: 0.96, fogNear: 15, fogFar: 44, ambient: 0.34 }
    }
  };

  var DEFAULT_MOOD = { bloom: 1.0, exposure: 1.0, fogNear: 18, fogFar: 50, ambient: 0.40 };

  // Constroi o objeto de tema (Colors + mapa .hex de strings) a partir do spec.
  function buildTheme(id, spec) {
    var t = { id: id, name: spec.name || id, subtitle: spec.subtitle || '', hex: {}, mood: {} };
    var i, k;

    for (i = 0; i < THEME_KEYS.length; i++) {
      k = THEME_KEYS[i];
      // Fallback defensivo: se faltar uma chave, cai no accent (nunca undefined).
      var v = spec[k] !== undefined ? spec[k] : (spec.accent || '#888888');
      t[k] = swatch(v);
      t.hex[k] = t[k].css;
    }
    for (i = 0; i < THEME_ARRAY_KEYS.length; i++) {
      k = THEME_ARRAY_KEYS[i];
      var arr = spec[k] || [spec.accent || '#888888'];
      var cols = [], hexes = [];
      for (var j = 0; j < arr.length; j++) {
        var c = swatch(arr[j]);
        cols.push(c);
        hexes.push(c.css);
      }
      t[k] = cols;
      t.hex[k] = hexes;
    }
    // mood: numeros de apoio (bloom/exposicao/nevoa). Quem nao quiser, ignora.
    for (k in DEFAULT_MOOD) {
      t.mood[k] = (spec.mood && spec.mood[k] !== undefined) ? spec.mood[k] : DEFAULT_MOOD[k];
    }
    return t;
  }

  var themes = {};
  var themeNames = [];
  var themeList = [];
  (function buildThemes() {
    for (var id in THEME_SPECS) {
      if (!Object.prototype.hasOwnProperty.call(THEME_SPECS, id)) continue;
      themes[id] = buildTheme(id, THEME_SPECS[id]);
      themeNames.push(id);
      themeList.push({ id: id, name: themes[id].name, subtitle: themes[id].subtitle });
    }
  })();

  /* =========================================================================
     3. CORES DE INTERFACE, JULGAMENTO, STAR POWER E FX
     Neutras: nao mudam com o tema (o tema entra via uiAccent/accent).
     ========================================================================= */

  var UI_SPEC = {
    bg:        '#06070c',   // fundo mais escuro possivel sem virar preto puro
    panel:     '#101423',   // painel/cartao
    panelSoft: '#171d31',   // painel elevado / hover
    panelEdge: '#2a3150',   // borda de painel
    text:      '#f2f5ff',   // texto primario
    textDim:   '#95a0c0',   // texto secundario
    textFaint: '#5a6485',   // texto terciario/desabilitado
    gold:      '#ffcf4a',   // 1o lugar, estrelas, destaque maximo
    silver:    '#d6dcea',
    bronze:    '#cd7f45',
    danger:    '#ff3b4e',   // erro, rock meter critico
    warning:   '#ffa22b',
    success:   '#39e08a',   // acerto, confirmacao
    sp:        '#8fd8ff',   // star power (azul gelo)
    outline:   '#2a3150',
    shadow:    '#000308',
    star:      '#ffd34a',
    focus:     '#ffffff'
  };

  var ui = { hex: {} };
  (function buildUI() {
    for (var k in UI_SPEC) {
      if (!Object.prototype.hasOwnProperty.call(UI_SPEC, k)) continue;
      ui[k] = swatch(UI_SPEC[k]);
      ui.hex[k] = ui[k].css;
    }
  })();

  // Julgamento de acerto (HUD e FX usam os mesmos tons — coerencia).
  var JUDGMENT_SPEC = {
    perfect: '#ffe45c',   // PERFEITO! — dourado quente
    great:   '#7dffbb',
    good:    '#8fd8ff',   // BOM — azul gelo
    late:    '#c98cff',   // atrasou
    early:   '#5ce0d8',   // adiantou
    miss:    '#ff4a5a'    // ERROU
  };
  var judgment = { hex: {} };
  (function buildJudgment() {
    for (var k in JUDGMENT_SPEC) {
      if (!Object.prototype.hasOwnProperty.call(JUDGMENT_SPEC, k)) continue;
      judgment[k] = swatch(JUDGMENT_SPEC[k]);
      judgment.hex[k] = judgment[k].css;
    }
  })();

  // Star Power: cromado/prateado com nucleo azul-gelo estourado.
  var SP_SPEC = {
    core: '#f2fbff',   // nucleo quase branco (vai estourar no bloom)
    glow: '#8fd8ff',
    rim:  '#ffffff',
    edge: '#3aa8ff',
    tint: '#b9e6ff',
    deep: '#0b2a4a'
  };
  var sp = { hex: {} };
  (function buildSP() {
    for (var k in SP_SPEC) {
      if (!Object.prototype.hasOwnProperty.call(SP_SPEC, k)) continue;
      sp[k] = swatch(SP_SPEC[k]);
      sp.hex[k] = sp[k].css;
    }
  })();

  // Rock meter: rampa continua do vermelho critico ao verde.
  var ROCK_SPEC = {
    critical: '#ff2438',
    low:      '#ff7a2b',
    mid:      '#ffd24a',
    high:     '#39e08a',
    max:      '#7dffbb',
    frame:    '#161b2e',
    sp:       '#8fd8ff'
  };
  var rockMeter = { hex: {} };
  (function buildRock() {
    for (var k in ROCK_SPEC) {
      if (!Object.prototype.hasOwnProperty.call(ROCK_SPEC, k)) continue;
      rockMeter[k] = swatch(ROCK_SPEC[k]);
      rockMeter[k + 'Hex'] = rockMeter[k].css;
      rockMeter.hex[k] = rockMeter[k].css;
    }
  })();

  // Rampas de gradiente prontas (FX/materials amostram com sampleRamp).
  var RAMP_SPECS = {
    // chama de acerto: nucleo branco-quente -> dourado -> laranja -> sangue
    flame:   ['#fff8d8', '#ffe066', '#ff9a2b', '#ff3d1e', '#8e1b10'],
    // chama de star power: branco -> gelo -> azul eletrico
    flameSP: ['#ffffff', '#dff4ff', '#8fd8ff', '#3aa8ff', '#12336e'],
    // faisca metalica
    spark:   ['#ffffff', '#ffe9b0', '#ff9a3c', '#7a2c0e'],
    // fumaca
    smoke:   ['#c9c4d8', '#7d7690', '#3b3548', '#14121c'],
    // multidao (variacao de pele/roupa em silhueta)
    crowd:   ['#0d1024', '#1a1f3c', '#2b2450', '#3a2a5e'],
    // estrelas do resultado
    stars:   ['#5a6485', '#d6dcea', '#ffcf4a', '#fff0a8']
  };
  var ramps = { hex: {} };
  (function buildRamps() {
    for (var k in RAMP_SPECS) {
      if (!Object.prototype.hasOwnProperty.call(RAMP_SPECS, k)) continue;
      var cols = [], hexes = [];
      for (var i = 0; i < RAMP_SPECS[k].length; i++) {
        var c = swatch(RAMP_SPECS[k][i]);
        cols.push(c); hexes.push(c.css);
      }
      ramps[k] = cols;
      ramps.hex[k] = hexes;
    }
  })();

  /* =========================================================================
     4. API PUBLICA
     ========================================================================= */

  var DEFAULT_THEME = 'para';
  var listeners = [];

  // Resolve nome de tema ou objeto de tema -> objeto de tema (ou null).
  function resolveTheme(x) {
    if (!x) return null;
    if (typeof x === 'string') return themes[x] || null;
    if (x.hex && x.sky) return x;
    return null;
  }

  /* Troca o tema corrente. Aceita nome ('para') ou objeto de tema.
     Notifica quem registrou onChange e atualiza as variaveis CSS. */
  function setTheme(name) {
    var t = resolveTheme(name) || themes[DEFAULT_THEME];
    P.current = t;
    P.themeName = t.id;
    applyCssVars();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](t); } catch (e) { /* um ouvinte ruim nao derruba o jogo */ }
    }
    return t;
  }
  function onChange(fn) { if (typeof fn === 'function' && listeners.indexOf(fn) < 0) listeners.push(fn); return fn; }
  function offChange(fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
  function hasTheme(name) { return !!themes[name]; }

  // Caminho pontilhado dentro de um objeto.
  function walk(root, parts) {
    var v = root;
    for (var i = 0; i < parts.length; i++) {
      if (v === null || v === undefined) return undefined;
      v = v[parts[i]];
    }
    return v;
  }

  /* get('neon')              -> cor do tema atual
     get('ui.gold')           -> cor da interface
     get('lanes.2.emissive')  -> emissivo da raia amarela
     get('themes.brega.neon') -> cor de outro tema
     Devolve THREE.Color (ou o que o caminho apontar). null se nao achar. */
  function get(key) {
    if (!key) return null;
    var parts = String(key).split('.');
    var v = walk(P.current, parts);
    if (v !== undefined) return v;
    v = walk(P, parts);
    if (v !== undefined) return v;
    v = walk(themes, parts);
    return (v === undefined) ? null : v;
  }
  // Mesma busca, mas devolve string '#rrggbb' (ou null).
  function getHex(key) {
    var v = get(key);
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (v.isColor) return '#' + v.getHexString();
    return null;
  }

  // Atalhos de raia: laneColor(2) -> base; laneColor(2,'glow') -> halo.
  function laneColor(i, part) {
    var lane = lanes[(i | 0) % lanes.length] || lanes[0];
    if (!part || part === 'base') return lane;
    return lane[part] || lane;
  }
  function laneCss(i, part) {
    var c = laneColor(i, part);
    return '#' + c.getHexString();
  }

  // Clona um tema (estrutura completa, cores independentes).
  function cloneTheme(t) {
    var src = resolveTheme(t) || themes[DEFAULT_THEME];
    var spec = { name: src.name, subtitle: src.subtitle, mood: src.mood };
    var i, k;
    for (i = 0; i < THEME_KEYS.length; i++) { k = THEME_KEYS[i]; spec[k] = src.hex[k]; }
    for (i = 0; i < THEME_ARRAY_KEYS.length; i++) { k = THEME_ARRAY_KEYS[i]; spec[k] = src.hex[k].slice(); }
    return buildTheme(src.id, spec);
  }

  /* lerpTheme(a, b, t [, out]) — transicao suave entre dois temas.
     a e b podem ser nome ou objeto. Se `out` for passado (um tema criado por
     cloneTheme/lerpTheme), a funcao NAO aloca nada — use assim no loop.
     A mistura e feita em luz linear: o meio do caminho fica vivo, nao cinza. */
  function lerpTheme(a, b, t, out) {
    var ta = resolveTheme(a) || themes[DEFAULT_THEME];
    var tb = resolveTheme(b) || ta;
    t = clamp01(t);
    out = out || cloneTheme(ta);

    var i, j, k;
    for (i = 0; i < THEME_KEYS.length; i++) {
      k = THEME_KEYS[i];
      mixLinearInto(out[k], ta[k], tb[k], t);
      out.hex[k] = '#' + out[k].getHexString();
    }
    for (i = 0; i < THEME_ARRAY_KEYS.length; i++) {
      k = THEME_ARRAY_KEYS[i];
      var arrA = ta[k], arrB = tb[k], arrO = out[k];
      var n = Math.max(arrA.length, arrB.length);
      for (j = 0; j < n; j++) {
        var ca = arrA[Math.min(j, arrA.length - 1)];
        var cb = arrB[Math.min(j, arrB.length - 1)];
        if (!arrO[j]) { arrO[j] = swatch('#000000'); }
        mixLinearInto(arrO[j], ca, cb, t);
        out.hex[k][j] = '#' + arrO[j].getHexString();
      }
      arrO.length = n;
      out.hex[k].length = n;
    }
    for (k in DEFAULT_MOOD) {
      out.mood[k] = lerpNum(ta.mood[k], tb.mood[k], t);
    }
    out.id       = (t < 0.5) ? ta.id : tb.id;
    out.name     = (t < 0.5) ? ta.name : tb.name;
    out.subtitle = (t < 0.5) ? ta.subtitle : tb.subtitle;
    return out;
  }

  /* Amostra uma rampa de cores (array) em t=0..1. `out` opcional.
     A cor recem-alocada sai DECORADA (toString/.css/.hex/.rgba): sem isso,
     `el.style.color = GH.Palette.healthColor(h)` escrevia '[object Object]'
     no HUD — armadilha real encontrada na integracao. Quando o chamador passa
     `out` reaproveitado, decoramos uma unica vez (os extras sao getters). */
  function sampleRamp(colors, t, out) {
    if (!out) out = decorate(new ColorCtor());
    else if (!out.__ghDecorated) decorate(out);
    if (!colors || !colors.length) return out.setRGB(1, 1, 1);
    if (colors.length === 1) return out.copy(colors[0]);
    var x = clamp01(t) * (colors.length - 1);
    var i = Math.floor(x);
    if (i >= colors.length - 1) return out.copy(colors[colors.length - 1]);
    return mixLinearInto(out, colors[i], colors[i + 1], x - i);
  }

  /* Cor do rock meter para uma saude 0..1 — usada pelo HUD e pelo FX.
     A rampa e montada uma unica vez: chamada por frame nao aloca nada. */
  var HEALTH_RAMP = null;
  function healthColor(h, out) {
    if (!HEALTH_RAMP) {
      HEALTH_RAMP = [rockMeter.critical, rockMeter.low, rockMeter.mid, rockMeter.high, rockMeter.max];
    }
    return sampleRamp(HEALTH_RAMP, clamp01(h), out);
  }
  /* Cor do multiplicador (1x..4x, e 8x com Star Power dobrado). */
  function multiplierColor(mult) {
    if (mult >= 8) return sp.glow;
    if (mult >= 4) return ui.gold;
    if (mult >= 3) return judgment.perfect;
    if (mult >= 2) return ui.success;
    return ui.textDim;
  }

  /* -------------------------------------------------------------------------
     Variaveis CSS: a UI em HTML consome a paleta sem hardcodar nada.
       .gh-score { color: var(--gh-gold); }
       .gh-lane-0 { background: var(--gh-lane0-glow); }
     Reaplicadas a cada setTheme().
     ------------------------------------------------------------------------- */
  function cssVars() {
    var v = {}, i, k;
    for (i = 0; i < lanes.length; i++) {
      v['--gh-lane' + i]            = lanes[i].hex.base;
      v['--gh-lane' + i + '-em']    = lanes[i].hex.emissive;
      v['--gh-lane' + i + '-rim']   = lanes[i].hex.rim;
      v['--gh-lane' + i + '-glow']  = lanes[i].hex.glow;
      v['--gh-lane' + i + '-dark']  = lanes[i].hex.dark;
    }
    for (k in UI_SPEC) {
      if (Object.prototype.hasOwnProperty.call(UI_SPEC, k)) v['--gh-' + k] = ui.hex[k];
    }
    for (k in JUDGMENT_SPEC) {
      if (Object.prototype.hasOwnProperty.call(JUDGMENT_SPEC, k)) v['--gh-judge-' + k] = judgment.hex[k];
    }
    v['--gh-sp']        = sp.hex.glow;
    v['--gh-sp-core']   = sp.hex.core;
    v['--gh-sp-edge']   = sp.hex.edge;
    var t = P.current || themes[DEFAULT_THEME];
    v['--gh-accent']    = t.hex.accent;
    v['--gh-ui-accent'] = t.hex.uiAccent;
    v['--gh-neon']      = t.hex.neon;
    v['--gh-sky']       = t.hex.sky;
    v['--gh-horizon']   = t.hex.horizon;
    v['--gh-fog']       = t.hex.fog;
    v['--gh-highway']   = t.hex.highway;
    v['--gh-edge']      = t.hex.highwayEdge;
    v['--gh-crowd']     = t.hex.crowdTint;
    for (i = 0; i < t.hex.sunset.length; i++) v['--gh-sunset' + i] = t.hex.sunset[i];
    for (i = 0; i < t.hex.stageLight.length; i++) v['--gh-stage' + i] = t.hex.stageLight[i];
    return v;
  }

  function applyCssVars(target) {
    try {
      var el = target || (typeof document !== 'undefined' ? document.documentElement : null);
      if (!el || !el.style || !el.style.setProperty) return;
      var v = cssVars();
      for (var k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k)) el.style.setProperty(k, v[k]);
      }
    } catch (e) { /* ambiente sem DOM (nunca deve derrubar o jogo) */ }
  }

  /* =========================================================================
     5. EXPORT
     ========================================================================= */

  var P = {
    // --- raias (contrato) ---
    lanes: lanes,                 // lanes[i] E um THREE.Color (base) + sub-cores
    laneBase: laneBase,
    laneEmissive: laneEmissive,
    laneRim: laneRim,
    laneGlow: laneGlow,
    laneDark: laneDark,
    laneHex: laneHex,             // ['#16c25c', ...] cores base como string
    laneNames: laneNames,         // nomes de exibicao em portugues
    laneKeys: laneKeys,           // ['green','red','yellow','blue','orange']
    LANES: lanes.length,

    // --- temas ---
    themes: themes,
    themeNames: themeNames,
    themeList: themeList,
    current: null,                // preenchido por setTheme() logo abaixo
    themeName: DEFAULT_THEME,
    defaultTheme: DEFAULT_THEME,
    THEME_KEYS: THEME_KEYS,
    THEME_ARRAY_KEYS: THEME_ARRAY_KEYS,

    // --- interface e efeitos ---
    ui: ui,
    judgment: judgment,
    sp: sp,
    starPower: sp,                // alias legivel
    rockMeter: rockMeter,
    ramps: ramps,

    // --- funcoes ---
    setTheme: setTheme,
    hasTheme: hasTheme,
    onChange: onChange,
    offChange: offChange,
    get: get,
    getHex: getHex,
    laneColor: laneColor,
    laneCss: laneCss,
    cloneTheme: cloneTheme,
    lerpTheme: lerpTheme,
    sampleRamp: sampleRamp,
    healthColor: healthColor,
    multiplierColor: multiplierColor,
    cssVars: cssVars,
    applyCssVars: applyCssVars,
    swatch: swatch,
    luma: luma
  };

  // Tema inicial: 'para' (Ver-o-Peso). `current` nunca fica nulo.
  GH.Palette = P;
  setTheme(DEFAULT_THEME);

})(window.GH = window.GH || {});

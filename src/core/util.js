/* ===========================================================================
   GUITARRADA HERO — src/core/util.js
   ---------------------------------------------------------------------------
   Camada BASE do jogo. Nao depende de nenhum outro modulo GH (so de THREE, e
   ainda assim de forma defensiva). Tudo aqui e deterministico, sem alocacao
   escondida nos caminhos quentes e pensado para rodar a 60fps.

   Entrega:
     GH.Layout  — sistema de coordenadas canonico (secao 3 do ARCHITECTURE.md)
     GH.Util    — matematica, easings, RNG deterministico, ruido procedural,
                  cor, formatacao, pooling, molas, curvas e tempo.

   CONVENCOES IMPORTANTES (leia antes de usar):
     - Angulos em radianos. Tempo em SEGUNDOS (dt, now(), formatTime).
     - noise2D/noise3D/noise4D devolvem [-1, 1] (padrao simplex).
       Se voce quer [0, 1] use noise2D01 / noise3D01 / fbm2D01.
     - fbm2D devolve [-1, 1] normalizado; ridged devolve [0, 1].
     - Util.now() devolve SEGUNDOS desde o carregamento (use nowMs() para ms).
     - RNG e mulberry32: mesma semente => mesma sequencia, sempre. O modo
       captura depende disso.
     - A tabela de permutacao do ruido tem semente FIXA interna: as texturas
       procedurais ficam identicas entre execucoes e entre cenas de captura,
       independente de GH.Util.seed(). Para ruido com outra semente use
       GH.Util.makeNoise(seed).
   =========================================================================== */
(function (GH) {
  'use strict';

  /* =========================================================================
     0. CONSTANTES
     ========================================================================= */

  var PI       = Math.PI;
  var TAU      = PI * 2;
  var HALF_PI  = PI * 0.5;
  var QUARTER_PI = PI * 0.25;
  var DEG2RAD  = PI / 180;
  var RAD2DEG  = 180 / PI;
  var EPSILON  = 1e-6;
  var SQRT2    = Math.SQRT2;
  var SQRT3    = Math.sqrt(3);
  var GOLDEN   = (1 + Math.sqrt(5)) / 2;

  // atalhos locais (evita lookup no objeto Math dentro dos loops quentes)
  var mAbs   = Math.abs,   mFloor = Math.floor, mCeil = Math.ceil,
      mSqrt  = Math.sqrt,  mPow   = Math.pow,   mSin  = Math.sin,
      mCos   = Math.cos,   mExp   = Math.exp,   mLog  = Math.log,
      mMin   = Math.min,   mMax   = Math.max,   mAtan2 = Math.atan2,
      mRound = Math.round, mImul  = Math.imul;

  /* =========================================================================
     1. GH.Layout — SISTEMA DE COORDENADAS CANONICO
     Copiado LITERALMENTE da secao 3 do ARCHITECTURE.md. Ninguem redefine.
     ========================================================================= */

  GH.Layout = {
    LANES: 5,
    LANE_W: 0.72,          // largura de cada raia
    HALF_W: 1.80,          // meia-largura total da pista (= 2.5*LANE_W)
    SPAWN_Z: -46,          // z de nascimento
    DESPAWN_Z: 6,          // z de morte
    STRIKE_Z: 0,           // linha de acerto
    SURFACE_Y: 0,
    GEM_Y: 0.16,
    laneX: function (i) { return (i - 2) * 0.72; }
  };

  // --- Auxiliares ADITIVOS (nao substituem nada acima) ----------------------
  // Largura total util da pista.
  GH.Layout.TOTAL_W = GH.Layout.HALF_W * 2;                   // 3.60
  // Comprimento visivel da pista, do nascimento ate a morte.
  GH.Layout.DEPTH   = GH.Layout.DESPAWN_Z - GH.Layout.SPAWN_Z; // 52
  // Raia (0..4) mais proxima de um x do mundo — util para hit-test/debug.
  GH.Layout.laneAt = function (x) {
    var i = mRound(x / GH.Layout.LANE_W) + 2;
    return i < 0 ? 0 : (i > 4 ? 4 : i);
  };
  // Borda esquerda/direita da raia i.
  GH.Layout.laneLeft  = function (i) { return GH.Layout.laneX(i) - GH.Layout.LANE_W * 0.5; };
  GH.Layout.laneRight = function (i) { return GH.Layout.laneX(i) + GH.Layout.LANE_W * 0.5; };
  // Progresso 0..1 de uma nota entre o nascimento (0) e a linha de acerto (1).
  GH.Layout.depthT = function (z) {
    return (z - GH.Layout.SPAWN_Z) / (GH.Layout.STRIKE_Z - GH.Layout.SPAWN_Z);
  };

  /* =========================================================================
     2. MATEMATICA ESCALAR
     ========================================================================= */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function saturate(v)      { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function clamp01(v)       { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp(a, b, t)    { return a + (b - a) * t; }
  function lerpClamped(a, b, t) { return a + (b - a) * saturate(t); }

  // Inverso do lerp: onde v cai entre a e b (pode extrapolar).
  function invLerp(a, b, v) {
    var d = b - a;
    return mAbs(d) < EPSILON ? 0 : (v - a) / d;
  }

  // Reparametrizacao linear de [a,b] para [c,d].
  function remap(v, a, b, c, d)        { return lerp(c, d, invLerp(a, b, v)); }
  function remapClamped(v, a, b, c, d) { return lerp(c, d, saturate(invLerp(a, b, v))); }

  // smoothstep no formato GLSL: smoothstep(edge0, edge1, x).
  // Aceita tambem a forma curta smoothstep(t) (equivale a edge0=0, edge1=1).
  function smoothstep(a, b, x) {
    if (x === undefined) { x = a; a = 0; b = 1; }
    var t = saturate(invLerp(a, b, x));
    return t * t * (3 - 2 * t);
  }
  // Versao de Ken Perlin: primeira E segunda derivadas nulas nas pontas.
  function smootherstep(a, b, x) {
    if (x === undefined) { x = a; a = 0; b = 1; }
    var t = saturate(invLerp(a, b, x));
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  function step(edge, x) { return x < edge ? 0 : 1; }

  /* damp(a, b, lambda, dt) — interpolacao exponencial INDEPENDENTE de framerate.
     Substitui o classico (e errado) `a = lerp(a, b, 0.1)` por frame.
     lambda = "velocidade de aproximacao" (1/segundo). lambda 10 ~= rapido,
     lambda 2 ~= preguicoso. Em dt=0 devolve `a` intacto. */
  function damp(a, b, lambda, dt) {
    if (dt <= 0) return a;
    return b + (a - b) * mExp(-lambda * dt);
  }
  // Mesma ideia para angulos (respeita o caminho curto no circulo).
  function dampAngle(a, b, lambda, dt) {
    return a + angleDelta(a, b) * (1 - mExp(-lambda * dt));
  }
  // Aproxima `a` de `b` com passo maximo (linear, previsivel).
  function moveTowards(a, b, maxDelta) {
    var d = b - a;
    if (mAbs(d) <= maxDelta) return b;
    return a + (d > 0 ? maxDelta : -maxDelta);
  }

  // Modulo euclidiano: mod(-1, 5) === 4 (o % do JS devolveria -1).
  function mod(a, n) { return ((a % n) + n) % n; }
  // Enrola um valor dentro de [min, max).
  function wrap(v, min, max) {
    var r = max - min;
    return mAbs(r) < EPSILON ? min : min + mod(v - min, r);
  }
  // Vai e volta entre 0 e len (triangular).
  function pingPong(t, len) {
    len = (len === undefined) ? 1 : len;
    var x = mod(t, len * 2);
    return x > len ? (len * 2 - x) : x;
  }
  // Onda triangular normalizada 0..1 com periodo 1.
  function tri(t) { return 1 - mAbs(mod(t, 1) * 2 - 1); }

  function deg2rad(d) { return d * DEG2RAD; }
  function rad2deg(r) { return r * RAD2DEG; }

  // Menor diferenca angular de a para b, sempre em (-PI, PI].
  function angleDelta(a, b) { return mod(b - a + PI, TAU) - PI; }
  function angleLerp(a, b, t) { return a + angleDelta(a, b) * t; }
  // Normaliza para (-PI, PI] e entao limita entre min e max.
  function clampAngle(angle, min, max) {
    var a = mod(angle + PI, TAU) - PI;
    if (min === undefined) return a;
    return clamp(a, min, max);
  }

  function sign(v)  { return v > 0 ? 1 : (v < 0 ? -1 : 0); }
  function sign1(v) { return v < 0 ? -1 : 1; }               // nunca devolve 0
  function approxEq(a, b, eps) { return mAbs(a - b) <= (eps === undefined ? 1e-4 : eps); }
  function nextPow2(v) { var p = 1; while (p < v) p *= 2; return p; }
  function isPow2(v)   { return (v & (v - 1)) === 0 && v > 0; }
  // Quantiza para o multiplo mais proximo de `stepSize` (grades, snapping).
  function snap(v, stepSize) { return stepSize ? mRound(v / stepSize) * stepSize : v; }
  // Media exponencial ponderada (para medidores suaves de HUD).
  function ema(prev, value, alpha) { return prev + (value - prev) * alpha; }

  // Distancias baratas (sem sqrt quando da).
  function dist2(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
  function dist(ax, ay, bx, by)  { return mSqrt(dist2(ax, ay, bx, by)); }
  function len2(x, y)            { return x * x + y * y; }

  /* =========================================================================
     3. EASINGS
     Todas mapeiam [0,1] -> [0,1] com f(0)=0 e f(1)=1.
     Back e Elastic passam do alvo de proposito (overshoot).
     ========================================================================= */

  var BACK_C1 = 1.70158;
  var BACK_C2 = BACK_C1 * 1.525;
  var BACK_C3 = BACK_C1 + 1;
  var ELASTIC_C4 = TAU / 3;
  var ELASTIC_C5 = TAU / 4.5;
  var BOUNCE_N1 = 7.5625;
  var BOUNCE_D1 = 2.75;

  function linear(t) { return t; }

  function easeInQuad(t)    { t = saturate(t); return t * t; }
  function easeOutQuad(t)   { t = saturate(t); return 1 - (1 - t) * (1 - t); }
  function easeInOutQuad(t) {
    t = saturate(t);
    return t < 0.5 ? 2 * t * t : 1 - mPow(-2 * t + 2, 2) / 2;
  }

  function easeInCubic(t)    { t = saturate(t); return t * t * t; }
  function easeOutCubic(t)   { t = saturate(t); var u = 1 - t; return 1 - u * u * u; }
  function easeInOutCubic(t) {
    t = saturate(t);
    return t < 0.5 ? 4 * t * t * t : 1 - mPow(-2 * t + 2, 3) / 2;
  }

  function easeInQuart(t)    { t = saturate(t); var u = t * t; return u * u; }
  function easeOutQuart(t)   { t = saturate(t); var u = 1 - t; u *= u; return 1 - u * u; }
  function easeInOutQuart(t) {
    t = saturate(t);
    return t < 0.5 ? 8 * t * t * t * t : 1 - mPow(-2 * t + 2, 4) / 2;
  }

  function easeInQuint(t)    { t = saturate(t); var u = t * t; return u * u * t; }
  function easeOutQuint(t)   { t = saturate(t); var u = 1 - t, u2 = u * u; return 1 - u2 * u2 * u; }
  function easeInOutQuint(t) {
    t = saturate(t);
    return t < 0.5 ? 16 * t * t * t * t * t : 1 - mPow(-2 * t + 2, 5) / 2;
  }

  function easeInSine(t)    { t = saturate(t); return 1 - mCos(t * HALF_PI); }
  function easeOutSine(t)   { t = saturate(t); return mSin(t * HALF_PI); }
  function easeInOutSine(t) { t = saturate(t); return -(mCos(PI * t) - 1) / 2; }

  function easeInExpo(t)    { t = saturate(t); return t === 0 ? 0 : mPow(2, 10 * t - 10); }
  function easeOutExpo(t)   { t = saturate(t); return t === 1 ? 1 : 1 - mPow(2, -10 * t); }
  function easeInOutExpo(t) {
    t = saturate(t);
    if (t === 0) return 0;
    if (t === 1) return 1;
    return t < 0.5 ? mPow(2, 20 * t - 10) / 2 : (2 - mPow(2, -20 * t + 10)) / 2;
  }

  function easeInCirc(t)    { t = saturate(t); return 1 - mSqrt(1 - t * t); }
  function easeOutCirc(t)   { t = saturate(t); var u = t - 1; return mSqrt(1 - u * u); }
  function easeInOutCirc(t) {
    t = saturate(t);
    return t < 0.5
      ? (1 - mSqrt(1 - mPow(2 * t, 2))) / 2
      : (mSqrt(1 - mPow(-2 * t + 2, 2)) + 1) / 2;
  }

  function easeInBack(t)  { t = saturate(t); return BACK_C3 * t * t * t - BACK_C1 * t * t; }
  function easeOutBack(t) {
    t = saturate(t); var u = t - 1;
    return 1 + BACK_C3 * u * u * u + BACK_C1 * u * u;
  }
  function easeInOutBack(t) {
    t = saturate(t);
    return t < 0.5
      ? (mPow(2 * t, 2) * ((BACK_C2 + 1) * 2 * t - BACK_C2)) / 2
      : (mPow(2 * t - 2, 2) * ((BACK_C2 + 1) * (t * 2 - 2) + BACK_C2) + 2) / 2;
  }

  function easeInElastic(t) {
    t = saturate(t);
    if (t === 0) return 0;
    if (t === 1) return 1;
    return -mPow(2, 10 * t - 10) * mSin((t * 10 - 10.75) * ELASTIC_C4);
  }
  function easeOutElastic(t) {
    t = saturate(t);
    if (t === 0) return 0;
    if (t === 1) return 1;
    return mPow(2, -10 * t) * mSin((t * 10 - 0.75) * ELASTIC_C4) + 1;
  }
  function easeInOutElastic(t) {
    t = saturate(t);
    if (t === 0) return 0;
    if (t === 1) return 1;
    return t < 0.5
      ? -(mPow(2, 20 * t - 10) * mSin((20 * t - 11.125) * ELASTIC_C5)) / 2
      :  (mPow(2, -20 * t + 10) * mSin((20 * t - 11.125) * ELASTIC_C5)) / 2 + 1;
  }

  function easeOutBounce(t) {
    t = saturate(t);
    if (t < 1 / BOUNCE_D1)      { return BOUNCE_N1 * t * t; }
    else if (t < 2 / BOUNCE_D1) { t -= 1.5 / BOUNCE_D1; return BOUNCE_N1 * t * t + 0.75; }
    else if (t < 2.5 / BOUNCE_D1) { t -= 2.25 / BOUNCE_D1; return BOUNCE_N1 * t * t + 0.9375; }
    t -= 2.625 / BOUNCE_D1;
    return BOUNCE_N1 * t * t + 0.984375;
  }
  function easeInBounce(t) { return 1 - easeOutBounce(1 - saturate(t)); }
  function easeInOutBounce(t) {
    t = saturate(t);
    return t < 0.5
      ? (1 - easeOutBounce(1 - 2 * t)) / 2
      : (1 + easeOutBounce(2 * t - 1)) / 2;
  }

  /* Curva de "impulso": sobe rapido ate 1 e volta a 0. Perfeita para flashes,
     pulsos de bloom e escalas de gem no acerto. k controla a agudeza. */
  function impulse(t, k) {
    k = (k === undefined) ? 6 : k;
    var h = k * t;
    return h * mExp(1 - h);
  }
  /* Curva de sino simetrica (0 nas pontas, 1 no meio). */
  function bell(t) { t = saturate(t); return mSin(t * PI); }

  // Mapa por nome — util para dados/config ("ease": "easeOutBack").
  var Ease = {
    linear: linear,
    easeInQuad: easeInQuad, easeOutQuad: easeOutQuad, easeInOutQuad: easeInOutQuad,
    easeInCubic: easeInCubic, easeOutCubic: easeOutCubic, easeInOutCubic: easeInOutCubic,
    easeInQuart: easeInQuart, easeOutQuart: easeOutQuart, easeInOutQuart: easeInOutQuart,
    easeInQuint: easeInQuint, easeOutQuint: easeOutQuint, easeInOutQuint: easeInOutQuint,
    easeInSine: easeInSine, easeOutSine: easeOutSine, easeInOutSine: easeInOutSine,
    easeInExpo: easeInExpo, easeOutExpo: easeOutExpo, easeInOutExpo: easeInOutExpo,
    easeInCirc: easeInCirc, easeOutCirc: easeOutCirc, easeInOutCirc: easeInOutCirc,
    easeInBack: easeInBack, easeOutBack: easeOutBack, easeInOutBack: easeInOutBack,
    easeInElastic: easeInElastic, easeOutElastic: easeOutElastic, easeInOutElastic: easeInOutElastic,
    easeInBounce: easeInBounce, easeOutBounce: easeOutBounce, easeInOutBounce: easeInOutBounce,
    impulse: impulse, bell: bell
  };
  function ease(name, t) {
    var f = Ease[name];
    return f ? f(t) : saturate(t);
  }

  /* cubicBezierEase(x1,y1,x2,y2) -> funcao de easing igual a do CSS.
     Resolve x(t)=alvo por Newton-Raphson com fallback de bissecao. */
  function cubicBezierEase(x1, y1, x2, y2) {
    function A(a1, a2) { return 1 - 3 * a2 + 3 * a1; }
    function B(a1, a2) { return 3 * a2 - 6 * a1; }
    function C(a1)     { return 3 * a1; }
    function calc(t, a1, a2) { return ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t; }
    function slope(t, a1, a2) { return 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1); }
    return function (x) {
      x = saturate(x);
      if (x1 === y1 && x2 === y2) return x;      // atalho linear
      var t = x, i, d, s;
      for (i = 0; i < 8; i++) {                  // Newton
        d = calc(t, x1, x2) - x;
        if (mAbs(d) < 1e-6) return calc(t, y1, y2);
        s = slope(t, x1, x2);
        if (mAbs(s) < 1e-6) break;
        t -= d / s;
      }
      var lo = 0, hi = 1; t = x;                 // bissecao (fallback robusto)
      for (i = 0; i < 24; i++) {
        d = calc(t, x1, x2);
        if (mAbs(d - x) < 1e-6) break;
        if (d > x) hi = t; else lo = t;
        t = (lo + hi) * 0.5;
      }
      return calc(t, y1, y2);
    };
  }

  /* =========================================================================
     4. RNG DETERMINISTICO (mulberry32)
     ========================================================================= */

  // Converte qualquer coisa (int, float, string, null) em semente uint32 estavel.
  function hashSeed(s) {
    var i, h;
    if (s === undefined || s === null) return 0x9E3779B9;
    if (typeof s === 'string') {
      h = 2166136261 >>> 0;                                   // FNV-1a
      for (i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = mImul(h, 16777619) >>> 0;
      }
      return h >>> 0;
    }
    var n = +s;
    if (!isFinite(n)) return 0x9E3779B9;
    if (n === (n | 0)) return (n | 0) >>> 0;
    // float: mistura mantissa e expoente
    h = mImul(mFloor(mAbs(n)) ^ 0x85EBCA6B, 0xC2B2AE35) >>> 0;
    h ^= mFloor(mAbs(n % 1) * 4294967296) >>> 0;
    return h >>> 0;
  }

  function RNG(seed) {
    if (!(this instanceof RNG)) return new RNG(seed);
    this._seed  = 0;
    this._s     = 0;
    this._spare = null;   // cache do Box-Muller
    this.reseed(seed);
  }

  // Re-semeia e zera todo estado derivado. Sequencia 100% reprodutivel.
  RNG.prototype.reseed = function (seed) {
    this._seed = hashSeed(seed);
    this._s = this._seed | 0;
    this._spare = null;
    // aquece: sementes vizinhas (7, 8, 9) sairiam correlacionadas sem isto
    for (var i = 0; i < 6; i++) this.next();
    return this;
  };
  // Volta ao inicio da sequencia da semente atual.
  RNG.prototype.reset = function () { return this.reseed(this._seed); };

  // [0, 1) — o gerador em si.
  RNG.prototype.next = function () {
    var t = (this._s = (this._s + 0x6D2B79F5) | 0);
    t = mImul(t ^ (t >>> 15), 1 | t);
    t = (t + mImul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /* Apelido: varios adaptadores por ai sondam .next, .random ou .nextFloat.
     Publicar os tres nomes elimina a sondagem e a chance de cair no fallback. */
  RNG.prototype.random = RNG.prototype.next;
  RNG.prototype.nextFloat = RNG.prototype.next;

  // Float em [a, b). Com 1 argumento: [0, a).
  RNG.prototype.range = function (a, b) {
    if (b === undefined) { b = a; a = 0; }
    return a + (b - a) * this.next();
  };
  // Inteiro em [a, b] INCLUSIVO. Com 1 argumento: [0, a-1].
  RNG.prototype.int = function (a, b) {
    if (b === undefined) { b = a - 1; a = 0; }
    if (b < a) { var t = a; a = b; b = t; }
    return a + mFloor(this.next() * (b - a + 1));
  };
  // Elemento aleatorio de um array (undefined se vazio).
  RNG.prototype.pick = function (arr) {
    if (!arr || !arr.length) return undefined;
    return arr[(this.next() * arr.length) | 0];
  };
  // -1 ou +1, meio a meio.
  RNG.prototype.sign = function () { return this.next() < 0.5 ? -1 : 1; };
  // true com probabilidade p (default 0.5).
  RNG.prototype.chance = function (p) { return this.next() < (p === undefined ? 0.5 : p); };
  RNG.prototype.bool = RNG.prototype.chance;

  /* Gaussiana (Box-Muller polar) com cache do par. gauss(media, desvio).
     Sem argumentos: media 0, desvio 1. */
  RNG.prototype.gauss = function (mean, sd) {
    mean = (mean === undefined) ? 0 : mean;
    sd   = (sd   === undefined) ? 1 : sd;
    if (this._spare !== null) {
      var s = this._spare; this._spare = null;
      return mean + sd * s;
    }
    var u, v, r;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      r = u * u + v * v;
    } while (r >= 1 || r === 0);
    var f = mSqrt(-2 * mLog(r) / r);
    this._spare = v * f;
    return mean + sd * (u * f);
  };
  // Gaussiana cortada em +-limite desvios (evita outliers absurdos em VFX).
  RNG.prototype.gaussClamped = function (mean, sd, limit) {
    limit = (limit === undefined) ? 2.5 : limit;
    var g = this.gauss(0, 1);
    return (mean === undefined ? 0 : mean) + (sd === undefined ? 1 : sd) * clamp(g, -limit, limit);
  };

  // Angulo em [0, TAU).
  RNG.prototype.angle = function () { return this.next() * TAU; };
  // Vetor unitario 2D (escreve em out se fornecido — zero alocacao).
  RNG.prototype.unitVec2 = function (out) {
    var a = this.next() * TAU;
    out = out || { x: 0, y: 0 };
    out.x = mCos(a); out.y = mSin(a);
    return out;
  };
  // Ponto uniforme dentro do disco de raio r.
  RNG.prototype.inDisc = function (r, out) {
    var a = this.next() * TAU, d = mSqrt(this.next()) * (r === undefined ? 1 : r);
    out = out || { x: 0, y: 0 };
    out.x = mCos(a) * d; out.y = mSin(a) * d;
    return out;
  };
  // Direcao uniforme na esfera (marsaglia) — escreve em out {x,y,z}.
  RNG.prototype.unitVec3 = function (out) {
    var u, v, s;
    do { u = this.next() * 2 - 1; v = this.next() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    var f = 2 * mSqrt(1 - s);
    out = out || { x: 0, y: 0, z: 0 };
    out.x = u * f; out.y = v * f; out.z = 1 - 2 * s;
    return out;
  };

  // Embaralha NO LUGAR (Fisher-Yates) e devolve o proprio array.
  RNG.prototype.shuffle = function (arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (this.next() * (i + 1)) | 0;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };
  // Indice sorteado por pesos ([3,1,1] => 60%/20%/20%).
  RNG.prototype.weighted = function (weights) {
    var total = 0, i;
    for (i = 0; i < weights.length; i++) total += weights[i];
    if (total <= 0) return 0;
    var r = this.next() * total;
    for (i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  };
  // Sub-gerador independente e deterministico (para "ramos" de conteudo).
  RNG.prototype.fork = function () { return new RNG((this.next() * 4294967296) >>> 0); };

  // Estado serializavel (salvar/restaurar sem perder determinismo).
  RNG.prototype.getState = function () { return { s: this._s, seed: this._seed, spare: this._spare }; };
  RNG.prototype.setState = function (st) {
    if (!st) return this;
    this._s = st.s | 0; this._seed = st.seed >>> 0; this._spare = (st.spare === undefined) ? null : st.spare;
    return this;
  };

  /* GH.Util.rand — instancia global.
     E CHAMAVEL como funcao (rand() -> [0,1)) e tambem expoe todos os metodos
     do RNG (rand.range(...), rand.pick(...)). Assim atende os dois estilos de
     uso que aparecem no contrato. */
  var RNG_METHODS = ['next', 'random', 'nextFloat', 'range', 'int', 'pick', 'sign', 'chance',
                     'bool', 'gauss', 'gaussClamped', 'angle', 'unitVec2', 'unitVec3', 'inDisc',
                     'shuffle', 'weighted', 'reseed', 'reset', 'getState', 'setState'];

  function makeCallableRNG(seed) {
    var rng = new RNG(seed);
    var fn = function () { return rng.next(); };
    fn.rng = rng;
    for (var i = 0; i < RNG_METHODS.length; i++) {
      (function (name) {
        fn[name] = function (a, b, c) { return rng[name](a, b, c); };
      })(RNG_METHODS[i]);
    }
    /* fork() tem tratamento proprio para que o filho tambem saia chamavel —
       senao um `var r2 = r.fork(); r2()` quebraria so no ramo. */
    fn.fork = function () { return makeCallableRNG((rng.next() * 4294967296) >>> 0); };
    Object.defineProperty(fn, 'seedValue', { get: function () { return rng._seed; } });
    return fn;
  }

  var rand = makeCallableRNG(7);   // semente default do modo captura

  /* GH.Util.RNG publico.
     Antes ele devolvia uma INSTANCIA crua (so com .next()), enquanto
     GH.Util.rand era chamavel — assimetria que fez tres modulos diferentes
     (songs, synth, materials) escreverem o mesmo adaptador defensivo, e que
     transformava `var r = GH.Util.RNG(7); r()` num TypeError. Agora as duas
     formas sao a mesma coisa: chamavel E com todos os metodos do RNG.
     `new GH.Util.RNG(7)` continua valendo (construtor que devolve objeto
     entrega esse objeto) e a SEQUENCIA de numeros nao mudou nada — o
     conteudo procedural ja gerado continua identico. */
  function PublicRNG(seed) { return makeCallableRNG(seed); }
  PublicRNG.prototype = RNG.prototype;

  // Re-semeia o gerador global. Chamado por main.js no modo captura.
  function seed(n) { rand.reseed(n); return rand; }

  /* =========================================================================
     5. HASH INTEIRO + RUIDO PROCEDURAL
     Simplex 2D/3D/4D (Gustavson) + fbm + ridged + curl + worley + tileable.
     E a base de TODAS as texturas de canvas do jogo — precisa ser suave,
     sem tiling visivel e barato.
     ========================================================================= */

  // Hash inteiro -> [0,1). Deterministico, sem tabela, bom o suficiente.
  function hash11(x) {
    var h = mImul(x | 0, 374761393) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = mImul(h, 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function hash21(x, y) {
    var h = (mImul(x | 0, 374761393) + mImul(y | 0, 668265263)) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = mImul(h, 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function hash31(x, y, z) {
    var h = (mImul(x | 0, 374761393) + mImul(y | 0, 668265263) + mImul(z | 0, 2147483647)) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = mImul(h, 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // Gradientes (Gustavson).
  var GRAD3 = new Float32Array([
    1, 1, 0,  -1, 1, 0,   1, -1, 0,  -1, -1, 0,
    1, 0, 1,  -1, 0, 1,   1, 0, -1,  -1, 0, -1,
    0, 1, 1,   0, -1, 1,  0, 1, -1,   0, -1, -1
  ]);
  var GRAD4 = new Float32Array([
    0, 1, 1, 1,   0, 1, 1, -1,   0, 1, -1, 1,   0, 1, -1, -1,
    0, -1, 1, 1,  0, -1, 1, -1,  0, -1, -1, 1,  0, -1, -1, -1,
    1, 0, 1, 1,   1, 0, 1, -1,   1, 0, -1, 1,   1, 0, -1, -1,
    -1, 0, 1, 1,  -1, 0, 1, -1,  -1, 0, -1, 1,  -1, 0, -1, -1,
    1, 1, 0, 1,   1, 1, 0, -1,   1, -1, 0, 1,   1, -1, 0, -1,
    -1, 1, 0, 1,  -1, 1, 0, -1,  -1, -1, 0, 1,  -1, -1, 0, -1,
    1, 1, 1, 0,   1, 1, -1, 0,   1, -1, 1, 0,   1, -1, -1, 0,
    -1, 1, 1, 0,  -1, 1, -1, 0,  -1, -1, 1, 0,  -1, -1, -1, 0
  ]);

  var F2 = 0.5 * (SQRT3 - 1);
  var G2 = (3 - SQRT3) / 6;
  var F3 = 1 / 3, G3 = 1 / 6;
  var F4 = (mSqrt(5) - 1) / 4;
  var G4 = (5 - mSqrt(5)) / 20;

  /* makeNoise(seedValue) -> conjunto completo de funcoes de ruido com tabela
     de permutacao propria. Instancias diferentes = campos diferentes, mas
     cada uma deterministica para sempre. */
  function makeNoise(seedValue) {
    var r = new RNG(seedValue === undefined ? 0x5EED : seedValue);
    var p = new Uint8Array(256), i, j, t;
    for (i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) {                    // Fisher-Yates deterministico
      j = (r.next() * (i + 1)) | 0;
      t = p[i]; p[i] = p[j]; p[j] = t;
    }
    var perm = new Uint8Array(512), permMod12 = new Uint8Array(512);
    for (i = 0; i < 512; i++) {
      perm[i] = p[i & 255];
      permMod12[i] = perm[i] % 12;
    }
    var salt = (r.next() * 0x7FFFFFFF) | 0;        // usado pelo worley

    // ---- Simplex 2D -> [-1, 1] ------------------------------------------
    function noise2D(xin, yin) {
      var n0 = 0, n1 = 0, n2 = 0;
      var s = (xin + yin) * F2;
      var i = mFloor(xin + s), j = mFloor(yin + s);
      var t = (i + j) * G2;
      var x0 = xin - (i - t), y0 = yin - (j - t);
      var i1, j1;
      if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
      var x1 = x0 - i1 + G2,       y1 = y0 - j1 + G2;
      var x2 = x0 - 1 + 2 * G2,    y2 = y0 - 1 + 2 * G2;
      var ii = i & 255, jj = j & 255;
      var g0 = permMod12[ii + perm[jj]] * 3;
      var g1 = permMod12[ii + i1 + perm[jj + j1]] * 3;
      var g2 = permMod12[ii + 1 + perm[jj + 1]] * 3;
      var t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 > 0) { t0 *= t0; n0 = t0 * t0 * (GRAD3[g0] * x0 + GRAD3[g0 + 1] * y0); }
      var t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 > 0) { t1 *= t1; n1 = t1 * t1 * (GRAD3[g1] * x1 + GRAD3[g1 + 1] * y1); }
      var t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t2 > 0) { t2 *= t2; n2 = t2 * t2 * (GRAD3[g2] * x2 + GRAD3[g2 + 1] * y2); }
      return 70 * (n0 + n1 + n2);
    }

    // ---- Simplex 3D -> [-1, 1] ------------------------------------------
    function noise3D(xin, yin, zin) {
      var n0 = 0, n1 = 0, n2 = 0, n3 = 0;
      var s = (xin + yin + zin) * F3;
      var i = mFloor(xin + s), j = mFloor(yin + s), k = mFloor(zin + s);
      var t = (i + j + k) * G3;
      var x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
      var i1, j1, k1, i2, j2, k2;
      if (x0 >= y0) {
        if (y0 >= z0)      { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
        else               { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
      } else {
        if (y0 < z0)       { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0)  { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else               { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      }
      var x1 = x0 - i1 + G3,        y1 = y0 - j1 + G3,        z1 = z0 - k1 + G3;
      var x2 = x0 - i2 + 2 * G3,    y2 = y0 - j2 + 2 * G3,    z2 = z0 - k2 + 2 * G3;
      var x3 = x0 - 1 + 3 * G3,     y3 = y0 - 1 + 3 * G3,     z3 = z0 - 1 + 3 * G3;
      var ii = i & 255, jj = j & 255, kk = k & 255;
      var g0 = permMod12[ii + perm[jj + perm[kk]]] * 3;
      var g1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      var g2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      var g3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      var t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
      if (t0 > 0) { t0 *= t0; n0 = t0 * t0 * (GRAD3[g0] * x0 + GRAD3[g0 + 1] * y0 + GRAD3[g0 + 2] * z0); }
      var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
      if (t1 > 0) { t1 *= t1; n1 = t1 * t1 * (GRAD3[g1] * x1 + GRAD3[g1 + 1] * y1 + GRAD3[g1 + 2] * z1); }
      var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
      if (t2 > 0) { t2 *= t2; n2 = t2 * t2 * (GRAD3[g2] * x2 + GRAD3[g2 + 1] * y2 + GRAD3[g2 + 2] * z2); }
      var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
      if (t3 > 0) { t3 *= t3; n3 = t3 * t3 * (GRAD3[g3] * x3 + GRAD3[g3 + 1] * y3 + GRAD3[g3 + 2] * z3); }
      return 32 * (n0 + n1 + n2 + n3);
    }

    // ---- Simplex 4D -> [-1, 1] (base do ruido tileavel) ------------------
    function noise4D(x, y, z, w) {
      var n0 = 0, n1 = 0, n2 = 0, n3 = 0, n4 = 0;
      var s = (x + y + z + w) * F4;
      var i = mFloor(x + s), j = mFloor(y + s), k = mFloor(z + s), l = mFloor(w + s);
      var t = (i + j + k + l) * G4;
      var x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t), w0 = w - (l - t);
      // ranking: quantas coordenadas cada eixo supera define a ordem do simplex
      var rx = 0, ry = 0, rz = 0, rw = 0;
      if (x0 > y0) rx++; else ry++;
      if (x0 > z0) rx++; else rz++;
      if (x0 > w0) rx++; else rw++;
      if (y0 > z0) ry++; else rz++;
      if (y0 > w0) ry++; else rw++;
      if (z0 > w0) rz++; else rw++;
      var i1 = rx >= 3 ? 1 : 0, j1 = ry >= 3 ? 1 : 0, k1 = rz >= 3 ? 1 : 0, l1 = rw >= 3 ? 1 : 0;
      var i2 = rx >= 2 ? 1 : 0, j2 = ry >= 2 ? 1 : 0, k2 = rz >= 2 ? 1 : 0, l2 = rw >= 2 ? 1 : 0;
      var i3 = rx >= 1 ? 1 : 0, j3 = ry >= 1 ? 1 : 0, k3 = rz >= 1 ? 1 : 0, l3 = rw >= 1 ? 1 : 0;
      var x1 = x0 - i1 + G4,     y1 = y0 - j1 + G4,     z1 = z0 - k1 + G4,     w1 = w0 - l1 + G4;
      var x2 = x0 - i2 + 2 * G4, y2 = y0 - j2 + 2 * G4, z2 = z0 - k2 + 2 * G4, w2 = w0 - l2 + 2 * G4;
      var x3 = x0 - i3 + 3 * G4, y3 = y0 - j3 + 3 * G4, z3 = z0 - k3 + 3 * G4, w3 = w0 - l3 + 3 * G4;
      var x4 = x0 - 1 + 4 * G4,  y4 = y0 - 1 + 4 * G4,  z4 = z0 - 1 + 4 * G4,  w4 = w0 - 1 + 4 * G4;
      var ii = i & 255, jj = j & 255, kk = k & 255, ll = l & 255;
      var g0 = (perm[ii + perm[jj + perm[kk + perm[ll]]]] % 32) * 4;
      var g1 = (perm[ii + i1 + perm[jj + j1 + perm[kk + k1 + perm[ll + l1]]]] % 32) * 4;
      var g2 = (perm[ii + i2 + perm[jj + j2 + perm[kk + k2 + perm[ll + l2]]]] % 32) * 4;
      var g3 = (perm[ii + i3 + perm[jj + j3 + perm[kk + k3 + perm[ll + l3]]]] % 32) * 4;
      var g4 = (perm[ii + 1 + perm[jj + 1 + perm[kk + 1 + perm[ll + 1]]]] % 32) * 4;
      var t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0;
      if (t0 > 0) { t0 *= t0; n0 = t0 * t0 * (GRAD4[g0] * x0 + GRAD4[g0 + 1] * y0 + GRAD4[g0 + 2] * z0 + GRAD4[g0 + 3] * w0); }
      var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1;
      if (t1 > 0) { t1 *= t1; n1 = t1 * t1 * (GRAD4[g1] * x1 + GRAD4[g1 + 1] * y1 + GRAD4[g1 + 2] * z1 + GRAD4[g1 + 3] * w1); }
      var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2;
      if (t2 > 0) { t2 *= t2; n2 = t2 * t2 * (GRAD4[g2] * x2 + GRAD4[g2 + 1] * y2 + GRAD4[g2 + 2] * z2 + GRAD4[g2 + 3] * w2); }
      var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3;
      if (t3 > 0) { t3 *= t3; n3 = t3 * t3 * (GRAD4[g3] * x3 + GRAD4[g3 + 1] * y3 + GRAD4[g3 + 2] * z3 + GRAD4[g3 + 3] * w3); }
      var t4 = 0.6 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4;
      if (t4 > 0) { t4 *= t4; n4 = t4 * t4 * (GRAD4[g4] * x4 + GRAD4[g4 + 1] * y4 + GRAD4[g4 + 2] * z4 + GRAD4[g4 + 3] * w4); }
      return 27 * (n0 + n1 + n2 + n3 + n4);
    }

    // versoes normalizadas 0..1
    function noise2D01(x, y)       { return noise2D(x, y) * 0.5 + 0.5; }
    function noise3D01(x, y, z)    { return noise3D(x, y, z) * 0.5 + 0.5; }

    /* fbm2D — soma de oitavas. Devolve [-1, 1] (normalizado pela soma das
       amplitudes, entao o contraste nao muda com o numero de oitavas). */
    function fbm2D(x, y, octaves, lacunarity, gain) {
      octaves    = octaves    || 4;
      lacunarity = lacunarity || 2.0;
      gain       = (gain === undefined) ? 0.5 : gain;
      var sum = 0, amp = 1, freq = 1, norm = 0;
      for (var o = 0; o < octaves; o++) {
        // deslocamento irracional por oitava: mata o alinhamento de features
        sum  += amp * noise2D(x * freq + o * 31.416, y * freq - o * 17.234);
        norm += amp;
        freq *= lacunarity;
        amp  *= gain;
      }
      return norm > 0 ? sum / norm : 0;
    }
    function fbm2D01(x, y, octaves, lacunarity, gain) {
      return fbm2D(x, y, octaves, lacunarity, gain) * 0.5 + 0.5;
    }
    function fbm3D(x, y, z, octaves, lacunarity, gain) {
      octaves    = octaves    || 4;
      lacunarity = lacunarity || 2.0;
      gain       = (gain === undefined) ? 0.5 : gain;
      var sum = 0, amp = 1, freq = 1, norm = 0;
      for (var o = 0; o < octaves; o++) {
        sum  += amp * noise3D(x * freq + o * 31.416, y * freq - o * 17.234, z * freq + o * 11.777);
        norm += amp;
        freq *= lacunarity;
        amp  *= gain;
      }
      return norm > 0 ? sum / norm : 0;
    }

    /* ridged — cristas afiadas (veios de madeira, riscos de metal, raios).
       Devolve [0, 1]. */
    function ridged(x, y, octaves, lacunarity, gain) {
      octaves    = octaves    || 4;
      lacunarity = lacunarity || 2.0;
      gain       = (gain === undefined) ? 0.5 : gain;
      var sum = 0, amp = 0.5, freq = 1, prev = 1, norm = 0;
      for (var o = 0; o < octaves; o++) {
        var n = 1 - mAbs(noise2D(x * freq + o * 23.11, y * freq + o * 41.77));
        n *= n;
        sum  += n * amp * prev;
        norm += amp;
        prev  = n;
        freq *= lacunarity;
        amp  *= gain;
      }
      return saturate(norm > 0 ? sum / norm : 0);
    }

    /* turbulencia — |fbm|, bom para fumaca, fogo e nuvem. [0, 1] */
    function turbulence(x, y, octaves, lacunarity, gain) {
      octaves    = octaves    || 4;
      lacunarity = lacunarity || 2.0;
      gain       = (gain === undefined) ? 0.5 : gain;
      var sum = 0, amp = 1, freq = 1, norm = 0;
      for (var o = 0; o < octaves; o++) {
        sum  += amp * mAbs(noise2D(x * freq + o * 13.7, y * freq + o * 29.3));
        norm += amp;
        freq *= lacunarity;
        amp  *= gain;
      }
      return norm > 0 ? saturate(sum / norm) : 0;
    }

    /* curl2D — campo vetorial sem divergencia derivado de um potencial fbm.
       Escoamento organico para fumaca/faisca (nunca converge nem diverge, e o
       que faz a fumaca "rolar" de verdade). Escreve em out {x,y}.
       ATENCAO a magnitude: e a derivada do potencial, entao cresce com 1/eps
       (com o eps padrao os valores ficam tipicamente em +-5). Multiplique por
       uma constante de velocidade ao advectar particulas. */
    function curl2D(x, y, out, eps, octaves) {
      eps = eps || 0.06;
      octaves = octaves || 3;
      out = out || { x: 0, y: 0 };
      var n1 = fbm2D(x, y + eps, octaves);
      var n2 = fbm2D(x, y - eps, octaves);
      var dy = (n1 - n2) / (2 * eps);
      var n3 = fbm2D(x + eps, y, octaves);
      var n4 = fbm2D(x - eps, y, octaves);
      var dx = (n3 - n4) / (2 * eps);
      out.x = dy;
      out.y = -dx;
      return out;
    }

    /* Domain warping — fbm cujas coordenadas sao deslocadas por outro fbm.
       E o truque que faz textura procedural parecer "feita a mao". [-1,1] */
    function warpedFbm2D(x, y, strength, octaves) {
      strength = (strength === undefined) ? 0.6 : strength;
      var qx = fbm2D(x + 0.0, y + 0.0, 3);
      var qy = fbm2D(x + 5.2, y + 1.3, 3);
      return fbm2D(x + strength * qx, y + strength * qy, octaves || 4);
    }

    /* Ruido 2D PERFEITAMENTE tileavel num retangulo w x h: amostra um toro
       em 4D. Sem costura, sem perda de contraste no meio do tile.

       Os deslocamentos irracionais (TORUS_OFF*) nao sao decoracao: sem eles,
       na borda do tile sin(0)=0 e sin(TAU)=-2.4e-16 produzem coordenadas
       EMPATADAS no ranking do simplex 4D, e o empate resolve para lados
       diferentes nos dois extremos da costura (erro medido de ~1e-3).
       Com o deslocamento, os dois extremos caem sempre no mesmo simplex e a
       costura fica exata ate o ultimo bit. */
    var TORUS_OFF_X = 12.53, TORUS_OFF_Y = 31.77, TORUS_OFF_Z = 53.91, TORUS_OFF_W = 71.31;
    function tileable2D(x, y, w, h) {
      w = w || 1; h = h || 1;
      var a = (x / w) * TAU, b = (y / h) * TAU;
      var rw = w / TAU, rh = h / TAU;
      return noise4D(mCos(a) * rw + TORUS_OFF_X, mSin(a) * rw + TORUS_OFF_Y,
                     mCos(b) * rh + TORUS_OFF_Z, mSin(b) * rh + TORUS_OFF_W);
    }
    function tileableFbm2D(x, y, w, h, octaves, lacunarity, gain) {
      octaves    = octaves    || 4;
      lacunarity = lacunarity || 2.0;
      gain       = (gain === undefined) ? 0.5 : gain;
      var sum = 0, amp = 1, freq = 1, norm = 0;
      for (var o = 0; o < octaves; o++) {
        sum  += amp * tileable2D(x * freq, y * freq, w * freq, h * freq);
        norm += amp;
        freq *= lacunarity;
        amp  *= gain;
      }
      return norm > 0 ? sum / norm : 0;
    }

    /* Worley / celular. Devolve out {f1, f2, id}:
       f1 = distancia ao ponto mais proximo, f2 = ao segundo (f2-f1 desenha as
       bordas das celulas — couro, pedra, escamas, multidao). */
    function worley2D(x, y, jitter, out) {
      jitter = (jitter === undefined) ? 1 : jitter;
      out = out || { f1: 0, f2: 0, id: 0 };
      var ix = mFloor(x), iy = mFloor(y);
      var fx = x - ix, fy = y - iy;
      var f1 = 8, f2 = 8, id = 0;
      for (var oy = -1; oy <= 1; oy++) {
        for (var ox = -1; ox <= 1; ox++) {
          var cx = ix + ox, cy = iy + oy;
          var h1 = hash21(cx + salt, cy - salt);
          var h2 = hash21(cx * 7 + 131 + salt, cy * 13 - 977 - salt);
          var px = ox + 0.5 + (h1 - 0.5) * jitter - fx;
          var py = oy + 0.5 + (h2 - 0.5) * jitter - fy;
          var d = px * px + py * py;
          if (d < f1) { f2 = f1; f1 = d; id = h1; }
          else if (d < f2) { f2 = d; }
        }
      }
      out.f1 = mSqrt(f1);
      out.f2 = mSqrt(f2);
      out.id = id;
      return out;
    }

    /* Value noise bilinear suave — mais barato que simplex, com cara de
       "manchado". Bom para variacao lenta e mascaras. [0,1] */
    function value2D(x, y) {
      var ix = mFloor(x), iy = mFloor(y);
      var fx = x - ix, fy = y - iy;
      var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      var a = hash21(ix + salt, iy + salt);
      var b = hash21(ix + 1 + salt, iy + salt);
      var c = hash21(ix + salt, iy + 1 + salt);
      var d = hash21(ix + 1 + salt, iy + 1 + salt);
      return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
    }

    return {
      seed: seedValue,
      perm: perm,
      noise2D: noise2D, noise3D: noise3D, noise4D: noise4D,
      noise2D01: noise2D01, noise3D01: noise3D01,
      fbm2D: fbm2D, fbm2D01: fbm2D01, fbm3D: fbm3D,
      ridged: ridged, turbulence: turbulence, curl2D: curl2D,
      warpedFbm2D: warpedFbm2D,
      tileable2D: tileable2D, tileableFbm2D: tileableFbm2D,
      worley2D: worley2D, value2D: value2D
    };
  }

  // Instancia padrao — semente FIXA para que as texturas do jogo sejam sempre
  // as mesmas (inclusive entre cenas do modo captura).
  var defaultNoise = makeNoise(0x6C1A);

  /* =========================================================================
     6. COR
     ========================================================================= */

  /* Fallback minimo de THREE.Color: se por qualquer motivo o vendor nao tiver
     carregado, o jogo ainda funciona sem tela preta silenciosa. */
  function FallbackColor(v) {
    this.isColor = true; this.r = 1; this.g = 1; this.b = 1;
    if (v !== undefined) this.set(v);
  }
  FallbackColor.prototype.set = function (v) {
    if (v && v.isColor) return this.copy(v);
    if (typeof v === 'number') return this.setHex(v);
    if (typeof v === 'string') return this.setStyle(v);
    return this;
  };
  FallbackColor.prototype.setHex = function (hex) {
    hex = mFloor(hex);
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
    return this;
  };
  FallbackColor.prototype.setStyle = function (s) {
    s = String(s).trim();
    if (s.charAt(0) === '#') s = s.slice(1);
    if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    return this.setHex(parseInt(s, 16) || 0);
  };
  FallbackColor.prototype.setRGB = function (r, g, b) { this.r = r; this.g = g; this.b = b; return this; };
  FallbackColor.prototype.setScalar = function (v) { this.r = this.g = this.b = v; return this; };
  FallbackColor.prototype.setHSL = function (h, s, l) {
    h = mod(h, 1); s = saturate(s); l = saturate(l);
    if (s === 0) { this.r = this.g = this.b = l; return this; }
    var q = l <= 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    this.r = hue2rgb(p, q, h + 1 / 3);
    this.g = hue2rgb(p, q, h);
    this.b = hue2rgb(p, q, h - 1 / 3);
    return this;
  };
  FallbackColor.prototype.copy = function (c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; };
  FallbackColor.prototype.clone = function () { return new FallbackColor().copy(this); };
  FallbackColor.prototype.getHex = function () {
    return (mRound(saturate(this.r) * 255) << 16) ^ (mRound(saturate(this.g) * 255) << 8) ^ mRound(saturate(this.b) * 255);
  };
  FallbackColor.prototype.getHexString = function () { return ('000000' + this.getHex().toString(16)).slice(-6); };
  FallbackColor.prototype.getStyle = function () { return '#' + this.getHexString(); };
  FallbackColor.prototype.lerp = function (c, t) {
    this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t;
    return this;
  };
  FallbackColor.prototype.multiplyScalar = function (s) { this.r *= s; this.g *= s; this.b *= s; return this; };
  FallbackColor.prototype.offsetHSL = function () { return this; };
  FallbackColor.prototype.getHSL = function (t) {
    t = t || { h: 0, s: 0, l: 0 };
    var r = this.r, g = this.g, b = this.b;
    var max = mMax(r, g, b), min = mMin(r, g, b);
    var h = 0, s = 0, l = (min + max) / 2;
    if (min !== max) {
      var d = max - min;
      s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
      if (max === r)      h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else                h = (r - g) / d + 4;
      h /= 6;
    }
    t.h = h; t.s = s; t.l = l;
    return t;
  };
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
    return p;
  }

  var ColorCtor = (typeof THREE !== 'undefined' && THREE.Color) ? THREE.Color : FallbackColor;

  // temporarios internos (evita alocar em mixColor/lumaOf a cada frame)
  var _tmpColorA = new ColorCtor();
  var _tmpColorB = new ColorCtor();
  var _tmpHSL    = { h: 0, s: 0, l: 0 };

  // Converte '#rrggbb' | 0xrrggbb | THREE.Color -> THREE.Color (usa `into` se dado).
  function toColor(v, into) {
    var c = into || new ColorCtor();
    if (v && v.isColor) { c.r = v.r; c.g = v.g; c.b = v.b; return c; }
    if (typeof v === 'number') return c.setHex(v);
    if (typeof v === 'string') return c.setStyle(v);
    return c.setRGB(1, 1, 1);
  }

  // h, s, l em 0..1 (h e volta completa, como no THREE).
  function hsl(h, s, l) { return new ColorCtor().setHSL(mod(h, 1), saturate(s), saturate(l)); }
  // Versao com matiz em graus — mais legivel ao escrever paletas.
  function hslDeg(hDeg, s, l) { return hsl(mod(hDeg, 360) / 360, s, l); }

  /* Mistura sRGB simples (o que a maioria espera visualmente).
     `out` opcional evita alocacao em loop. */
  function mixColor(a, b, t, out) {
    var ca = toColor(a, _tmpColorA);
    var cb = toColor(b, _tmpColorB);
    out = out || new ColorCtor();
    out.r = ca.r + (cb.r - ca.r) * t;
    out.g = ca.g + (cb.g - ca.g) * t;
    out.b = ca.b + (cb.b - ca.b) * t;
    return out;
  }
  /* Mistura em luz LINEAR (fisicamente correta): meio-termo mais brilhante,
     sem aquele cinza morto. Usada nas transicoes de tema. */
  function mixColorLinear(a, b, t, out) {
    var ca = toColor(a, _tmpColorA);
    var cb = toColor(b, _tmpColorB);
    out = out || new ColorCtor();
    out.r = mSqrt(mMax(0, ca.r * ca.r + (cb.r * cb.r - ca.r * ca.r) * t));
    out.g = mSqrt(mMax(0, ca.g * ca.g + (cb.g * cb.g - ca.g * ca.g) * t));
    out.b = mSqrt(mMax(0, ca.b * ca.b + (cb.b * cb.b - ca.b * ca.b) * t));
    return out;
  }
  // Mistura pelo caminho de matiz (transicao vibrante entre cores saturadas).
  function mixColorHSL(a, b, t, out) {
    var ca = toColor(a, _tmpColorA);
    var cb = toColor(b, _tmpColorB);
    var h1 = ca.getHSL({ h: 0, s: 0, l: 0 });
    var h2 = cb.getHSL({ h: 0, s: 0, l: 0 });
    var dh = h2.h - h1.h;
    if (dh > 0.5) dh -= 1; else if (dh < -0.5) dh += 1;   // caminho curto
    out = out || new ColorCtor();
    return out.setHSL(mod(h1.h + dh * t, 1), lerp(h1.s, h2.s, t), lerp(h1.l, h2.l, t));
  }

  // '#rrggbb' | '#rgb' | 0xrrggbb -> {r,g,b} em 0..1 (+ r8,g8,b8 em 0..255).
  function hexToRgb(hex) {
    var c = toColor(hex, _tmpColorA);
    return {
      r: c.r, g: c.g, b: c.b,
      r8: mRound(c.r * 255), g8: mRound(c.g * 255), b8: mRound(c.b * 255)
    };
  }
  // r,g,b em 0..1 -> '#rrggbb'
  function rgbToHex(r, g, b) {
    var n = (mRound(saturate(r) * 255) << 16) | (mRound(saturate(g) * 255) << 8) | mRound(saturate(b) * 255);
    return '#' + ('000000' + n.toString(16)).slice(-6);
  }
  // Qualquer cor -> '#rrggbb'
  function colorToHex(c) { return '#' + toColor(c, _tmpColorA).getHexString(); }
  // Qualquer cor -> 'rgba(r,g,b,a)' — para CSS/canvas 2D.
  function cssRgba(c, alpha) {
    var k = toColor(c, _tmpColorA);
    return 'rgba(' + mRound(k.r * 255) + ',' + mRound(k.g * 255) + ',' + mRound(k.b * 255) + ',' +
           (alpha === undefined ? 1 : mRound(alpha * 1000) / 1000) + ')';
  }

  // Luminancia relativa Rec.709 (0..1) — decide texto claro/escuro e contraste.
  function lumaOf(c) {
    var k = toColor(c, _tmpColorA);
    return 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b;
  }
  // Escurece (amt<0) ou clareia (amt>0) mantendo matiz. amt em -1..1.
  function shade(c, amt, out) {
    var k = toColor(c, out || new ColorCtor());
    if (amt >= 0) { k.r += (1 - k.r) * amt; k.g += (1 - k.g) * amt; k.b += (1 - k.b) * amt; }
    else          { var f = 1 + amt; k.r *= f; k.g *= f; k.b *= f; }
    return k;
  }
  // Ajusta saturacao (0 = cinza, 1 = original, >1 = estoura).
  function saturateColor(c, amt, out) {
    var k = toColor(c, out || new ColorCtor());
    var l = 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b;
    k.r = mMax(0, l + (k.r - l) * amt);
    k.g = mMax(0, l + (k.g - l) * amt);
    k.b = mMax(0, l + (k.b - l) * amt);
    return k;
  }
  // Multiplica a intensidade (util para emissiveIntensity implicita).
  function scaleColor(c, k, out) {
    var col = toColor(c, out || new ColorCtor());
    col.r *= k; col.g *= k; col.b *= k;
    return col;
  }
  // Gira o matiz em `turns` (0..1) — variacao rapida de paleta.
  function rotateHue(c, turns, out) {
    var k = toColor(c, out || new ColorCtor());
    k.getHSL(_tmpHSL);
    return k.setHSL(mod(_tmpHSL.h + turns, 1), _tmpHSL.s, _tmpHSL.l);
  }
  // Amostra de um gradiente definido por array de cores (t em 0..1).
  function sampleRamp(colors, t, out) {
    if (!colors || !colors.length) return toColor(0xffffff, out);
    if (colors.length === 1) return toColor(colors[0], out);
    var x = saturate(t) * (colors.length - 1);
    var i = mFloor(x);
    if (i >= colors.length - 1) return toColor(colors[colors.length - 1], out);
    return mixColor(colors[i], colors[i + 1], x - i, out);
  }

  /* =========================================================================
     7. FORMATACAO (HUD/menus)
     ========================================================================= */

  // 1234567 -> "1.234.567" (pt-BR). Passe sep para trocar o separador.
  function formatScore(n, sep) {
    sep = (sep === undefined) ? '.' : sep;
    var v = mRound(+n || 0);
    var neg = v < 0;
    var s = String(mAbs(v));
    var out = '';
    var i = s.length;
    while (i > 3) { out = sep + s.slice(i - 3, i) + out; i -= 3; }
    out = s.slice(0, i) + out;
    return (neg ? '-' : '') + out;
  }
  // Alias semantico.
  function formatNumber(n, sep) { return formatScore(n, sep); }

  // 83 -> "1:23"; 3723 -> "1:02:03". Negativo vira "0:00".
  function formatTime(sec) {
    var v = mFloor(mMax(0, +sec || 0));
    var h = mFloor(v / 3600);
    var m = mFloor((v % 3600) / 60);
    var s = v % 60;
    var ss = (s < 10 ? '0' : '') + s;
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + ss;
    return m + ':' + ss;
  }
  // 0.9873 -> "98.7%" (digits casas decimais).
  function formatPercent(x, digits) {
    digits = (digits === undefined) ? 1 : digits;
    return (saturate(x) * 100).toFixed(digits) + '%';
  }
  // -12.4 -> "-12ms" (offsets de calibracao/julgamento).
  function formatMs(ms, signed) {
    var v = mRound(ms);
    return (signed && v > 0 ? '+' : '') + v + 'ms';
  }
  function padZero(n, width) {
    var s = String(mAbs(mFloor(n)));
    while (s.length < width) s = '0' + s;
    return (n < 0 ? '-' : '') + s;
  }
  // "5" -> "5x"; formata multiplicador.
  function formatMult(m) { return (m | 0) + 'x'; }

  /* =========================================================================
     8. POOL DE OBJETOS
     Zero alocacao no loop quente: remocao O(1) por swap, indice guardado no
     proprio objeto.
     ========================================================================= */

  function Pool(factory, resetFn, initialSize) {
    if (!(this instanceof Pool)) return new Pool(factory, resetFn, initialSize);
    this._factory = factory;
    this._reset   = resetFn || null;
    this._free    = [];
    this._active  = [];
    this.created  = 0;
    if (initialSize) this.prewarm(initialSize);
  }

  // Cria n objetos adiantado (evita hitch no primeiro uso).
  Pool.prototype.prewarm = function (n) {
    for (var i = 0; i < n; i++) {
      var o = this._factory(this);
      this.created++;
      o.__poolIndex = -1;
      o.__poolOwner = null;
      if (this._reset) this._reset(o);
      this._free.push(o);
    }
    return this;
  };

  // Pega um objeto livre (ou fabrica um novo) e marca como ativo.
  Pool.prototype.get = function () {
    var o;
    if (this._free.length) o = this._free.pop();
    else { o = this._factory(this); this.created++; }
    o.__poolOwner = this;
    o.__poolIndex = this._active.length;
    this._active.push(o);
    return o;
  };

  // Devolve ao pool. Chama resetFn(obj) ANTES de guardar. Ignora duplicata.
  Pool.prototype.release = function (o) {
    if (!o || o.__poolOwner !== this) return false;
    var idx = o.__poolIndex;
    var last = this._active.pop();
    if (last !== o) { this._active[idx] = last; last.__poolIndex = idx; }
    o.__poolIndex = -1;
    o.__poolOwner = null;
    if (this._reset) this._reset(o);
    this._free.push(o);
    return true;
  };

  // Devolve todos os ativos.
  Pool.prototype.releaseAll = function () {
    for (var i = this._active.length - 1; i >= 0; i--) {
      var o = this._active[i];
      o.__poolIndex = -1;
      o.__poolOwner = null;
      if (this._reset) this._reset(o);
      this._free.push(o);
    }
    this._active.length = 0;
    return this;
  };

  /* Itera os ativos DE TRAS PRA FRENTE: e seguro chamar release() de dentro
     do callback. fn(obj, index) — se devolver false, para a iteracao. */
  Pool.prototype.forEachActive = function (fn) {
    for (var i = this._active.length - 1; i >= 0; i--) {
      if (fn(this._active[i], i) === false) break;
    }
    return this;
  };

  // Descarta tudo (chama fn em cada objeto, ex.: geometry.dispose()).
  Pool.prototype.dispose = function (fn) {
    var i;
    if (fn) {
      for (i = 0; i < this._active.length; i++) fn(this._active[i]);
      for (i = 0; i < this._free.length; i++) fn(this._free[i]);
    }
    this._active.length = 0;
    this._free.length = 0;
    this.created = 0;
    return this;
  };

  Object.defineProperty(Pool.prototype, 'activeCount', {
    get: function () { return this._active.length; }
  });
  Object.defineProperty(Pool.prototype, 'freeCount', {
    get: function () { return this._free.length; }
  });
  Object.defineProperty(Pool.prototype, 'size', {
    get: function () { return this._active.length + this._free.length; }
  });
  Object.defineProperty(Pool.prototype, 'active', {
    get: function () { return this._active; }   // leitura apenas — nao mutar!
  });

  /* =========================================================================
     9. MOLAS E SUAVIZACAO
     ========================================================================= */

  /* SpringValue(stiffness, damping) — mola numerica para UI e camera.
       sv.target = 1.0;  sv.update(dt);  usa sv.value
     Defaults sao criticamente amortecidos-ish (sem oscilar feio).
     Integrado com sub-passos: estavel mesmo com dt grande. */
  function SpringValue(stiffness, damping, value) {
    if (!(this instanceof SpringValue)) return new SpringValue(stiffness, damping, value);
    this.stiffness = (stiffness === undefined) ? 180 : stiffness;
    this.damping   = (damping   === undefined) ? 2 * mSqrt((stiffness === undefined) ? 180 : stiffness) : damping;
    this.value     = value || 0;
    this.target    = this.value;
    this.velocity  = 0;
    this.precision = 0.0004;
    this.settled   = true;
    this.maxStep   = 1 / 120;     // passo interno de integracao
  }
  // Salta direto para v (sem animar).
  SpringValue.prototype.set = function (v) {
    this.value = v; this.target = v; this.velocity = 0; this.settled = true;
    return this;
  };
  // Define alvo (equivale a sv.target = v, mas encadeavel).
  SpringValue.prototype.to = function (v) { this.target = v; this.settled = false; return this; };
  // Empurrao de velocidade (impacto, batida, acerto).
  SpringValue.prototype.nudge = function (dv) { this.velocity += dv; this.settled = false; return this; };
  /* Configura por frequencia (Hz) e razao de amortecimento:
       ratio 1 = critico, <1 oscila, >1 arrasta. */
  SpringValue.prototype.configure = function (freqHz, ratio) {
    var omega = TAU * freqHz;
    this.stiffness = omega * omega;
    this.damping   = 2 * ratio * omega;
    return this;
  };
  SpringValue.prototype.update = function (dt) {
    if (!(dt > 0)) return this.value;
    if (dt > 0.25) dt = 0.25;                       // protege contra abas em background
    var steps = mMin(16, mMax(1, mCeil(dt / this.maxStep)));
    var h = dt / steps;
    for (var i = 0; i < steps; i++) {
      var a = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
      this.velocity += a * h;
      this.value    += this.velocity * h;
    }
    if (mAbs(this.target - this.value) < this.precision && mAbs(this.velocity) < this.precision * 60) {
      this.value = this.target; this.velocity = 0; this.settled = true;
    } else {
      this.settled = false;
    }
    return this.value;
  };

  /* Versao 3 componentes — camera rig, posicao de painel, etc.
     Trabalha com qualquer objeto {x,y,z} (inclusive THREE.Vector3). */
  function SpringVec3(stiffness, damping) {
    if (!(this instanceof SpringVec3)) return new SpringVec3(stiffness, damping);
    this.x = new SpringValue(stiffness, damping);
    this.y = new SpringValue(stiffness, damping);
    this.z = new SpringValue(stiffness, damping);
  }
  SpringVec3.prototype.set = function (x, y, z) {
    this.x.set(x); this.y.set(y); this.z.set(z); return this;
  };
  SpringVec3.prototype.to = function (x, y, z) {
    this.x.target = x; this.y.target = y; this.z.target = z; return this;
  };
  SpringVec3.prototype.nudge = function (x, y, z) {
    this.x.nudge(x); this.y.nudge(y); this.z.nudge(z); return this;
  };
  SpringVec3.prototype.configure = function (freqHz, ratio) {
    this.x.configure(freqHz, ratio); this.y.configure(freqHz, ratio); this.z.configure(freqHz, ratio);
    return this;
  };
  SpringVec3.prototype.update = function (dt) {
    this.x.update(dt); this.y.update(dt); this.z.update(dt); return this;
  };
  // Escreve o resultado em qualquer objeto com x,y,z (ex.: camera.position).
  SpringVec3.prototype.applyTo = function (obj) {
    obj.x = this.x.value; obj.y = this.y.value; obj.z = this.z.value; return obj;
  };
  Object.defineProperty(SpringVec3.prototype, 'settled', {
    get: function () { return this.x.settled && this.y.settled && this.z.settled; }
  });

  /* smoothDamp — o mesmo algoritmo do Mathf.SmoothDamp da Unity.
     A velocidade e mantida em um objeto por referencia: var v = {v:0};
       pos = GH.Util.smoothDamp(pos, alvo, v, 0.15, dt);
     smoothTime = tempo aproximado para chegar ao alvo (segundos). */
  function smoothDamp(current, target, velRef, smoothTime, dt, maxSpeed) {
    smoothTime = mMax(0.0001, smoothTime);
    maxSpeed   = (maxSpeed === undefined) ? Infinity : maxSpeed;
    if (!velRef) velRef = { v: 0 };
    if (velRef.v === undefined) velRef.v = 0;
    if (!(dt > 0)) return current;

    var omega = 2 / smoothTime;
    var x = omega * dt;
    // aproximacao racional de exp(-x) — barata e estavel
    var expo = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    var change = current - target;
    var originalTo = target;

    var maxChange = maxSpeed * smoothTime;
    change = clamp(change, -maxChange, maxChange);
    target = current - change;

    var temp = (velRef.v + omega * change) * dt;
    velRef.v = (velRef.v - omega * temp) * expo;
    var output = target + (change + temp) * expo;

    // impede ultrapassar o alvo
    if ((originalTo - current > 0) === (output > originalTo)) {
      output = originalTo;
      velRef.v = (output - originalTo) / dt;
    }
    return output;
  }
  // Versao angular (respeita o caminho curto).
  function smoothDampAngle(current, target, velRef, smoothTime, dt, maxSpeed) {
    return smoothDamp(current, current + angleDelta(current, target), velRef, smoothTime, dt, maxSpeed);
  }

  /* =========================================================================
     10. CURVAS
     ========================================================================= */

  // Catmull-Rom uniforme escalar: passa por p1 (t=0) e p2 (t=1).
  function catmullRom(p0, p1, p2, p3, t) {
    var v0 = (p2 - p0) * 0.5;
    var v1 = (p3 - p1) * 0.5;
    var t2 = t * t, t3 = t2 * t;
    return (2 * p1 - 2 * p2 + v0 + v1) * t3 +
           (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 +
           v0 * t + p1;
  }
  // Idem para vetores {x,y,z} (out opcional, zero alocacao).
  function catmullRom3(p0, p1, p2, p3, t, out) {
    out = out || { x: 0, y: 0, z: 0 };
    out.x = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
    out.y = catmullRom(p0.y, p1.y, p2.y, p3.y, t);
    out.z = catmullRom(p0.z || 0, p1.z || 0, p2.z || 0, p3.z || 0, t);
    return out;
  }
  // Bezier cubica escalar.
  function bezier(p0, p1, p2, p3, t) {
    var mt = 1 - t, mt2 = mt * mt, t2 = t * t;
    return mt2 * mt * p0 + 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t2 * t * p3;
  }
  // Bezier quadratica escalar.
  function bezier2(p0, p1, p2, t) {
    var mt = 1 - t;
    return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
  }
  // Bezier cubica em 3D (out opcional).
  function bezier3(p0, p1, p2, p3, t, out) {
    out = out || { x: 0, y: 0, z: 0 };
    out.x = bezier(p0.x, p1.x, p2.x, p3.x, t);
    out.y = bezier(p0.y, p1.y, p2.y, p3.y, t);
    out.z = bezier(p0.z || 0, p1.z || 0, p2.z || 0, p3.z || 0, t);
    return out;
  }
  // Derivada da bezier cubica (tangente — orientar trilhas/particulas).
  function bezierDerivative(p0, p1, p2, p3, t) {
    var mt = 1 - t;
    return 3 * mt * mt * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t * t * (p3 - p2);
  }
  // Hermite escalar (posicao + tangente nas duas pontas).
  function hermite(p0, m0, p1, m1, t) {
    var t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 +
           (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
  }

  /* =========================================================================
     11. TEMPO, THROTTLE, DIVERSOS
     ========================================================================= */

  var _perf = (typeof performance !== 'undefined' && performance.now) ? performance : null;
  var _timeOrigin = _perf ? _perf.now() : Date.now();

  // SEGUNDOS desde o carregamento do modulo (alta resolucao).
  function now() { return ((_perf ? _perf.now() : Date.now()) - _timeOrigin) / 1000; }
  // MILISSEGUNDOS de alta resolucao (equivalente a performance.now()).
  function nowMs() { return _perf ? _perf.now() : Date.now(); }

  /* throttle(fn, ms) — no maximo uma chamada a cada ms. Dispara na borda de
     subida e agenda a ultima chamada pendente na borda de descida. */
  function throttle(fn, ms, context) {
    var last = -Infinity, timer = null, pendingArgs = null;
    function invoke(args) {
      last = nowMs();
      fn.apply(context || null, args || []);
    }
    var wrapped = function () {
      var args = Array.prototype.slice.call(arguments);
      var elapsed = nowMs() - last;
      if (elapsed >= ms) {
        if (timer) { clearTimeout(timer); timer = null; }
        invoke(args);
      } else {
        pendingArgs = args;
        if (!timer) {
          timer = setTimeout(function () {
            timer = null;
            invoke(pendingArgs);
            pendingArgs = null;
          }, ms - elapsed);
        }
      }
    };
    wrapped.cancel = function () {
      if (timer) { clearTimeout(timer); timer = null; }
      pendingArgs = null;
    };
    return wrapped;
  }

  /* debounce(fn, ms) — so dispara depois de ms sem chamadas (resize, etc.). */
  function debounce(fn, ms, context) {
    var timer = null;
    var wrapped = function () {
      var args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(context || null, args);
      }, ms);
    };
    wrapped.cancel = function () { if (timer) { clearTimeout(timer); timer = null; } };
    return wrapped;
  }

  // Ids incrementais (nomes de objetos, chaves de pool, debug).
  var _uid = 0;
  function uid(prefix) { _uid++; return (prefix || 'gh') + '_' + _uid; }

  // Busca binaria: maior indice cujo key(arr[i]) <= value (-1 se nenhum).
  // Usado para achar a nota/secao corrente sem varrer o array inteiro.
  function bisectLE(arr, value, key) {
    var lo = 0, hi = arr.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var v = key ? key(arr[mid]) : arr[mid];
      if (v <= value) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }
  // Menor indice cujo key(arr[i]) >= value (arr.length se nenhum).
  function bisectGE(arr, value, key) {
    var lo = 0, hi = arr.length - 1, best = arr.length;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var v = key ? key(arr[mid]) : arr[mid];
      if (v >= value) { best = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return best;
  }

  // Copia rasa defensiva de objeto simples (config/settings).
  function shallowCopy(src, into) {
    var out = into || {};
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    return out;
  }
  // Preenche campos ausentes de `obj` com os de `defaults` (recursivo raso).
  function defaults(obj, defs) {
    obj = obj || {};
    for (var k in defs) {
      if (!Object.prototype.hasOwnProperty.call(defs, k)) continue;
      if (obj[k] === undefined) obj[k] = defs[k];
    }
    return obj;
  }
  // Executa fn em try/catch — o jogo NUNCA pode ficar preto por um modulo.
  function safe(fn, fallback) {
    try { return fn(); } catch (e) {
      if (typeof window !== 'undefined' && window.__GH_fatal) window.__GH_fatal(e && e.message ? e.message : String(e));
      return fallback;
    }
  }

  /* =========================================================================
     12. EXPORT
     ========================================================================= */

  GH.Util = {
    // --- constantes ---
    PI: PI, TAU: TAU, HALF_PI: HALF_PI, QUARTER_PI: QUARTER_PI,
    DEG2RAD: DEG2RAD, RAD2DEG: RAD2DEG, EPSILON: EPSILON,
    SQRT2: SQRT2, SQRT3: SQRT3, GOLDEN: GOLDEN,

    // --- escalares ---
    clamp: clamp, clamp01: clamp01, saturate: saturate,
    lerp: lerp, lerpClamped: lerpClamped, invLerp: invLerp,
    remap: remap, remapClamped: remapClamped,
    smoothstep: smoothstep, smootherstep: smootherstep, step: step,
    damp: damp, dampAngle: dampAngle, moveTowards: moveTowards,
    mod: mod, wrap: wrap, pingPong: pingPong, tri: tri,
    deg2rad: deg2rad, rad2deg: rad2deg,
    angleDelta: angleDelta, angleLerp: angleLerp, clampAngle: clampAngle,
    sign: sign, sign1: sign1, approxEq: approxEq,
    nextPow2: nextPow2, isPow2: isPow2, snap: snap, ema: ema,
    dist: dist, dist2: dist2, len2: len2,

    // --- easings ---
    linear: linear,
    easeInQuad: easeInQuad, easeOutQuad: easeOutQuad, easeInOutQuad: easeInOutQuad,
    easeInCubic: easeInCubic, easeOutCubic: easeOutCubic, easeInOutCubic: easeInOutCubic,
    easeInQuart: easeInQuart, easeOutQuart: easeOutQuart, easeInOutQuart: easeInOutQuart,
    easeInQuint: easeInQuint, easeOutQuint: easeOutQuint, easeInOutQuint: easeInOutQuint,
    easeInSine: easeInSine, easeOutSine: easeOutSine, easeInOutSine: easeInOutSine,
    easeInExpo: easeInExpo, easeOutExpo: easeOutExpo, easeInOutExpo: easeInOutExpo,
    easeInCirc: easeInCirc, easeOutCirc: easeOutCirc, easeInOutCirc: easeInOutCirc,
    easeInBack: easeInBack, easeOutBack: easeOutBack, easeInOutBack: easeInOutBack,
    easeInElastic: easeInElastic, easeOutElastic: easeOutElastic, easeInOutElastic: easeInOutElastic,
    easeInBounce: easeInBounce, easeOutBounce: easeOutBounce, easeInOutBounce: easeInOutBounce,
    impulse: impulse, bell: bell,
    Ease: Ease, ease: ease, cubicBezierEase: cubicBezierEase,

    // --- aleatoriedade ---
    RNG: PublicRNG, RNGClass: RNG, rand: rand, seed: seed, hashSeed: hashSeed,
    hash11: hash11, hash21: hash21, hash31: hash31,

    // --- ruido (instancia padrao, semente fixa) ---
    makeNoise: makeNoise,
    noise: defaultNoise,
    noise2D:   defaultNoise.noise2D,
    noise3D:   defaultNoise.noise3D,
    noise4D:   defaultNoise.noise4D,
    noise2D01: defaultNoise.noise2D01,
    noise3D01: defaultNoise.noise3D01,
    fbm2D:     defaultNoise.fbm2D,
    fbm2D01:   defaultNoise.fbm2D01,
    fbm3D:     defaultNoise.fbm3D,
    fbm:       defaultNoise.fbm2D,          // alias do contrato: fbm(x,y,oct)
    ridged:    defaultNoise.ridged,
    turbulence: defaultNoise.turbulence,
    curl2D:    defaultNoise.curl2D,
    warpedFbm2D: defaultNoise.warpedFbm2D,
    tileable2D:  defaultNoise.tileable2D,
    tileableFbm2D: defaultNoise.tileableFbm2D,
    worley2D:  defaultNoise.worley2D,
    value2D:   defaultNoise.value2D,

    // --- cor ---
    Color: ColorCtor,
    toColor: toColor, hsl: hsl, hslDeg: hslDeg,
    mixColor: mixColor, mixColorLinear: mixColorLinear, mixColorHSL: mixColorHSL,
    hexToRgb: hexToRgb, rgbToHex: rgbToHex, colorToHex: colorToHex, cssRgba: cssRgba,
    lumaOf: lumaOf, shade: shade, saturateColor: saturateColor,
    scaleColor: scaleColor, rotateHue: rotateHue, sampleRamp: sampleRamp,

    // --- formatacao ---
    formatScore: formatScore, formatNumber: formatNumber, formatTime: formatTime,
    formatPercent: formatPercent, formatMs: formatMs, formatMult: formatMult,
    padZero: padZero,

    // --- estruturas ---
    Pool: Pool, SpringValue: SpringValue, SpringVec3: SpringVec3,
    smoothDamp: smoothDamp, smoothDampAngle: smoothDampAngle,

    // --- curvas ---
    catmullRom: catmullRom, catmullRom3: catmullRom3,
    bezier: bezier, bezier2: bezier2, bezier3: bezier3,
    bezierDerivative: bezierDerivative, hermite: hermite,

    // --- tempo / diversos ---
    now: now, nowMs: nowMs, throttle: throttle, debounce: debounce,
    uid: uid, bisectLE: bisectLE, bisectGE: bisectGE,
    shallowCopy: shallowCopy, defaults: defaults, safe: safe
  };

})(window.GH = window.GH || {});

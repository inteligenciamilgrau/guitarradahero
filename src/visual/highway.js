/* ==========================================================================
 * GUITARRADA HERO — src/visual/highway.js
 * Dono: agente HIGHWAY.
 *
 * A PISTA. Fica no centro da tela do primeiro ao ultimo segundo de musica —
 * e o objeto que decide sozinho se o jogo parece AAA ou parece protótipo.
 *
 * ANATOMIA (de baixo para cima, na ordem em que sao desenhados):
 *
 *   1. CONVES        jacaranda escuro envernizado, com COROA de braco de
 *                    guitarra (raio 26u): o centro fica em y=0 (contrato) e as
 *                    bordas afundam ~6cm. Toda a decoracao de chao acompanha a
 *                    coroa, entao nada "flutua" sobre a madeira.
 *   2. SANGRIA       halo da cor de cada raia vazando das divisorias.
 *   3. INLAYS        friso marajoara correndo nos ombros, rolando com a musica.
 *   4. BATIDAS       linhas transversais em sincronia com GH.Conductor.beat.
 *                    A linha de COMPASSO e uma faixa ornamental marajoara.
 *   5. DIVISORIAS    5 raias separadas por filetes luminosos.
 *   6. REFLEXOS      gems e aros espelhados no verniz (aditivo, por baixo).
 *   7. PULSOS        ondas que percorrem a pista no beat / no acerto.
 *   8. TRILHOS       moldura de aluminio escovado + rebites + tubo de neon +
 *                    fita de LED que pulsa no ritmo.
 *   9. LINHA DE      barra transversal de metal com bisel + halo + os 5 AROS
 *      ACERTO        DE FRET (bisel torneado, nucleo colorido, estouro no
 *                    acerto, sombra propria e reflexo no verniz).
 *  10. STAR POWER    camada fria/prateada + energia correndo pelas bordas.
 *
 * CONTRATO (secao 6): GH.Highway = { init, update, group, pulse, setTheme,
 * setStarPower }. Tudo o mais e aditivo e opcional.
 *
 * NAO se registra em GH.Engine.addUpdater: quem conduz e GH.Game (ver
 * relatorio do agente da cola). update(dt, songTime) e chamado por ele.
 *
 * Carrega depois de: util, palette, materials, engine, input, conductor,
 * songs, chart, scoring. Nenhuma dependencia dura no topo do IIFE.
 * ========================================================================== */
(function (GH) {
  'use strict';

  /* ========================================================================
   * 0. MATEMATICA LOCAL (prefere GH.Util, mas nunca depende dele)
   * ====================================================================== */

  var PI = Math.PI;
  var TAU = PI * 2;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) {
    if (e0 === e1) return x < e0 ? 0 : 1;
    var t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }
  /* interpolacao exponencial independente de framerate */
  function damp(a, b, lambda, dt) {
    if (!(dt > 0)) return a;
    return b + (a - b) * Math.exp(-lambda * dt);
  }
  /* curva de impulso: sobe rapido ate 1 e volta a 0 */
  function impulse(t, k) {
    var h = (k === undefined ? 6 : k) * t;
    return h * Math.exp(1 - h);
  }
  function easeOutCubic(t) { t = clamp01(t); var u = 1 - t; return 1 - u * u * u; }
  function fract(x) { return x - Math.floor(x); }

  /* ruido barato e deterministico para variacao ao longo do comprimento */
  function noiseZ(z, s) {
    var U = GH.Util;
    if (U && U.fbm2D) return U.fbm2D(z * s, 3.77, 3);
    return Math.sin(z * s * 3.1 + 1.7) * 0.5 + Math.sin(z * s * 7.9 - 0.4) * 0.3;
  }

  /* ========================================================================
   * 1. GEOMETRIA CANONICA DA PISTA
   * ====================================================================== */

  function LAY() {
    return GH.Layout || {
      LANES: 5, LANE_W: 0.72, HALF_W: 1.80, SPAWN_Z: -46, DESPAWN_Z: 6,
      STRIKE_Z: 0, SURFACE_Y: 0, GEM_Y: 0.16,
      laneX: function (i) { return (i - 2) * 0.72; }
    };
  }

  var LANES = 5;
  var LANE_W = 0.72;
  var HALF_W = 1.80;          /* meia-largura JOGAVEL (5 raias) */
  var SHOULDER = 0.21;        /* ombro decorativo fora das raias (inlay) */
  var DECK_HW = HALF_W + SHOULDER;   /* meia-largura do conves = 2.01 */
  var RAIL_W = 0.235;         /* largura do trilho lateral */

  /* Extensao longitudinal do conves. Vai alem do SPAWN_Z para a pista morrer
   * dentro da neblina, e alem da camera no lado de ca para nunca aparecer a
   * borda de perto. */
  var NEAR_Z = 7.2;
  var FAR_Z = -52.0;
  var DECK_LEN = NEAR_Z - FAR_Z;      /* 59.2 */

  /* Coroa (fretboard radius). Um braco de guitarra de verdade e abaulado:
   * e o que da gradiente de sombreamento na largura em vez de um plano morto.
   * O centro fica exatamente em y=0 (contrato) e as bordas descem. */
  var CROWN_R = 26.0;
  function surfaceY(x) {
    var r2 = CROWN_R * CROWN_R - x * x;
    return (r2 > 0 ? Math.sqrt(r2) : 0) - CROWN_R;
  }
  function crownSlope(x) {
    var r2 = CROWN_R * CROWN_R - x * x;
    return r2 > 1e-6 ? (-x / Math.sqrt(r2)) : 0;
  }

  /* Alturas de empilhamento das camadas de chao. Todas seguem a coroa, entao a
   * diferenca entre elas e constante e nao ha z-fighting em lugar nenhum. */
  var Y = {
    deck: 0.0000,
    bleed: 0.0035,
    inlay: 0.0060,
    beat: 0.0100,
    bar: 0.0125,
    divider: 0.0165,
    reflect: 0.0205,
    pulse: 0.0250,
    strikeGlow: 0.0290,
    laneLit: 0.0330,
    spWash: 0.0370
  };

  /* Quantos ladrilhos de textura ao longo do conves (grao da madeira). */
  var DECK_TILES_V = 6;
  var DECK_TILES_U = 0.42;

  /* ========================================================================
   * 2. ESTADO DO MODULO
   * ====================================================================== */

  var inited = false;
  var scene = null;
  var group = null;

  var theme = null;            /* objeto de tema de GH.Palette */
  var themeName = 'para';

  /* tempo */
  var elapsed = 0;             /* segundos desde init (animacao livre) */
  var songTime = 0;
  var scrollDist = 0;          /* distancia percorrida pela pista, em unidades */

  /* pulso global (beat / acerto) */
  var pulseLevel = 0;
  var pulseTarget = 0;

  /* star power */
  var spOn = false;
  var spLevel = 0;             /* 0..1 amortecido */

  /* raias */
  var laneHold = [0, 0, 0, 0, 0];      /* 0..1 — quanto a raia esta acesa */
  var laneHoldTarget = [0, 0, 0, 0, 0];
  var laneHeld = [false, false, false, false, false];
  var laneHit = [0, 0, 0, 0, 0];       /* decai depois de um acerto */
  var laneMiss = [0, 0, 0, 0, 0];
  var fretPress = [0, 0, 0, 0, 0];     /* afundamento animado do aro */
  var fretBurst = [-1, -1, -1, -1, -1];/* tempo do estouro (-1 = inativo) */
  var fretBurstQ = [0, 0, 0, 0, 0];    /* 1 = perfeito, 0.6 = bom */

  /* leitura do chart para detectar acertos sem depender de evento */
  var chartCursor = 0;
  var chartSig = '';

  /* janela de dedos (Facil/Medio): song.laneWindows[dificuldade] */
  var lwList = null;           /* [{t, lo, hi}] ou null */
  var lwCur = -1;              /* indice da janela valendo na linha de acerto */
  var lwOpenEnd = 0;           /* ate quando valem as setas da abertura */
  var laneAct = [1, 1, 1, 1, 1];       /* 1 = raia em uso, amortecido */

  /* objetos three (preenchidos em build*) */
  var deck = null, deckMat = null;
  var laneBleed = [], laneLit = [];
  var dividers = [];
  var beatPool = [], barPool = [];
  var inlayL = null, inlayR = null;
  var neonRefl = [];               /* reflexo do neon no verniz (2 faixas) */
  var rails = [];              /* {group, neonMat, haloMat, ledMat, bodyMat} */
  var rivets = null;
  var strike = null;           /* {bar, barMat, edge, edgeMat, glow, glowMat} */
  var frets = [];              /* {group, bezel, core, coreMat, halo, haloMat, burst, burstMat} */
  var decals = null;           /* QuadBatch: reflexos + pulsos */
  var lwShade = null;          /* QuadBatch: sombra das raias fora da janela */
  var lwArrowSide = null;      /* QuadBatch: setas laterais logo abaixo dos aros */
  var lwArrowFwd = null;       /* QuadBatch: setas para frente (janela de abertura) */
  var spWash = null, spWashMat = null;
  var spEdge = [];             /* faixas de energia nas bordas */
  var farFade = null, farFadeMat = null;

  /* cores de trabalho (reaproveitadas — zero alocacao no loop quente) */
  var _c1 = null, _c2 = null, _c3 = null;
  /* constantes de cor usadas por frame: alocar THREE.Color dentro do update()
   * geraria lixo a 60fps sem necessidade nenhuma */
  var K_WHITE = null;     /* branco puro */
  var K_MISSDEEP = null;  /* sangue escuro do erro na raia */
  var K_MISSHOT = null;   /* vermelho do erro no aro */
  var K_SPSTEEL = null;   /* aco frio que esfria a madeira no star power */

  /* registro para dispose() */
  var ownedGeo = [];
  var ownedMat = [];
  var ownedTex = [];

  /* diagnostico defensivo */
  var warnCount = {};
  function warn(key, e) {
    var n = (warnCount[key] || 0) + 1;
    warnCount[key] = n;
    if (n > 2) return;
    if (window.console && console.warn) {
      console.warn('[GH.Highway] ' + key + ': ' + (e && e.message ? e.message : e));
    }
  }
  function safe(key, fn) {
    try { return fn(); } catch (e) { warn(key, e); return null; }
  }

  /* ========================================================================
   * 3. PONTE COM PALETA E MATERIAIS
   * ====================================================================== */

  function C(hex) { return new THREE.Color(hex); }

  function palette() { return GH.Palette || null; }

  /* O `metal` dos temas e quente (bege/dourado). Numa moldura de pista isso
   * le como MADEIRA, nao como hardware. Puxamos para o aco neutro mantendo
   * um resto do calor do tema — assim o trilho continua sendo do tema, mas
   * parece metal. */
  function metalOf() {
    return tc('metal', 0xd9b98c).clone().lerp(C(0x93a0b2), 0.62);
  }

  function resolveTheme(x) {
    var P = palette();
    if (!P) return null;
    if (x && typeof x === 'object' && x.hex) return x;
    if (typeof x === 'string' && P.themes && P.themes[x]) return P.themes[x];
    if (P.current) return P.current;
    if (P.themes && P.themes.para) return P.themes.para;
    return null;
  }

  /* cor do tema com fallback duro — nunca devolve undefined */
  function tc(key, fallback) {
    var t = theme;
    if (t && t[key] && t[key].isColor) return t[key];
    var P = palette();
    if (P && P.current && P.current[key] && P.current[key].isColor) return P.current[key];
    return C(fallback);
  }

  function laneCol(i, part) {
    var P = palette();
    if (P && P.laneColor) {
      var c = P.laneColor(i, part);
      if (c && c.isColor) return c;
    }
    var fb = [0x16c25c, 0xe31530, 0xe8b707, 0x1c63de, 0xe9640a];
    return C(fb[i % 5]);
  }

  function spCol(key, fallback) {
    var P = palette();
    if (P && P.sp && P.sp[key] && P.sp[key].isColor) return P.sp[key];
    return C(fallback);
  }

  var MAT = null;
  function materials() {
    if (!MAT) MAT = GH.Materials || null;
    return MAT;
  }

  /* Textura compartilhada do materials.js, com repeticao propria.
   * Nunca gera textura duplicada: `tex.clone` reaproveita o mesmo canvas. */
  function texRep(name, rx, ry) {
    var M = materials();
    if (!M || !M.tex) return null;
    try {
      var t = (typeof M.tex.clone === 'function') ? M.tex.clone(name, rx, ry) : M.tex[name];
      if (t) ownedTex.push(t);
      return t || null;
    } catch (e) { warn('tex:' + name, e); return null; }
  }

  /* Rampa de gradiente (linear, sem sRGB — e mascara, nao cor de exibicao). */
  function ramp(colors, stops, vertical) {
    var M = materials();
    if (!M || !M.tex || typeof M.tex.gradientRamp !== 'function') return null;
    try {
      return M.tex.gradientRamp(colors, {
        vertical: !!vertical, stops: stops, size: 256, srgb: false
      });
    } catch (e) { warn('ramp', e); return null; }
  }

  function keepGeo(g) { if (g) ownedGeo.push(g); return g; }
  function keepMat(m) { if (m) ownedMat.push(m); return m; }

  /* ========================================================================
   * 4. FABRICAS DE GEOMETRIA
   * ====================================================================== */

  /* --------------------------------------------------------------------
   * deckGeometry — malha no plano XZ que ACOMPANHA A COROA do conves.
   * Todas as camadas de chao saem daqui, entao ficam exatamente paralelas
   * a madeira (sem flutuar nas bordas, sem z-fighting).
   *
   * colorFn(x, z, u, v, out[4]) escreve cor+alfa por vertice. O atributo tem
   * 4 componentes: o three liga USE_COLOR_ALPHA e o alfa por vertice passa a
   * valer — e assim que os degrades de profundidade sao feitos sem shader.
   * ------------------------------------------------------------------ */
  function deckGeometry(x0, x1, zN, zF, segX, segZ, yLift, colorFn, uvSpec) {
    var nx = segX + 1, nz = segZ + 1, n = nx * nz;
    var pos = new Float32Array(n * 3);
    var nor = new Float32Array(n * 3);
    var uv = new Float32Array(n * 2);
    var col = new Float32Array(n * 4);
    var idx = new Uint16Array(segX * segZ * 6);
    var out = [1, 1, 1, 1];
    var uRep = (uvSpec && uvSpec.uRepeat) || 1;
    var vRep = (uvSpec && uvSpec.vRepeat) || 1;
    var i, j, k, p;

    for (j = 0; j < nz; j++) {
      var tz = segZ ? j / segZ : 0;                 /* 0 = perto, 1 = fundo */
      var z = zN + (zF - zN) * tz;
      for (i = 0; i < nx; i++) {
        var tx = segX ? i / segX : 0;
        var x = x0 + (x1 - x0) * tx;
        k = j * nx + i;
        p = k * 3;
        pos[p] = x; pos[p + 1] = surfaceY(x) + yLift; pos[p + 2] = z;
        var d = crownSlope(x);
        var inv = 1 / Math.sqrt(d * d + 1);
        nor[p] = -d * inv; nor[p + 1] = inv; nor[p + 2] = 0;
        uv[k * 2] = tx * uRep;
        uv[k * 2 + 1] = tz * vRep;
        out[0] = 1; out[1] = 1; out[2] = 1; out[3] = 1;
        if (colorFn) colorFn(x, z, tx, tz, out);
        p = k * 4;
        col[p] = out[0]; col[p + 1] = out[1]; col[p + 2] = out[2]; col[p + 3] = out[3];
      }
    }
    var w = 0;
    for (j = 0; j < segZ; j++) {
      for (i = 0; i < segX; i++) {
        var a = j * nx + i, b = a + 1, c = a + nx, d2 = c + 1;
        /* enrolamento CCW visto de +Y (z decresce com j) */
        idx[w++] = a; idx[w++] = b; idx[w++] = c;
        idx[w++] = b; idx[w++] = d2; idx[w++] = c;
      }
    }
    var g = new THREE.BufferGeometry();
    if (uvSpec && uvSpec.swap) {
      /* troca os eixos do mapeamento: usado no friso marajoara, cujo desenho
       * corre ao longo do eixo U da textura e precisa correr ao longo da
       * PISTA, nao atravessada nela. */
      for (k = 0; k < n; k++) {
        var uu = uv[k * 2], vv = uv[k * 2 + 1];
        uv[k * 2] = vv; uv[k * 2 + 1] = uu;
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return keepGeo(g);
  }

  /* --------------------------------------------------------------------
   * sweepProfile — varre um perfil (z,y) ao longo de X seguindo a coroa.
   * E o que faz a barra da linha de acerto encostar na madeira de ponta a
   * ponta em vez de flutuar 6cm nas bordas. Geometria NAO indexada: as
   * normais saem planas e os biseis ficam nitidos (cara de peca usinada).
   * ------------------------------------------------------------------ */
  function sweepProfile(profile, xA, xB, samples) {
    var np = profile.length;
    var quads = np * samples;                 /* perfil fechado */
    var tris = quads * 2 + (np - 2) * 2;      /* + duas tampas em leque */
    var pos = new Float32Array(tris * 9);
    var w = 0;
    var i, s;

    function put(x, y, z) { pos[w++] = x; pos[w++] = y; pos[w++] = z; }

    for (s = 0; s < samples; s++) {
      var x0 = xA + (xB - xA) * (s / samples);
      var x1 = xA + (xB - xA) * ((s + 1) / samples);
      var y0 = surfaceY(x0), y1 = surfaceY(x1);
      for (i = 0; i < np; i++) {
        var a = profile[i], b = profile[(i + 1) % np];
        /* quad: (x0,a) (x0,b) (x1,b) (x1,a) — perfil em sentido horario no
         * plano ZY faz a normal apontar para fora */
        put(x0, y0 + a.y, a.z); put(x1, y1 + a.y, a.z); put(x1, y1 + b.y, b.z);
        put(x0, y0 + a.y, a.z); put(x1, y1 + b.y, b.z); put(x0, y0 + b.y, b.z);
      }
    }
    /* tampas em leque nas duas pontas (ficam escondidas sob os trilhos, mas
     * sem elas o interior apareceria em qualquer angulo de camera) */
    var yA = surfaceY(xA), yB = surfaceY(xB);
    for (i = 1; i < np - 1; i++) {
      put(xA, yA + profile[0].y, profile[0].z);
      put(xA, yA + profile[i + 1].y, profile[i + 1].z);
      put(xA, yA + profile[i].y, profile[i].z);
      put(xB, yB + profile[0].y, profile[0].z);
      put(xB, yB + profile[i].y, profile[i].z);
      put(xB, yB + profile[i + 1].y, profile[i + 1].z);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, w), 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return keepGeo(g);
  }

  /* --------------------------------------------------------------------
   * extrudeAlongZ — perfil (x,y) extrudado no eixo Z. Usado nos trilhos.
   * ------------------------------------------------------------------ */
  function extrudeAlongZ(profile, zN, zF) {
    var np = profile.length;
    var tris = np * 2 + (np - 2) * 2;
    var pos = new Float32Array(tris * 9);
    var w = 0;
    function put(x, y, z) { pos[w++] = x; pos[w++] = y; pos[w++] = z; }
    var i;
    for (i = 0; i < np; i++) {
      var a = profile[i], b = profile[(i + 1) % np];
      put(a.x, a.y, zN); put(b.x, b.y, zN); put(b.x, b.y, zF);
      put(a.x, a.y, zN); put(b.x, b.y, zF); put(a.x, a.y, zF);
    }
    for (i = 1; i < np - 1; i++) {
      put(profile[0].x, profile[0].y, zN);
      put(profile[i].x, profile[i].y, zN);
      put(profile[i + 1].x, profile[i + 1].y, zN);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, w), 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return keepGeo(g);
  }

  /* --------------------------------------------------------------------
   * QuadBatch — lote de retangulos no plano XZ com cor+alfa por vertice,
   * regravado a cada frame num unico draw call e sem alocar nada.
   * Serve para reflexos das gems, reflexo dos aros e ondas de pulso.
   * ------------------------------------------------------------------ */
  function QuadBatch(capacity, material, renderOrder) {
    var pos = new Float32Array(capacity * 4 * 3);
    var uv = new Float32Array(capacity * 4 * 2);
    var col = new Float32Array(capacity * 4 * 4);
    var idx = new Uint16Array(capacity * 6);
    var i;
    for (i = 0; i < capacity; i++) {
      var v = i * 4;
      idx[i * 6] = v; idx[i * 6 + 1] = v + 1; idx[i * 6 + 2] = v + 2;
      idx[i * 6 + 3] = v; idx[i * 6 + 4] = v + 2; idx[i * 6 + 5] = v + 3;
      /* uv fixo: 0..1 na largura, 0..1 no comprimento */
      uv[v * 2] = 0; uv[v * 2 + 1] = 0;
      uv[(v + 1) * 2] = 1; uv[(v + 1) * 2 + 1] = 0;
      uv[(v + 2) * 2] = 1; uv[(v + 2) * 2 + 1] = 1;
      uv[(v + 3) * 2] = 0; uv[(v + 3) * 2 + 1] = 1;
    }
    var g = new THREE.BufferGeometry();
    var aPos = new THREE.BufferAttribute(pos, 3); aPos.setUsage(THREE.DynamicDrawUsage);
    var aCol = new THREE.BufferAttribute(col, 4); aCol.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', aPos);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', aCol);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    /* esfera de contorno generosa: a pista inteira. Sem isto o frustum
     * culling usaria uma esfera velha e o lote sumiria em certos angulos. */
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, (NEAR_Z + FAR_Z) * 0.5), DECK_LEN);
    keepGeo(g);

    var mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder || 0;
    mesh.matrixAutoUpdate = false;

    var count = 0;

    return {
      mesh: mesh,
      begin: function () { count = 0; },
      /* retangulo de x0..x1, do z proximo (zN) ao distante (zF), com cor e
       * alfa interpolando entre as duas pontas. */
      push: function (x0, x1, zN, zF, y, r, g2, b, aN, aF) {
        if (count >= capacity) return;
        var v = count * 4, p = v * 3, c = v * 4;
        pos[p] = x0; pos[p + 1] = surfaceY(x0) + y; pos[p + 2] = zN;
        pos[p + 3] = x1; pos[p + 4] = surfaceY(x1) + y; pos[p + 5] = zN;
        pos[p + 6] = x1; pos[p + 7] = surfaceY(x1) + y; pos[p + 8] = zF;
        pos[p + 9] = x0; pos[p + 10] = surfaceY(x0) + y; pos[p + 11] = zF;
        col[c] = r; col[c + 1] = g2; col[c + 2] = b; col[c + 3] = aN;
        col[c + 4] = r; col[c + 5] = g2; col[c + 6] = b; col[c + 7] = aN;
        col[c + 8] = r; col[c + 9] = g2; col[c + 10] = b; col[c + 11] = aF;
        col[c + 12] = r; col[c + 13] = g2; col[c + 14] = b; col[c + 15] = aF;
        count++;
      },
      end: function () {
        g.setDrawRange(0, count * 6);
        aPos.needsUpdate = true;
        aCol.needsUpdate = true;
      }
    };
  }

  /* ========================================================================
   * 5. CONSTRUCAO — CONVES
   * ====================================================================== */

  /* fade de profundidade: 1 perto da linha de acerto, ~0 no fundo.
   * E o que faz a pista MORRER na neblina em vez de terminar num corte seco. */
  function depthFade(z) {
    var far = smoothstep(-10.0, -44.0, z);        /* 0 perto -> 1 no fundo */
    return (1 - far * 0.965) * nearTaper(z, 0.22);
  }
  /* Atenuacao do PRIMEIRO PLANO. O ultimo metro de pista antes da camera
   * ocupa a base inteira da tela; sem isto o neon e o friso chegam ali com a
   * area maxima e estouram no bloom (visto no print do tema frevo). Tambem
   * funciona como vinheta: o olho vai para a linha de acerto. */
  function nearTaper(z, amount) {
    return 1 - smoothstep(1.0, 6.6, z) * (amount === undefined ? 0.55 : amount);
  }
  /* fade mais curto, para elementos luminosos (neon, linhas) */
  function glowFade(z) {
    return (1 - smoothstep(-6.0, -42.0, z) * 0.88) * nearTaper(z, 0.58);
  }

  function buildDeck() {
    var M = materials();

    /* --- material: jacaranda escuro com verniz de luthier -----------------
     * Albedo BAIXO de proposito. A luz RIM magenta do engine (2.55) varre a
     * pista inteira em angulo rasante; com albedo claro ela lava tudo de rosa
     * e as gems perdem contraste. Com albedo escuro, a mesma luz vira um
     * realce bonito no verniz em vez de uma mancha. */
    /* ALBEDO: o multiplicador entra CLARO de proposito. O mapa woodJacaranda
     * ja e uma madeira escura (luminancia linear ~0.05); multiplicar por uma
     * cor escura por cima zerava a pista — nas duas primeiras iteracoes o
     * conves ficou preto e a imagem inteira passou a ser feita das camadas
     * aditivas, que e exatamente o "parece plastico" que o contrato proibe.
     * Aqui a cor do material so TINGE (madeira do tema) e deixa a textura
     * mandar no valor. */
    var wood = tc('wood', 0x4a2a18).clone();
    /* CONTRASTE PISTA x GEM. O ponto de equilibrio medido no print: com
     * lerp(branco, 0.70) o conves virava um vermelho vivo sob a contraluz do
     * tema e a gem vermelha sumia dentro dele. Com lerp(branco, 0.34) e o
     * dobro de tinta escura do tema (0.38) a madeira continua legivel (o veio
     * e o poro aparecem), mas o valor cai para a faixa escura do Guitar Hero,
     * que e onde as 5 cores das raias saltam. */
    var deckBase = wood.clone().lerp(C(0xffffff), 0.34).lerp(tc('highway', 0x150a20), 0.38);

    deckMat = keepMat(new THREE.MeshPhysicalMaterial({
      map: texRep('woodJacaranda', DECK_TILES_U, DECK_TILES_V),
      normalMap: texRep('woodJacarandaNormal', DECK_TILES_U, DECK_TILES_V),
      roughnessMap: texRep('woodJacarandaRough', DECK_TILES_U, DECK_TILES_V),
      color: deckBase,
      metalness: 0.0,
      roughness: 1.0,
      /* VERNIZ CONTIDO. A luz RIM do engine (magenta, 2.55, quase rasante)
       * bate na pista inteira; com clearcoat "bonito" (0.4 / rugosidade 0.25)
       * o lobo especular vira uma mancha branca de meia tela — medido no
       * print. Verniz baixo + rugosidade alta espalha o mesmo realce numa
       * varredura larga e discreta, que e o que se ve num palco de verdade. */
      clearcoat: 0.10,
      clearcoatRoughness: 0.62,
      envMapIntensity: 0.10,
      specularIntensity: 0.10,
      normalScale: new THREE.Vector2(0.52, 0.52),
      vertexColors: true,
      dithering: true
    }));
    deckMat.userData.baseColor = deckBase.clone();

    /* REMAPEAMENTO DA RUGOSIDADE (o conserto mais importante da pista).
     * O mapa de rugosidade do jacaranda vai de 0.18 (verniz cheio) a 0.85
     * (poro). No three, `roughness` MULTIPLICA o mapa: mesmo com roughness=1
     * a madeira lisa fica em 0.18, e a luz RIM do engine (magenta, 2.55, quase
     * rasante sobre 50 metros de pista) vira um lobo especular branco de meia
     * tela. Medido no print, duas vezes.
     * Aqui a faixa e comprimida para [0.60, 0.95]: o veio e o poro continuam
     * a modular a superficie (materialidade preservada), mas o realce vira uma
     * varredura larga em vez de uma mancha. O verniz de luthier passa a ser
     * responsabilidade do CLEARCOAT, que e onde ele fisicamente mora. */
    deckMat.onBeforeCompile = function (shader) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n\troughnessFactor = mix( 0.80, 0.98, roughnessFactor );'
      );
    };
    deckMat.customProgramCacheKey = function () { return 'ghDeckRough1'; };

    /* Cor por vertice do conves:
     *   - degrade de profundidade (converge para a neblina),
     *   - variacao de larga escala (fbm) para a madeira nao ficar uniforme,
     *   - escurecimento nos ombros (vinheta lateral, empurra o olho pro centro),
     *   - leve esfriamento no fundo. */
    var geo = deckGeometry(-DECK_HW, DECK_HW, NEAR_Z, FAR_Z, 24, 132, Y.deck,
      function (x, z, u, v, out) {
        var f = depthFade(z);
        var grain = 1 + noiseZ(z, 0.055) * 0.26 + noiseZ(z, 0.21) * 0.11;
        var edge = 1 - smoothstep(HALF_W * 0.72, DECK_HW, Math.abs(x)) * 0.42;
        var k = f * grain * edge;
        out[0] = k * (1 - v * 0.05);
        out[1] = k * (1 - v * 0.02);
        out[2] = k * (1 + v * 0.07);
        out[3] = 1;
      },
      { uRepeat: DECK_TILES_U, vRepeat: DECK_TILES_V });

    deck = new THREE.Mesh(geo, deckMat);
    deck.receiveShadow = true;
    deck.renderOrder = 0;
    deck.name = 'GH_Highway_Deck';
    group.add(deck);

    /* --- dissolucao final: um veu com a cor exata da neblina, com alfa
     * crescendo ate 1 no ultimo metro. Garante que a pista some sem emenda,
     * seja qual for a densidade de fog que o engine escolher. */
    var fogC = C(0x301246);
    try {
      var sc = GH.Engine && GH.Engine.scene;
      if (sc && sc.fog && sc.fog.color) fogC = sc.fog.color.clone();
    } catch (e) { /* usa o fallback */ }

    farFadeMat = keepMat(new THREE.MeshBasicMaterial({
      color: fogC, transparent: true, depthWrite: false, fog: false,
      vertexColors: true, side: THREE.DoubleSide, toneMapped: false
    }));
    /* Carta de neblina DEITADA sobre a pista, meio metro acima dela. Vista da
     * camera de gameplay (que olha a pista de cima, em angulo raso), uma carta
     * horizontal cobre exatamente a faixa de tela onde o conves esta longe —
     * e o truque classico de "ground fog" e e o que garante que a pista morra
     * sem corte, seja qual for a densidade que o engine escolher. */
    var ff = deckGeometry(-DECK_HW - RAIL_W - 0.6, DECK_HW + RAIL_W + 0.6,
      -30, FAR_Z, 2, 44, 0.50,
      function (x, z, u, v, out) {
        out[0] = 1; out[1] = 1; out[2] = 1;
        out[3] = smoothstep(0.02, 0.86, v) * 0.86;
      });
    farFade = new THREE.Mesh(ff, farFadeMat);
    farFade.renderOrder = 26;
    farFade.frustumCulled = false;
    group.add(farFade);
  }

  /* ========================================================================
   * 6. CONSTRUCAO — RAIAS (sangria + acendimento)
   * ====================================================================== */

  function buildLanes() {
    var i;
    /* rampa horizontal com halo nas DUAS bordas da raia: e a cor vazando das
     * divisorias para dentro da madeira. */
    var rEdges = ramp([0xffffff, 0x2a2a2a, 0x000000, 0x000000, 0x2a2a2a, 0xffffff],
      [0, 0.14, 0.34, 0.66, 0.86, 1], false);
    /* rampa cheia (centro forte) para o estado ACESO */
    var rFill = ramp([0x000000, 0xdadada, 0xffffff, 0xdadada, 0x000000],
      [0, 0.16, 0.5, 0.84, 1], false);

    for (i = 0; i < LANES; i++) {
      var cx = LAY().laneX(i);
      var x0 = cx - LANE_W * 0.5, x1 = cx + LANE_W * 0.5;
      var col = laneCol(i, 'glow');

      /* ---- SANGRIA: sempre ligada, discreta ---- */
      var mB = keepMat(new THREE.MeshBasicMaterial({
        map: rEdges, color: col.clone(), transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, toneMapped: false
      }));
      mB.userData.base = col.clone();
      var gB = deckGeometry(x0, x1, NEAR_Z, FAR_Z, 4, 56, Y.bleed,
        function (x, z, u, v, out) {
          var f = glowFade(z);
          /* Concentrada no ultimo trecho antes da linha de acerto. La no
           * fundo a pista tem que ser madeira escura e neutra — e assim que
           * o Guitar Hero mantem as gems como a coisa mais clara da tela. */
          out[0] = out[1] = out[2] = 1;
          /* Pico baixado de 0.080 para 0.052: no plano cinematografico
           * (stage_wide) o trecho perto da lente aparece inteiro e as cinco
           * faixas aditivas viravam um tapete arco-iris. Na camera de
           * gameplay esse trecho fica embaixo da linha de acerto, entao a
           * identidade de raia no que importa continua a mesma. */
          /* mesma logica do jorro: a sangria tambem cai depois da linha de
             acerto, senao o rodape do quadro (e a pista inteira vista de
             lado) fica coberto de faixas coloridas aditivas */
          out[3] = f * (0.010 + 0.052 * smoothstep(-22.0, 0.0, z))
                   * (1 - 0.55 * smoothstep(0.3, 3.4, z));
        });
      var mesh = new THREE.Mesh(gB, mB);
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      group.add(mesh);
      laneBleed.push({ mesh: mesh, mat: mB, base: col.clone() });

      /* ---- ACESO: a raia inteira acende quando o traste e segurado ---- */
      var cE = laneCol(i, 'emissive');
      var mL = keepMat(new THREE.MeshBasicMaterial({
        map: rFill, color: cE.clone(), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, toneMapped: false
      }));
      var gL = deckGeometry(x0, x1, NEAR_Z, FAR_Z, 4, 56, Y.laneLit,
        function (x, z, u, v, out) {
          out[0] = out[1] = out[2] = 1;
          /* jorro saindo da linha de acerto para o fundo */
          /* O jorro sobe ATE a linha de acerto e morre logo depois dela.
             Antes ele ficava no maximo de z=0,5 ate a lente: no plano
             cinematografico as 5 raias acesas cobriam todo o trecho perto da
             camera e a pista virava TAPETE ARCO-IRIS (medido em stage_wide).
             Guitar Hero acende a raia A FRENTE do jogador, nao atras. */
          out[3] = glowFade(z) * (0.06 + 0.94 * smoothstep(-11, -0.5, z))
                   * (1 - 0.86 * smoothstep(0.15, 2.6, z));
        });
      var meshL = new THREE.Mesh(gL, mL);
      meshL.renderOrder = 9;
      meshL.frustumCulled = false;
      meshL.visible = false;
      group.add(meshL);
      laneLit.push({ mesh: meshL, mat: mL, base: cE.clone() });
    }
  }

  function buildDividers() {
    /* 6 filetes: os 2 externos sao a moldura do campo de jogo (mais fortes),
     * os 4 internos separam as raias. */
    var lineC = tc('laneLine', 0x7a3e9c);
    var edgeC = tc('highwayEdge', 0xff3d8a);
    var i;
    for (i = 0; i <= LANES; i++) {
      var x = (i - 2.5) * LANE_W;
      var isEdge = (i === 0 || i === LANES);
      var wHalf = isEdge ? 0.0150 : 0.0095;
      /* A borda do campo de jogo e clara e NEUTRA. Deixa-la magenta duplicava
       * o tubo de neon do trilho, que fica dois dedos ao lado, e a pista virava
       * duas linhas rosa paralelas. */
      var base = isEdge
        ? C(0xffe9d6).lerp(edgeC, 0.22)
        : C(0xcfd8ff).lerp(lineC, 0.30);
      var mat = keepMat(new THREE.MeshBasicMaterial({
        color: base.clone(), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, toneMapped: false
      }));
      var geo = deckGeometry(x - wHalf, x + wHalf, NEAR_Z, FAR_Z, 1, 64, Y.divider,
        (function (isE) {
          return function (px, z, u, v, out) {
            out[0] = out[1] = out[2] = 1;
            /* mais presenca perto do jogador: e onde a leitura da raia importa */
            out[3] = glowFade(z) * (isE ? 0.40 : 0.30) *
                     (0.55 + 0.45 * smoothstep(-30, 1.0, z));
          };
        })(isEdge));
      var m = new THREE.Mesh(geo, mat);
      m.renderOrder = 6;
      m.frustumCulled = false;
      group.add(m);
      dividers.push({ mesh: m, mat: mat, base: base.clone(), edge: isEdge });
    }
  }

  /* ========================================================================
   * 7. CONSTRUCAO — LINHAS DE BATIDA E DE COMPASSO
   * ====================================================================== */

  var BEAT_POOL = 26;
  var BAR_POOL = 10;

  function buildBeatLines() {
    var i;
    var beatC = tc('beatLine', 0xffcb6b);

    /* --- BATIDA: filete transversal fino, atravessa o campo inteiro ---- */
    for (i = 0; i < BEAT_POOL; i++) {
      var mat = keepMat(new THREE.MeshBasicMaterial({
        color: beatC.clone(), transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, toneMapped: false
      }));
      var geo = deckGeometry(-HALF_W - 0.02, HALF_W + 0.02, 0.030, -0.030, 20, 1, Y.beat,
        function (x, z, u, v, out) {
          out[0] = out[1] = out[2] = 1;
          /* pontas mais fracas: o filete "nasce" das divisorias externas */
          out[3] = 0.55 + 0.45 * (1 - Math.abs(u * 2 - 1));
        });
      var m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 4;
      group.add(m);
      beatPool.push({ mesh: m, mat: mat });
    }

    /* --- COMPASSO: faixa ornamental MARAJOARA -------------------------
     * A identidade paraense entra aqui, no elemento que o jogador mais ve
     * repetir: a divisao de compasso da pista e um friso marajoara. */
    var band = texRep('marajoaraBand', 7, 1);
    var inlayC = tc('inlay', 0xf0c486);
    for (i = 0; i < BAR_POOL; i++) {
      var bmat = keepMat(new THREE.MeshBasicMaterial({
        color: inlayC.clone(), map: band, alphaMap: band,
        transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, toneMapped: false
      }));
      var bgeo = deckGeometry(-HALF_W - 0.05, HALF_W + 0.05, 0.195, -0.195, 20, 2, Y.bar,
        function (x, z, u, v, out) {
          out[0] = out[1] = out[2] = 1;
          out[3] = 0.85;
        }, { uRepeat: 1, vRepeat: 1 });
      var bm = new THREE.Mesh(bgeo, bmat);
      bm.frustumCulled = false;
      bm.visible = false;
      bm.renderOrder = 5;
      group.add(bm);

      /* nucleo solido do compasso: um filete mais grosso e mais claro por
       * baixo do friso, para a linha ler mesmo la longe */
      var cmat = keepMat(new THREE.MeshBasicMaterial({
        color: inlayC.clone().lerp(C(0xffffff), 0.35), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, toneMapped: false
      }));
      var cgeo = deckGeometry(-HALF_W - 0.05, HALF_W + 0.05, 0.050, -0.050, 20, 1, Y.bar - 0.0008,
        function (x, z, u, v, out) {
          out[0] = out[1] = out[2] = 1;
          out[3] = 0.55 + 0.45 * (1 - Math.abs(u * 2 - 1));
        });
      var cm = new THREE.Mesh(cgeo, cmat);
      cm.frustumCulled = false;
      cm.visible = false;
      cm.renderOrder = 5;
      group.add(cm);

      barPool.push({ mesh: bm, mat: bmat, core: cm, coreMat: cmat });
    }
  }

  /* ========================================================================
   * 8. CONSTRUCAO — INLAYS MARAJOARA NOS OMBROS
   * ====================================================================== */

  /* comprimento (em unidades de mundo) de UM ciclo completo da textura do
   * friso — a textura traz 4 modulos de grega, entao um modulo a cada 1,6u */
  var INLAY_TILE = 6.4;

  function buildInlays() {
    var uRep = DECK_LEN / INLAY_TILE;
    var inlayC = tc('inlay', 0xf0c486);

    function makeSide(sign) {
      var band = texRep('marajoaraBand', 1, 1);
      if (band) {
        band.wrapS = THREE.RepeatWrapping;
        band.wrapT = THREE.RepeatWrapping;
        band.repeat.set(1, 1);
        band.needsUpdate = true;
      }
      var mat = keepMat(new THREE.MeshBasicMaterial({
        color: inlayC.clone().multiplyScalar(0.55),
        map: band, alphaMap: band,
        transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, toneMapped: false
      }));
      var xa = sign * (HALF_W + 0.024);
      var xb = sign * (DECK_HW - 0.018);
      /* swap: o desenho do friso corre no eixo U da textura, e aqui ele
       * precisa correr ao longo da pista */
      var geo = deckGeometry(Math.min(xa, xb), Math.max(xa, xb), NEAR_Z, FAR_Z, 2, 128, Y.inlay,
        function (x, z, u, v, out) {
          out[0] = out[1] = out[2] = 1;
          out[3] = glowFade(z) * 0.42;
        }, { uRepeat: 1, vRepeat: uRep, swap: true });
      var m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 3;
      group.add(m);
      return { mesh: m, mat: mat, tex: band, base: inlayC.clone() };
    }
    inlayL = makeSide(-1);
    inlayR = makeSide(1);
  }

  /* --------------------------------------------------------------------
   * REFLEXO DO NEON NO VERNIZ
   * O tubo de neon corre 10cm acima do ombro da pista; num tampo envernizado
   * ele deixa um rastro esticado do lado de dentro. Fazer isso com espelho de
   * verdade custaria um render target inteiro por lado — aqui e uma faixa
   * aditiva com queda horizontal, que no print da exatamente a mesma leitura
   * e custa dois triangulos.
   * ------------------------------------------------------------------ */
  function buildNeonReflection() {
    var soft = ramp([0x000000, 0x1e1e1e, 0xffffff], [0, 0.42, 1], false);
    var edgeC = tc('highwayEdge', 0xff3d8a);
    for (var s = -1; s <= 1; s += 2) {
      var mat = keepMat(new THREE.MeshBasicMaterial({
        color: edgeC.clone().multiplyScalar(0.55),
        map: soft, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, toneMapped: false
      }));
      var xIn = s * (HALF_W - 0.34);
      var xOut = s * (DECK_HW - 0.005);
      var geo = deckGeometry(Math.min(xIn, xOut), Math.max(xIn, xOut),
        NEAR_Z, FAR_Z, 3, 64, Y.bleed + 0.0008,
        (function (sign) {
          return function (x, z, u, v, out) {
            out[0] = out[1] = out[2] = 1;
            /* u vai de dentro para fora quando sign>0 e ao contrario quando
             * sign<0; a rampa `soft` cresce em u, entao invertemos a esquerda */
            var t = (sign > 0) ? u : (1 - u);
            out[3] = glowFade(z) * 0.30 * (0.25 + 0.75 * t);
          };
        })(s));
      var m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 2;
      group.add(m);
      neonRefl.push({ mesh: m, mat: mat });
    }
  }

  /* ========================================================================
   * 9. CONSTRUCAO — TRILHOS LATERAIS
   * ====================================================================== */

  function buildRails() {
    var M = materials();
    var edgeC = tc('highwayEdge', 0xff3d8a);
    var neonC = tc('neon', 0x25e8ce);
    var metalC = metalOf();

    /* corpo: aluminio escovado escurecido — metal de palco, nao cromo de CG */
    var bodyMat = keepMat(new THREE.MeshStandardMaterial({
      color: metalC.clone().multiplyScalar(1.05),
      map: texRep('brushedMetal', 1, 26),
      normalMap: texRep('brushedMetalNormal', 1, 26),
      roughnessMap: texRep('brushedMetalRough', 1, 26),
      metalness: 1.0,
      roughness: 0.34,
      envMapIntensity: 1.9,
      normalScale: new THREE.Vector2(0.8, 0.8)
    }));

    /* perfil do trilho DIREITO (x cresce para fora). O esquerdo e o espelho. */
    var inner = HALF_W + SHOULDER;                 /* 2.01 */
    var outer = inner + RAIL_W;                    /* 2.245 */
    var yBase = surfaceY(inner);
    var P = [
      { x: inner, y: yBase - 0.055 },
      { x: inner, y: yBase + 0.052 },
      { x: inner + 0.020, y: yBase + 0.082 },
      { x: inner + 0.052, y: yBase + 0.094 },
      { x: inner + 0.086, y: yBase + 0.128 },
      { x: outer - 0.062, y: yBase + 0.124 },
      { x: outer - 0.020, y: yBase + 0.092 },
      { x: outer, y: yBase + 0.044 },
      { x: outer, y: yBase - 0.055 }
    ];

    var ledRamp = ramp([0x000000, 0xffffff, 0xffffff, 0x000000], [0, 0.30, 0.70, 1], true);
    var chaseRamp = ramp([0x000000, 0x3a3a3a, 0xffffff, 0x2a2a2a, 0x000000],
      [0, 0.34, 0.46, 0.58, 1], false);
    /* a rampa nasce em ClampToEdge; a corrida do LED precisa dar a volta */
    if (chaseRamp) {
      chaseRamp.wrapS = THREE.RepeatWrapping;
      chaseRamp.repeat.set(9, 1);
      chaseRamp.needsUpdate = true;
    }

    var s;
    for (s = -1; s <= 1; s += 2) {
      var rg = new THREE.Group();
      var prof = [];
      var i;
      for (i = 0; i < P.length; i++) prof.push({ x: s * P[i].x, y: P[i].y });
      if (s < 0) prof.reverse();                   /* mantem a normal para fora */

      var body = new THREE.Mesh(extrudeAlongZ(prof, NEAR_Z, FAR_Z), bodyMat);
      body.castShadow = false;
      body.receiveShadow = true;
      body.frustumCulled = false;
      rg.add(body);

      /* ---- TUBO DE NEON no ombro interno do trilho -------------------- */
      var neonMat = keepMat(new THREE.MeshBasicMaterial({
        color: edgeC.clone().multiplyScalar(1.05),
        toneMapped: false, fog: true
      }));
      var tubeGeo = keepGeo(new THREE.CylinderGeometry(0.0235, 0.0235, DECK_LEN, 10, 1, true));
      tubeGeo.rotateX(PI * 0.5);
      var tube = new THREE.Mesh(tubeGeo, neonMat);
      tube.position.set(s * (inner + 0.052), yBase + 0.104, (NEAR_Z + FAR_Z) * 0.5);
      tube.frustumCulled = false;
      rg.add(tube);

      /* halo aditivo em volta do tubo: o bloom morde isto, nao a geometria */
      var haloMat = keepMat(new THREE.MeshBasicMaterial({
        color: edgeC.clone(), transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, side: THREE.DoubleSide, toneMapped: false
      }));
      var haloGeo = keepGeo(new THREE.CylinderGeometry(0.050, 0.050, DECK_LEN, 8, 26, true));
      haloGeo.rotateX(PI * 0.5);
      /* fade longitudinal por vertice (aditivo nao pode usar fog) */
      (function (g) {
        var p = g.attributes.position;
        var n = p.count;
        var cc = new Float32Array(n * 4);
        for (var k = 0; k < n; k++) {
          var zz = p.getZ(k) + (NEAR_Z + FAR_Z) * 0.5;
          var f = glowFade(zz);
          cc[k * 4] = 1; cc[k * 4 + 1] = 1; cc[k * 4 + 2] = 1; cc[k * 4 + 3] = f;
        }
        g.setAttribute('color', new THREE.BufferAttribute(cc, 4));
      })(haloGeo);
      var halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.copy(tube.position);
      halo.frustumCulled = false;
      halo.renderOrder = 8;
      rg.add(halo);

      /* ---- FITA DE LED na face interna, pulsa no ritmo ---------------- */
      var ledMat = keepMat(new THREE.MeshBasicMaterial({
        color: neonC.clone(), map: chaseRamp, alphaMap: ledRamp,
        transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, side: THREE.DoubleSide, toneMapped: false
      }));
      var ledGeo = keepGeo(makeVerticalStrip(
        s * (inner - 0.004), yBase - 0.010, yBase + 0.062, NEAR_Z, FAR_Z, 96));
      var led = new THREE.Mesh(ledGeo, ledMat);
      led.frustumCulled = false;
      led.renderOrder = 7;
      rg.add(led);

      rg.name = 'GH_Rail_' + (s < 0 ? 'L' : 'R');
      group.add(rg);
      rails.push({
        group: rg, side: s, neonMat: neonMat, haloMat: haloMat, ledMat: ledMat,
        body: body, tube: tube, halo: halo, led: led,
        neonBase: edgeC.clone(), ledBase: neonC.clone()
      });
    }

    /* ---- REBITES: um unico InstancedMesh para os dois lados ---------- */
    var rivetMat = keepMat(new THREE.MeshStandardMaterial({
      color: metalC.clone().multiplyScalar(0.72),
      metalness: 1.0, roughness: 0.30,
      roughnessMap: texRep('brushedMetalRough', 1, 1),
      envMapIntensity: 1.5
    }));
    var rivetGeo = keepGeo(new THREE.SphereGeometry(0.0225, 10, 6, 0, TAU, 0, PI * 0.5));
    var spacing = 1.45;
    var perSide = Math.floor(DECK_LEN / spacing);
    var total = perSide * 2;
    rivets = new THREE.InstancedMesh(rivetGeo, rivetMat, total);
    rivets.frustumCulled = false;
    rivets.castShadow = false;
    var mtx = new THREE.Matrix4();
    var k = 0;
    for (s = -1; s <= 1; s += 2) {
      for (var j = 0; j < perSide; j++) {
        var z = NEAR_Z - 0.7 - j * spacing;
        mtx.makeTranslation(s * (inner + 0.148), yBase + 0.126, z);
        rivets.setMatrixAt(k++, mtx);
      }
    }
    rivets.instanceMatrix.needsUpdate = true;
    rivets.name = 'GH_Rail_Rivets';
    group.add(rivets);
  }

  /* faixa vertical (plano em YZ) com fade longitudinal por vertice */
  function makeVerticalStrip(x, y0, y1, zN, zF, segZ) {
    var nz = segZ + 1;
    var pos = new Float32Array(nz * 2 * 3);
    var uv = new Float32Array(nz * 2 * 2);
    var col = new Float32Array(nz * 2 * 4);
    var idx = new Uint16Array(segZ * 6);
    var i;
    for (i = 0; i < nz; i++) {
      var t = i / segZ;
      var z = zN + (zF - zN) * t;
      var f = glowFade(z);
      var a = i * 2, b = a + 1;
      pos[a * 3] = x; pos[a * 3 + 1] = y0; pos[a * 3 + 2] = z;
      pos[b * 3] = x; pos[b * 3 + 1] = y1; pos[b * 3 + 2] = z;
      uv[a * 2] = t; uv[a * 2 + 1] = 0;
      uv[b * 2] = t; uv[b * 2 + 1] = 1;
      col[a * 4] = 1; col[a * 4 + 1] = 1; col[a * 4 + 2] = 1; col[a * 4 + 3] = f;
      col[b * 4] = 1; col[b * 4 + 1] = 1; col[b * 4 + 2] = 1; col[b * 4 + 3] = f;
    }
    var w = 0;
    for (i = 0; i < segZ; i++) {
      var a2 = i * 2, b2 = a2 + 1, c2 = a2 + 2, d2 = a2 + 3;
      idx[w++] = a2; idx[w++] = b2; idx[w++] = c2;
      idx[w++] = b2; idx[w++] = d2; idx[w++] = c2;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  /* ========================================================================
   * 10. CONSTRUCAO — LINHA DE ACERTO
   * ====================================================================== */

  function buildStrike() {
    var metalC = metalOf();
    var accent = tc('accent', 0xffb03a);

    /* --- barra usinada, varrida seguindo a coroa do conves ------------- */
    var barMat = keepMat(new THREE.MeshStandardMaterial({
      color: metalC.clone().multiplyScalar(0.30),
      metalness: 1.0,
      roughness: 0.95,
      roughnessMap: texRep('brushedMetalRough', 10, 1),
      normalMap: texRep('brushedMetalNormal', 10, 1),
      normalScale: new THREE.Vector2(0.55, 0.55),
      envMapIntensity: 0.70
    }));
    /* Perfil no plano ZY (sentido horario visto de +X). Deliberadamente BAIXO
     * e com uma canaleta rebaixada no meio: a barra e o assento dos aros, nao
     * pode ficar mais alta que eles nem esconder o nucleo colorido — foi o
     * que aconteceu na primeira versao. */
    var prof = [
      { z: 0.330, y: -0.045 },
      { z: 0.330, y: 0.014 },
      { z: 0.292, y: 0.034 },
      { z: 0.185, y: 0.031 },
      { z: 0.150, y: 0.012 },
      { z: -0.150, y: 0.012 },
      { z: -0.185, y: 0.031 },
      { z: -0.292, y: 0.034 },
      { z: -0.330, y: 0.014 },
      { z: -0.330, y: -0.045 }
    ];
    var barGeo = sweepProfile(prof, -DECK_HW - 0.10, DECK_HW + 0.10, 24);
    var bar = new THREE.Mesh(barGeo, barMat);
    bar.castShadow = true;
    bar.receiveShadow = true;
    bar.frustumCulled = false;
    group.add(bar);

    /* --- filete emissivo no topo da barra ------------------------------ */
    var edgeC = tc('highwayEdge', 0xff3d8a).clone().lerp(C(0xffffff), 0.55);
    var edgeMat = keepMat(new THREE.MeshBasicMaterial({
      color: edgeC.clone(), transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      vertexColors: true, toneMapped: false
    }));
    var edgeGeo = deckGeometry(-DECK_HW - 0.08, DECK_HW + 0.08, 0.070, -0.070, 26, 1, 0.0148,
      function (x, z, u, v, out) {
        out[0] = out[1] = out[2] = 1;
        out[3] = 0.55 + 0.45 * (1 - Math.abs(u * 2 - 1));
      });
    var edge = new THREE.Mesh(edgeGeo, edgeMat);
    edge.frustumCulled = false;
    edge.renderOrder = 12;
    group.add(edge);

    /* --- poca de luz no verniz em volta da linha ----------------------- */
    var glowRamp = ramp([0x000000, 0x6a6a6a, 0xffffff, 0x8a8a8a, 0x000000],
      [0, 0.30, 0.52, 0.72, 1], true);
    var glowMat = keepMat(new THREE.MeshBasicMaterial({
      color: accent.clone().lerp(C(0xffffff), 0.30),
      map: glowRamp, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      vertexColors: true, toneMapped: false
    }));
    var glowGeo = deckGeometry(-DECK_HW, DECK_HW, 1.35, -2.25, 20, 24, Y.strikeGlow,
      function (x, z, u, v, out) {
        out[0] = out[1] = out[2] = 1;
        out[3] = 1 - smoothstep(HALF_W * 0.55, DECK_HW, Math.abs(x)) * 0.55;
      });
    var glow = new THREE.Mesh(glowGeo, glowMat);
    glow.frustumCulled = false;
    glow.renderOrder = 10;
    group.add(glow);

    /* --- cabeceiras: blocos de metal fechando a barra nos trilhos ------ */
    var capMat = keepMat(new THREE.MeshStandardMaterial({
      color: metalC.clone().multiplyScalar(0.30),
      /* Espelho puro (metal 1.0 / envMap 1.3) devolvia o ceu e a trelica
         inteiros: no plano lateral a cabeceira da direita virava um BLOCO
         VERDE-AGUA solto, fora da paleta. Metal escovado real espalha o
         reflexo — assim ela le como peca de metal, nao como espelho. */
      metalness: 0.86, roughness: 0.56,
      roughnessMap: texRep('brushedMetalRough', 2, 2),
      envMapIntensity: 0.55
    }));
    var capGeo = keepGeo(new THREE.BoxGeometry(RAIL_W + 0.13, 0.235, 0.72));
    var caps = [];
    for (var s = -1; s <= 1; s += 2) {
      var cap = new THREE.Mesh(capGeo, capMat);
      cap.position.set(s * (DECK_HW + RAIL_W * 0.5 - 0.02), surfaceY(DECK_HW) + 0.062, 0);
      cap.castShadow = true;
      cap.receiveShadow = true;
      group.add(cap);
      caps.push(cap);
    }

    strike = {
      bar: bar, barMat: barMat, edge: edge, edgeMat: edgeMat,
      glow: glow, glowMat: glowMat, caps: caps, capMat: capMat,
      edgeBase: edgeC.clone(), glowBase: accent.clone().lerp(C(0xffffff), 0.30)
    };
  }

  /* ========================================================================
   * 11. CONSTRUCAO — OS 5 AROS DE FRET
   * ====================================================================== */

  /* Aros grandes, quase se tocando (folga de 7cm entre raias vizinhas), como
   * no Clone Hero/GH3: a linha de acerto tem que ser HARDWARE, nao decalque. */
  var RING_RI = 0.206;         /* raio interno (onde aparece a cor da raia) */
  var RING_RO = 0.326;         /* raio externo do bisel */

  function ringLatheGeometry() {
    /* perfil torneado do bisel: aba na base, parede externa, chanfro, topo
     * levemente coroado, chanfro interno e a parede do "poco" colorido. */
    var pts = [
      new THREE.Vector2(RING_RI, 0.000),
      new THREE.Vector2(RING_RI, 0.052),
      new THREE.Vector2(RING_RI + 0.014, 0.072),
      new THREE.Vector2(RING_RI + 0.048, 0.084),
      new THREE.Vector2(RING_RO - 0.044, 0.082),
      new THREE.Vector2(RING_RO - 0.012, 0.062),
      new THREE.Vector2(RING_RO, 0.032),
      new THREE.Vector2(RING_RO, -0.004),
      new THREE.Vector2(RING_RO + 0.024, -0.012)
    ];
    return keepGeo(new THREE.LatheGeometry(pts, 48));
  }

  function buildFrets() {
    var lay = LAY();
    var ringGeo = ringLatheGeometry();
    var coreTex = null;
    var M = materials();
    if (M && M.tex) { try { coreTex = M.tex.softGlow; } catch (e) { coreTex = null; } }
    var ringTex = null;
    if (M && M.tex) { try { ringTex = M.tex.ring; } catch (e) { ringTex = null; } }

    var burstGeo = keepGeo(new THREE.RingGeometry(RING_RO * 0.88, RING_RO * 1.05, 48, 1));
    burstGeo.rotateX(-PI * 0.5);
    var coreGeo = keepGeo(new THREE.CircleGeometry(RING_RI * 1.03, 40));
    coreGeo.rotateX(-PI * 0.5);
    var haloGeo = keepGeo(new THREE.TorusGeometry(RING_RI + 0.030, 0.0175, 8, 44));
    haloGeo.rotateX(-PI * 0.5);
    var chamferGeo = keepGeo(new THREE.TorusGeometry(RING_RO - 0.030, 0.0075, 6, 48));
    chamferGeo.rotateX(-PI * 0.5);
    var wellGeo = keepGeo(new THREE.CircleGeometry(RING_RO * 1.60, 32));
    wellGeo.rotateX(-PI * 0.5);

    for (var i = 0; i < LANES; i++) {
      var g = new THREE.Group();
      var x = lay.laneX(i);
      g.position.set(x, surfaceY(x), lay.STRIKE_Z);
      g.name = 'GH_Fret_' + i;

      /* --- bisel metalico (material da fabrica de materiais) --- */
      var bezMat = null;
      if (M && M.fresh) bezMat = M.fresh('fretRing', i);
      if (!bezMat && M && M.make && M.make.fretRing) bezMat = M.make.fretRing(i);
      if (!bezMat) {
        bezMat = new THREE.MeshStandardMaterial({
          color: laneCol(i, 'rim'), metalness: 1.0, roughness: 0.35,
          envMapIntensity: 1.5
        });
      }
      keepMat(bezMat);
      /* O aro e a peca mais olhada da tela: precisa LER como metal usinado.
       * A copia da fabrica vem calibrada para uma cena com muita luz de palco;
       * aqui reforcamos o brilho ambiente e damos um emissivo minimo da cor da
       * raia para o bisel nunca virar uma silhueta preta num trecho escuro. */
      bezMat.envMapIntensity = 2.6;
      bezMat.roughness = 0.40;
      if (bezMat.color) bezMat.color.lerp(C(0xdfe6f2), 0.34);
      if (bezMat.emissive) {
        /* metalness 1 nao tem difusa: sem um emissivo minimo o bisel vira
         * silhueta preta em qualquer trecho de palco escuro. Aco frio + um
         * toque da cor da raia, para o aro nunca sumir. */
        bezMat.emissive.copy(C(0x8f9bb0)).multiplyScalar(0.09)
          .add(laneCol(i, 'emissive').clone().multiplyScalar(0.13));
        bezMat.emissiveIntensity = 1.0;
      }
      bezMat.needsUpdate = true;
      var bezel = new THREE.Mesh(ringGeo, bezMat);
      bezel.castShadow = true;
      bezel.receiveShadow = true;
      g.add(bezel);

      /* filete usinado no chanfro externo: a aresta viva que qualquer peca
       * torneada tem e que e o que faz o aro parecer metal e nao decalque */
      var chamMat = keepMat(new THREE.MeshBasicMaterial({
        color: C(0xcfd9ea).lerp(laneCol(i, 'rim'), 0.35).multiplyScalar(0.42),
        transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        toneMapped: false
      }));
      var cham = new THREE.Mesh(chamferGeo, chamMat);
      cham.position.y = 0.0805;
      cham.renderOrder = 13;
      g.add(cham);

      /* --- nucleo colorido: o "poco" da raia acendendo --- */
      var cEm = laneCol(i, 'emissive');
      var coreMat = keepMat(new THREE.MeshBasicMaterial({
        color: cEm.clone().multiplyScalar(0.88),
        map: coreTex, transparent: true, opacity: 0.92,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        toneMapped: false, side: THREE.DoubleSide
      }));
      var core = new THREE.Mesh(coreGeo, coreMat);
      core.position.y = 0.038;
      core.renderOrder = 14;
      g.add(core);

      /* --- anel emissivo assentado no chanfro interno --- */
      var haloMat = keepMat(new THREE.MeshBasicMaterial({
        color: cEm.clone(), transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        toneMapped: false
      }));
      var halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.y = 0.070;
      halo.renderOrder = 15;
      g.add(halo);

      /* --- estouro do acerto: anel que expande e some --- */
      var burstMat = keepMat(new THREE.MeshBasicMaterial({
        color: cEm.clone().lerp(C(0xffffff), 0.40),
        map: ringTex, alphaMap: ringTex,
        transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        toneMapped: false, side: THREE.DoubleSide
      }));
      var burst = new THREE.Mesh(burstGeo, burstMat);
      burst.position.y = 0.026;
      burst.visible = false;
      burst.renderOrder = 16;
      g.add(burst);

      /* --- poco de luz no verniz sob o aro (fica no CONVES, nao no grupo,
       *     para nao afundar junto quando o aro e pressionado) --- */
      var wellMat = keepMat(new THREE.MeshBasicMaterial({
        color: laneCol(i, 'glow').clone(),
        map: coreTex, transparent: true, opacity: 0.30,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        toneMapped: false
      }));
      var well = new THREE.Mesh(wellGeo, wellMat);
      well.position.set(x, surfaceY(x) + Y.reflect, lay.STRIKE_Z);
      well.renderOrder = 7;
      group.add(well);

      group.add(g);
      frets.push({
        group: g, bezel: bezel, bezelMat: bezMat,
        core: core, coreMat: coreMat, coreBase: cEm.clone(),
        halo: halo, haloMat: haloMat,
        burst: burst, burstMat: burstMat, burstBase: cEm.clone().lerp(C(0xffffff), 0.40),
        well: well, wellMat: wellMat, wellBase: laneCol(i, 'glow').clone(),
        x: x, y0: surfaceY(x)
      });
    }
  }

  /* ========================================================================
   * 12. CONSTRUCAO — DECALQUES DINAMICOS (reflexos + pulsos)
   * ====================================================================== */

  /* Ondas de pulso: pool FIXO, alocado uma vez. `active` liga/desliga o slot,
   * entao pulse() nunca aloca e o coletor de lixo nunca acorda no meio de uma
   * musica (a causa classica de engasgo em jogo de ritmo). */
  var PULSE_MAX = 7;
  var pulses = [];             /* {active, t, power} */
  (function () {
    for (var i = 0; i < PULSE_MAX; i++) pulses.push({ active: false, t: 0, power: 0 });
  })();
  function spawnPulse(power) {
    var i, oldest = 0, oldestT = -1;
    for (i = 0; i < PULSE_MAX; i++) {
      if (!pulses[i].active) { pulses[i].active = true; pulses[i].t = 0; pulses[i].power = power; return; }
      if (pulses[i].t > oldestT) { oldestT = pulses[i].t; oldest = i; }
    }
    /* pool cheio: recicla a onda mais velha (ja quase apagada) */
    pulses[oldest].t = 0;
    pulses[oldest].power = power;
  }

  function buildDecals() {
    /* mascara horizontal suave: da borda macia em X sem precisar de shader */
    var soft = ramp([0x000000, 0x9a9a9a, 0xffffff, 0x9a9a9a, 0x000000],
      [0, 0.22, 0.5, 0.78, 1], false);
    var mat = keepMat(new THREE.MeshBasicMaterial({
      map: soft, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      vertexColors: true, toneMapped: false, side: THREE.DoubleSide
    }));
    decals = QuadBatch(96, mat, 8);
    group.add(decals.mesh);
  }

  /* ========================================================================
   * 12B. CONSTRUCAO — JANELA DE DEDOS (Facil / Medio)
   * No Facil e no Medio o chart usa 3 ou 4 raias que mudam de lugar depois de
   * cada frase de Star Power. A pista mostra isso sem texto: as raias fora da
   * janela ficam na sombra (e a fronteira desce junto com as notas), e perto
   * da troca setas piscam logo abaixo dos aros da janela nova, apontando para
   * onde a mao vai. Na janela de abertura elas apontam PARA FRENTE.
   * ====================================================================== */

  /* seta em "V" deitado; up = true aponta para o fundo da pista */
  function chevronTexture(up) {
    var c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    var g = c.getContext('2d');
    g.strokeStyle = '#ffffff';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.shadowColor = '#ffffff';
    function chev(w, a) {
      g.globalAlpha = a;
      g.lineWidth = w;
      g.beginPath();
      if (up) { g.moveTo(20, 86); g.lineTo(64, 38); g.lineTo(108, 86); }
      else { g.moveTo(42, 20); g.lineTo(90, 64); g.lineTo(42, 108); }
      g.stroke();
    }
    g.shadowBlur = 22; chev(30, 0.30);
    g.shadowBlur = 8; chev(17, 1);
    var tex = new THREE.CanvasTexture(c);
    ownedTex.push(tex);
    return tex;
  }

  function arrowMat(up) {
    return keepMat(new THREE.MeshBasicMaterial({
      map: chevronTexture(up), transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      vertexColors: true, toneMapped: false, side: THREE.DoubleSide
    }));
  }

  function buildLaneWindow() {
    var shadeMat = keepMat(new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1,
      blending: THREE.NormalBlending, depthWrite: false, fog: false,
      vertexColors: true, toneMapped: false, side: THREE.DoubleSide
    }));
    /* depois das linhas de batida/compasso (4-5), antes das gems acesas */
    lwShade = QuadBatch(64, shadeMat, 6);
    group.add(lwShade.mesh);

    /* depois do brilho dos aros: as setas ficam por cima da pista */
    lwArrowSide = QuadBatch(LANES, arrowMat(false), 15);
    lwArrowFwd = QuadBatch(LANES, arrowMat(true), 15);
    group.add(lwArrowSide.mesh);
    group.add(lwArrowFwd.mesh);
  }

  /* ========================================================================
   * 13. CONSTRUCAO — CAMADA DE STAR POWER
   * ====================================================================== */

  function buildStarPower() {
    /* --- veu frio correndo sobre toda a madeira --- */
    var chase = ramp([0x000000, 0x1a1a1a, 0xffffff, 0x2a2a2a, 0x000000],
      [0, 0.34, 0.50, 0.66, 1], true);
    if (chase) { chase.wrapT = THREE.RepeatWrapping; chase.wrapS = THREE.RepeatWrapping; }
    spWashMat = keepMat(new THREE.MeshBasicMaterial({
      color: spCol('glow', 0x8fd8ff).clone(),
      map: chase, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      vertexColors: true, toneMapped: false
    }));
    var geo = deckGeometry(-DECK_HW + 0.01, DECK_HW - 0.01, NEAR_Z, FAR_Z, 8, 96, Y.spWash,
      function (x, z, u, v, out) {
        out[0] = out[1] = out[2] = 1;
        out[3] = glowFade(z) * (0.35 + 0.65 * (1 - Math.abs(u * 2 - 1)));
      }, { uRepeat: 1, vRepeat: DECK_LEN / 7.5 });
    spWash = new THREE.Mesh(geo, spWashMat);
    spWash.frustumCulled = false;
    spWash.visible = false;
    spWash.renderOrder = 11;
    group.add(spWash);

    /* --- energia correndo pelas bordas (duas faixas verticais) --- */
    var streak = ramp([0x000000, 0x000000, 0xffffff, 0x000000, 0x000000],
      [0, 0.36, 0.50, 0.64, 1], false);
    if (streak) { streak.wrapS = THREE.RepeatWrapping; }
    var inner = HALF_W + SHOULDER;
    var yBase = surfaceY(inner);
    for (var s = -1; s <= 1; s += 2) {
      var mat = keepMat(new THREE.MeshBasicMaterial({
        color: spCol('core', 0xf2fbff).clone(),
        map: streak, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        vertexColors: true, side: THREE.DoubleSide, toneMapped: false
      }));
      var g = keepGeo(makeVerticalStrip(
        s * (inner + 0.020), yBase + 0.020, yBase + 0.175, NEAR_Z, FAR_Z, 110));
      var m = new THREE.Mesh(g, mat);
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 13;
      group.add(m);
      spEdge.push({ mesh: m, mat: mat, tex: streak });
    }
  }

  /* ========================================================================
   * 14. LEITURA DO ESTADO DE JOGO
   * ====================================================================== */

  /* Detecta acertos/erros lendo o estado que GH.Scoring escreve nas notas do
   * GH.Chart. Funciona igual em jogo real e no modo captura (onde os eventos
   * do preroll sao emitidos em silencio) — e por isso nao dependemos deles. */
  function syncFromChart(t) {
    var Ch = GH.Chart;
    if (!Ch || !Ch.notes || !Ch.notes.length) return;
    var notes = Ch.notes;
    var ST = Ch.STATE || { PENDING: 0, HIT: 1, MISSED: 2, HELD: 3, DONE: 4 };

    /* recomeco / troca de musica: reancora o cursor */
    var sig = (Ch.song ? (Ch.song.id || '') : '') + '|' + (Ch.difficulty || '') + '|' + notes.length;
    if (sig !== chartSig) {
      chartSig = sig;
      chartCursor = 0;
      var lw = Ch.song && Ch.song.laneWindows;
      lwList = (lw && lw[Ch.difficulty] && lw[Ch.difficulty].length) ? lw[Ch.difficulty] : null;
      lwCur = -1;
      lwArrowK = -1;
      lwArrowA = 0;
      lwOpenEnd = Math.max(notes[0].t + 0.6, 3.0);
    }
    if (chartCursor > 0 && chartCursor <= notes.length && notes[chartCursor - 1] &&
        notes[chartCursor - 1].t > t + 0.35) {
      chartCursor = 0;                    /* voltou no tempo (seek/restart) */
    }

    var i;
    for (i = chartCursor; i < notes.length; i++) {
      var n = notes[i];
      if (n.t > t + 0.012) break;
      var st = n.state;
      if (st === ST.PENDING) break;       /* ainda nao julgada: nao avance */
      /* ALCANCE SILENCIOSO: o modo captura simula a musica inteira antes do
       * primeiro update (Scoring.autoPlayTo). Sem este corte, todas as notas
       * ja tocadas disparariam de uma vez e a pista nasceria estourada. So
       * anima o que aconteceu agorinha. */
      if (n.t >= t - 0.30) {
        if (st === ST.HIT || st === ST.HELD || st === ST.DONE) {
          fireHit(n.open ? -1 : n.lane, 1);
        } else if (st === ST.MISSED) {
          fireMiss(n.open ? -1 : n.lane);
        }
      }
      chartCursor = i + 1;
    }

    /* sustains segurados acendem a raia inteira */
    var S = GH.Scoring;
    if (S && typeof S.activeSustains === 'function') {
      var sus = null;
      try { sus = S.activeSustains(); } catch (e) { sus = null; }
      if (sus && sus.length) {
        for (i = 0; i < sus.length; i++) {
          var s = sus[i];
          var ln = (s && s.lane !== undefined) ? s.lane
                 : (s && s.note && s.note.lane !== undefined ? s.note.lane : -1);
          var op = !!(s && (s.open || (s.note && s.note.open)));
          if (op) { for (var k = 0; k < LANES; k++) laneHoldTarget[k] = 1; }
          else if (ln >= 0 && ln < LANES) laneHoldTarget[ln] = 1;
        }
      }
    }
  }

  function readInput() {
    var I = GH.Input;
    if (!I || typeof I.isFret !== 'function') return;
    for (var i = 0; i < LANES; i++) {
      var down = false;
      try { down = !!I.isFret(i); } catch (e) { down = false; }
      if (down) { laneHoldTarget[i] = 1; laneHeld[i] = true; }
      else laneHeld[i] = false;
    }
  }

  function fireHit(lane, quality) {
    var q = (quality === 'perfect' || quality === 1) ? 1 : 0.62;
    if (lane < 0) {
      for (var i = 0; i < LANES; i++) fireHit(i, quality);
      return;
    }
    if (lane < 0 || lane >= LANES) return;
    laneHit[lane] = 1;
    fretBurst[lane] = 0;
    fretBurstQ[lane] = q;
    laneHoldTarget[lane] = Math.max(laneHoldTarget[lane], 0.70);
    pulseTarget = Math.min(1.15, pulseTarget + 0.10 * q);
  }

  function fireMiss(lane) {
    if (lane < 0) {
      for (var i = 0; i < LANES; i++) fireMiss(i);
      return;
    }
    if (lane >= LANES) return;
    laneMiss[lane] = 1;
  }

  /* ========================================================================
   * 15. ATUALIZACAO POR FRAME
   * ====================================================================== */

  /* objeto reaproveitado — nao aloca por frame */
  var _info = { beat: 0, spb: 0.5, beatsPerBar: 4, ok: false };

  function conductorInfo(t) {
    var Cd = GH.Conductor;
    var info = _info;
    info.beat = 0; info.spb = 0.5; info.beatsPerBar = 4; info.ok = false;
    if (!Cd) return info;
    try {
      var bpm = (typeof Cd.bpmAt === 'function') ? Cd.bpmAt(t) : 120;
      if (!(bpm > 1)) bpm = 120;
      info.spb = 60 / bpm;
      info.beat = (typeof Cd.beatAt === 'function') ? Cd.beatAt(t) : t / info.spb;
      info.beatsPerBar = Cd.beatsPerBar || 4;
      info.ok = true;
    } catch (e) { /* fica no fallback */ }
    return info;
  }

  function zOfTime(t, noteTime) {
    var Ch = GH.Chart;
    if (Ch && typeof Ch.zAt === 'function') {
      var z = Ch.zAt(t, noteTime);
      if (isFinite(z)) return z;
    }
    var speed = (Ch && Ch.speed) || 14;
    return (noteTime - t) * -1 * speed;
  }

  function scrollSpeed() {
    var Ch = GH.Chart;
    var s = (Ch && Ch.speed) || 14;
    return (s > 0.1 && s < 200) ? s : 14;
  }

  /* ---- linhas de batida e compasso ---- */
  function updateBeatLines(t) {
    var i;
    for (i = 0; i < beatPool.length; i++) beatPool[i].mesh.visible = false;
    for (i = 0; i < barPool.length; i++) {
      barPool[i].mesh.visible = false;
      barPool[i].core.visible = false;
    }

    var info = conductorInfo(t);
    var Cd = GH.Conductor;
    var spb = info.spb;
    if (!(spb > 0.05)) return;

    var speed = scrollSpeed();
    /* faixa de batidas cujo z cai dentro do conves */
    var bNear = Math.ceil((info.beat - (NEAR_Z / speed) / spb) - 1);
    var bFar = Math.floor(info.beat + ((-FAR_Z) / speed) / spb) + 1;
    if (!isFinite(bNear) || !isFinite(bFar)) return;
    if (bFar - bNear > 400) return;                /* seguranca contra bpm louco */

    var bpBar = info.beatsPerBar || 4;
    var beatC = tc('beatLine', 0xffcb6b);
    var baseCol = _c1.copy(beatC);
    if (spLevel > 0.01) baseCol.lerp(spCol('core', 0xf2fbff), spLevel * 0.85);

    var barC = _c2.copy(tc('inlay', 0xf0c486));
    if (spLevel > 0.01) barC.lerp(spCol('rim', 0xffffff), spLevel * 0.8);

    /* RESPIRACAO PROPRIA. Mesmo que ninguem chame pulse(), a pista tem que
     * pulsar no compasso — e o que faz um jogo de ritmo parecer vivo. Pico na
     * batida, queda rapida; entra como PISO do pulso global, entao nunca soma
     * duas vezes com o pulso que o Game manda no acerto. */
    var ph = info.beat - Math.floor(info.beat);
    var breath = Math.pow(1 - ph, 2.4);
    var barPh = (info.beat / bpBar) - Math.floor(info.beat / bpBar);
    breath = Math.max(breath, Math.pow(1 - barPh, 9.0) * 1.35);
    if (pulseLevel < breath * 0.26) pulseLevel = breath * 0.26;

    var bi = 0, bri = 0;
    for (var b = bNear; b <= bFar; b++) {
      var bt = (Cd && typeof Cd.timeAtBeat === 'function') ? Cd.timeAtBeat(b) : b * spb;
      var z = zOfTime(t, bt);
      if (z > NEAR_Z || z < FAR_Z) continue;
      var isBar = (((b % bpBar) + bpBar) % bpBar) === 0;
      var fade = glowFade(z);
      /* pequeno flash quando a linha cruza a linha de acerto */
      var cross = 1 + impulse(clamp01(1 - Math.abs(z) / 2.6), 3.2) * 0.55;

      if (isBar && bri < barPool.length) {
        var bp = barPool[bri++];
        bp.mesh.visible = true;
        bp.mesh.position.z = z;
        bp.core.visible = true;
        bp.core.position.z = z;
        var kb = fade * cross * (0.85 + pulseLevel * 0.40) * (1 + spLevel * 0.5);
        bp.mat.color.copy(barC).multiplyScalar(clamp(kb, 0, 2.6));
        bp.coreMat.color.copy(barC).lerp(K_WHITE, 0.35)
          .multiplyScalar(clamp(kb * 0.55, 0, 1.6));
      } else if (bi < beatPool.length) {
        var bpp = beatPool[bi++];
        bpp.mesh.visible = true;
        bpp.mesh.position.z = z;
        var k = fade * cross * (0.26 + pulseLevel * 0.26) * (1 + spLevel * 0.45);
        bpp.mat.color.copy(baseCol).multiplyScalar(clamp(k, 0, 1.6));
      }
    }
  }

  /* ---- rolagem das texturas (madeira, friso, LED, star power) ---- */
  function updateScroll(dt) {
    var speed = scrollSpeed();
    scrollDist += speed * dt;

    var vDeck = scrollDist * DECK_TILES_V / DECK_LEN;
    if (deckMat) {
      if (deckMat.map) deckMat.map.offset.y = vDeck;
      if (deckMat.normalMap) deckMat.normalMap.offset.y = vDeck;
      if (deckMat.roughnessMap) deckMat.roughnessMap.offset.y = vDeck;
    }
    /* o friso corre no eixo U da textura (ver o `swap` em buildInlays) */
    var vInlay = scrollDist / INLAY_TILE;
    if (inlayL && inlayL.tex) inlayL.tex.offset.x = vInlay;
    if (inlayR && inlayR.tex) inlayR.tex.offset.x = vInlay;

    /* fita de LED: corrida rapida, acelera com o star power */
    var chaseSpeed = 0.55 + spLevel * 2.4;
    for (var i = 0; i < rails.length; i++) {
      var m = rails[i].ledMat;
      if (m && m.map) m.map.offset.x = -elapsed * chaseSpeed;
    }
    if (spWashMat && spWashMat.map) {
      spWashMat.map.offset.y = scrollDist / 7.5 + elapsed * 0.22;
    }
    for (i = 0; i < spEdge.length; i++) {
      if (spEdge[i].tex) spEdge[i].tex.offset.x = -elapsed * (0.85 + spLevel * 1.6);
    }
  }

  /* ---- raias: sangria, acendimento, erro ---- */
  function updateLanes(dt) {
    for (var i = 0; i < LANES; i++) {
      laneHit[i] = damp(laneHit[i], 0, 7.5, dt);
      laneMiss[i] = damp(laneMiss[i], 0, 4.2, dt);
      var target = Math.max(laneHoldTarget[i], laneHit[i] * 0.85);
      laneHold[i] = damp(laneHold[i], target, target > laneHold[i] ? 26 : 8.5, dt);
      laneHoldTarget[i] = 0;

      var bleed = laneBleed[i];
      if (bleed) {
        var k = 0.45 + 0.55 * laneHold[i] + pulseLevel * 0.22;
        _c1.copy(bleed.base);
        if (spLevel > 0.01) _c1.lerp(spCol('tint', 0xb9e6ff), spLevel * 0.75);
        if (laneMiss[i] > 0.01) _c1.lerp(K_MISSDEEP, laneMiss[i] * 0.7);
        bleed.mat.color.copy(_c1).multiplyScalar(k);
      }

      var lit = laneLit[i];
      if (lit) {
        var a = laneHold[i];
        lit.mesh.visible = a > 0.012;
        if (lit.mesh.visible) {
          /* 0,30 com o jorro antigo (30 unidades de comprimento) fazia cinco
             faixas saturadas do tamanho da pista: no plano lateral virava
             carpete colorido. A raia acesa e uma LINGUA de luz curta saindo do
             aro, nao uma pintura no braco. */
          lit.mat.opacity = a * 0.20;
          _c2.copy(lit.base);
          if (spLevel > 0.01) _c2.lerp(spCol('glow', 0x8fd8ff), spLevel * 0.8);
          lit.mat.color.copy(_c2).multiplyScalar(0.85 + laneHit[i] * 1.1);
        }
      }
    }
  }

  /* ---- aros de fret: idle / pressed / hit ---- */
  function updateFrets(dt, t) {
    for (var i = 0; i < LANES; i++) {
      var f = frets[i];
      if (!f) continue;

      /* afundamento */
      var pressTarget = laneHold[i];
      fretPress[i] = damp(fretPress[i], pressTarget, pressTarget > fretPress[i] ? 30 : 11, dt);
      f.group.position.y = f.y0 - fretPress[i] * 0.030;

      /* respiracao lenta no idle — nunca parado, nunca linear */
      var breath = 0.5 + 0.5 * Math.sin(elapsed * 1.55 + i * 0.82);
      /* aro fora da janela de dedos (Facil/Medio) descansa apagado */
      var idle = (0.62 + 0.16 * breath) * (0.30 + 0.70 * laneAct[i]);
      var lit = idle + laneHold[i] * 1.25 + laneHit[i] * 1.4 + pulseLevel * 0.20 * laneAct[i];

      _c1.copy(f.coreBase);
      if (spLevel > 0.01) _c1.lerp(spCol('glow', 0x8fd8ff), spLevel * 0.48);
      if (laneMiss[i] > 0.01) _c1.lerp(K_MISSHOT, laneMiss[i] * 0.65);
      f.coreMat.color.copy(_c1).multiplyScalar(clamp(lit * 1.12, 0, 3.4));
      f.coreMat.opacity = clamp(0.85 + laneHold[i] * 0.15, 0, 1);
      var sc = 1 + breath * 0.018 + laneHit[i] * 0.10 - fretPress[i] * 0.045;
      f.core.scale.set(sc, 1, sc);

      f.haloMat.color.copy(_c1).multiplyScalar(clamp(0.55 + lit * 0.75, 0, 3.6));
      f.haloMat.opacity = clamp(0.55 + laneHold[i] * 0.45, 0, 1);
      f.halo.position.y = 0.070 + laneHit[i] * 0.004;

      /* poco de luz no verniz sob o aro */
      _c2.copy(f.wellBase);
      if (spLevel > 0.01) _c2.lerp(spCol('tint', 0xb9e6ff), spLevel * 0.8);
      f.wellMat.color.copy(_c2).multiplyScalar(clamp(0.22 + lit * 0.38, 0, 1.6));
      f.wellMat.opacity = clamp(0.10 + laneHold[i] * 0.26 + laneHit[i] * 0.24, 0, 0.72);

      /* estouro: o anel expande e desaparece */
      if (fretBurst[i] >= 0) {
        fretBurst[i] += dt;
        var life = 0.30;
        var p = fretBurst[i] / life;
        if (p >= 1) {
          fretBurst[i] = -1;
          f.burst.visible = false;
          f.burstMat.opacity = 0;
        } else {
          var e = easeOutCubic(p);
          var s = 1 + e * (1.35 + fretBurstQ[i] * 0.85);
          f.burst.visible = true;
          f.burst.scale.set(s, 1, s);
          f.burst.position.y = 0.026 + e * 0.055;
          f.burstMat.opacity = (1 - p) * (1 - p) * (0.85 + fretBurstQ[i] * 0.35);
          _c3.copy(f.burstBase);
          if (spLevel > 0.01) _c3.lerp(spCol('core', 0xf2fbff), spLevel * 0.9);
          f.burstMat.color.copy(_c3).multiplyScalar(1 + fretBurstQ[i] * 0.6);
        }
      }
    }
  }

  /* ---- reflexos das gems no verniz + ondas de pulso ---- */
  function updateDecals(dt, t) {
    if (!decals) return;
    decals.begin();

    /* --- reflexo dos AROS: rastro esticado em direcao a camera --- */
    var i;
    for (i = 0; i < LANES; i++) {
      var f = frets[i];
      if (!f) continue;
      var amt = 0.14 + laneHold[i] * 0.34 + laneHit[i] * 0.30;
      _c1.copy(f.wellBase);
      if (spLevel > 0.01) _c1.lerp(spCol('glow', 0x8fd8ff), spLevel * 0.8);
      var half = LANE_W * 0.32;
      decals.push(f.x - half, f.x + half, 1.55, -0.05, Y.reflect + 0.0006,
        _c1.r, _c1.g, _c1.b, 0.0, amt);
    }

    /* --- reflexo das GEMS que estao descendo (o verniz e molhado) --- */
    var Ch = GH.Chart;
    if (Ch && Ch.notes && Ch.notes.length && typeof Ch.visibleRange === 'function') {
      var ST = Ch.STATE || { PENDING: 0 };
      var r = null;
      try { r = Ch.visibleRange(t); } catch (e) { r = null; }
      if (r) {
        var lay = LAY();
        var count = 0;
        for (i = r[0]; i <= r[1] && count < 60; i++) {
          var n = Ch.notes[i];
          if (!n) continue;
          if (n.state !== ST.PENDING && n.state !== undefined && n.state !== 3) continue;
          var z = zOfTime(t, n.t);
          if (z > 1.2 || z < -34) continue;
          var fade = (1 - smoothstep(-8, -30, z)) * 0.32 * nearTaper(z, 0.45);
          if (fade <= 0.008) continue;
          var lc = laneCol(n.lane, 'glow');
          _c2.copy(lc);
          if (spLevel > 0.01 || n.sp) _c2.lerp(spCol('glow', 0x8fd8ff), Math.max(spLevel, n.sp ? 0.55 : 0) * 0.8);
          if (n.open) {
            decals.push(-HALF_W, HALF_W, z + 0.42, z - 0.22, Y.reflect,
              _c2.r, _c2.g, _c2.b, 0.0, fade * 0.85);
          } else {
            var cx = lay.laneX(n.lane);
            var hw = LANE_W * 0.30;
            /* o rastro se estica NA DIRECAO DA CAMERA, que e como um reflexo
             * se comporta numa superficie com microrrugosidade */
            decals.push(cx - hw, cx + hw, z + 1.05, z - 0.14, Y.reflect,
              _c2.r, _c2.g, _c2.b, 0.0, fade);
          }
          count++;
        }
      }
    }

    /* --- ondas de pulso percorrendo a pista --- */
    var speed = scrollSpeed();
    for (i = 0; i < PULSE_MAX; i++) {
      var p = pulses[i];
      if (!p.active) continue;
      p.t += dt;
      var life = 1.05;
      if (p.t >= life) { p.active = false; continue; }
      var k = p.t / life;
      var z = 1.6 - k * (speed * 1.75 + 22);
      var a = (1 - k) * (1 - k) * p.power * 0.26;
      if (a < 0.004 || z < FAR_Z) continue;
      _c3.copy(tc('highwayEdge', 0xff3d8a)).lerp(K_WHITE, 0.35);
      if (spLevel > 0.01) _c3.lerp(spCol('core', 0xf2fbff), spLevel * 0.9);
      decals.push(-HALF_W - 0.04, HALF_W + 0.04, z + 0.35, z - 1.55, Y.pulse,
        _c3.r, _c3.g, _c3.b, a, 0.0);
    }

    decals.end();
  }

  /* ---- janela de dedos: sombra fora da janela + setas na troca ---- */
  var LW_SHADE_A = 0.62;       /* sombra maxima sobre a raia fora de uso */
  var LW_Z_END = -0.55;        /* a sombra para antes do aro (ele apaga sozinho) */

  function lwShadeA(z) {
    return LW_SHADE_A * smoothstep(LW_Z_END, -1.9, z) * (1 - 0.55 * smoothstep(-26, -50, z));
  }

  var LW_ARROW_LEAD = 1.8;     /* s antes da troca em que as setas acendem */
  var LW_ARROW_TAIL = 1.0;     /* e quanto ficam depois dela */
  var LW_ARROW_Z = 0.82;       /* logo abaixo dos aros (lado do jogador) */
  var lwArrowK = -1;           /* janela cujas setas estao na tela */
  var lwArrowA = 0;            /* envelope 0..1 das setas */

  function updateLaneWindows(dt, t) {
    if (!lwShade || !lwArrowSide || !lwArrowFwd) return;
    var i, k;
    lwShade.begin();
    lwArrowSide.begin();
    lwArrowFwd.begin();
    if (!lwList) {
      for (i = 0; i < LANES; i++) laneAct[i] = damp(laneAct[i], 1, 6, dt);
      lwArrowA = 0;
      lwShade.end();
      lwArrowSide.end();
      lwArrowFwd.end();
      return;
    }

    var cur = 0;
    while (cur + 1 < lwList.length && lwList[cur + 1].t <= t) cur++;
    if (lwCur >= 0 && cur > lwCur) {
      /* a troca chegou na linha de acerto: os aros da janela nova acendem */
      for (i = lwList[cur].lo; i <= lwList[cur].hi; i++) laneHit[i] = Math.max(laneHit[i], 0.8);
      pulse(0.55);
    }
    lwCur = cur;
    for (i = 0; i < LANES; i++) {
      var on = i >= lwList[cur].lo && i <= lwList[cur].hi;
      laneAct[i] = damp(laneAct[i], on ? 1 : 0, 7, dt);
    }

    var lay = LAY();
    var y = Y.divider - 0.002;
    for (k = cur; k < lwList.length; k++) {
      var zN = (k === cur) ? LW_Z_END : Math.min(LW_Z_END, zOfTime(t, lwList[k].t));
      var zF = (k + 1 < lwList.length) ? Math.max(FAR_Z, zOfTime(t, lwList[k + 1].t)) : FAR_Z;
      if (zN <= FAR_Z) break;
      if (zF >= zN) continue;
      for (i = 0; i < LANES; i++) {
        if (i >= lwList[k].lo && i <= lwList[k].hi) continue;
        var x0 = lay.laneX(i) - LANE_W * 0.5, x1 = x0 + LANE_W;
        /* em pedacos, para o alfa seguir a profundidade (o lote so
         * interpola entre as duas pontas de cada retangulo) */
        for (var z0 = zN; z0 > zF + 1e-3;) {
          var z1 = Math.max(zF, z0 - (z0 > -2.5 ? 1.4 : 6.0));
          lwShade.push(x0, x1, z0, z1, y, 0.010, 0.005, 0.018, lwShadeA(z0), lwShadeA(z1));
          z0 = z1;
        }
      }
    }

    /* setas logo abaixo dos aros da janela nova, piscando perto de cada troca;
       na abertura (ate a primeira nota) apontam para frente */
    var show = -1;
    for (k = 1; k < lwList.length; k++) {
      if (t >= lwList[k].t - LW_ARROW_LEAD && t < lwList[k].t + LW_ARROW_TAIL) { show = k; break; }
    }
    if (show < 0 && t < lwOpenEnd) show = 0;
    if (show >= 0) lwArrowK = show;
    lwArrowA = damp(lwArrowA, show >= 0 ? 1 : 0, show >= 0 ? 14 : 7, dt);
    if (lwArrowA > 0.01 && lwArrowK >= 0 && lwArrowK < lwList.length) {
      var w = lwList[lwArrowK];
      var dir = lwArrowK === 0 ? 0 : (w.lo >= lwList[lwArrowK - 1].lo ? 1 : -1);
      var blink = 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(elapsed * 13), 1.5);
      var a = lwArrowA * blink;
      var sx = LANE_W * 0.36;
      var zN = LW_ARROW_Z + 0.30, zF = LW_ARROW_Z - 0.30;
      var ay = Y.pulse + 0.002;
      for (i = w.lo; i <= w.hi; i++) {
        var cx = lay.laneX(i);
        _c3.copy(laneCol(i, 'glow')).lerp(K_WHITE, 0.45).multiplyScalar(1.8);
        if (dir === 0) {
          lwArrowFwd.push(cx - sx, cx + sx, zN, zF, ay, _c3.r, _c3.g, _c3.b, a, a);
        } else {
          /* x0 > x1 espelha a textura: a seta aponta para a esquerda */
          lwArrowSide.push(cx - sx * dir, cx + sx * dir, zN, zF, ay, _c3.r, _c3.g, _c3.b, a, a);
        }
      }
    }

    lwShade.end();
    lwArrowSide.end();
    lwArrowFwd.end();
  }

  /* ---- trilhos, neon, LED ---- */
  function updateRails(dt) {
    var edgeC = _c1.copy(tc('highwayEdge', 0xff3d8a));
    var neonC = _c2.copy(tc('neon', 0x25e8ce));
    if (spLevel > 0.01) {
      edgeC.lerp(spCol('edge', 0x3aa8ff), spLevel * 0.92);
      neonC.lerp(spCol('core', 0xf2fbff), spLevel * 0.85);
    }
    var beat = 1 + pulseLevel * 0.45 + spLevel * 0.30;
    for (var i = 0; i < rails.length; i++) {
      var r = rails[i];
      r.neonMat.color.copy(edgeC).multiplyScalar(0.72 * beat);
      r.haloMat.color.copy(edgeC).multiplyScalar(0.55);
      r.haloMat.opacity = clamp(0.16 + pulseLevel * 0.16 + spLevel * 0.18, 0, 1);
      r.ledMat.color.copy(neonC).multiplyScalar(0.55 + pulseLevel * 0.65);
      r.ledMat.opacity = clamp(0.26 + pulseLevel * 0.30 + spLevel * 0.22, 0, 1);
    }
    /* o rastro do neon no verniz segue o tubo (inclusive no star power) */
    for (i = 0; i < neonRefl.length; i++) {
      neonRefl[i].mat.color.copy(edgeC).multiplyScalar(0.55 * (0.85 + pulseLevel * 0.5));
    }
  }

  /* ---- linha de acerto ---- */
  function updateStrike(dt) {
    if (!strike) return;
    var k = 0.72 + pulseLevel * 0.55;
    _c1.copy(strike.edgeBase);
    if (spLevel > 0.01) _c1.lerp(spCol('core', 0xf2fbff), spLevel * 0.9);
    strike.edgeMat.color.copy(_c1).multiplyScalar(clamp(k, 0, 2.0));
    strike.edgeMat.opacity = clamp(0.55 + pulseLevel * 0.30, 0, 1);

    _c2.copy(strike.glowBase);
    if (spLevel > 0.01) _c2.lerp(spCol('glow', 0x8fd8ff), spLevel * 0.85);
    /* soma o brilho das raias acesas: com 5 trastes segurados a linha inteira
     * acende, exatamente como no Guitar Hero */
    var laneSum = 0;
    for (var i = 0; i < LANES; i++) laneSum += laneHold[i] * 0.13 + laneHit[i] * 0.09;
    /* O halo da linha de acerto e ADITIVO e cobre o conves inteiro na altura
     * dos aros. Somado ao rastro das raias e ao flash do FX ele virava um
     * ovalo laranja que passava por cima dos cinco aros — o "estouro" do
     * briefing. Aqui ele volta a ser o brilho da linha, nao um holofote. */
    /* ORCAMENTO DE ENERGIA DA LINHA DE ACERTO. Quatro fontes independentes
       (este halo + a poca por raia do FX + o flash de acerto + a luz pontual
       do engine) somam no mesmo lugar; cada agente calibrou a sua sozinha e o
       resultado foi um ovalo laranja por cima dos cinco aros. Esta e a de
       MAIOR AREA — cobre o conves inteiro — entao e a que tem que ceder: ela
       volta a ser o brilho encostado na barra, e o desenho do acerto fica por
       conta das fontes pequenas, que e onde ele le melhor. */
    strike.glowMat.color.copy(_c2).multiplyScalar(clamp(0.22 + pulseLevel * 0.22 + laneSum * 0.5, 0, 0.85));
    strike.glowMat.opacity = clamp(0.055 + pulseLevel * 0.065 + laneSum * 0.15 + spLevel * 0.05, 0, 0.26);
  }

  /* ---- star power ---- */
  function updateStarPower(dt) {
    spLevel = damp(spLevel, spOn ? 1 : 0, spOn ? 4.5 : 3.0, dt);
    var on = spLevel > 0.012;

    if (spWash) {
      spWash.visible = on;
      if (on) {
        /* O banho de star power e ADITIVO por cima do conves inteiro. Com
         * 0.42 a pista virava um rosa fluorescente e as gems prateadas
         * sumiam dentro dele — o oposto do que o star power deveria fazer. */
        spWashMat.opacity = spLevel * 0.20;
        _c1.copy(spCol('glow', 0x8fd8ff));
        spWashMat.color.copy(_c1).multiplyScalar(0.55 + pulseLevel * 0.40);
      }
    }
    for (var i = 0; i < spEdge.length; i++) {
      var e = spEdge[i];
      e.mesh.visible = on;
      if (on) {
        e.mat.opacity = spLevel * (0.55 + pulseLevel * 0.35);
        e.mat.color.copy(spCol('core', 0xf2fbff)).multiplyScalar(1 + pulseLevel * 0.5);
      }
    }
    /* a propria madeira esfria: prata/azul em vez de jacaranda quente */
    if (deckMat && deckMat.userData.baseColor) {
      _c2.copy(deckMat.userData.baseColor);
      if (on) _c2.lerp(spCol('deep', 0x0b2a4a), spLevel * 0.55)
                 .lerp(K_SPSTEEL, spLevel * 0.20);
      deckMat.color.copy(_c2);
      deckMat.clearcoat = 0.38 + spLevel * 0.30;
    }
    /* inlays viram madreperola gelada */
    var ic = _c3.copy(tc('inlay', 0xf0c486));
    if (on) ic.lerp(spCol('rim', 0xffffff), spLevel * 0.85);
    if (inlayL) inlayL.mat.color.copy(ic).multiplyScalar(0.9 + pulseLevel * 0.5 + spLevel * 0.35);
    if (inlayR) inlayR.mat.color.copy(ic).multiplyScalar(0.9 + pulseLevel * 0.5 + spLevel * 0.35);

    /* divisorias */
    for (i = 0; i < dividers.length; i++) {
      var d = dividers[i];
      _c1.copy(d.base);
      if (on) _c1.lerp(spCol('tint', 0xb9e6ff), spLevel * 0.85);
      d.mat.color.copy(_c1).multiplyScalar(
        (d.edge ? 1.05 : 0.80) * (1 + pulseLevel * 0.45 + spLevel * 0.30));
    }
  }

  /* ---- veu de neblina no fundo acompanha a cor real do fog ---- */
  function updateFarFade() {
    if (!farFadeMat) return;
    try {
      var sc = GH.Engine && GH.Engine.scene;
      if (sc && sc.fog && sc.fog.color) farFadeMat.color.copy(sc.fog.color);
    } catch (e) { /* mantem a cor anterior */ }
  }

  /* ========================================================================
   * 16. API PUBLICA
   * ====================================================================== */

  function init(sc) {
    if (inited) return API;
    if (typeof THREE === 'undefined') return API;
    scene = sc || (GH.Engine ? GH.Engine.scene : null);
    if (!scene) return API;

    _c1 = new THREE.Color();
    _c2 = new THREE.Color();
    _c3 = new THREE.Color();
    K_WHITE = C(0xffffff);
    K_MISSDEEP = C(0x2a0308);
    K_MISSHOT = C(0xff2438);
    K_SPSTEEL = C(0x8ba9c8);

    var lay = LAY();
    LANES = lay.LANES || 5;
    LANE_W = lay.LANE_W || 0.72;
    HALF_W = lay.HALF_W || 1.80;
    DECK_HW = HALF_W + SHOULDER;

    group = new THREE.Group();
    group.name = 'GH_Highway';
    API.group = group;

    theme = resolveTheme(themeName);

    safe('buildDeck', buildDeck);
    safe('buildLanes', buildLanes);
    safe('buildInlays', buildInlays);
    safe('buildNeonReflection', buildNeonReflection);
    safe('buildBeatLines', buildBeatLines);
    safe('buildDividers', buildDividers);
    safe('buildRails', buildRails);
    safe('buildDecals', buildDecals);
    safe('buildLaneWindow', buildLaneWindow);
    safe('buildStrike', buildStrike);
    safe('buildFrets', buildFrets);
    safe('buildStarPower', buildStarPower);

    scene.add(group);

    /* o envMap do materials.js da o reflexo do palco no verniz e no metal */
    safe('env', function () {
      var M = materials();
      if (M && typeof M.applyEnvironment === 'function' && scene && !scene.environment) {
        M.applyEnvironment(scene);
      }
    });

    /* eventos de pontuacao: caminho rapido para acerto/erro no jogo real.
     * O caminho lento (leitura do chart) continua valendo no modo captura. */
    safe('hookScoring', function () {
      var S = GH.Scoring;
      if (S && typeof S.onEvent === 'function') {
        S.onEvent(function (e) {
          if (!e || !inited) return;
          try {
            if (e.type === 'hit') {
              if (e.open) fireHit(-1, e.quality);
              else if (e.lanes && e.lanes.length) {
                for (var i = 0; i < e.lanes.length; i++) fireHit(e.lanes[i], e.quality);
              } else if (e.lane >= 0) fireHit(e.lane, e.quality);
            } else if (e.type === 'miss') {
              if (e.open) fireMiss(-1);
              else if (e.lanes && e.lanes.length) {
                for (var j = 0; j < e.lanes.length; j++) fireMiss(e.lanes[j]);
              } else if (e.lane >= 0) fireMiss(e.lane);
            } else if (e.type === 'sp') {
              if (e.action === 'start') setStarPower(true);
              else if (e.action === 'end') setStarPower(false);
            }
          } catch (err) { warn('scoringEvent', err); }
        });
      }
    });

    inited = true;
    return API;
  }

  function update(dt, t) {
    if (!inited) return;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;                  /* nao deixa um travamento explodir a animacao */
    elapsed += dt;
    songTime = (typeof t === 'number' && isFinite(t)) ? t : songTime;

    /* pulso global decai sempre; pulse() e o beat empurram para cima */
    pulseTarget = damp(pulseTarget, 0, 9.0, dt);
    pulseLevel = damp(pulseLevel, pulseTarget, pulseLevel < pulseTarget ? 32 : 6.5, dt);

    safe('starPower', function () { updateStarPower(dt); });
    safe('scroll', function () { updateScroll(dt); });
    safe('sync', function () { syncFromChart(songTime); });
    safe('input', readInput);
    safe('lanes', function () { updateLanes(dt); });
    safe('beatLines', function () { updateBeatLines(songTime); });
    safe('laneWindows', function () { updateLaneWindows(dt, songTime); });
    safe('frets', function () { updateFrets(dt, songTime); });
    safe('rails', function () { updateRails(dt); });
    safe('strike', function () { updateStrike(dt); });
    safe('decals', function () { updateDecals(dt, songTime); });
    safe('farFade', updateFarFade);
  }

  /* Flash que percorre a pista. intensity ~0.3 (beat) a ~1.6 (acorde perfeito). */
  function pulse(intensity) {
    if (!inited) return;
    var k = (typeof intensity === 'number' && isFinite(intensity)) ? clamp(intensity, 0, 2) : 0.5;
    pulseTarget = Math.min(1.15, pulseTarget + k * 0.72);
    if (k >= 0.22) spawnPulse(clamp(k, 0.2, 1.6));
  }

  function setTheme(name) {
    var t = resolveTheme(name);
    if (!t) return;
    theme = t;
    themeName = t.id || themeName;
    if (!inited) return;
    safe('repaint', repaint);
  }

  /* repinta as cores base a partir do tema (materiais e vertex colors ficam) */
  function repaint() {
    var i;
    if (deckMat) {
      var wood = tc('wood', 0x4a2a18).clone();
      var base = wood.lerp(C(0xffffff), 0.70).lerp(tc('highway', 0x150a20), 0.14);
      deckMat.userData.baseColor = base.clone();
      deckMat.color.copy(base);
    }
    var lineC = tc('laneLine', 0x7a3e9c);
    var edgeC = tc('highwayEdge', 0xff3d8a);
    for (i = 0; i < dividers.length; i++) {
      dividers[i].base = dividers[i].edge
        ? edgeC.clone().lerp(C(0xffffff), 0.32)
        : lineC.clone().lerp(C(0xd8c6ff), 0.55);
    }
    var inlayC = tc('inlay', 0xf0c486);
    if (inlayL) inlayL.base = inlayC.clone();
    if (inlayR) inlayR.base = inlayC.clone();
    for (i = 0; i < rails.length; i++) {
      rails[i].neonBase = edgeC.clone();
      rails[i].ledBase = tc('neon', 0x25e8ce).clone();
    }
    if (strike) {
      strike.edgeBase = edgeC.clone().lerp(C(0xffffff), 0.55);
      strike.glowBase = tc('accent', 0xffb03a).clone().lerp(C(0xffffff), 0.30);
    }
    var metalC = metalOf();
    for (i = 0; i < rails.length; i++) {
      if (rails[i].body && rails[i].body.material) {
        rails[i].body.material.color.copy(metalC).multiplyScalar(1.05);
      }
    }
    updateFarFade();
  }

  function setStarPower(on) {
    spOn = !!on;
    if (spOn) pulse(0.8);
  }

  /* --- API ADITIVA (usada pelo jogo real; opcional para os outros agentes) --- */

  function setLaneHeld(lane, on) {
    if (lane < 0 || lane >= LANES) return;
    laneHeld[lane] = !!on;
    if (on) laneHoldTarget[lane] = 1;
  }
  function hit(lane, quality) { fireHit(lane, quality); }
  function miss(lane) { fireMiss(lane); }

  function reset() {
    chartCursor = 0;
    chartSig = '';
    lwList = null;
    lwCur = -1;
    lwArrowK = -1;
    lwArrowA = 0;
    for (var pi = 0; pi < PULSE_MAX; pi++) { pulses[pi].active = false; pulses[pi].t = 0; }
    pulseLevel = pulseTarget = 0;
    spOn = false;
    for (var i = 0; i < LANES; i++) {
      laneHold[i] = laneHoldTarget[i] = laneHit[i] = laneMiss[i] = 0;
      laneHeld[i] = false;
      fretPress[i] = 0;
      fretBurst[i] = -1;
      if (frets[i]) { frets[i].burst.visible = false; frets[i].burstMat.opacity = 0; }
    }
  }

  function show() { if (group) group.visible = true; }
  function hide() { if (group) group.visible = false; }

  function dispose() {
    if (!inited) return;
    try { if (scene && group) scene.remove(group); } catch (e) { /* ok */ }
    var i;
    for (i = 0; i < ownedGeo.length; i++) { try { ownedGeo[i].dispose(); } catch (e) {} }
    for (i = 0; i < ownedMat.length; i++) { try { ownedMat[i].dispose(); } catch (e) {} }
    for (i = 0; i < ownedTex.length; i++) { try { ownedTex[i].dispose(); } catch (e) {} }
    ownedGeo.length = 0; ownedMat.length = 0; ownedTex.length = 0;
    laneBleed.length = 0; laneLit.length = 0; dividers.length = 0;
    beatPool.length = 0; barPool.length = 0; rails.length = 0;
    frets.length = 0; spEdge.length = 0; neonRefl.length = 0;
    deck = null; deckMat = null; strike = null; decals = null;
    lwShade = null; lwArrowSide = null; lwArrowFwd = null; lwList = null;
    spWash = null; spWashMat = null; farFade = null; farFadeMat = null;
    rivets = null; inlayL = null; inlayR = null;
    group = null;
    inited = false;
    API.group = null;
  }

  function activePulses() {
    var n = 0;
    for (var i = 0; i < PULSE_MAX; i++) if (pulses[i].active) n++;
    return n;
  }

  /* diagnostico: usado pelo integrador para conferir a cena sem olhar pixel */
  function stats() {
    return {
      inited: inited,
      objects: group ? group.children.length : 0,
      geometries: ownedGeo.length,
      materials: ownedMat.length,
      pulses: activePulses(),
      starPower: spLevel,
      pulseLevel: pulseLevel,
      lanes: laneHold.slice(),
      laneWindow: (lwList && lwCur >= 0) ? { index: lwCur, lo: lwList[lwCur].lo, hi: lwList[lwCur].hi,
                                             arrows: lwArrowK, arrowA: lwArrowA, act: laneAct.slice() } : null,
      theme: themeName,
      scroll: scrollDist
    };
  }

  var API = {
    /* contrato */
    init: init,
    update: update,
    group: null,
    pulse: pulse,
    setTheme: setTheme,
    setStarPower: setStarPower,
    /* aditivo */
    setLaneHeld: setLaneHeld,
    hit: hit,
    miss: miss,
    reset: reset,
    show: show,
    hide: hide,
    dispose: dispose,
    stats: stats,
    /* GH.Game respeita isto: false => o Game chama update() por frame */
    selfDriven: false,
    /* constantes uteis para outros agentes (notas/efeitos) */
    layout: {
      NEAR_Z: NEAR_Z, FAR_Z: FAR_Z,
      DECK_HW: DECK_HW, RAIL_W: RAIL_W, SHOULDER: SHOULDER,
      CROWN_R: CROWN_R, surfaceY: surfaceY,
      RING_RI: RING_RI, RING_RO: RING_RO,
      layers: Y
    }
  };

  GH.Highway = API;

})(window.GH = window.GH || {});

/* ============================================================================
 * GUITARRADA HERO — src/visual/materials.js
 * Dono: agente MATERIAIS.
 *
 * Missao: o jogo NAO pode parecer plastico. Aqui nascem TODAS as texturas
 * (canvas 2D, zero arquivo externo) e TODOS os materiais PBR reutilizaveis.
 *
 * Principios de producao usados neste arquivo:
 *   1. Tudo procedural e DETERMINISTICO. Cada gerador tem sua propria semente
 *      privada (mulberry32) — o modo captura exige que dois runs produzam
 *      exatamente os mesmos pixels.
 *   2. Ruido proprio, tileavel por construcao (lattice com wrap inteiro). Nao
 *      dependemos do range/tileabilidade do ruido de outro modulo para decidir
 *      valor de pixel; GH.Util e usado como acelerador quando existe e passa
 *      na validacao.
 *   3. Nada de "cor chapada": toda superficie tem variacao de larga escala
 *      (fbm), sujeira/poro de media escala e microdetalhe (risco/fibra).
 *   4. Normal map de verdade: Sobel sobre heightmap real, com wrap, convencao
 *      OpenGL (+Y para cima em espaco tangente) — que e a do three.js.
 *   5. Roughness e AO tambem procedurais e coerentes com o mesmo heightmap.
 *   6. Cache agressivo: uma textura nunca e gerada duas vezes. Geracao e
 *      preguicosa (getter) para nao custar boot em cena que nao usa a textura.
 *      E entre aberturas do jogo: ver secao 4B (IndexedDB).
 *
 * Carrega depois de: three.min.js, src/core/util.js, src/core/palette.js.
 * Nao usa nenhum outro modulo no topo do IIFE — so em runtime e com guarda.
 * ========================================================================== */
(function materialsModule(GH) {
  'use strict';

  /* ==========================================================================
   * 0. ESTADO DO MODULO
   * ======================================================================== */

  var renderer = null;          // WebGLRenderer, chega em init()
  var maxAniso = 8;             // atualizado com capabilities.getMaxAnisotropy()
  var initialized = false;
  var texScale = 1;             // multiplicador global de resolucao de textura
  var envRT = null;             // WebGLRenderTarget do PMREM
  var envMapTex = null;

  var allTextures = [];         // registro para disposeAll()
  var allMaterials = [];
  var texCache = {};            // nome -> THREE.Texture
  var canvasCache = {};         // nome -> canvas ou grupo de canvases
  var matCache = {};            // chave -> THREE.Material
  var paletteBound = [];        // materiais que sabem se repintar em setTheme

  var TAU = Math.PI * 2;

  /* Sementes fixas por gerador — mudar um numero aqui muda a arte daquele
   * gerador e de mais nada. Determinismo total entre execucoes. */
  var SEED = {
    noise: 1301, cloud: 1319, scratch: 1327, grunge: 1361, dust: 1373,
    brushed: 1409, wood: 1423, carbon: 1439, fret: 1447, hex: 1459,
    panel: 1471, crowd: 1483, flare: 1487, ring: 1489, sparkle: 1493,
    glow: 1499, streak: 1511, smoke: 1523, flame: 1531, shock: 1543,
    star: 1549, confetti: 1553, marajoara: 1559, azulejo: 1571,
    fabric: 1579, led: 1583, env: 1597
  };

  /* --------------------------------------------------------------------------
   * Pigmentos base. Sao "tintas" de textura, nao cores de UI/gameplay.
   * Se palette.js publicar GH.Palette.pigments, ele sobrescreve o que quiser.
   * ------------------------------------------------------------------------ */
  var PIG_DEFAULT = {
    steelLight: 0xc9ced8, steelMid: 0x8d939d, steelDark: 0x41464f,
    aluminum: 0xb6bcc6, nickel: 0xeceef2, nickelDark: 0x81858d,
    jacDark: 0x241612, jacMid: 0x53301f, jacLight: 0x8f5c31,
    jacViolet: 0x33202c, jacPore: 0x150c09,
    carbonBase: 0x090b0e, carbonSheen: 0x6e7885,
    panelBase: 0x1e2431, panelHi: 0x3d4860, panelLo: 0x0c0f15,
    ceramic: 0xf1e9d9, cobalt: 0x1d4a9e, cobaltDeep: 0x102c62,
    crowdDark: 0x05070d, dustWarm: 0xd6c9a4, rubberBase: 0x14161a,
    skyTop: 0x0a0c1c, skyHorizon: 0x2a1a2e, skyGround: 0x07080d
  };
  var PIG = {};
  (function () { for (var k in PIG_DEFAULT) { if (PIG_DEFAULT.hasOwnProperty(k)) PIG[k] = PIG_DEFAULT[k]; } })();

  /* Cores de raia de emergencia (verde, vermelho, amarelo, azul, laranja).
   * So sao usadas se GH.Palette ainda nao existir — palette.js manda. */
  var LANE_FALLBACK = [0x2fd35a, 0xff2d3c, 0xffd23a, 0x2a8cff, 0xff8a1f];

  /* ==========================================================================
   * 1. MATEMATICA, DETERMINISMO E RUIDO
   * ======================================================================== */

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) {
    if (e0 === e1) return x < e0 ? 0 : 1;
    var t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }
  function fract(x) { return x - Math.floor(x); }
  function imod(n, m) { var r = n % m; return r < 0 ? r + m : r; }

  /* mulberry32 — PRNG de 32 bits, rapido, sem estado global compartilhado. */
  function mulberry32(seed) {
    var a = (seed | 0) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Usa GH.Util.RNG quando ele existir E provar ser deterministico por
   * instancia (duas instancias com a mesma semente => mesma sequencia, todos
   * os valores em [0,1)). Se falhar em qualquer criterio, cai no mulberry32.
   * Isso honra o contrato sem terceirizar o determinismo das texturas. */
  var _rngProbe = 0; // 0 = nao testado, 1 = GH.Util ok, 2 = fallback
  function _adaptRNG(seed) {
    var U = GH.Util;
    if (!U || typeof U.RNG !== 'function') return null;
    var o = null;
    try { o = U.RNG(seed); } catch (e) { o = null; }
    if (!o) { try { o = new U.RNG(seed); } catch (e2) { o = null; } }
    if (!o) return null;
    if (typeof o === 'function') return o;
    if (typeof o.next === 'function') return function () { return o.next(); };
    if (typeof o.random === 'function') return function () { return o.random(); };
    if (typeof o.nextFloat === 'function') return function () { return o.nextFloat(); };
    return null;
  }
  function makeRNG(seed) {
    if (_rngProbe === 0) {
      _rngProbe = 2;
      var a = _adaptRNG(98765), b = _adaptRNG(98765), ok = !!(a && b), i;
      if (ok) {
        for (i = 0; i < 6; i++) {
          var va = a(), vb = b();
          if (typeof va !== 'number' || !isFinite(va) || va < 0 || va >= 1 || va !== vb) { ok = false; break; }
        }
      }
      if (ok) _rngProbe = 1;
    }
    if (_rngProbe === 1) {
      var r = _adaptRNG(seed);
      if (r) return r;
    }
    return mulberry32(seed);
  }

  /* Hash inteiro 2D -> [0,1). Base do ruido de valor tileavel. */
  function hash2i(x, y, seed) {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /* Ruido de valor com periodo INDEPENDENTE por eixo => textura tileavel
   * mesmo quando as frequencias em U e V sao diferentes (madeira, escovado). */
  function vn(x, y, px, py, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var x0 = imod(xi, px), x1 = imod(xi + 1, px);
    var y0 = imod(yi, py), y1 = imod(yi + 1, py);
    var a = hash2i(x0, y0, seed), b = hash2i(x1, y0, seed);
    var c = hash2i(x0, y1, seed), d = hash2i(x1, y1, seed);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }

  /* fbm tileavel: coordenada deve vir escalada pelo proprio periodo
   * (ex.: fbm(u*8, v*3, 8, 3, 4, seed) tem periodo exato em [0,1)). */
  function fbm(x, y, px, py, oct, seed, gain, lac) {
    gain = gain == null ? 0.5 : gain;
    lac = lac == null ? 2 : lac;
    var sum = 0, amp = 1, norm = 0, f = 1, i;
    for (i = 0; i < oct; i++) {
      sum += vn(x * f, y * f, Math.max(1, Math.round(px * f)), Math.max(1, Math.round(py * f)), seed + i * 131) * amp;
      norm += amp;
      amp *= gain;
      f *= lac;
    }
    return sum / (norm || 1);
  }

  /* fbm "ridged": cristas afiadas — bom para fumaca, chama e nervura. */
  function ridged(x, y, px, py, oct, seed) {
    var sum = 0, amp = 1, norm = 0, f = 1, i;
    for (i = 0; i < oct; i++) {
      var n = Math.abs(vn(x * f, y * f, Math.max(1, Math.round(px * f)), Math.max(1, Math.round(py * f)), seed + i * 71) * 2 - 1);
      sum += (1 - n) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / (norm || 1);
  }

  /* Adaptador opcional para GH.Util.noise2D — usado apenas em perturbacoes
   * organicas onde o range exato nao decide a leitura da textura. Normaliza
   * automaticamente ruidos que devolvem [-1,1]. */
  var _utilNoiseMode = 0; // 0 nao testado, 1 = [0,1], 2 = [-1,1], 3 = indisponivel
  function utilNoise(x, y) {
    var U = GH.Util;
    if (_utilNoiseMode === 0) {
      _utilNoiseMode = 3;
      if (U && typeof U.noise2D === 'function') {
        var mn = 1e9, mx = -1e9, i, v;
        try {
          for (i = 0; i < 96; i++) {
            v = U.noise2D(i * 0.37 + 0.11, i * 0.71 + 0.29);
            if (typeof v !== 'number' || !isFinite(v)) { mn = 1e9; break; }
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          if (mn < 1e8) _utilNoiseMode = (mn < -0.02) ? 2 : 1;
        } catch (e) { _utilNoiseMode = 3; }
      }
    }
    if (_utilNoiseMode === 3) return vn(x, y, 4096, 4096, 7717);
    var r = GH.Util.noise2D(x, y);
    if (!isFinite(r)) return 0.5;
    return _utilNoiseMode === 2 ? clamp01(r * 0.5 + 0.5) : clamp01(r);
  }

  /* Rampa de cor por paradas: stops = [[pos, [r,g,b]], ...] em 0..1. */
  function ramp(stops, t) {
    t = clamp01(t);
    var i;
    if (t <= stops[0][0]) return stops[0][1];
    for (i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i];
        var k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        return [lerp(a[1][0], b[1][0], k), lerp(a[1][1], b[1][1], k), lerp(a[1][2], b[1][2], k)];
      }
    }
    return stops[stops.length - 1][1];
  }

  function hex2rgb(hex) {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }
  function css(hex, alpha) {
    var r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    return alpha == null ? 'rgb(' + r + ',' + g + ',' + b + ')'
                         : 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }
  function cssRGB(rgb, alpha) {
    var r = Math.round(clamp01(rgb[0]) * 255), g = Math.round(clamp01(rgb[1]) * 255), b = Math.round(clamp01(rgb[2]) * 255);
    return alpha == null ? 'rgb(' + r + ',' + g + ',' + b + ')'
                         : 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }
  function gray(v, alpha) {
    var c = Math.round(clamp01(v) * 255);
    return alpha == null ? 'rgb(' + c + ',' + c + ',' + c + ')' : 'rgba(' + c + ',' + c + ',' + c + ',' + alpha + ')';
  }
  function mix3(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }

  /* ==========================================================================
   * 2. UTILIDADES DE CANVAS
   * ======================================================================== */

  /* Resolucao efetiva: base * texScale, arredondada para potencia de 2. */
  function px(base) {
    var v = Math.round(base * texScale);
    var p = 64;
    while (p * 2 <= v) p *= 2;
    return Math.max(32, p);
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, (h == null ? w : h) | 0);
    return c;
  }
  function ctx2d(cv, readFrequently) {
    var g = readFrequently ? cv.getContext('2d', { willReadFrequently: true }) : cv.getContext('2d');
    return g;
  }

  /* Desenha a mesma forma tambem do outro lado da borda quando ela vaza,
   * garantindo tileabilidade perfeita sem custo de 9x sempre. */
  function wrapPaint(g, W, H, bx0, bx1, by0, by1, paint) {
    var ox = [0], oy = [0], i, j;
    if (bx1 > W) ox.push(-W);
    if (bx0 < 0) ox.push(W);
    if (by1 > H) oy.push(-H);
    if (by0 < 0) oy.push(H);
    for (i = 0; i < ox.length; i++) {
      for (j = 0; j < oy.length; j++) {
        if (ox[i] === 0 && oy[j] === 0) { paint(g); continue; }
        g.save(); g.translate(ox[i], oy[j]); paint(g); g.restore();
      }
    }
  }

  /* Blur com ctx.filter (Chromium/Firefox). Fallback: down/upsample. */
  function blurCanvas(cv, radius) {
    if (!(radius > 0)) return cv;
    var out = makeCanvas(cv.width, cv.height), o = ctx2d(out);
    if (typeof o.filter === 'string') {
      o.filter = 'blur(' + radius + 'px)';
      o.drawImage(cv, 0, 0);
      o.filter = 'none';
      return out;
    }
    var s = Math.max(1, Math.round(1 / Math.max(1, radius) * cv.width));
    var tmp = makeCanvas(s, s), t = ctx2d(tmp);
    t.drawImage(cv, 0, 0, s, s);
    o.imageSmoothingEnabled = true;
    o.drawImage(tmp, 0, 0, cv.width, cv.height);
    return out;
  }

  /* Preenche um canvas pixel a pixel. fn(x, y, u, v) -> [r,g,b] (0..1) ou
   * [r,g,b,a]. Centraliza o custo de createImageData/putImageData. */
  function paintPixels(cv, fn) {
    var g = ctx2d(cv, true), W = cv.width, H = cv.height;
    var img = g.createImageData(W, H), d = img.data;
    var x, y, i = 0, c;
    for (y = 0; y < H; y++) {
      var v = y / H;
      for (x = 0; x < W; x++) {
        c = fn(x, y, x / W, v);
        d[i] = clamp01(c[0]) * 255;
        d[i + 1] = clamp01(c[1]) * 255;
        d[i + 2] = clamp01(c[2]) * 255;
        d[i + 3] = (c.length > 3 ? clamp01(c[3]) : 1) * 255;
        i += 4;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  /* Campo escalar -> canvas cinza (heightmap/roughness/AO). */
  function fieldToCanvas(field, W, H) {
    var cv = makeCanvas(W, H), g = ctx2d(cv, true);
    var img = g.createImageData(W, H), d = img.data;
    var i, n = W * H, c;
    for (i = 0; i < n; i++) {
      c = clamp01(field[i]) * 255;
      d[i * 4] = c; d[i * 4 + 1] = c; d[i * 4 + 2] = c; d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  /* Canvas -> campo de altura (luminancia perceptual em 0..1). */
  function canvasToField(cv) {
    var W = cv.width, H = cv.height;
    var d = ctx2d(cv, true).getImageData(0, 0, W, H).data;
    var f = new Float32Array(W * H), i, n = W * H;
    for (i = 0; i < n; i++) {
      f[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
    }
    return f;
  }

  /* Box blur separavel com wrap — usado no calculo de AO e no amaciamento
   * de heightmaps antes do Sobel (evita normal "serrilhada"). */
  function blurField(field, W, H, radius, passes) {
    if (!(radius > 0)) return field;
    passes = passes || 2;
    var tmp = new Float32Array(W * H), p, x, y, k, sum, row;
    var r = Math.max(1, radius | 0), inv = 1 / (r * 2 + 1);
    /* Soma corrente: cada pixel custa uma soma e uma subtracao, nao (2r+1)
     * leituras. Num heightmap 1024x1024 com raio 5 isso e a diferenca entre
     * ~44M e ~4M operacoes — e o que mantem o boot em segundos, nao dezenas. */
    for (p = 0; p < passes; p++) {
      // passada horizontal
      for (y = 0; y < H; y++) {
        row = y * W;
        sum = 0;
        for (k = -r; k <= r; k++) sum += field[row + imod(k, W)];
        for (x = 0; x < W; x++) {
          tmp[row + x] = sum * inv;
          sum += field[row + imod(x + r + 1, W)] - field[row + imod(x - r, W)];
        }
      }
      // passada vertical
      for (x = 0; x < W; x++) {
        sum = 0;
        for (k = -r; k <= r; k++) sum += tmp[imod(k, H) * W + x];
        for (y = 0; y < H; y++) {
          field[y * W + x] = sum * inv;
          sum += tmp[imod(y + r + 1, H) * W + x] - tmp[imod(y - r, H) * W + x];
        }
      }
    }
    return field;
  }

  /* ==========================================================================
   * 3. HEIGHT -> NORMAL / ROUGHNESS / AO  (obrigatorio pelo briefing)
   * ======================================================================== */

  /* Sobel 3x3 com amostragem wrap. Convencao OpenGL: n = (-dH/du, +dH/drow, 1)
   * — que e o que o three.js espera em normalMap de espaco tangente. */
  function normalCanvasFromField(field, W, H, strength) {
    strength = strength == null ? 1 : strength;
    var cv = makeCanvas(W, H), g = ctx2d(cv, true);
    var img = g.createImageData(W, H), d = img.data;
    var x, y, i = 0;
    var xm, xp, ym, yp, tl, t, tr, ml, mr, bl, b, br, gx, gy, nx, ny, nz, len;
    for (y = 0; y < H; y++) {
      ym = (y === 0 ? H - 1 : y - 1) * W;
      yp = (y === H - 1 ? 0 : y + 1) * W;
      var yc = y * W;
      for (x = 0; x < W; x++) {
        xm = (x === 0 ? W - 1 : x - 1);
        xp = (x === W - 1 ? 0 : x + 1);
        tl = field[ym + xm]; t = field[ym + x]; tr = field[ym + xp];
        ml = field[yc + xm]; mr = field[yc + xp];
        bl = field[yp + xm]; b = field[yp + x]; br = field[yp + xp];
        gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        nx = -gx * strength;
        ny = gy * strength;
        nz = 1;
        len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        d[i] = (nx / len * 0.5 + 0.5) * 255;
        d[i + 1] = (ny / len * 0.5 + 0.5) * 255;
        d[i + 2] = (nz / len * 0.5 + 0.5) * 255;
        d[i + 3] = 255;
        i += 4;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  /* AO barata e convincente: quanto mais o pixel esta abaixo da media da
   * vizinhanca, mais ocluido ele fica (cavidade). */
  function aoCanvasFromField(field, W, H, radius, power) {
    radius = radius || 6;
    power = power == null ? 1.6 : power;
    var blurred = new Float32Array(field);
    blurField(blurred, W, H, radius, 2);
    var out = new Float32Array(W * H), i, n = W * H, diff;
    for (i = 0; i < n; i++) {
      diff = (blurred[i] - field[i]) * 2.2;
      out[i] = clamp01(1 - Math.pow(clamp01(diff), 1 / power));
      out[i] = 0.25 + out[i] * 0.75;   // nunca preto puro: AO e multiplicativa
    }
    return fieldToCanvas(out, W, H);
  }

  /* ==========================================================================
   * 4. FABRICA E REGISTRO DE TEXTURAS
   * ======================================================================== */

  function hasTHREE() { return (typeof THREE !== 'undefined') && !!THREE.CanvasTexture; }

  function registerTexture(t) {
    if (t) allTextures.push(t);
    return t;
  }

  /* opts: { srgb, clamp, clampX, clampY, mips, aniso, name } */
  function texFromCanvas(cv, opts) {
    opts = opts || {};
    if (!hasTHREE()) return null;
    var t = new THREE.CanvasTexture(cv);
    var wrapX = (opts.clamp || opts.clampX) ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    var wrapY = (opts.clamp || opts.clampY) ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.wrapS = wrapX;
    t.wrapT = wrapY;
    t.encoding = opts.srgb ? THREE.sRGBEncoding : THREE.LinearEncoding;
    t.generateMipmaps = opts.mips !== false;
    t.minFilter = t.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = opts.aniso != null ? opts.aniso : maxAniso;
    t.name = opts.name || '';
    t.userData.ghOpts = opts;      /* o cache persistente remonta igual (4B) */
    t.needsUpdate = true;
    return registerTexture(t);
  }

  /* ==========================================================================
   * 4B. CACHE PERSISTENTE DAS TEXTURAS (IndexedDB)
   * Desenhar as ~46 texturas pixel a pixel custava ~1,2 s de CPU em TODA
   * abertura do jogo — a maior fatia do carregamento. Elas saem sempre
   * iguais, entao a primeira abertura guarda cada canvas pronto (WebP sem
   * perda, ~6 MB) e as seguintes so decodificam (~60 ms, fora da thread
   * principal). A chave e o hash do proprio codigo deste arquivo + a escala
   * de textura: qualquer mudanca aqui invalida o cache sozinha.
   * Sem IndexedDB (aba anonima restrita, file:// em outro navegador) tudo
   * continua como antes: gera na hora.
   * ======================================================================== */

  var TEXDB = 'gh-texcache', TEXSTORE = 'tex';
  var texPre = {};              // nome -> { bm: ImageBitmap, opts, key } lidos nesta abertura
  var texMade = [];             // nomes gerados do zero nesta abertura (a guardar)
  var texSrcHash = '';

  function hashStr(s) {         // FNV-1a 32 bits
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  function texCacheKey() {
    if (!texSrcHash) {
      try { texSrcHash = hashStr(String(materialsModule)); } catch (e) { texSrcHash = 'x'; }
    }
    return texSrcHash + '@' + texScale;
  }

  function openTexDB(cb) {
    var called = false;
    function once(db) { if (!called) { called = true; cb(db); } }
    try {
      if (!window.indexedDB || typeof createImageBitmap !== 'function') return once(null);
      var rq = window.indexedDB.open(TEXDB, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore(TEXSTORE); };
      rq.onsuccess = function () { once(rq.result); };
      rq.onerror = function () { once(null); };
      rq.onblocked = function () { once(null); };
    } catch (e) { once(null); }
  }

  /* Le o cache desta versao e ja decodifica as imagens. done() e chamado
     exatamente uma vez, aconteca o que acontecer. */
  function prefetchTextures(done) {
    var ended = false;
    function end() { if (ended) return; ended = true; try { if (done) done(); } catch (e) { /* ok */ } }
    var key = texCacheKey();
    openTexDB(function (db) {
      if (!db) return end();
      try {
        var rq = db.transaction(TEXSTORE, 'readonly').objectStore(TEXSTORE).getAll();
        rq.onsuccess = function () {
          var rows = rq.result || [], jobs = [];
          rows.forEach(function (r) {
            if (!r || r.key !== key || !r.blob || !GENERATORS[r.name] || texCache[r.name]) return;
            jobs.push(createImageBitmap(r.blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
              .then(function (bm) { texPre[r.name] = { bm: bm, opts: r.opts || {}, key: key }; }, function () { /* gera */ }));
          });
          Promise.all(jobs).then(end, end);
        };
        rq.onerror = end;
      } catch (e) { end(); }
    });
  }

  /* Textura vinda do cache, ou null (ai o gerador roda normalmente). */
  function textureFromCache(name) {
    var pre = texPre[name];
    if (!pre) return null;
    delete texPre[name];
    var t = null;
    if (pre.key === texCacheKey()) {
      try {
        var cv = makeCanvas(pre.bm.width, pre.bm.height);
        ctx2d(cv).drawImage(pre.bm, 0, 0);
        t = texFromCanvas(cv, pre.opts);
      } catch (e) { t = null; }
    }
    try { pre.bm.close(); } catch (e2) { /* ok */ }
    return t;
  }

  /* Guarda as texturas geradas do zero nesta abertura. O boot chama isto
     depois que o titulo ja apareceu; com musica tocando, espera. A codificacao
     (WebP sem perda) roda fora da thread principal e tudo vai numa escrita
     so. A loja e indexada pelo nome: uma versao nova sobrescreve a velha. */
  function saveTextureCache() {
    if (!texMade.length) return;
    var st = GH.Game && GH.Game.state;
    if (st === 'playing' || st === 'countdown') { setTimeout(saveTextureCache, 3000); return; }
    var key = texCacheKey(), names = texMade.splice(0);
    Promise.all(names.map(function (n) {
      var t = texCache[n], cv = t && t.image;
      if (!cv || typeof cv.toBlob !== 'function') return null;
      return new Promise(function (res) {
        try { cv.toBlob(function (b) { res(b ? { name: n, key: key, blob: b, opts: t.userData.ghOpts || {} } : null); }, 'image/webp', 1); }
        catch (e) { res(null); }
      });
    })).then(function (rows) {
      openTexDB(function (db) {
        if (!db) return;
        try {
          var os = db.transaction(TEXSTORE, 'readwrite').objectStore(TEXSTORE);
          rows.forEach(function (r) { if (r) os.put(r, r.name); });
        } catch (e) { /* cota cheia ou modo privado: fica sem cache */ }
      });
    });
  }

  /* Clone leve: compartilha o canvas, permite repeat/offset independentes. */
  function cloneTex(t) {
    if (!t) return null;
    var c = t.clone();
    c.needsUpdate = true;
    return registerTexture(c);
  }

  /* Textura de emergencia 4x4 branca: um gerador que exploda nunca leva o
   * jogo para a tela preta. */
  var _fallbackTex = null;
  function fallbackTexture() {
    if (_fallbackTex) return _fallbackTex;
    var cv = makeCanvas(4, 4), g = ctx2d(cv);
    g.fillStyle = '#808080'; g.fillRect(0, 0, 4, 4);
    _fallbackTex = texFromCanvas(cv, { name: 'fallback' });
    return _fallbackTex;
  }

  /* Cache de canvases intermediarios (compartilhados entre geradores:
   * o escovado usa os riscos, o painel usa o grunge, etc.). */
  function cachedCanvas(name, build) {
    if (canvasCache[name]) return canvasCache[name];
    var c = build();
    canvasCache[name] = c;
    return c;
  }

  /* ==========================================================================
   * 5. GERADORES — RUIDO, SUJEIRA E MICRODETALHE
   * ======================================================================== */

  /* noise: textura de dados de 4 canais para uso em shader/overlay.
   * R = ruido branco (grao de filme), G = valor medio (macro), B = fbm suave,
   * A = fbm deslocado (mascara secundaria). Linear, nunca sRGB. */
  function buildNoiseCanvas() {
    var S = px(512), cv = makeCanvas(S, S);
    return paintPixels(cv, function (x, y, u, v) {
      var white = hash2i(x, y, SEED.noise);
      var mid = vn(u * 32, v * 32, 32, 32, SEED.noise + 1);
      var soft = fbm(u * 8, v * 8, 8, 8, 4, SEED.noise + 2);
      var alt = fbm(u * 16 + 3.7, v * 16 + 1.3, 16, 16, 3, SEED.noise + 3);
      return [white, mid, soft, alt];
    });
  }

  /* noiseFine: grao apertado de alta frequencia. Serve de "quebra-banding"
   * em superficies grandes e de dither em gradientes. */
  function buildNoiseFineCanvas() {
    var S = px(256), cv = makeCanvas(S, S);
    return paintPixels(cv, function (x, y) {
      var n = hash2i(x, y, SEED.noise + 91);
      var n2 = hash2i(x >> 1, y >> 1, SEED.noise + 92);
      var g = 0.5 + (n - 0.5) * 0.9 + (n2 - 0.5) * 0.35;
      return [g, g, g, 1];
    });
  }

  /* microRelief: heightmap de "casca de laranja" — ondulacao suave de escala
   * milimetrica. NUNCA use ruido branco como normalMap: os tres canais viram
   * direcoes aleatorias e o resultado e chuvisco, nao superficie. O caminho
   * certo e este: altura suave -> Sobel -> normal. */
  function buildMicroReliefCanvas() {
    var S = px(256), cv = makeCanvas(S, S);
    return paintPixels(cv, function (x, y, u, v) {
      var a = fbm(u * 24, v * 24, 24, 24, 3, SEED.noise + 41);
      var b = fbm(u * 60, v * 60, 60, 60, 2, SEED.noise + 43);
      var g = clamp01(0.5 + (a - 0.5) * 0.85 + (b - 0.5) * 0.35);
      return [g, g, g, 1];
    });
  }

  /* fbmCloud: nuvem billowy com cristas — base de fumaca, haze e dissolucao.
   * Mistura fbm (massa) com ridged (fiapo) e aplica curva de contraste. */
  function buildCloudCanvas() {
    var S = px(512), cv = makeCanvas(S, S);
    return paintPixels(cv, function (x, y, u, v) {
      var base = fbm(u * 4, v * 4, 4, 4, 6, SEED.cloud);
      var rid = ridged(u * 8, v * 8, 8, 8, 4, SEED.cloud + 17);
      var m = clamp01(base * 0.72 + rid * 0.38 - 0.12);
      m = smoothstep(0.12, 0.9, m);
      var wisp = fbm(u * 24, v * 24, 24, 24, 3, SEED.cloud + 33);
      var g = clamp01(m * (0.72 + wisp * 0.5));
      return [g, g, g, g];
    });
  }

  /* scratches: riscos finos ANISOTROPICOS (quase horizontais) — e o que faz
   * metal escovado e verniz parecerem usados de verdade em vez de renderizados.
   * Curvatura leve, larguras sub-pixel e alfa em cauda longa. */
  function buildScratchCanvas() {
    var S = px(1024), cv = makeCanvas(S, S), g = ctx2d(cv);
    var rng = makeRNG(SEED.scratch);
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    g.lineCap = 'round';
    g.globalCompositeOperation = 'lighter';

    function stroke(count, lenMin, lenMax, angJit, wMin, wMax, aMax, bowAmt) {
      var i;
      for (i = 0; i < count; i++) {
        var x0 = rng() * S, y0 = rng() * S;
        var len = lenMin + Math.pow(rng(), 2.1) * (lenMax - lenMin);
        var ang = (rng() - 0.5) * angJit;
        var w = wMin + Math.pow(rng(), 3) * (wMax - wMin);
        var a = 0.03 + Math.pow(rng(), 2.4) * aMax;
        var bow = (rng() - 0.5) * bowAmt;
        var dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
        var mx = x0 + dx * 0.5 - Math.sin(ang) * bow;
        var my = y0 + dy * 0.5 + Math.cos(ang) * bow;
        g.strokeStyle = 'rgba(255,255,255,' + a.toFixed(4) + ')';
        g.lineWidth = w;
        var bx0 = Math.min(x0, mx, x0 + dx) - w, bx1 = Math.max(x0, mx, x0 + dx) + w;
        var by0 = Math.min(y0, my, y0 + dy) - w, by1 = Math.max(y0, my, y0 + dy) + w;
        wrapPaint(g, S, S, bx0, bx1, by0, by1, function (c) {
          c.beginPath();
          c.moveTo(x0, y0);
          c.quadraticCurveTo(mx, my, x0 + dx, y0 + dy);
          c.stroke();
        });
      }
    }

    // 1) polimento longo, quase paralelo — direcao dominante do escovado
    stroke(900, S * 0.06, S * 0.9, 0.09, 0.4, 1.7, 0.34, 7);
    // 2) riscos medios com mais inclinacao — quebram a monotonia
    stroke(320, S * 0.03, S * 0.28, 0.42, 0.5, 2.2, 0.28, 16);
    // 3) arranhoes profundos e raros — leitura de "objeto que viveu"
    stroke(26, S * 0.10, S * 0.55, 0.85, 1.2, 3.4, 0.55, 34);
    // 4) micro cross-hatch quase vertical — evita padrao 100% direcional
    stroke(180, S * 0.01, S * 0.06, TAU * 0.5, 0.35, 1.0, 0.16, 3);

    g.globalCompositeOperation = 'source-over';
    return cv;
  }

  /* grunge: sujeira multi-escala. Manchas grandes (acumulo), granulacao media
   * (poeira presa) e respingos pequenos. Branco = sujo. */
  function buildGrungeCanvas() {
    var S = px(512), cv = makeCanvas(S, S);
    paintPixels(cv, function (x, y, u, v) {
      var macro = fbm(u * 3, v * 3, 3, 3, 5, SEED.grunge);
      var meso = fbm(u * 11, v * 11, 11, 11, 4, SEED.grunge + 7);
      var micro = fbm(u * 47, v * 47, 47, 47, 2, SEED.grunge + 13);
      var stain = smoothstep(0.52, 0.82, macro) * 0.85;
      var film = smoothstep(0.35, 0.78, meso) * 0.45;
      var spec = smoothstep(0.74, 0.93, micro) * 0.5;
      var d = clamp01(stain + film * 0.7 + spec * 0.5);
      // leve tinta quente: poeira tropical puxa para o ocre
      var t = hex2rgb(PIG.dustWarm);
      var c = mix3([d, d, d], [d * t[0], d * t[1], d * t[2]], 0.45);
      return [c[0], c[1], c[2], d];
    });
    // respingos duros por cima (pontos de sujeira colada)
    var g = ctx2d(cv), rng = makeRNG(SEED.grunge + 101), i;
    for (i = 0; i < 700; i++) {
      var r = 0.4 + Math.pow(rng(), 3) * 3.4;
      var x = rng() * S, y = rng() * S;
      var a = 0.06 + Math.pow(rng(), 2) * 0.5;
      g.fillStyle = gray(0.85, a);
      wrapPaint(g, S, S, x - r, x + r, y - r, y + r, function (c) {
        c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      });
    }
    return cv;
  }

  /* dust: motas de poeira em fundo transparente. Usada como overlay de lente,
   * particula volumetrica e "cheirinho" de haze na frente da camera. */
  function buildDustCanvas() {
    var S = px(512), cv = makeCanvas(S, S), g = ctx2d(cv);
    var rng = makeRNG(SEED.dust), i;
    g.clearRect(0, 0, S, S);
    g.globalCompositeOperation = 'lighter';
    for (i = 0; i < 900; i++) {
      var x = rng() * S, y = rng() * S;
      var r = 0.6 + Math.pow(rng(), 3.4) * 5.5;
      var a = 0.05 + Math.pow(rng(), 2.6) * 0.65;
      var warm = rng() < 0.35;
      var grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, warm ? 'rgba(255,240,214,' + a.toFixed(3) + ')' : 'rgba(255,255,255,' + a.toFixed(3) + ')');
      grd.addColorStop(0.45, 'rgba(255,246,230,' + (a * 0.35).toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      wrapPaint(g, S, S, x - r, x + r, y - r, y + r, function (c) {
        c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      });
    }
    // alguns fiapos maiores e desfocados (poeira perto da lente)
    for (i = 0; i < 40; i++) {
      var bx = rng() * S, by = rng() * S, br = 6 + rng() * 22;
      var ba = 0.02 + rng() * 0.07;
      var bg = g.createRadialGradient(bx, by, 0, bx, by, br);
      bg.addColorStop(0, 'rgba(255,250,238,' + ba.toFixed(3) + ')');
      bg.addColorStop(1, 'rgba(255,250,238,0)');
      g.fillStyle = bg;
      wrapPaint(g, S, S, bx - br, bx + br, by - br, by + br, function (c) {
        c.beginPath(); c.arc(bx, by, br, 0, TAU); c.fill();
      });
    }
    g.globalCompositeOperation = 'source-over';
    return cv;
  }

  /* ==========================================================================
   * 6. METAL ESCOVADO (cor + normal + roughness)
   * ======================================================================== */

  /* O escovado real e um campo de sulcos paralelos: quase constante ao longo
   * da direcao da escova (U) e muito ruidoso na perpendicular (V). Derivamos
   * cor, altura e rugosidade do MESMO campo para que brilho, relevo e
   * aspereza concordem — e o que separa metal de plastico cinza. */
  function buildBrushedSet() {
    /* 512 basta: metal escovado aparece em aros, trilhos e ferragens — nunca
     * ocupa a tela inteira como a pista. Com anisotropia 16 o sulco continua
     * legivel em angulo rasante. */
    var S = px(512);
    var field = new Float32Array(S * S);
    var x, y, i = 0;
    for (y = 0; y < S; y++) {
      var v = y / S;
      // tres escalas de sulco na perpendicular
      var g1 = vn(0, v * 512, 4, 512, SEED.brushed);
      var g2 = vn(0, v * 160, 4, 160, SEED.brushed + 3);
      var g3 = vn(0, v * 44, 4, 44, SEED.brushed + 5);
      var rowBase = g1 * 0.42 + g2 * 0.34 + g3 * 0.24;
      for (x = 0; x < S; x++) {
        var u = x / S;
        // ondulacao lenta ao longo da escova: o sulco nao e perfeitamente reto
        var wob = vn(u * 6, v * 96, 6, 96, SEED.brushed + 11) - 0.5;
        var macro = fbm(u * 3, v * 3, 3, 3, 4, SEED.brushed + 19);
        field[i++] = clamp01(rowBase * 0.78 + wob * 0.18 + (macro - 0.5) * 0.22 + 0.11);
      }
    }

    // --- cor ---
    var steelL = hex2rgb(PIG.steelLight), steelM = hex2rgb(PIG.steelMid), steelD = hex2rgb(PIG.steelDark);
    var color = makeCanvas(S, S);
    paintPixels(color, function (xx, yy) {
      var f = field[yy * S + xx];
      var c = f < 0.5 ? mix3(steelD, steelM, f * 2) : mix3(steelM, steelL, (f - 0.5) * 2);
      return [c[0], c[1], c[2], 1];
    });
    // microrriscos por cima em modo screen: brilho fino e anisotropico
    var cg = ctx2d(color);
    cg.globalAlpha = 0.16;
    cg.globalCompositeOperation = 'screen';
    cg.drawImage(cachedCanvas('scratch', buildScratchCanvas), 0, 0, S, S);
    // sujeira leve em multiply: tira o "novo de fabrica"
    cg.globalAlpha = 0.14;
    cg.globalCompositeOperation = 'multiply';
    cg.drawImage(cachedCanvas('grunge', buildGrungeCanvas), 0, 0, S, S);
    cg.globalAlpha = 1;
    cg.globalCompositeOperation = 'source-over';

    // --- altura: mesmo campo, suavizado, mais os riscos como sulcos ---
    var hf = new Float32Array(S * S);
    var scratchField = canvasToField(cachedCanvas('scratch', buildScratchCanvas));
    var sw = Math.sqrt(scratchField.length) | 0;
    for (i = 0; i < S * S; i++) {
      var sx = (i % S) * sw / S | 0, sy = (i / S | 0) * sw / S | 0;
      hf[i] = clamp01(0.5 + (field[i] - 0.5) * 0.55 - scratchField[sy * sw + sx] * 0.30);
    }
    blurField(hf, S, S, 1, 1);

    // --- roughness: fundo de sulco espalha mais luz que a crista ---
    var rf = new Float32Array(S * S);
    for (i = 0; i < S * S; i++) {
      rf[i] = clamp01(0.20 + (1 - field[i]) * 0.26 + scratchField[((i / S | 0) * sw / S | 0) * sw + ((i % S) * sw / S | 0)] * 0.24);
    }

    return {
      color: color,
      normal: normalCanvasFromField(hf, S, S, 1.15),
      rough: fieldToCanvas(rf, S, S),
      height: fieldToCanvas(hf, S, S)
    };
  }

  /* ==========================================================================
   * 7. MADEIRA NOBRE — JACARANDA / IMBUIA (cor + normal + roughness)
   * ======================================================================== */

  /* Jacaranda-da-bahia: fundo chocolate quase preto, veio violaceo, faixas
   * douradas da imbuia e POROS abertos (a marca registrada dessa madeira).
   * O veio corre ao longo de V — como o braco de uma guitarra. O verniz nao
   * esta aqui: ele e clearcoat no material, que e o jeito fisicamente certo. */
  function buildWoodSet() {
    /* 512: a madeira veste cenario e instrumentos, sempre em area media.
     * O poro continua visivel porque a frequencia do poro acompanha a
     * resolucao (e definida em unidades de UV, nao em pixels). */
    var S = px(512);
    var cDark = hex2rgb(PIG.jacDark), cMid = hex2rgb(PIG.jacMid);
    var cLight = hex2rgb(PIG.jacLight), cViolet = hex2rgb(PIG.jacViolet);
    var cPore = hex2rgb(PIG.jacPore);
    var hf = new Float32Array(S * S);
    var rf = new Float32Array(S * S);

    var color = makeCanvas(S, S);
    paintPixels(color, function (x, y, u, v) {
      // Warp de dominio: faz o anel serpentear como madeira serrada de verdade
      var w1 = fbm(u * 4, v * 2, 4, 2, 3, SEED.wood) - 0.5;
      var w2 = fbm(u * 13, v * 5, 13, 5, 2, SEED.wood + 9) - 0.5;

      // 17 aneis no eixo U (inteiro => tileavel), veio correndo ao longo de V
      var rings = u * 17 + w1 * 3.1 + w2 * 0.85;
      var f = fract(rings);
      // latewood: banda escura estreita e assimetrica (borda dura de um lado)
      var band = Math.pow(Math.max(0, Math.sin(f * Math.PI)), 7);
      var hard = smoothstep(0.02, 0.16, f) * (1 - smoothstep(0.55, 0.72, f));

      // faixas violaceas longas — assinatura do jacaranda
      var streak = smoothstep(0.66, 0.94, fbm(u * 52, v * 6, 52, 6, 2, SEED.wood + 21));
      // figura/chatoyance: brilho ondulante perpendicular ao veio
      var fig = 0.5 + 0.5 * Math.sin(v * TAU * 5 + w1 * 5.5);
      // poros: pontos alongados na direcao do veio
      var poreN = fbm(u * 150, v * 34, 150, 34, 2, SEED.wood + 37);
      var pore = smoothstep(0.70, 0.87, poreN);

      var base = clamp01(0.30 + fbm(u * 7, v * 3, 7, 3, 2, SEED.wood + 51) * 0.7);
      var c = mix3(cDark, cMid, base);
      c = mix3(c, cLight, clamp01(fig * 0.30 * (1 - band)));
      c = mix3(c, cViolet, streak * 0.62);
      c = mix3(c, cDark, band * 0.72 + hard * 0.18);
      c = mix3(c, cPore, pore * 0.85);

      var idx = y * S + x;
      // poro fundo, anel levemente rebaixado, resto plano
      hf[idx] = clamp01(0.72 - pore * 0.62 - band * 0.16 - streak * 0.06);
      // o verniz preenche menos os poros => poro mais fosco
      rf[idx] = clamp01(0.18 + pore * 0.52 + band * 0.10 + (1 - fig) * 0.05);
      return [c[0], c[1], c[2], 1];
    });

    blurField(hf, S, S, 1, 1);
    return {
      color: color,
      normal: normalCanvasFromField(hf, S, S, 1.9),
      rough: fieldToCanvas(rf, S, S),
      height: fieldToCanvas(hf, S, S)
    };
  }

  /* ==========================================================================
   * 8. FIBRA DE CARBONO (bordas da pista) e TECIDO
   * ======================================================================== */

  /* Trama sarja 2x2 de verdade: os feixes passam por cima em diagonal.
   * Cada feixe tem perfil arredondado (brilho no centro), estrias finas de
   * fibra individual e sombra de contato na juncao. */
  function buildCarbonSet() {
    var S = px(512);
    var T = S / 16;                      // 16 feixes por lado: trama fina, de peca real
    var base = hex2rgb(PIG.carbonBase), sheen = hex2rgb(PIG.carbonSheen);
    var hf = new Float32Array(S * S), rf = new Float32Array(S * S);

    var color = makeCanvas(S, S);
    paintPixels(color, function (x, y, u, v) {
      var cx = Math.floor(x / T), cy = Math.floor(y / T);
      var twill = imod(cx - cy, 4);      // sarja 2x2: corridas de 2 celulas
      var horizTop = twill < 2;
      var lx = (x % T) / T, ly = (y % T) / T;
      var perp = horizTop ? ly : lx;     // atravessa a largura do feixe
      // posicao AO LONGO da corrida de 2 celulas: e aqui que o feixe mergulha
      var runPos = ((twill % 2) + (horizTop ? lx : ly)) * 0.5;

      // perfil cilindrico na largura
      var prof = Math.sin(clamp01(perp) * Math.PI);
      var round = Math.pow(prof, 0.62);
      // mergulho: nas pontas da corrida o feixe passa por baixo do outro
      var dip = 0.62 + 0.38 * Math.sin(clamp01(runPos) * Math.PI);
      // estrias: filamentos paralelos a fibra
      var fib = 0.5 + 0.5 * Math.sin(perp * Math.PI * 13);
      var fibN = vn(u * 96, v * 96, 96, 96, SEED.carbon);
      // anisotropia: o feixe horizontal e o vertical devolvem luz diferente
      var aniso = horizTop ? 1.0 : 0.62;
      var spec = Math.pow(round, 2.8) * aniso * dip;

      var c = mix3(base, sheen, clamp01(spec * 1.05 + fib * 0.05 * round + (fibN - 0.5) * 0.05));
      // sombra de contato na borda do feixe e na entrada do mergulho
      var edge = smoothstep(0.36, 0.0, prof);
      c = mix3(c, [0, 0, 0], clamp01(edge * 0.85 + (1 - dip) * 0.35));

      var idx = y * S + x;
      hf[idx] = clamp01(0.30 + round * dip * 0.58 - edge * 0.20);
      rf[idx] = clamp01(0.20 + (1 - round) * 0.28 + (1 - dip) * 0.10 + fib * 0.03);
      return [c[0], c[1], c[2], 1];
    });

    blurField(hf, S, S, 1, 1);
    return {
      color: color,
      normal: normalCanvasFromField(hf, S, S, 2.2),
      rough: fieldToCanvas(rf, S, S)
    };
  }

  /* Tecido: trama simples (over/under alternado) com fiapo. Branco, para ser
   * tingido pelo material — usado com sheen no MeshPhysicalMaterial, que e o
   * que da o veludo/cetim das cortinas e capas do palco. */
  function buildFabricSet() {
    var S = px(512);
    var T = S / 32;                      // fios finos
    var hf = new Float32Array(S * S);

    var color = makeCanvas(S, S);
    paintPixels(color, function (x, y, u, v) {
      var cx = Math.floor(x / T), cy = Math.floor(y / T);
      var horizTop = imod(cx + cy, 2) === 0;
      var lx = (x % T) / T, ly = (y % T) / T;
      var perp = horizTop ? ly : lx;
      var prof = Math.sin(clamp01(perp) * Math.PI);
      // fiapo/pelo: ruido alto que quebra a regularidade do tecido
      var fuzz = fbm(u * 128, v * 128, 128, 128, 2, SEED.fabric);
      var slub = fbm(u * 9, v * 9, 9, 9, 3, SEED.fabric + 5);  // irregularidade do fio
      var lum = 0.62 + prof * 0.30 + (fuzz - 0.5) * 0.18 + (slub - 0.5) * 0.12;
      lum = clamp01(lum * (horizTop ? 1.0 : 0.93));
      hf[y * S + x] = clamp01(0.4 + prof * 0.45 + (fuzz - 0.5) * 0.12);
      return [lum, lum, lum, 1];
    });

    blurField(hf, S, S, 1, 1);
    return { color: color, normal: normalCanvasFromField(hf, S, S, 1.4) };
  }

  /* ==========================================================================
   * 9. TRASTE — NIQUEL-PRATA COM DESGASTE
   * ======================================================================== */

  /* Traste de guitarra: liga niquel-prata (levemente quente, nao branca),
   * polida longitudinalmente, com covinhas de corda, oxidacao nos vales e
   * areas espelhadas onde a mao passou mil vezes. */
  function buildFretSet() {
    var S = px(512);
    var nk = hex2rgb(PIG.nickel), nkD = hex2rgb(PIG.nickelDark);
    var hf = new Float32Array(S * S), rf = new Float32Array(S * S);

    var color = makeCanvas(S, S);
    paintPixels(color, function (x, y, u, v) {
      // polimento longitudinal: variacao forte em V, quase nula em U
      var pol = vn(u * 3, v * 220, 3, 220, SEED.fret) * 0.6 + vn(u * 2, v * 70, 2, 70, SEED.fret + 3) * 0.4;
      // patina/oxidacao em manchas largas
      var tarn = smoothstep(0.55, 0.86, fbm(u * 5, v * 5, 5, 5, 4, SEED.fret + 11));
      // zonas espelhadas de uso (onde a corda pressiona)
      var worn = smoothstep(0.42, 0.72, fbm(u * 3.5 + 2.1, v * 3.5, 4, 4, 3, SEED.fret + 17));
      // covinhas: marcas de corda
      var dent = smoothstep(0.80, 0.95, fbm(u * 60, v * 26, 60, 26, 2, SEED.fret + 23));

      var lum = 0.52 + pol * 0.46 + worn * 0.20 - tarn * 0.16 - dent * 0.20;
      var c = mix3(nkD, nk, clamp01(lum));
      // patina: escurece de leve e puxa para o palha, sem virar marmore
      c = mix3(c, [c[0] * 0.86, c[1] * 0.84, c[2] * 0.76], tarn * 0.45);

      var idx = y * S + x;
      hf[idx] = clamp01(0.62 + pol * 0.12 - dent * 0.55 - tarn * 0.06);
      rf[idx] = clamp01(0.08 + tarn * 0.34 + dent * 0.30 - worn * 0.05);
      return [c[0], c[1], c[2], 1];
    });

    blurField(hf, S, S, 1, 1);
    return {
      color: color,
      normal: normalCanvasFromField(hf, S, S, 1.5),
      rough: fieldToCanvas(rf, S, S)
    };
  }

  /* ==========================================================================
   * 10. GRADE HEXAGONAL E PAINEL TECNOLOGICO
   * ======================================================================== */

  /* Colmeia tecnologica. A rede usa passo 64 em X e 128 em Y (duas fileiras),
   * ambos divisores de 512 => tileavel exato. Hexagonos levemente encolhidos
   * criam a canaleta escura entre celulas. */
  function buildHexCanvas() {
    var S = px(512), cv = makeCanvas(S, S), g = ctx2d(cv);
    var stepX = S / 8, stepY = S / 4, rng = makeRNG(SEED.hex);
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);

    function hexPath(c, cx, cy, rx, ry) {
      var i, a;
      c.beginPath();
      for (i = 0; i < 6; i++) {
        a = TAU * (i / 6) + Math.PI / 6;
        var px2 = cx + Math.cos(a) * rx, py2 = cy + Math.sin(a) * ry;
        if (i === 0) c.moveTo(px2, py2); else c.lineTo(px2, py2);
      }
      c.closePath();
    }

    var rx = stepX * 0.52, ry = stepY * 0.30;
    var row, col;
    for (row = -1; row <= 4; row++) {
      for (col = -1; col <= 8; col++) {
        var cx = col * stepX + (imod(row, 2) ? stepX * 0.5 : 0);
        var cy = row * stepY * 0.5;
        var lit = rng();
        // celula: fundo levemente iluminado, contorno mais claro
        var fillV = 0.05 + (lit < 0.10 ? 0.30 : lit < 0.28 ? 0.13 : 0.05);
        wrapPaint(g, S, S, cx - rx - 3, cx + rx + 3, cy - ry - 3, cy + ry + 3, function (c) {
          hexPath(c, cx, cy, rx, ry);
          c.fillStyle = gray(fillV);
          c.fill();
          c.lineWidth = 1.6;
          c.strokeStyle = gray(0.42 + (lit < 0.10 ? 0.45 : 0));
          c.stroke();
          // chanfro interno
          hexPath(c, cx, cy, rx * 0.82, ry * 0.82);
          c.lineWidth = 1;
          c.strokeStyle = gray(0.16);
          c.stroke();
        });
      }
    }
    return cv;
  }

  /* Subdivisao recursiva em paineis. Como os cortes respeitam as bordas do
   * canvas, o resultado casa perfeitamente no tile. */
  function splitRect(list, x, y, w, h, depth, rng, minSize) {
    if (depth <= 0 || (w < minSize * 2 && h < minSize * 2) || rng() < 0.16) {
      list.push({ x: x, y: y, w: w, h: h });
      return;
    }
    var horiz = (w >= h) ? true : false;
    if (Math.abs(w - h) < minSize * 0.5) horiz = rng() < 0.5;
    var t = 0.32 + rng() * 0.36;
    if (horiz) {
      var cw = Math.round(w * t / 8) * 8;
      cw = clamp(cw, minSize, w - minSize);
      splitRect(list, x, y, cw, h, depth - 1, rng, minSize);
      splitRect(list, x + cw, y, w - cw, h, depth - 1, rng, minSize);
    } else {
      var ch = Math.round(h * t / 8) * 8;
      ch = clamp(ch, minSize, h - minSize);
      splitRect(list, x, y, w, ch, depth - 1, rng, minSize);
      splitRect(list, x, y + ch, w, h - ch, depth - 1, rng, minSize);
    }
  }

  /* techPanel: a superficie da pista. Paineis de compensado tecnico escuro com
   * chanfro, parafusos, grelhas e junta rebaixada. Escuro de proposito: a
   * pista e o fundo contra o qual as gems precisam gritar. Cor, altura,
   * rugosidade e AO saem todos da mesma construcao geometrica. */
  function buildPanelSet() {
    var S = px(1024);
    var cv = makeCanvas(S, S), g = ctx2d(cv, true);
    var hv = makeCanvas(S, S), hg = ctx2d(hv, true);
    var rv = makeCanvas(S, S), rg = ctx2d(rv, true);
    var rng = makeRNG(SEED.panel);
    var pBase = hex2rgb(PIG.panelBase), pHi = hex2rgb(PIG.panelHi), pLo = hex2rgb(PIG.panelLo);

    // --- base com variacao tonal de larga escala (nada de cor chapada) ---
    paintPixels(cv, function (x, y, u, v) {
      var m = fbm(u * 3, v * 3, 3, 3, 3, SEED.panel + 1);
      var f = fbm(u * 19, v * 19, 19, 19, 2, SEED.panel + 2);
      var c = mix3(pLo, pBase, clamp01(0.35 + m * 0.75));
      c = mix3(c, pHi, f * 0.07);
      return [c[0], c[1], c[2], 1];
    });
    hg.fillStyle = gray(0.42); hg.fillRect(0, 0, S, S);   // junta = nivel baixo
    rg.fillStyle = gray(0.66); rg.fillRect(0, 0, S, S);   // base meio rugosa

    // --- paineis ---
    var rects = [];
    splitRect(rects, 0, 0, S, S, 5, rng, Math.round(S / 12));
    var i, k;
    for (i = 0; i < rects.length; i++) {
      var r = rects[i];
      var inset = 3;
      var x0 = r.x + inset, y0 = r.y + inset, w = r.w - inset * 2, h = r.h - inset * 2;
      if (w < 8 || h < 8) continue;
      var tone = 0.82 + rng() * 0.4;

      // corpo do painel: opaco o bastante para a chapa ser LIDA como chapa
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = cssRGB(mix3(pBase, pHi, (tone - 0.82) * 1.35), 0.92);
      g.fillRect(x0, y0, w, h);
      // gradiente interno: a chapa nao e uniforme, pega luz de cima
      var pg = g.createLinearGradient(x0, y0, x0, y0 + h);
      pg.addColorStop(0, gray(0.72, 0.13));
      pg.addColorStop(0.55, gray(0.5, 0.0));
      pg.addColorStop(1, gray(0.0, 0.20));
      g.fillStyle = pg;
      g.fillRect(x0, y0, w, h);
      // chanfro: luz no topo/esquerda, sombra embaixo/direita
      g.fillStyle = gray(0.92, 0.30); g.fillRect(x0, y0, w, 1.5);
      g.fillStyle = gray(0.85, 0.20); g.fillRect(x0, y0, 1.5, h);
      g.fillStyle = gray(0.0, 0.62); g.fillRect(x0, y0 + h - 1.5, w, 1.5);
      g.fillStyle = gray(0.0, 0.52); g.fillRect(x0 + w - 1.5, y0, 1.5, h);

      // altura: interior elevado, junta permanece baixa
      hg.fillStyle = gray(0.66 + (tone - 1) * 0.06);
      hg.fillRect(x0, y0, w, h);
      // rugosidade: painel mais liso que a junta
      rg.fillStyle = gray(0.40 + rng() * 0.14);
      rg.fillRect(x0, y0, w, h);

      // parafusos nos cantos de alguns paineis
      if (rng() < 0.55 && w > 40 && h > 40) {
        var br = 3.2 + rng() * 1.6, m = 9;
        var pts = [[x0 + m, y0 + m], [x0 + w - m, y0 + m], [x0 + m, y0 + h - m], [x0 + w - m, y0 + h - m]];
        for (k = 0; k < pts.length; k++) {
          var bx = pts[k][0], by = pts[k][1];
          var grd = g.createRadialGradient(bx - br * 0.3, by - br * 0.3, 0, bx, by, br);
          grd.addColorStop(0, gray(0.55));
          grd.addColorStop(0.6, gray(0.24));
          grd.addColorStop(1, gray(0.05));
          g.fillStyle = grd;
          g.beginPath(); g.arc(bx, by, br, 0, TAU); g.fill();
          hg.fillStyle = gray(0.86);
          hg.beginPath(); hg.arc(bx, by, br * 0.8, 0, TAU); hg.fill();
          rg.fillStyle = gray(0.30);
          rg.beginPath(); rg.arc(bx, by, br * 0.8, 0, TAU); rg.fill();
        }
      }

      // grelha de ventilacao em alguns paineis
      if (rng() < 0.30 && w > 60 && h > 46) {
        var slots = 3 + (rng() * 4 | 0);
        var sh = Math.min(5, h / (slots * 2.4));
        var sy0 = y0 + h * 0.5 - (slots * sh * 2) * 0.5;
        for (k = 0; k < slots; k++) {
          var sy = sy0 + k * sh * 2;
          g.fillStyle = gray(0.02, 0.9);
          g.fillRect(x0 + w * 0.16, sy, w * 0.68, sh);
          g.fillStyle = gray(0.7, 0.12);
          g.fillRect(x0 + w * 0.16, sy - 1, w * 0.68, 1);
          hg.fillStyle = gray(0.14);
          hg.fillRect(x0 + w * 0.16, sy, w * 0.68, sh);
          rg.fillStyle = gray(0.78);
          rg.fillRect(x0 + w * 0.16, sy, w * 0.68, sh);
        }
      }

      // colmeia sutil dentro de poucos paineis: sabor tecnologico sem gritar
      if (rng() < 0.22 && w > 70 && h > 70) {
        g.save();
        g.beginPath(); g.rect(x0 + 4, y0 + 4, w - 8, h - 8); g.clip();
        g.globalAlpha = 0.16;
        g.globalCompositeOperation = 'lighter';
        g.drawImage(cachedCanvas('hex', buildHexCanvas), x0, y0, Math.max(w, 64), Math.max(h, 64));
        g.globalAlpha = 1;
        g.restore();
        g.globalCompositeOperation = 'source-over';
      }

      // fita refletiva fina em alguns paineis (leitura de pista de corrida)
      if (rng() < 0.14 && w > 50) {
        var ly = y0 + h * (0.2 + rng() * 0.6);
        g.fillStyle = gray(0.42, 0.30);
        g.fillRect(x0 + 6, ly, w - 12, 2);
        rg.fillStyle = gray(0.20);
        rg.fillRect(x0 + 6, ly, w - 12, 2);
      }
    }

    // --- desgaste global: sujeira e riscos amarram tudo ---
    g.globalCompositeOperation = 'multiply';
    g.globalAlpha = 0.26;
    g.drawImage(cachedCanvas('grunge', buildGrungeCanvas), 0, 0, S, S);
    g.globalCompositeOperation = 'screen';
    g.globalAlpha = 0.13;
    g.drawImage(cachedCanvas('scratch', buildScratchCanvas), 0, 0, S, S);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    rg.globalCompositeOperation = 'screen';
    rg.globalAlpha = 0.30;
    rg.drawImage(cachedCanvas('grunge', buildGrungeCanvas), 0, 0, S, S);
    rg.globalAlpha = 1;
    rg.globalCompositeOperation = 'source-over';

    // --- derivados a partir do heightmap real ---
    // normal e AO sao caros e nem toda cena usa os dois: viram getters que se
    // calculam na primeira leitura e se memorizam. Pedir so o mapa de cor da
    // pista nao paga o preco da oclusao.
    var hCanvas = blurCanvas(hv, 1.2);
    var set = { color: cv, rough: rv, height: hCanvas };
    var hfCache = null;
    function hf() {
      if (!hfCache) hfCache = canvasToField(hCanvas);
      return hfCache;
    }
    function lazy(prop, build) {
      Object.defineProperty(set, prop, {
        configurable: true, enumerable: true,
        get: function () {
          var v = build();
          Object.defineProperty(set, prop, { value: v, enumerable: true, configurable: true });
          return v;
        }
      });
    }
    lazy('normal', function () { return normalCanvasFromField(hf(), S, S, 1.35); });
    lazy('ao', function () { return aoCanvasFromField(hf(), S, S, 5, 1.5); });
    return set;
  }

  /* ledGrid: matriz de LED do telao. Subpixels RGB com canaleta preta —
   * usada como mascara/overlay para o telao nao parecer um video colado. */
  function buildLedCanvas() {
    var S = px(512), cell = 8, cv = makeCanvas(S, S), g = ctx2d(cv);
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    var x, y, c;
    var cols = ['rgba(255,40,40,1)', 'rgba(40,255,60,1)', 'rgba(50,90,255,1)'];
    for (y = 0; y < S; y += cell) {
      for (x = 0; x < S; x += cell) {
        for (c = 0; c < 3; c++) {
          g.fillStyle = cols[c];
          g.fillRect(x + 1 + c * 2, y + 1, 1.6, cell - 2.6);
        }
      }
    }
    // leve borrao: LED real nao tem borda dura
    return blurCanvas(cv, 0.7);
  }

  /* ==========================================================================
   * 11. SPRITES DE EFEITO  (todos em fundo transparente, para blend aditivo)
   * ======================================================================== */

  /* softGlow: gaussiana pura. O tijolo de todo efeito luminoso. */
  function buildGlowCanvas() {
    var S = px(256), cv = makeCanvas(S, S);
    var half = S * 0.5;
    return paintPixels(cv, function (x, y) {
      var dx = (x - half + 0.5) / half, dy = (y - half + 0.5) / half;
      var d = Math.sqrt(dx * dx + dy * dy);
      var a = Math.exp(-d * d * 5.2);
      a *= smoothstep(1.0, 0.86, d);        // corta limpo na borda do quadro
      return [1, 1, 1, a];
    });
  }

  /* ring: anel fino com halo. Base de onda de acerto e aro de fret. */
  function buildRingCanvas() {
    var S = px(256), cv = makeCanvas(S, S);
    var half = S * 0.5;
    return paintPixels(cv, function (x, y) {
      var dx = (x - half + 0.5) / half, dy = (y - half + 0.5) / half;
      var d = Math.sqrt(dx * dx + dy * dy);
      var core = Math.exp(-Math.pow((d - 0.74) / 0.055, 2));
      var halo = Math.exp(-Math.pow((d - 0.74) / 0.22, 2)) * 0.30;
      var inner = smoothstep(0.74, 0.30, d) * 0.06;
      var a = clamp01(core + halo + inner) * smoothstep(1.0, 0.94, d);
      return [1, 1, 1, a];
    });
  }

  /* sparkle: estrela de 4 pontas com micro-difracao — a faisca de acerto. */
  function buildSparkleCanvas() {
    var S = px(256), cv = makeCanvas(S, S);
    var half = S * 0.5;
    return paintPixels(cv, function (x, y) {
      var dx = (x - half + 0.5) / half, dy = (y - half + 0.5) / half;
      var d = Math.sqrt(dx * dx + dy * dy);
      var core = Math.exp(-d * d * 46);
      // pontas principais (cruz) e secundarias (diagonais, mais curtas)
      var sx = Math.exp(-(dy * dy) * 900) * Math.exp(-Math.abs(dx) * 4.2);
      var sy = Math.exp(-(dx * dx) * 900) * Math.exp(-Math.abs(dy) * 4.2);
      var d1 = (dx + dy) * 0.7071, d2 = (dx - dy) * 0.7071;
      var sd = (Math.exp(-(d2 * d2) * 2600) * Math.exp(-Math.abs(d1) * 8.5) +
                Math.exp(-(d1 * d1) * 2600) * Math.exp(-Math.abs(d2) * 8.5)) * 0.45;
      var a = clamp01(core + (sx + sy) * 0.85 + sd) * smoothstep(1.0, 0.9, d);
      // nucleo levemente azulado, pontas quentes: dispersao cromatica sutil
      return [a, a * (0.94 + core * 0.06), a * (0.86 + core * 0.14), a];
    });
  }

  /* flare: flare anamorfico de palco — nucleo estourado, risco horizontal
   * azulado e fantasmas cromaticos. E o que vende "luz forte de verdade". */
  function buildFlareCanvas() {
    var S = px(512), cv = makeCanvas(S, S);
    var half = S * 0.5;
    return paintPixels(cv, function (x, y) {
      var dx = (x - half + 0.5) / half, dy = (y - half + 0.5) / half;
      var d = Math.sqrt(dx * dx + dy * dy);
      var core = Math.exp(-d * d * 30) + Math.exp(-d * d * 240) * 0.9;
      // risco anamorfico: largo em X, apertadissimo em Y
      var streak = Math.exp(-(dy * dy) * 1500) * Math.exp(-Math.abs(dx) * 2.6) * 0.85;
      var streak2 = Math.exp(-(dy * dy) * 260) * Math.exp(-Math.abs(dx) * 4.6) * 0.22;
      // espinhos radiais irregulares
      var ang = Math.atan2(dy, dx);
      var spikes = Math.pow(clamp01(0.5 + 0.5 * Math.sin(ang * 9)), 6) * Math.exp(-d * 5.5) * 0.35;
      var halo = Math.exp(-Math.pow((d - 0.42) / 0.12, 2)) * 0.10;
      var a = clamp01(core + streak + streak2 + spikes + halo) * smoothstep(1.0, 0.9, d);
      // separacao cromatica: azul no risco, quente no nucleo
      var r = clamp01(core * 1.0 + streak * 0.72 + spikes + halo * 1.1);
      var gg = clamp01(core * 0.96 + streak * 0.88 + spikes * 0.8 + halo * 0.7);
      var b = clamp01(core * 0.92 + streak * 1.15 + spikes * 0.5 + halo * 0.5);
      return [r, gg, b, a];
    });
  }

  /* streak: rastro luminoso alongado (trilha da nota, raio de luz). */
  function buildStreakCanvas() {
    var W = px(512), H = px(128), cv = makeCanvas(W, H);
    return paintPixels(cv, function (x, y, u, v) {
      var dy = (v - 0.5) * 2;
      var body = Math.exp(-(dy * dy) * 11);
      var core = Math.exp(-(dy * dy) * 130);
      // afina nas duas pontas
      var taper = Math.pow(Math.sin(clamp01(u) * Math.PI), 0.9);
      var a = clamp01((body * 0.6 + core * 0.7) * taper);
      return [1, 1, 1, a];
    });
  }

  /* smoke: baforada volumetrica. Densidade fbm dentro de mascara radial,
   * com borda esfarrapada (nada de bolinha borrada de tutorial). */
  function buildSmokeCanvas() {
    var S = px(256), cv = makeCanvas(S, S);
    var half = S * 0.5;
    return paintPixels(cv, function (x, y, u, v) {
      var dx = (x - half + 0.5) / half, dy = (y - half + 0.5) / half;
      var d = Math.sqrt(dx * dx + dy * dy);
      var n = fbm(u * 6, v * 6, 6, 6, 5, SEED.smoke);
      var rid = ridged(u * 10, v * 10, 10, 10, 3, SEED.smoke + 5);
      var dens = clamp01(n * 0.75 + rid * 0.35);
      // mascara radial modulada pelo ruido => contorno irregular
      var mask = smoothstep(0.98, 0.28, d + (n - 0.5) * 0.42);
      var a = clamp01(dens * mask * 1.25);
      var lum = 0.72 + dens * 0.28;
      return [lum, lum * 0.985, lum * 0.96, a];
    });
  }

  /* flame: ATLAS ANIMADO 4x2 (8 quadros) com loop perfeito.
   * O ruido e deslocado exatamente um periodo ao longo dos 8 quadros, entao
   * o quadro 8 == quadro 0. Rampa de calor branco-azulado -> ambar -> vermelho
   * -> fuligem. Com brasas subindo que tambem fecham o ciclo. */
  var FLAME_RAMP = [
    [0.00, [0.12, 0.02, 0.00]],
    [0.18, [0.62, 0.09, 0.01]],
    [0.38, [1.00, 0.32, 0.03]],
    [0.60, [1.00, 0.66, 0.14]],
    [0.80, [1.00, 0.90, 0.55]],
    [1.00, [1.00, 0.99, 0.94]]
  ];
  function buildFlameCanvas() {
    var cell = px(256), cols = 4, rows = 2, frames = 8;
    var cv = makeCanvas(cell * cols, cell * rows), g = ctx2d(cv, true);
    var NP = 16;                       // periodo do ruido no eixo temporal
    var f, pxi, pyi;
    g.clearRect(0, 0, cv.width, cv.height);

    for (f = 0; f < frames; f++) {
      var ox = (f % cols) * cell, oy = ((f / cols) | 0) * cell;
      var phase = (f / frames) * NP;
      var img = g.createImageData(cell, cell), d = img.data, idx = 0;
      for (pyi = 0; pyi < cell; pyi++) {
        var v = 1 - pyi / (cell - 1);            // v=1 no topo, 0 na base
        for (pxi = 0; pxi < cell; pxi++) {
          var u = (pxi / (cell - 1)) * 2 - 1;    // -1..1
          // turbulencia que sobe (deslocamento em -y do campo de ruido)
          var n1 = vn(pxi * 0.020, pyi * 0.026 - phase, NP, NP, SEED.flame);
          var n2 = fbm(pxi * 0.012, pyi * 0.017 - phase * 0.6, NP, NP, 3, SEED.flame + 7);
          var n3 = vn(pxi * 0.055, pyi * 0.060 - phase * 1.6, NP, NP, SEED.flame + 13);

          // a lingua de fogo balanca mais quanto mais alto
          var sway = (n1 - 0.5) * 0.78 * Math.pow(v, 1.25);
          // lingua alta e afilada: chama baixa e larga parece fogueira de CG
          var halfW = 0.44 * Math.pow(1 - v * 0.86, 0.75) * (0.68 + n2 * 0.74);
          var dist = Math.abs(u - sway) / Math.max(0.008, halfW);
          var body = smoothstep(1.15, 0.08, dist);
          var top = smoothstep(1.04, 0.22, v);            // sobe bem mais alto
          var dens = body * top * (0.48 + n3 * 0.78);
          // base larga e quente colada no chao
          var base = smoothstep(0.24, 0.0, v) * smoothstep(0.85, 0.12, Math.abs(u)) * 0.80;
          dens = clamp01(dens + base);

          // calor: cai com a altura (topo vira fumaca alaranjada)
          var heat = clamp01(dens * (1.06 - v * 0.62) * (0.85 + n2 * 0.4));
          var c = ramp(FLAME_RAMP, heat);
          var a = clamp01(dens * 1.15);
          d[idx] = clamp01(c[0] * (0.55 + heat * 0.75)) * 255;
          d[idx + 1] = clamp01(c[1] * (0.55 + heat * 0.75)) * 255;
          d[idx + 2] = clamp01(c[2] * (0.55 + heat * 0.75)) * 255;
          d[idx + 3] = a * 255;
          idx += 4;
        }
      }
      g.putImageData(img, ox, oy);

      // brasas: sobem e reentram por baixo => ciclo fechado
      var rngE = makeRNG(SEED.flame + 99);
      g.save();
      g.beginPath(); g.rect(ox, oy, cell, cell); g.clip();
      g.globalCompositeOperation = 'lighter';
      var e;
      for (e = 0; e < 22; e++) {
        var ex = 0.5 + (rngE() - 0.5) * 0.62;
        var speed = 0.55 + rngE() * 0.75;
        var ey = fract(rngE() + (f / frames) * speed);
        var er = (0.6 + rngE() * 1.9) * (cell / 256);
        var ea = (1 - ey) * (0.35 + rngE() * 0.55);
        var cx = ox + (ex + (Math.sin(ey * 9 + e) * 0.06)) * cell;
        var cy = oy + (1 - ey) * cell;
        var grd = g.createRadialGradient(cx, cy, 0, cx, cy, er * 3);
        grd.addColorStop(0, 'rgba(255,236,190,' + ea.toFixed(3) + ')');
        grd.addColorStop(0.35, 'rgba(255,150,40,' + (ea * 0.55).toFixed(3) + ')');
        grd.addColorStop(1, 'rgba(255,90,10,0)');
        g.fillStyle = grd;
        g.beginPath(); g.arc(cx, cy, er * 3, 0, TAU); g.fill();
      }
      g.restore();
      g.globalCompositeOperation = 'source-over';
    }
    return cv;
  }

  /* shockwave: anel de choque com borda interna dura, franja externa macia,
   * estrias radiais e leve aberracao cromatica (R fora, B dentro). */
  function buildShockCanvas() {
    var S = px(512), cv = makeCanvas(S, S);
    var half = S * 0.5;
    return paintPixels(cv, function (x, y) {
      var dx = (x - half + 0.5) / half, dy = (y - half + 0.5) / half;
      var d = Math.sqrt(dx * dx + dy * dy);
      var ang = Math.atan2(dy, dx);
      // estrias: modulacao angular do raio do anel
      var wob = (vn(Math.cos(ang) * 6 + 8, Math.sin(ang) * 6 + 8, 64, 64, SEED.shock) - 0.5) * 0.045;
      var rr = 0.70 + wob;
      function band(off) {
        var t = (d - (rr + off));
        var inner = smoothstep(-0.10, 0.0, t);          // borda interna dura
        var outer = 1 - smoothstep(0.0, 0.16, t);
        return clamp01(inner * outer);
      }
      var r = band(0.012), gg = band(0.0), b = band(-0.014);
      var glow = Math.exp(-Math.pow((d - rr) / 0.20, 2)) * 0.18;
      var a = clamp01(Math.max(r, Math.max(gg, b)) + glow) * smoothstep(1.0, 0.93, d);
      return [clamp01(r + glow), clamp01(gg + glow * 0.9), clamp01(b + glow * 1.1), a];
    });
  }

  /* star: estrela de 5 pontas com halo e realce interno — tela de resultados. */
  function buildStarCanvas() {
    var S = px(256), cv = makeCanvas(S, S), g = ctx2d(cv);
    var half = S * 0.5, R = S * 0.42, r = R * 0.42, i, a, rad;
    g.clearRect(0, 0, S, S);
    // halo
    var grd = g.createRadialGradient(half, half, 0, half, half, half);
    grd.addColorStop(0, 'rgba(255,240,190,0.55)');
    grd.addColorStop(0.42, 'rgba(255,200,90,0.18)');
    grd.addColorStop(1, 'rgba(255,180,60,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    // corpo
    g.beginPath();
    for (i = 0; i < 10; i++) {
      a = -Math.PI / 2 + i * Math.PI / 5;
      rad = (i % 2 === 0) ? R : r;
      var xx = half + Math.cos(a) * rad, yy = half + Math.sin(a) * rad;
      if (i === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
    }
    g.closePath();
    var bodyG = g.createLinearGradient(0, half - R, 0, half + R);
    bodyG.addColorStop(0, 'rgba(255,255,248,1)');
    bodyG.addColorStop(0.45, 'rgba(255,226,140,1)');
    bodyG.addColorStop(1, 'rgba(255,170,50,1)');
    g.fillStyle = bodyG;
    g.fill();
    // bisel interno
    g.lineWidth = S * 0.012;
    g.strokeStyle = 'rgba(255,255,230,0.85)';
    g.stroke();
    // raios finos de difracao
    g.globalCompositeOperation = 'lighter';
    for (i = 0; i < 5; i++) {
      a = -Math.PI / 2 + i * TAU / 5;
      g.strokeStyle = 'rgba(255,246,214,0.35)';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(half, half);
      g.lineTo(half + Math.cos(a) * half * 0.98, half + Math.sin(a) * half * 0.98);
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    return cv;
  }

  /* confetti: atlas 4x4 de recortes (retangulo, fita curvada, disco, losango,
   * triangulo, estrelinha). Branco com sombreado interno para o tingimento
   * por instancia ainda ter volume. */
  function buildConfettiCanvas() {
    var cell = 64, cols = 4, rows = 4;
    var cv = makeCanvas(cell * cols, cell * rows), g = ctx2d(cv);
    var rng = makeRNG(SEED.confetti), i;
    g.clearRect(0, 0, cv.width, cv.height);
    for (i = 0; i < 16; i++) {
      var ox = (i % cols) * cell, oy = ((i / cols) | 0) * cell;
      g.save();
      g.translate(ox + cell / 2, oy + cell / 2);
      g.rotate((rng() - 0.5) * 0.9);
      var shade = g.createLinearGradient(-cell / 2, -cell / 2, cell / 2, cell / 2);
      shade.addColorStop(0, 'rgba(255,255,255,1)');
      shade.addColorStop(0.5, 'rgba(215,215,215,1)');
      shade.addColorStop(1, 'rgba(255,255,255,1)');
      g.fillStyle = shade;
      var kind = i % 6;
      if (kind === 0) {                                  // tira retangular
        g.fillRect(-cell * 0.10, -cell * 0.34, cell * 0.20, cell * 0.68);
      } else if (kind === 1) {                           // retangulo largo
        g.fillRect(-cell * 0.30, -cell * 0.14, cell * 0.60, cell * 0.28);
      } else if (kind === 2) {                           // disco
        g.beginPath(); g.arc(0, 0, cell * 0.26, 0, TAU); g.fill();
      } else if (kind === 3) {                           // losango
        g.beginPath();
        g.moveTo(0, -cell * 0.32); g.lineTo(cell * 0.20, 0);
        g.lineTo(0, cell * 0.32); g.lineTo(-cell * 0.20, 0);
        g.closePath(); g.fill();
      } else if (kind === 4) {                           // fita curvada
        g.strokeStyle = shade;
        g.lineWidth = cell * 0.16;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(-cell * 0.30, cell * 0.22);
        g.quadraticCurveTo(0, -cell * 0.42, cell * 0.30, cell * 0.18);
        g.stroke();
      } else {                                           // triangulo
        g.beginPath();
        g.moveTo(0, -cell * 0.30); g.lineTo(cell * 0.28, cell * 0.24);
        g.lineTo(-cell * 0.28, cell * 0.24);
        g.closePath(); g.fill();
      }
      g.restore();
    }
    return cv;
  }

  /* crowdDots: atlas 4x4 de silhuetas de publico, branco puro no alfa para o
   * agente de palco tingir/escurecer a vontade. Poses variadas (bracos no ar,
   * palmas, chifrinho, celular erguido) — o que faz a plateia parecer viva. */
  function buildCrowdCanvas() {
    var cell = px(256), cols = 4, rows = 4;
    var cv = makeCanvas(cell * cols, cell * rows), g = ctx2d(cv);
    var rng = makeRNG(SEED.crowd), i;
    g.clearRect(0, 0, cv.width, cv.height);

    function limb(c, x0, y0, x1, y1, w) {
      c.lineWidth = w;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.stroke();
    }

    for (i = 0; i < 16; i++) {
      var ox = (i % cols) * cell, oy = ((i / cols) | 0) * cell;
      var s = cell / 256;
      g.save();
      g.translate(ox, oy);
      g.fillStyle = '#fff';
      g.strokeStyle = '#fff';

      var cx = 128 * s;
      var headR = (20 + rng() * 4) * s;
      var headY = (74 + rng() * 8) * s;
      var shoulderY = headY + headR * 1.75;
      var bodyW = (54 + rng() * 12) * s;
      var hipY = 232 * s;

      // tronco: trapezio ombro->quadril
      g.beginPath();
      g.moveTo(cx - bodyW * 0.5, shoulderY);
      g.lineTo(cx + bodyW * 0.5, shoulderY);
      g.lineTo(cx + bodyW * 0.62, hipY);
      g.lineTo(cx - bodyW * 0.62, hipY);
      g.closePath();
      g.fill();
      // ombros arredondados
      g.beginPath();
      g.arc(cx - bodyW * 0.5, shoulderY + 4 * s, bodyW * 0.20, 0, TAU);
      g.arc(cx + bodyW * 0.5, shoulderY + 4 * s, bodyW * 0.20, 0, TAU);
      g.fill();
      // cabeca
      g.beginPath();
      g.arc(cx, headY, headR, 0, TAU);
      g.fill();
      // pescoco
      g.fillRect(cx - headR * 0.34, headY, headR * 0.68, headR * 1.1);

      var pose = i % 8;
      var armW = (14 + rng() * 4) * s;
      var sxL = cx - bodyW * 0.52, sxR = cx + bodyW * 0.52;
      var syy = shoulderY + 8 * s;
      var jitter = (rng() - 0.5) * 18 * s;

      if (pose === 0 || pose === 4) {              // dois bracos ao alto
        limb(g, sxL, syy, cx - bodyW * 0.85 + jitter, headY - 62 * s, armW);
        limb(g, sxR, syy, cx + bodyW * 0.85 + jitter, headY - 70 * s, armW);
      } else if (pose === 1) {                     // um braco ao alto
        limb(g, sxL, syy, sxL - 18 * s, hipY - 40 * s, armW);
        limb(g, sxR, syy, cx + bodyW * 0.80, headY - 66 * s, armW);
      } else if (pose === 2) {                     // palmas na frente
        limb(g, sxL, syy, cx - 10 * s, headY + 46 * s, armW);
        limb(g, sxR, syy, cx + 10 * s, headY + 44 * s, armW);
      } else if (pose === 3) {                     // chifrinho (metal horns)
        limb(g, sxL, syy, sxL - 22 * s, hipY - 46 * s, armW);
        limb(g, sxR, syy, cx + bodyW * 0.70, headY - 76 * s, armW * 0.9);
        g.beginPath();                             // dedos erguidos
        g.arc(cx + bodyW * 0.70, headY - 84 * s, armW * 0.42, 0, TAU);
        g.fill();
      } else if (pose === 5) {                     // celular erguido
        limb(g, sxR, syy, cx + bodyW * 0.55, headY - 56 * s, armW);
        limb(g, sxL, syy, sxL - 16 * s, hipY - 44 * s, armW);
        g.fillRect(cx + bodyW * 0.42, headY - 82 * s, 15 * s, 26 * s);
      } else if (pose === 6) {                     // bracos abertos
        limb(g, sxL, syy, sxL - 52 * s, headY + 10 * s, armW);
        limb(g, sxR, syy, sxR + 52 * s, headY + 6 * s, armW);
      } else {                                     // parado, bracos ao lado
        limb(g, sxL, syy, sxL - 12 * s, hipY - 26 * s, armW);
        limb(g, sxR, syy, sxR + 12 * s, hipY - 30 * s, armW);
      }
      g.restore();
    }
    return cv;
  }

  /* ==========================================================================
   * 12. GRAFISMO MARAJOARA  —  a identidade paraense do visual
   * ==========================================================================
   * Reinterpretacao estilizada da geometria ceramista marajoara: gregas
   * escalonadas, espirais duplas, losangos concentricos com ganchos, rostos
   * esquematicos e bichos do rio (jabuti, cobra-grande, pirarucu). Tudo em
   * branco com alfa, para ser tingido pela paleta e usado como inlay
   * incrustado na pista, mascara de emissivo e ornamento de UI.
   * ======================================================================== */

  /* Espiral quadrada (labirinto) — o motivo mais reconhecivel da ceramica. */
  function drawSquareSpiral(c, cx, cy, size, turns, lw) {
    var step = size / (turns * 2 + 1);
    var x = cx - size * 0.5, y = cy - size * 0.5;
    var w = size, h = size, i;
    c.lineWidth = lw;
    c.lineJoin = 'miter';
    c.beginPath();
    c.moveTo(x, y + h);
    for (i = 0; i < turns; i++) {
      c.lineTo(x, y);
      c.lineTo(x + w, y);
      c.lineTo(x + w, y + h - step);
      c.lineTo(x + step, y + h - step);
      x += step; y += step; w -= step * 2; h -= step * 2;
      if (w <= step || h <= step) break;
    }
    c.stroke();
  }

  /* Espiral curva dupla — usada em pares espelhados nas bordas. */
  function drawSpiral(c, cx, cy, r0, r1, turns, lw) {
    var i, n = 90, a, rr;
    c.lineWidth = lw;
    c.lineCap = 'round';
    c.beginPath();
    for (i = 0; i <= n; i++) {
      a = (i / n) * TAU * turns;
      rr = lerp(r0, r1, i / n);
      var xx = cx + Math.cos(a) * rr, yy = cy + Math.sin(a) * rr;
      if (i === 0) c.moveTo(xx, yy); else c.lineTo(xx, yy);
    }
    c.stroke();
  }

  /* Grega escalonada (o "degrau" marajoara). */
  function drawStepFret(c, x0, y0, w, h, steps, lw) {
    var sw = w / steps, sh = h / steps, i;
    c.lineWidth = lw;
    c.lineJoin = 'miter';
    c.beginPath();
    c.moveTo(x0, y0 + h);
    for (i = 0; i < steps; i++) {
      c.lineTo(x0 + i * sw, y0 + h - i * sh);
      c.lineTo(x0 + (i + 1) * sw, y0 + h - i * sh);
    }
    c.stroke();
  }

  /* Losango concentrico com ganchos nas pontas. */
  function drawHookedDiamond(c, cx, cy, r, rings, lw) {
    var i, k;
    c.lineWidth = lw;
    for (i = 0; i < rings; i++) {
      var rr = r * (1 - i / rings * 0.62);
      c.beginPath();
      c.moveTo(cx, cy - rr);
      c.lineTo(cx + rr, cy);
      c.lineTo(cx, cy + rr);
      c.lineTo(cx - rr, cy);
      c.closePath();
      c.stroke();
    }
    // ganchos nas quatro pontas
    var hooks = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (k = 0; k < 4; k++) {
      var hx = cx + hooks[k][0] * r, hy = cy + hooks[k][1] * r;
      var px2 = -hooks[k][1], py2 = hooks[k][0];
      c.beginPath();
      c.moveTo(hx, hy);
      c.lineTo(hx + hooks[k][0] * r * 0.26 + px2 * r * 0.20, hy + hooks[k][1] * r * 0.26 + py2 * r * 0.20);
      c.lineTo(hx + px2 * r * 0.30, hy + py2 * r * 0.30);
      c.stroke();
    }
  }

  function drawZigzag(c, x0, y0, x1, y1, amp, n, lw) {
    var i, t, xx, yy;
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len;
    c.lineWidth = lw;
    c.lineJoin = 'miter';
    c.beginPath();
    for (i = 0; i <= n; i++) {
      t = i / n;
      var s = (i % 2 === 0) ? 1 : -1;
      xx = x0 + dx * t + nx * amp * s;
      yy = y0 + dy * t + ny * amp * s;
      if (i === 0) c.moveTo(xx, yy); else c.lineTo(xx, yy);
    }
    c.stroke();
  }

  /* Os 16 motivos do atlas. Cada um desenha dentro de um quadro 256x256
   * (escalado por s) com margem de seguranca para nao vazar no mipmap. */
  function drawMarajoaraGlyph(g, idx, s) {
    var C = 128 * s, R = 92 * s, lw = 9 * s, i, a;
    g.strokeStyle = '#fff';
    g.fillStyle = '#fff';
    g.lineCap = 'butt';
    g.lineJoin = 'miter';

    switch (idx) {
      case 0:  // grega em faixa dupla espelhada
        drawStepFret(g, 34 * s, 40 * s, 188 * s, 76 * s, 5, lw);
        g.save();
        g.translate(0, 256 * s);
        g.scale(1, -1);
        drawStepFret(g, 34 * s, 40 * s, 188 * s, 76 * s, 5, lw);
        g.restore();
        break;
      case 1:  // espiral dupla enlacada
        drawSpiral(g, C - 42 * s, C, 6 * s, 44 * s, 1.6, lw);
        drawSpiral(g, C + 42 * s, C, 6 * s, 44 * s, -1.6, lw);
        g.lineWidth = lw;
        g.beginPath();
        g.moveTo(C - 42 * s, C - 44 * s);
        g.lineTo(C + 42 * s, C - 44 * s);
        g.stroke();
        break;
      case 2:  // losango concentrico com ganchos
        drawHookedDiamond(g, C, C, R * 0.86, 3, lw);
        break;
      case 3:  // jabuti esquematico (casco em losangos)
        g.lineWidth = lw;
        g.beginPath();
        g.ellipse(C, C, R * 0.72, R * 0.56, 0, 0, TAU);
        g.stroke();
        for (i = -1; i <= 1; i++) {
          g.beginPath();
          g.moveTo(C + i * 34 * s, C - 34 * s);
          g.lineTo(C + i * 34 * s + 20 * s, C);
          g.lineTo(C + i * 34 * s, C + 34 * s);
          g.lineTo(C + i * 34 * s - 20 * s, C);
          g.closePath();
          g.stroke();
        }
        g.beginPath();                       // cabeca e patas
        g.arc(C, C - R * 0.66, 14 * s, 0, TAU);
        g.fill();
        for (i = 0; i < 4; i++) {
          a = Math.PI * 0.25 + i * Math.PI * 0.5;
          g.beginPath();
          g.arc(C + Math.cos(a) * R * 0.66, C + Math.sin(a) * R * 0.52, 11 * s, 0, TAU);
          g.fill();
        }
        break;
      case 4:  // cobra-grande: zigue-zague com olhos
        drawZigzag(g, 30 * s, C, 226 * s, C, 40 * s, 6, lw);
        g.beginPath();
        g.arc(34 * s, C - 40 * s, 12 * s, 0, TAU);
        g.fill();
        g.beginPath();
        g.arc(222 * s, C + 40 * s, 12 * s, 0, TAU);
        g.fill();
        break;
      case 5:  // rosto esquematico (mascara ritual)
        g.lineWidth = lw;
        g.strokeRect(C - R * 0.70, C - R * 0.78, R * 1.40, R * 1.56);
        g.beginPath();                       // olhos em espiral
        drawSpiral(g, C - 34 * s, C - 22 * s, 3 * s, 20 * s, 1.3, lw * 0.7);
        drawSpiral(g, C + 34 * s, C - 22 * s, 3 * s, 20 * s, -1.3, lw * 0.7);
        g.lineWidth = lw;
        g.beginPath();                       // boca escalonada
        g.moveTo(C - 40 * s, C + 40 * s);
        g.lineTo(C - 20 * s, C + 40 * s);
        g.lineTo(C - 20 * s, C + 56 * s);
        g.lineTo(C + 20 * s, C + 56 * s);
        g.lineTo(C + 20 * s, C + 40 * s);
        g.lineTo(C + 40 * s, C + 40 * s);
        g.stroke();
        break;
      case 6:  // triangulos escalonados (montanha/igarape)
        for (i = 0; i < 3; i++) {
          g.lineWidth = lw;
          g.beginPath();
          g.moveTo(40 * s, 210 * s - i * 20 * s);
          g.lineTo(C, 60 * s + i * 26 * s);
          g.lineTo(216 * s, 210 * s - i * 20 * s);
          g.stroke();
        }
        break;
      case 7:  // ganchos em L entrelacados
        for (i = 0; i < 4; i++) {
          g.save();
          g.translate(C, C);
          g.rotate(i * Math.PI * 0.5);
          g.lineWidth = lw;
          g.beginPath();
          g.moveTo(-70 * s, -70 * s);
          g.lineTo(20 * s, -70 * s);
          g.lineTo(20 * s, -24 * s);
          g.lineTo(-24 * s, -24 * s);
          g.stroke();
          g.restore();
        }
        break;
      case 8:  // roseta radial escalonada (sol amazonico)
        for (i = 0; i < 8; i++) {
          a = i * TAU / 8;
          g.save();
          g.translate(C, C);
          g.rotate(a);
          g.lineWidth = lw;
          g.beginPath();
          g.moveTo(24 * s, -14 * s);
          g.lineTo(58 * s, -14 * s);
          g.lineTo(58 * s, -30 * s);
          g.lineTo(86 * s, 0);
          g.lineTo(58 * s, 30 * s);
          g.lineTo(58 * s, 14 * s);
          g.lineTo(24 * s, 14 * s);
          g.closePath();
          g.stroke();
          g.restore();
        }
        g.beginPath();
        g.arc(C, C, 16 * s, 0, TAU);
        g.fill();
        break;
      case 9:  // cruz com ganchos terminais
        g.lineWidth = lw * 1.2;
        g.beginPath();
        g.moveTo(C, 36 * s); g.lineTo(C, 220 * s);
        g.moveTo(36 * s, C); g.lineTo(220 * s, C);
        g.stroke();
        var ends = [[C, 36 * s, 1, 0], [C, 220 * s, -1, 0], [36 * s, C, 0, 1], [220 * s, C, 0, -1]];
        for (i = 0; i < 4; i++) {
          g.beginPath();
          g.moveTo(ends[i][0], ends[i][1]);
          g.lineTo(ends[i][0] + ends[i][2] * 34 * s, ends[i][1] + ends[i][3] * 34 * s);
          g.stroke();
        }
        break;
      case 10: // onda do rio
        g.lineWidth = lw;
        for (i = 0; i < 3; i++) {
          var yy = 76 * s + i * 52 * s;
          g.beginPath();
          g.moveTo(28 * s, yy);
          var k;
          for (k = 0; k < 4; k++) {
            g.quadraticCurveTo(28 * s + k * 50 * s + 25 * s, yy - 30 * s, 28 * s + (k + 1) * 50 * s, yy);
          }
          g.stroke();
        }
        break;
      case 11: // acai: cachos em circulos
        for (i = 0; i < 14; i++) {
          var rr = 26 * s + (i % 3) * 22 * s;
          a = i * TAU / 14 + (i % 2) * 0.2;
          g.beginPath();
          g.arc(C + Math.cos(a) * rr, C + Math.sin(a) * rr, 11 * s, 0, TAU);
          g.fill();
        }
        g.lineWidth = lw * 0.8;
        g.beginPath();
        g.arc(C, C, 84 * s, 0, TAU);
        g.stroke();
        break;
      case 12: // labirinto quadrado
        drawSquareSpiral(g, C, C, 180 * s, 3, lw);
        break;
      case 13: // faixa de chevrons
        for (i = 0; i < 3; i++) {
          drawZigzag(g, 30 * s, 70 * s + i * 58 * s, 226 * s, 70 * s + i * 58 * s, 18 * s, 8, lw * 0.85);
        }
        break;
      case 14: // olho/urna com pestanas escalonadas
        g.lineWidth = lw;
        g.beginPath();
        g.ellipse(C, C, 88 * s, 54 * s, 0, 0, TAU);
        g.stroke();
        g.beginPath();
        g.arc(C, C, 26 * s, 0, TAU);
        g.fill();
        for (i = 0; i < 9; i++) {
          var t = i / 8;
          var ex = lerp(C - 80 * s, C + 80 * s, t);
          g.beginPath();
          g.moveTo(ex, C - 52 * s + Math.abs(t - 0.5) * 34 * s);
          g.lineTo(ex, C - 84 * s + Math.abs(t - 0.5) * 34 * s);
          g.stroke();
        }
        break;
      default: // 15 — pirarucu geometrico
        g.lineWidth = lw;
        g.beginPath();
        g.moveTo(30 * s, C);
        g.quadraticCurveTo(C, 56 * s, 206 * s, C);
        g.quadraticCurveTo(C, 200 * s, 30 * s, C);
        g.stroke();
        g.beginPath();                       // cauda
        g.moveTo(206 * s, C);
        g.lineTo(238 * s, C - 34 * s);
        g.lineTo(238 * s, C + 34 * s);
        g.closePath();
        g.stroke();
        g.beginPath();
        g.arc(66 * s, C - 10 * s, 10 * s, 0, TAU);
        g.fill();
        for (i = 0; i < 4; i++) {            // escamas em losango
          g.beginPath();
          var sx = 96 * s + i * 30 * s;
          g.moveTo(sx, C - 22 * s);
          g.lineTo(sx + 16 * s, C);
          g.lineTo(sx, C + 22 * s);
          g.lineTo(sx - 16 * s, C);
          g.closePath();
          g.stroke();
        }
        break;
    }
  }

  function buildMarajoaraCanvas() {
    var cell = px(256), cols = 4, rows = 4;
    var cv = makeCanvas(cell * cols, cell * rows), g = ctx2d(cv);
    var s = cell / 256, i;
    g.clearRect(0, 0, cv.width, cv.height);
    for (i = 0; i < 16; i++) {
      g.save();
      g.translate((i % cols) * cell, ((i / cols) | 0) * cell);
      // margem interna: evita sangramento entre celulas no mipmap
      g.beginPath();
      g.rect(2 * s, 2 * s, 252 * s, 252 * s);
      g.clip();
      drawMarajoaraGlyph(g, i, s);
      g.restore();
    }
    return cv;
  }

  /* Friso marajoara tileavel horizontalmente — os INLAYS da pista.
   * Periodo 256 em 1024 => 4 repeticoes exatas, casa sem emenda. */
  function buildMarajoaraBandCanvas() {
    var W = px(1024), H = px(256), cv = makeCanvas(W, H), g = ctx2d(cv);
    var s = H / 256, period = W / 4, i;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = '#fff';
    g.fillStyle = '#fff';

    // linhas-guia superior e inferior
    g.lineWidth = 7 * s;
    g.beginPath();
    g.moveTo(0, 22 * s); g.lineTo(W, 22 * s);
    g.moveTo(0, 234 * s); g.lineTo(W, 234 * s);
    g.stroke();
    g.lineWidth = 3 * s;
    g.beginPath();
    g.moveTo(0, 38 * s); g.lineTo(W, 38 * s);
    g.moveTo(0, 218 * s); g.lineTo(W, 218 * s);
    g.stroke();

    for (i = 0; i < 4; i++) {
      var ox = i * period;
      g.save();
      g.translate(ox, 0);
      // grega corrida (o motivo continua de um modulo para o outro)
      g.lineWidth = 9 * s;
      g.lineJoin = 'miter';
      g.beginPath();
      var stepW = period / 4, k;
      for (k = 0; k < 4; k++) {
        var bx = k * stepW;
        g.moveTo(bx, 178 * s);
        g.lineTo(bx, 96 * s);
        g.lineTo(bx + stepW * 0.62, 96 * s);
        g.lineTo(bx + stepW * 0.62, 140 * s);
        g.lineTo(bx + stepW * 0.30, 140 * s);
      }
      g.stroke();
      // losango central alternado com espiral
      if (i % 2 === 0) {
        drawHookedDiamond(g, period * 0.5, 128 * s, 46 * s, 2, 7 * s);
      } else {
        drawSpiral(g, period * 0.5 - 26 * s, 128 * s, 4 * s, 26 * s, 1.4, 7 * s);
        drawSpiral(g, period * 0.5 + 26 * s, 128 * s, 4 * s, 26 * s, -1.4, 7 * s);
      }
      g.restore();
    }
    return cv;
  }

  /* ==========================================================================
   * 13. AZULEJARIA DE BELEM
   * ==========================================================================
   * Azulejo portugues de padrao, azul cobalto sobre esmalte creme, pintado
   * a mao (a mancha da tinta varia). Belem e a cidade mais azulejada do
   * Brasil — este e o painel decorativo do cenario paraense.
   * ======================================================================== */
  function buildAzulejoSet() {
    var S = px(512), cell = S / 2;
    var cv = makeCanvas(S, S), g = ctx2d(cv, true);
    var hv = makeCanvas(S, S), hg = ctx2d(hv);
    var rng = makeRNG(SEED.azulejo);
    var cer = hex2rgb(PIG.ceramic), cob = hex2rgb(PIG.cobalt), cobD = hex2rgb(PIG.cobaltDeep);

    // --- esmalte de fundo: creme com variacao de queima ---
    paintPixels(cv, function (x, y, u, v) {
      var n = fbm(u * 5, v * 5, 5, 5, 4, SEED.azulejo);
      var g2 = fbm(u * 23, v * 23, 23, 23, 3, SEED.azulejo + 3);
      var c = mix3(cer, [cer[0] * 0.90, cer[1] * 0.89, cer[2] * 0.83], n * 0.55 + g2 * 0.2);
      return [c[0], c[1], c[2], 1];
    });

    // --- craquele do esmalte: rachaduras finissimas ---
    g.strokeStyle = 'rgba(120,105,80,0.13)';
    g.lineWidth = 0.8;
    var i, k;
    for (i = 0; i < 130; i++) {
      var cx0 = rng() * S, cy0 = rng() * S, ang = rng() * TAU, len = 10 + rng() * 70;
      var x1 = cx0 + Math.cos(ang) * len, y1 = cy0 + Math.sin(ang) * len;
      wrapPaint(g, S, S, Math.min(cx0, x1) - 2, Math.max(cx0, x1) + 2, Math.min(cy0, y1) - 2, Math.max(cy0, y1) + 2, function (c) {
        c.beginPath();
        c.moveTo(cx0, cy0);
        c.quadraticCurveTo((cx0 + x1) * 0.5 + (rng() - 0.5) * 8, (cy0 + y1) * 0.5 + (rng() - 0.5) * 8, x1, y1);
        c.stroke();
      });
    }

    // --- altura: cada azulejo abaulado, rejunte rebaixado ---
    hg.fillStyle = gray(0.30);
    hg.fillRect(0, 0, S, S);
    var cyi, cxi;
    for (cyi = 0; cyi < 2; cyi++) {
      for (cxi = 0; cxi < 2; cxi++) {
        var gx = cxi * cell, gy = cyi * cell, pad = 4;
        var grd = hg.createRadialGradient(gx + cell / 2, gy + cell / 2, cell * 0.1, gx + cell / 2, gy + cell / 2, cell * 0.72);
        grd.addColorStop(0, gray(0.88));
        grd.addColorStop(0.72, gray(0.80));
        grd.addColorStop(1, gray(0.55));
        hg.fillStyle = grd;
        hg.fillRect(gx + pad, gy + pad, cell - pad * 2, cell - pad * 2);
      }
    }

    // --- pintura cobalto: motivo por azulejo + quartos nos cantos ---
    function petal(c, cx, cy, r, rot) {
      c.save();
      c.translate(cx, cy);
      c.rotate(rot);
      c.beginPath();
      c.moveTo(0, 0);
      c.quadraticCurveTo(r * 0.55, -r * 0.42, r, 0);
      c.quadraticCurveTo(r * 0.55, r * 0.42, 0, 0);
      c.fill();
      c.restore();
    }

    function paintTile(c, gx, gy) {
      var mx = gx + cell / 2, my = gy + cell / 2;
      // roseta central de 8 petalas
      c.fillStyle = cssRGB(cob, 0.92);
      for (k = 0; k < 8; k++) petal(c, mx, my, cell * 0.30, k * TAU / 8);
      c.fillStyle = cssRGB(cobD, 0.95);
      c.beginPath();
      c.arc(mx, my, cell * 0.075, 0, TAU);
      c.fill();
      // arcos diagonais ligando os cantos (forma o "tapete" entre azulejos)
      c.strokeStyle = cssRGB(cob, 0.85);
      c.lineWidth = cell * 0.042;
      for (k = 0; k < 4; k++) {
        var qx = gx + (k % 2) * cell, qy = gy + ((k / 2) | 0) * cell;
        c.beginPath();
        c.arc(qx, qy, cell * 0.34, 0, TAU);
        c.stroke();
      }
      // filete de borda duplo
      c.lineWidth = cell * 0.028;
      c.strokeStyle = cssRGB(cobD, 0.75);
      c.strokeRect(gx + cell * 0.055, gy + cell * 0.055, cell * 0.89, cell * 0.89);
      c.lineWidth = cell * 0.012;
      c.strokeStyle = cssRGB(cob, 0.55);
      c.strokeRect(gx + cell * 0.10, gy + cell * 0.10, cell * 0.80, cell * 0.80);
      // pingos de canto
      c.fillStyle = cssRGB(cob, 0.8);
      for (k = 0; k < 4; k++) {
        var dx2 = gx + (k % 2 ? cell * 0.845 : cell * 0.155);
        var dy2 = gy + ((k / 2) | 0 ? cell * 0.845 : cell * 0.155);
        c.beginPath();
        c.arc(dx2, dy2, cell * 0.035, 0, TAU);
        c.fill();
      }
    }

    for (cyi = 0; cyi < 2; cyi++) {
      for (cxi = 0; cxi < 2; cxi++) {
        var gx2 = cxi * cell, gy2 = cyi * cell;
        wrapPaint(g, S, S, gx2 - cell * 0.4, gx2 + cell * 1.4, gy2 - cell * 0.4, gy2 + cell * 1.4, function (c) {
          paintTile(c, gx2, gy2);
        });
      }
    }

    // --- mancha de pincel: a tinta cobalto nao e uniforme ---
    var wash = makeCanvas(S, S);
    paintPixels(wash, function (x, y, u, v) {
      var n = fbm(u * 9, v * 9, 9, 9, 4, SEED.azulejo + 21);
      return [0, 0, 0, clamp01((n - 0.42) * 0.55)];
    });
    g.globalAlpha = 0.5;
    g.globalCompositeOperation = 'multiply';
    g.drawImage(wash, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    // --- rejunte escuro entre os azulejos ---
    g.strokeStyle = 'rgba(70,60,48,0.55)';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(cell, 0); g.lineTo(cell, S);
    g.moveTo(0, cell); g.lineTo(S, cell);
    g.moveTo(0, 0.5); g.lineTo(S, 0.5);
    g.moveTo(0.5, 0); g.lineTo(0.5, S);
    g.stroke();

    var hf = canvasToField(blurCanvas(hv, 2));
    return { color: cv, normal: normalCanvasFromField(hf, S, S, 1.1) };
  }

  /* ==========================================================================
   * 14. RAMPAS DE COR (lookup para shader, gradiente de UI, fade de particula)
   * ======================================================================== */

  /* gradientRamp(colors, opts)
   *   colors: array de cores (hex number, '#rrggbb', THREE.Color ou [r,g,b]).
   *   opts:   { stops:[0..1], size:256, vertical:false, alpha:[a...],
   *             srgb:true, smooth:true }
   * Devolve THREE.Texture 1D (size x 4) com ClampToEdge e sem mipmap — para
   * lookup exato dentro de shader/emissivo. Cacheada pela chave completa. */
  function buildGradientRamp(colors, opts) {
    opts = opts || {};
    var size = opts.size || 256;
    var vertical = !!opts.vertical;
    var W = vertical ? 4 : size, H = vertical ? size : 4;
    var cv = makeCanvas(W, H), g = ctx2d(cv);
    var list = colors && colors.length ? colors : [0x000000, 0xffffff];
    var grd = vertical ? g.createLinearGradient(0, 0, 0, H) : g.createLinearGradient(0, 0, W, 0);
    var i, pos;
    for (i = 0; i < list.length; i++) {
      pos = (opts.stops && opts.stops[i] != null) ? clamp01(opts.stops[i])
           : (list.length === 1 ? 0 : i / (list.length - 1));
      var rgb = colorToRGB01(list[i]);
      var a = (opts.alpha && opts.alpha[i] != null) ? clamp01(opts.alpha[i]) : 1;
      grd.addColorStop(clamp01(pos), cssRGB(rgb, a));
    }
    g.clearRect(0, 0, W, H);
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    return texFromCanvas(cv, {
      srgb: opts.srgb !== false, clamp: true, mips: false, aniso: 1,
      name: 'gradientRamp'
    });
  }

  /* Aceita hex, string, THREE.Color, array [r,g,b] — devolve [r,g,b] em 0..1 */
  /* Componentes 0..1 PRONTOS PARA PINTAR NUM CANVAS 2D.
   * O canvas e sempre um buffer de EXIBICAO (sRGB) — quem consome a textura
   * marca encoding = sRGBEncoding. Mas com THREE.ColorManagement ligado (que e
   * como o jogo roda, ver index.html) os r/g/b de um THREE.Color estao em luz
   * LINEAR: pintar com eles daria uma rampa visivelmente escura demais.
   * getHexString() faz a conversao de volta para o espaco de exibicao nos DOIS
   * modos (com legacyMode=true ela e um no-op), entao passamos por ela sempre.
   * Precisao de 8 bits e exatamente o que o canvas guarda — nao se perde nada. */
  function displayRGB01(c) {
    if (c && typeof c.getHexString === 'function') {
      var n = parseInt(c.getHexString(), 16);
      if (isFinite(n)) return hex2rgb(n);
    }
    return [c.r, c.g, c.b];
  }

  function colorToRGB01(v) {
    if (v == null) return [1, 1, 1];
    if (typeof v === 'number') return hex2rgb(v);
    if (typeof v === 'string') {
      if (hasTHREE()) { return displayRGB01(new THREE.Color(v)); }
      return [1, 1, 1];
    }
    if (v.isColor) return displayRGB01(v);
    if (v.length >= 3) return [v[0], v[1], v[2]];
    if (v.r != null) return [v.r, v.g, v.b];
    return [1, 1, 1];
  }

  /* Converte qualquer coisa em THREE.Color (usado pela ponte com a paleta). */
  function toColor(v) {
    if (!hasTHREE()) return null;
    if (v && v.isColor) return v.clone();
    if (typeof v === 'number') return new THREE.Color(v);
    if (typeof v === 'string') return new THREE.Color(v);
    if (v && v.length >= 3) return new THREE.Color(v[0], v[1], v[2]);
    if (v && v.r != null) return new THREE.Color(v.r, v.g, v.b);
    return new THREE.Color(0xffffff);
  }

  /* ==========================================================================
   * 15. REGISTRO DE TEXTURAS  —  geracao preguicosa + cache
   * ======================================================================== */

  /* Cada entrada devolve a THREE.Texture pronta. Nada roda antes de alguem
   * pedir: uma cena que nao usa madeira nunca paga o custo da madeira. */
  var GENERATORS = {
    /* --- dados / microdetalhe (LINEAR, nunca sRGB) --- */
    noise: function () { return texFromCanvas(cachedCanvas('noise', buildNoiseCanvas), { name: 'noise' }); },
    noiseFine: function () { return texFromCanvas(cachedCanvas('noiseFine', buildNoiseFineCanvas), { name: 'noiseFine' }); },
    microRelief: function () { return texFromCanvas(cachedCanvas('microRelief', buildMicroReliefCanvas), { name: 'microRelief' }); },
    microNormal: function () {
      var c = cachedCanvas('microRelief', buildMicroReliefCanvas);
      return texFromCanvas(normalCanvasFromField(canvasToField(c), c.width, c.height, 1.1), { name: 'microNormal' });
    },
    fbmCloud: function () { return texFromCanvas(cachedCanvas('cloud', buildCloudCanvas), { name: 'fbmCloud' }); },
    scratches: function () { return texFromCanvas(cachedCanvas('scratch', buildScratchCanvas), { name: 'scratches' }); },
    grunge: function () { return texFromCanvas(cachedCanvas('grunge', buildGrungeCanvas), { name: 'grunge' }); },
    dust: function () { return texFromCanvas(cachedCanvas('dust', buildDustCanvas), { srgb: true, name: 'dust' }); },

    /* --- metal escovado --- */
    brushedMetal: function () { return texFromCanvas(brushedSet().color, { srgb: true, name: 'brushedMetal' }); },
    brushedMetalNormal: function () { return texFromCanvas(brushedSet().normal, { name: 'brushedMetalNormal' }); },
    brushedMetalRough: function () { return texFromCanvas(brushedSet().rough, { name: 'brushedMetalRough' }); },
    brushedMetalHeight: function () { return texFromCanvas(brushedSet().height, { name: 'brushedMetalHeight' }); },

    /* --- madeira --- */
    woodJacaranda: function () { return texFromCanvas(woodSet().color, { srgb: true, name: 'woodJacaranda' }); },
    woodJacarandaNormal: function () { return texFromCanvas(woodSet().normal, { name: 'woodJacarandaNormal' }); },
    woodJacarandaRough: function () { return texFromCanvas(woodSet().rough, { name: 'woodJacarandaRough' }); },

    /* --- fibra de carbono --- */
    carbonWeave: function () { return texFromCanvas(carbonSet().color, { srgb: true, name: 'carbonWeave' }); },
    carbonWeaveNormal: function () { return texFromCanvas(carbonSet().normal, { name: 'carbonWeaveNormal' }); },
    carbonWeaveRough: function () { return texFromCanvas(carbonSet().rough, { name: 'carbonWeaveRough' }); },

    /* --- traste --- */
    fretMetal: function () { return texFromCanvas(fretSet().color, { srgb: true, name: 'fretMetal' }); },
    fretMetalNormal: function () { return texFromCanvas(fretSet().normal, { name: 'fretMetalNormal' }); },
    fretMetalRough: function () { return texFromCanvas(fretSet().rough, { name: 'fretMetalRough' }); },

    /* --- painel tecnologico (superficie da pista) --- */
    hexGrid: function () { return texFromCanvas(cachedCanvas('hex', buildHexCanvas), { srgb: true, name: 'hexGrid' }); },
    techPanel: function () { return texFromCanvas(panelSet().color, { srgb: true, name: 'techPanel' }); },
    techPanelNormal: function () { return texFromCanvas(panelSet().normal, { name: 'techPanelNormal' }); },
    techPanelRough: function () { return texFromCanvas(panelSet().rough, { name: 'techPanelRough' }); },
    techPanelAO: function () { return texFromCanvas(panelSet().ao, { name: 'techPanelAO' }); },
    techPanelHeight: function () { return texFromCanvas(panelSet().height, { name: 'techPanelHeight' }); },

    /* --- tecido e telao --- */
    fabricWeave: function () { return texFromCanvas(fabricSet().color, { srgb: true, name: 'fabricWeave' }); },
    fabricWeaveNormal: function () { return texFromCanvas(fabricSet().normal, { name: 'fabricWeaveNormal' }); },
    ledGrid: function () { return texFromCanvas(cachedCanvas('led', buildLedCanvas), { srgb: true, name: 'ledGrid' }); },

    /* --- identidade paraense --- */
    marajoara: function () { return texFromCanvas(cachedCanvas('marajoara', buildMarajoaraCanvas), { srgb: true, clamp: true, name: 'marajoara' }); },
    /* O friso repete nos DOIS eixos: em X pelo desenho (periodo 256 em 1024),
     * em Y porque a pista corre no eixo V — um clamp aqui esticaria a borda
     * e o inlay sumiria da pista. */
    marajoaraBand: function () { return texFromCanvas(cachedCanvas('marajoaraBand', buildMarajoaraBandCanvas), { srgb: true, name: 'marajoaraBand' }); },
    marajoaraBandNormal: function () {
      var cvv = cachedCanvas('marajoaraBand', buildMarajoaraBandCanvas);
      var f = canvasToField(blurCanvas(cvv, 2));
      return texFromCanvas(normalCanvasFromField(f, cvv.width, cvv.height, 2.4), { name: 'marajoaraBandNormal' });
    },
    azulejo: function () { return texFromCanvas(azulejoSet().color, { srgb: true, name: 'azulejo' }); },
    azulejoNormal: function () { return texFromCanvas(azulejoSet().normal, { name: 'azulejoNormal' }); },

    /* --- publico --- */
    crowdDots: function () { return texFromCanvas(cachedCanvas('crowd', buildCrowdCanvas), { srgb: true, clamp: true, name: 'crowdDots' }); },

    /* --- sprites de efeito (sRGB, clamp, fundo transparente) --- */
    flare: function () { return texFromCanvas(cachedCanvas('flare', buildFlareCanvas), { srgb: true, clamp: true, name: 'flare' }); },
    ring: function () { return texFromCanvas(cachedCanvas('ring', buildRingCanvas), { srgb: true, clamp: true, name: 'ring' }); },
    sparkle: function () { return texFromCanvas(cachedCanvas('sparkle', buildSparkleCanvas), { srgb: true, clamp: true, name: 'sparkle' }); },
    softGlow: function () { return texFromCanvas(cachedCanvas('glow', buildGlowCanvas), { srgb: true, clamp: true, name: 'softGlow' }); },
    streak: function () { return texFromCanvas(cachedCanvas('streak', buildStreakCanvas), { srgb: true, clamp: true, name: 'streak' }); },
    smoke: function () { return texFromCanvas(cachedCanvas('smoke', buildSmokeCanvas), { srgb: true, clamp: true, name: 'smoke' }); },
    flame: function () { return texFromCanvas(cachedCanvas('flame', buildFlameCanvas), { srgb: true, clamp: true, name: 'flame' }); },
    shockwave: function () { return texFromCanvas(cachedCanvas('shock', buildShockCanvas), { srgb: true, clamp: true, name: 'shockwave' }); },
    star: function () { return texFromCanvas(cachedCanvas('star', buildStarCanvas), { srgb: true, clamp: true, name: 'star' }); },
    confetti: function () { return texFromCanvas(cachedCanvas('confetti', buildConfettiCanvas), { srgb: true, clamp: true, name: 'confetti' }); }
  };

  /* Grupos multi-saida: gerados uma unica vez, consumidos por varias texturas. */
  function brushedSet() { return cachedCanvas('set:brushed', buildBrushedSet); }
  function woodSet() { return cachedCanvas('set:wood', buildWoodSet); }
  function carbonSet() { return cachedCanvas('set:carbon', buildCarbonSet); }
  function fretSet() { return cachedCanvas('set:fret', buildFretSet); }
  function panelSet() { return cachedCanvas('set:panel', buildPanelSet); }
  function fabricSet() { return cachedCanvas('set:fabric', buildFabricSet); }
  function azulejoSet() { return cachedCanvas('set:azulejo', buildAzulejoSet); }

  /* getTex: cache + blindagem. Um gerador que exploda vira textura neutra e
   * o jogo continua — nunca tela preta por causa de textura. */
  function getTex(name) {
    if (texCache[name]) return texCache[name];
    autoAdopt();
    var gen = GENERATORS[name], t = null;
    if (!gen) {
      if (window.console && console.warn) console.warn('[GH.Materials] textura desconhecida: ' + name);
      return fallbackTexture();
    }
    t = textureFromCache(name);
    if (t) { texCache[name] = t; return t; }
    try {
      t = gen();
    } catch (e) {
      if (window.console && console.warn) console.warn('[GH.Materials] falha ao gerar "' + name + '": ' + (e && e.message));
      t = null;
    }
    if (t && t.image) texMade.push(name);
    if (!t) t = fallbackTexture();
    texCache[name] = t;
    return t;
  }

  /* ==========================================================================
   * 16. ATLAS — metadados e recorte de quadro
   * ======================================================================== */

  var ATLAS = {
    flame: { cols: 4, rows: 2, count: 8, tex: 'flame' },
    crowdDots: { cols: 4, rows: 4, count: 16, tex: 'crowdDots' },
    marajoara: { cols: 4, rows: 4, count: 16, tex: 'marajoara' },
    confetti: { cols: 4, rows: 4, count: 16, tex: 'confetti' }
  };

  /* UV do quadro i (indice 0 = celula superior-esquerda). Devolve
   * { offsetX, offsetY, repeatX, repeatY } no espaco UV do three.js
   * (origem no canto inferior-esquerdo). */
  function atlasUV(name, index) {
    var a = ATLAS[name];
    if (!a) return { offsetX: 0, offsetY: 0, repeatX: 1, repeatY: 1 };
    var i = imod(index | 0, a.count);
    var col = i % a.cols, row = (i / a.cols) | 0;
    return {
      offsetX: col / a.cols,
      offsetY: 1 - (row + 1) / a.rows,
      repeatX: 1 / a.cols,
      repeatY: 1 / a.rows
    };
  }

  /* Textura clonada apontando para um unico quadro do atlas. Cacheada:
   * pedir o mesmo quadro mil vezes custa uma vez so. */
  function atlasFrame(name, index) {
    var a = ATLAS[name];
    if (!a) return fallbackTexture();
    var i = imod(index | 0, a.count);
    var key = 'atlas:' + name + ':' + i;
    if (texCache[key]) return texCache[key];
    var src = getTex(a.tex);
    var t = cloneTex(src);
    if (t) {
      var uv = atlasUV(name, i);
      t.repeat.set(uv.repeatX, uv.repeatY);
      t.offset.set(uv.offsetX, uv.offsetY);
      t.name = key;
      t.needsUpdate = true;
    }
    texCache[key] = t || fallbackTexture();
    return texCache[key];
  }

  /* Aplica um quadro do atlas numa textura ja existente (sem alocar nada) —
   * o caminho quente para animar chama por frame sem gerar lixo. */
  function setAtlasFrame(texture, name, index) {
    if (!texture) return texture;
    var uv = atlasUV(name, index);
    texture.repeat.set(uv.repeatX, uv.repeatY);
    texture.offset.set(uv.offsetX, uv.offsetY);
    return texture;
  }

  /* ==========================================================================
   * 17. OBJETO PUBLICO tex.*  —  getters preguicosos
   * ======================================================================== */

  var tex = {};
  (function () {
    var names = [], k;
    for (k in GENERATORS) {
      if (GENERATORS.hasOwnProperty(k)) names.push(k);
    }
    var i;
    for (i = 0; i < names.length; i++) {
      (function (n) {
        Object.defineProperty(tex, n, {
          enumerable: true,
          configurable: true,
          get: function () { return getTex(n); }
        });
      })(names[i]);
    }

    /* Membros parametricos e utilitarios (nao sao getters). */
    Object.defineProperty(tex, 'gradientRamp', {
      enumerable: false, configurable: true, writable: true,
      value: function (colors, opts) {
        var key = 'ramp:' + (colors || []).map(function (c) {
          var r = colorToRGB01(c);
          return (r[0].toFixed(3) + ',' + r[1].toFixed(3) + ',' + r[2].toFixed(3));
        }).join('|') + ':' + JSON.stringify(opts || {});
        if (texCache[key]) return texCache[key];
        var t;
        try { t = buildGradientRamp(colors, opts); } catch (e) { t = fallbackTexture(); }
        texCache[key] = t || fallbackTexture();
        return texCache[key];
      }
    });
    Object.defineProperty(tex, 'get', {
      enumerable: false, configurable: true, writable: true,
      value: function (n) { return getTex(n); }
    });
    Object.defineProperty(tex, 'has', {
      enumerable: false, configurable: true, writable: true,
      value: function (n) { return GENERATORS.hasOwnProperty(n); }
    });
    Object.defineProperty(tex, 'names', {
      enumerable: false, configurable: true, writable: true,
      value: function () { return names.slice(); }
    });
    Object.defineProperty(tex, 'frame', {
      enumerable: false, configurable: true, writable: true,
      value: atlasFrame
    });
    Object.defineProperty(tex, 'clone', {
      enumerable: false, configurable: true, writable: true,
      value: function (n, repeatX, repeatY) {
        var t = cloneTex(getTex(n));
        if (t && repeatX != null) t.repeat.set(repeatX, repeatY == null ? repeatX : repeatY);
        return t;
      }
    });
  })();

  /* ==========================================================================
   * 18. PONTE COM A PALETA
   * ==========================================================================
   * palette.js manda na cor. Aqui so existe leitura defensiva + fallback,
   * para que materials.js funcione mesmo se carregado isolado (lint/teste).
   * ======================================================================== */

  function themeObj() {
    var P = GH.Palette;
    if (!P) return null;
    var t = P.current;
    if (typeof t === 'string' && P.themes) t = P.themes[t];
    if (t && typeof t === 'object') return t;
    if (P.themes && P.themes.para) return P.themes.para;
    return null;
  }

  /* Busca uma cor de tema por nome, com varias grafias aceitas. */
  function themeColor(keys, fallbackHex) {
    var P = GH.Palette, t = themeObj(), i, k;
    var list = (typeof keys === 'string') ? [keys] : keys;
    for (i = 0; i < list.length; i++) {
      k = list[i];
      if (t && t[k] != null) return toColor(t[k]);
      if (P && P.ui && P.ui[k] != null) return toColor(P.ui[k]);
      if (P && P[k] != null && typeof P[k] !== 'function') return toColor(P[k]);
    }
    return toColor(fallbackHex);
  }

  /* Tinta de tema com luminancia alvo. As cores de pista do tema sao MUITO
   * escuras (ex.: #150a20); usadas cruas como color de um material que ja tem
   * mapa escuro, o resultado vira preto e a textura some. Aqui preservamos
   * matiz/saturacao e levamos a luminancia para um valor que deixa o mapa
   * respirar. */
  function themeTint(keys, fallbackHex, targetL) {
    var c = themeColor(keys, fallbackHex);
    if (!c) return toColor(fallbackHex);
    var hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 0.85), targetL == null ? 0.45 : targetL);
  }

  function laneColor(i) {
    var P = GH.Palette;
    i = imod(i | 0, 5);
    if (P && P.lanes && P.lanes[i] != null) return toColor(P.lanes[i]);
    return toColor(LANE_FALLBACK[i]);
  }

  function laneEmissive(i) {
    var P = GH.Palette;
    i = imod(i | 0, 5);
    if (P && P.laneEmissive && P.laneEmissive[i] != null) return toColor(P.laneEmissive[i]);
    var c = laneColor(i);
    if (!c) return null;
    // sem cor de emissivo publicada: clareia e satura a cor da raia
    var hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.06), Math.min(1, hsl.l * 1.25 + 0.10));
  }

  /* Materiais que dependem da paleta se registram aqui para poderem ser
   * repintados quando GH.Palette.setTheme() rodar. */
  function bindPalette(mat, applyFn) {
    if (!mat) return mat;
    mat.userData.ghApplyPalette = applyFn;
    paletteBound.push(mat);
    try { applyFn(mat); } catch (e) {}
    return mat;
  }

  function refreshPalette() {
    var i;
    for (i = 0; i < paletteBound.length; i++) {
      try {
        var m = paletteBound[i];
        if (m && m.userData && m.userData.ghApplyPalette) {
          m.userData.ghApplyPalette(m);
          m.needsUpdate = true;
        }
      } catch (e) {}
    }
  }

  /* ==========================================================================
   * 19. ENVMAP  —  estudio procedural + PMREMGenerator
   * ==========================================================================
   * Sem envMap, metal vira cinza chapado e o clearcoat some. Montamos um
   * pequeno "estudio" 3D: ceu em gradiente equiretangular, chao escuro e
   * seis painéis emissivos (key quente, fill fria, rim magenta, softbox
   * branco no teto e duas barras laterais na cor do tema). O PMREM
   * pre-filtra isso em mipmaps de rugosidade — reflexo PBR de verdade,
   * de graca em runtime.
   * ======================================================================== */

  /* Ceu equiretangular: gradiente vertical + halo de refletores no horizonte. */
  function buildEnvSkyCanvas() {
    var W = 1024, H = 512, cv = makeCanvas(W, H), g = ctx2d(cv);
    var top = themeColor(['sky', 'skyTop', 'bgTop'], PIG.skyTop);
    var mid = themeColor(['horizon', 'skyHorizon', 'bgMid'], PIG.skyHorizon);
    var bot = themeColor(['shadow', 'fog', 'skyGround', 'ground'], PIG.skyGround);
    var grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.00, cssRGB([top.r, top.g, top.b]));
    grd.addColorStop(0.42, cssRGB([mid.r * 0.9, mid.g * 0.9, mid.b * 0.95]));
    grd.addColorStop(0.52, cssRGB([mid.r * 1.35 + 0.05, mid.g * 1.1, mid.b * 1.2]));
    grd.addColorStop(0.62, cssRGB([bot.r * 1.4, bot.g * 1.3, bot.b * 1.4]));
    grd.addColorStop(1.00, cssRGB([bot.r, bot.g, bot.b]));
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);

    // halos de refletor distribuidos no horizonte (dao variacao ao reflexo)
    var rng = makeRNG(SEED.env), i;
    // o tema publica stageLight como array de 3 cores de refletor — usamos
    // exatamente elas, para o reflexo do metal concordar com o palco
    var t = themeObj();
    var lampCols;
    if (t && t.stageLight && t.stageLight.length >= 3) {
      lampCols = [toColor(t.stageLight[0]), toColor(t.stageLight[1]), toColor(t.stageLight[2])];
    } else {
      lampCols = [
        themeColor(['accent', 'primary'], 0xff7a1f),
        themeColor(['neon', 'accent2', 'secondary'], 0x18d0ff),
        themeColor(['uiAccent', 'highwayEdge', 'accent3'], 0xff2d7a)
      ];
    }
    g.globalCompositeOperation = 'lighter';
    for (i = 0; i < 14; i++) {
      var lx = rng() * W, ly = H * (0.34 + rng() * 0.22);
      var lr = 60 + rng() * 150;
      var lc = lampCols[i % 3];
      var lg = g.createRadialGradient(lx, ly, 0, lx, ly, lr);
      lg.addColorStop(0, cssRGB([lc.r, lc.g, lc.b], 0.55));
      lg.addColorStop(0.35, cssRGB([lc.r, lc.g, lc.b], 0.16));
      lg.addColorStop(1, cssRGB([lc.r, lc.g, lc.b], 0));
      g.fillStyle = lg;
      g.beginPath(); g.arc(lx, ly, lr, 0, TAU); g.fill();
    }
    // faixa de luz do teto: e ela que vira o realce linear no cromado
    var strip = g.createLinearGradient(0, 0, 0, H * 0.16);
    strip.addColorStop(0, 'rgba(255,252,244,0.85)');
    strip.addColorStop(1, 'rgba(255,250,236,0)');
    g.fillStyle = strip;
    g.fillRect(0, 0, W, H * 0.16);
    g.globalCompositeOperation = 'source-over';
    return cv;
  }

  function buildEnvScene() {
    var scene = new THREE.Scene();
    var trash = { g: [], m: [], t: [] };

    function track(mesh) { scene.add(mesh); trash.g.push(mesh.geometry); trash.m.push(mesh.material); return mesh; }

    // --- ceu ---
    var skyCv = buildEnvSkyCanvas();
    var skyTex = new THREE.CanvasTexture(skyCv);
    skyTex.encoding = THREE.sRGBEncoding;
    skyTex.needsUpdate = true;
    trash.t.push(skyTex);
    track(new THREE.Mesh(
      new THREE.SphereGeometry(60, 32, 20),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, toneMapped: false, fog: false })
    ));

    // --- chao ---
    var floorColor = themeColor(['shadow', 'floor', 'stageFloor'], 0x0a0c12);
    var floor = track(new THREE.Mesh(
      new THREE.CircleGeometry(52, 40),
      new THREE.MeshBasicMaterial({ color: floorColor, toneMapped: false, fog: false })
    ));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -9;

    // --- paineis emissivos: cada um vira um realce especular distinto ---
    /* rotX/rotY explicitos desligam o lookAt — necessario para o painel do
     * teto, onde a direcao seria paralela ao vetor "up" e geraria NaN. */
    function panel(x, y, z, w, h, colorLike, intensity, rotX, rotY) {
      var col = toColor(colorLike).clone().multiplyScalar(intensity);
      var m = track(new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, toneMapped: false, fog: false })
      ));
      m.position.set(x, y, z);
      if (rotX != null || rotY != null) {
        m.rotation.set(rotX || 0, rotY || 0, 0);
      } else {
        m.lookAt(0, 0, 0);
      }
      return m;
    }

    var keyC = themeColor(['spotlight', 'keyLight', 'accent'], 0xffd9a8);
    var fillC = themeColor(['neon', 'fillLight', 'accent2'], 0x8fd8ff);
    var rimC = themeColor(['uiAccent', 'highwayEdge', 'rimLight'], 0xff3d92);
    var laneA = laneColor(0), laneB = laneColor(4);

    panel(-16, 10, -14, 22, 14, keyC, 3.4);      // key quente, alta esquerda
    panel(18, 7, -10, 18, 12, fillC, 1.5);       // fill fria, direita
    panel(0, 8, 22, 26, 10, rimC, 1.9);          // rim atras do jogador
    panel(0, 20, 0, 40, 22, 0xfff6e8, 2.2, Math.PI / 2, 0);  // softbox do teto
    panel(-24, 2, 6, 6, 20, laneA, 1.25);        // barra lateral esquerda
    panel(24, 2, 6, 6, 20, laneB, 1.25);         // barra lateral direita
    panel(0, -6, -26, 30, 4, keyC, 0.55);        // bounce do palco

    return {
      scene: scene,
      dispose: function () {
        var i;
        for (i = 0; i < trash.g.length; i++) { try { trash.g[i].dispose(); } catch (e) {} }
        for (i = 0; i < trash.m.length; i++) { try { trash.m[i].dispose(); } catch (e) {} }
        for (i = 0; i < trash.t.length; i++) { try { trash.t[i].dispose(); } catch (e) {} }
      }
    };
  }

  function buildEnvMap() {
    if (!renderer || !hasTHREE() || !THREE.PMREMGenerator) return null;
    var pmrem = null, built = null;
    // caminho principal: cena 3D procedural -> PMREM
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileCubemapShader();
      built = buildEnvScene();
      var rt = pmrem.fromScene(built.scene, 0.035, 0.5, 260);
      built.dispose();
      pmrem.dispose();
      envRT = rt;
      return rt.texture;
    } catch (e) {
      try { if (built) built.dispose(); } catch (e1) {}
      try { if (pmrem) pmrem.dispose(); } catch (e2) {}
      if (window.console && console.warn) console.warn('[GH.Materials] PMREM fromScene falhou, usando equirect: ' + (e && e.message));
    }
    // plano B: equiretangular direto do canvas do ceu
    try {
      var sky = new THREE.CanvasTexture(buildEnvSkyCanvas());
      sky.mapping = THREE.EquirectangularReflectionMapping;
      sky.encoding = THREE.sRGBEncoding;
      sky.needsUpdate = true;
      var p2 = new THREE.PMREMGenerator(renderer);
      p2.compileEquirectangularShader();
      var rt2 = p2.fromEquirectangular(sky);
      p2.dispose();
      sky.dispose();
      envRT = rt2;
      return rt2.texture;
    } catch (e3) {
      if (window.console && console.warn) console.warn('[GH.Materials] envMap indisponivel: ' + (e3 && e3.message));
      return null;
    }
  }

  /* Aplica o ambiente numa cena (o jeito certo: uma vez, na cena inteira). */
  function applyEnvironment(scene) {
    if (!scene || !envMapTex) return false;
    scene.environment = envMapTex;
    return true;
  }

  /* ==========================================================================
   * 20. FABRICAS DE MATERIAL  —  make.*
   * ==========================================================================
   * Regras fisicas seguidas aqui (o critico cobra isso):
   *   - metalness e 0 OU 1. Nada de 0.5 "porque ficou bonito".
   *   - verniz/laca = clearcoat, nao roughness baixa no material inteiro.
   *   - tecido = sheen, nao specular fake.
   *   - toda superficie grande tem normalMap e roughnessMap.
   *   - envMapIntensity calibrado por material (metal reflete mais que verniz).
   *
   * Os materiais sao CACHEADOS por chave. Se voce precisa mutar um material
   * so seu (opacidade animada, cor por instancia), peca uma copia com
   * GH.Materials.fresh('nome', ...args).
   * ======================================================================== */

  function cachedMat(key, factory) {
    if (matCache[key]) return matCache[key];
    autoAdopt();
    var m;
    try {
      m = factory();
    } catch (e) {
      if (window.console && console.warn) console.warn('[GH.Materials] falha em make.' + key + ': ' + (e && e.message));
      m = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6, metalness: 0 });
    }
    m.userData.ghKey = key;
    matCache[key] = m;
    allMaterials.push(m);
    return m;
  }

  /* Textura clonada com repeticao propria (para nao brigar com outro dono). */
  function rep(name, rx, ry) {
    var t = cloneTex(getTex(name));
    if (t) t.repeat.set(rx == null ? 1 : rx, ry == null ? (rx == null ? 1 : rx) : ry);
    return t;
  }

  var make = {};

  /* --- SUPERFICIE DA PISTA -------------------------------------------------
   * Painel tecnico escuro e envernizado. Escuro por decisao de leitura: as
   * gems precisam ser a coisa mais clara da tela. O clearcoat da o brilho
   * molhado de palco sem clarear o albedo. */
  make.highwaySurface = function (opts) {
    opts = opts || {};
    var rx = opts.repeatX == null ? 2 : opts.repeatX;
    var ry = opts.repeatY == null ? 14 : opts.repeatY;
    var key = 'highwaySurface:' + rx + ':' + ry + ':' + (opts.aoMap ? 1 : 0);
    return cachedMat(key, function () {
      var m = new THREE.MeshPhysicalMaterial({
        map: rep('techPanel', rx, ry),
        normalMap: rep('techPanelNormal', rx, ry),
        roughnessMap: rep('techPanelRough', rx, ry),
        color: 0xffffff,
        metalness: 0.0,
        roughness: 1.0,               // modulado pelo roughnessMap
        // verniz contido: em angulo rasante (que e como a camera ve a pista)
        // o Fresnel dispara e um clearcoat alto lava a pista de laranja,
        // matando o contraste com as gems. Este e o ponto de equilibrio.
        clearcoat: 0.42,
        clearcoatRoughness: 0.30,
        envMapIntensity: 0.42,
        normalScale: new THREE.Vector2(0.85, 0.85),
        dithering: true
      });
      // aoMap exige uv2 na geometria — so liga quando o dono garante isso
      if (opts.aoMap) m.aoMap = rep('techPanelAO', rx, ry);
      return bindPalette(m, function (mat) {
        mat.color.copy(themeTint(['highway', 'track'], 0x1a1426, 0.40));
      });
    });
  };

  /* --- BORDA / TRILHO DE FIBRA DE CARBONO --------------------------------- */
  make.carbonFiber = function (opts) {
    opts = opts || {};
    var rx = opts.repeatX == null ? 2 : opts.repeatX;
    var ry = opts.repeatY == null ? 24 : opts.repeatY;
    return cachedMat('carbonFiber:' + rx + ':' + ry, function () {
      return new THREE.MeshPhysicalMaterial({
        map: rep('carbonWeave', rx, ry),
        normalMap: rep('carbonWeaveNormal', rx, ry),
        roughnessMap: rep('carbonWeaveRough', rx, ry),
        metalness: 0.0,
        roughness: 0.9,
        clearcoat: 1.0,               // fibra de carbono e sempre laqueada
        clearcoatRoughness: 0.06,
        envMapIntensity: 1.15,
        normalScale: new THREE.Vector2(1.0, 1.0)
      });
    });
  };

  /* --- GEMS ----------------------------------------------------------------
   * variant: 'normal' | 'sp' (star power, cromada) | 'tap' | 'hopo' | 'open'
   * Corpo = resina colorida sobre nucleo emissivo, com verniz espesso. */
  make.gemBody = function (lane, variant) {
    variant = variant || 'normal';
    lane = imod(lane | 0, 5);
    return cachedMat('gemBody:' + lane + ':' + variant, function () {
      var m = new THREE.MeshPhysicalMaterial({
        metalness: variant === 'sp' ? 1.0 : 0.0,
        roughness: variant === 'sp' ? 0.13 : 0.26,
        clearcoat: 1.0,
        clearcoatRoughness: variant === 'tap' ? 0.18 : 0.05,
        envMapIntensity: variant === 'sp' ? 1.9 : 1.15,
        transparent: variant === 'tap',
        opacity: variant === 'tap' ? 0.88 : 1.0,
        sheen: 0.0
      });
      return bindPalette(m, function (mat) {
        var c = laneColor(lane), e = laneEmissive(lane);
        if (variant === 'sp') {
          // star power: cromo espelhado com um sopro da cor da raia
          mat.color.copy(toColor(0xdfe6f0)).lerp(c, 0.16);
          mat.emissive.copy(e).multiplyScalar(0.22);
        } else if (variant === 'tap') {
          // tap: gem escura translucida com nucleo aceso
          mat.color.copy(c).multiplyScalar(0.20);
          mat.emissive.copy(e).multiplyScalar(0.55);
        } else if (variant === 'hopo') {
          mat.color.copy(c).multiplyScalar(0.80);
          mat.emissive.copy(e).multiplyScalar(0.45);
        } else if (variant === 'open') {
          mat.color.copy(c).multiplyScalar(0.72);
          mat.emissive.copy(e).multiplyScalar(0.60);
        } else {
          mat.color.copy(c).multiplyScalar(1.0);
          mat.emissive.copy(e).multiplyScalar(0.30);
        }
      });
    });
  };

  /* Tampa da gem: o disco que o bloom pega. Emissivo forte + iridescencia
   * fina, que da aquele brilho de plastico caro / cristal. */
  make.gemTop = function (lane, variant) {
    variant = variant || 'normal';
    lane = imod(lane | 0, 5);
    return cachedMat('gemTop:' + lane + ':' + variant, function () {
      var m = new THREE.MeshPhysicalMaterial({
        metalness: variant === 'sp' ? 1.0 : 0.0,
        roughness: 0.14,
        clearcoat: 1.0,
        // a tampa e um disco virado para cima, bem embaixo do softbox do
        // envMap: com clearcoatRoughness quase zero o disco inteiro vira UM
        // realce branco. Espalhar o realce e o que preserva a cor da raia.
        clearcoatRoughness: 0.14,
        // iridescencia comedida: em excesso ela lava a cor da raia e as cinco
        // gems viram pastel indistinguivel — legibilidade vem antes do efeito
        iridescence: 0.15,
        iridescenceIOR: 1.62,
        envMapIntensity: 0.85,
        emissiveIntensity: 1.0
      });
      return bindPalette(m, function (mat) {
        var c = laneColor(lane), e = laneEmissive(lane);
        if (variant === 'sp') {
          mat.color.copy(toColor(0xf2f6ff));
          mat.emissive.copy(toColor(0xcfe4ff)).multiplyScalar(0.9);
        } else if (variant === 'tap') {
          mat.color.copy(toColor(0x11131a));
          mat.emissive.copy(e).multiplyScalar(1.1);
        } else {
          // cor pura da raia: a saturacao E a informacao de jogo.
          // Emissivo abaixo de 1.0 de proposito — acima disso o ACES joga o
          // pixel para o branco e as cinco raias viram o mesmo pastel.
          mat.color.copy(c);
          mat.emissive.copy(e).multiplyScalar(variant === 'hopo' ? 0.72 : 0.55);
        }
      });
    });
  };

  /* Aro metalico da gem / do HOPO: niquel escovado tingido pela raia. */
  make.gemRim = function (lane, variant) {
    variant = variant || 'normal';
    lane = imod(lane | 0, 5);
    return cachedMat('gemRim:' + lane + ':' + variant, function () {
      var m = new THREE.MeshStandardMaterial({
        map: rep('fretMetal', 2, 1),
        normalMap: rep('fretMetalNormal', 2, 1),
        roughnessMap: rep('fretMetalRough', 2, 1),
        metalness: 1.0,
        roughness: 0.7,
        envMapIntensity: 1.7
      });
      return bindPalette(m, function (mat) {
        if (variant === 'hopo') mat.color.copy(toColor(0xf4f6fa));
        else mat.color.copy(toColor(0xd8dde6)).lerp(laneColor(lane), 0.35);
      });
    });
  };

  /* --- AROS DE FRET (linha de acerto) -------------------------------------- */
  make.fretRing = function (lane) {
    lane = imod(lane | 0, 5);
    return cachedMat('fretRing:' + lane, function () {
      var m = new THREE.MeshPhysicalMaterial({
        map: rep('brushedMetal', 3, 1),
        normalMap: rep('brushedMetalNormal', 3, 1),
        roughnessMap: rep('brushedMetalRough', 3, 1),
        metalness: 1.0,
        // roughness MULTIPLICA o roughnessMap no three: 0.55 puxa o mapa
        // (0.2..0.7) para a faixa de aro polido, sem perder a anisotropia
        roughness: 0.55,
        clearcoat: 0.35,
        clearcoatRoughness: 0.25,
        envMapIntensity: 1.6,
        normalScale: new THREE.Vector2(0.7, 0.7)
      });
      return bindPalette(m, function (mat) {
        mat.color.copy(toColor(0xb9c2d0)).lerp(laneColor(lane), 0.30);
        mat.emissive.copy(laneEmissive(lane)).multiplyScalar(0.14);
      });
    });
  };

  /* Aro no estado aceso: metal quase apagado + emissivo estourado, para o
   * bloom desenhar o anel de luz sem lavar a geometria. */
  make.fretRingActive = function (lane) {
    lane = imod(lane | 0, 5);
    return cachedMat('fretRingActive:' + lane, function () {
      var m = new THREE.MeshPhysicalMaterial({
        map: rep('brushedMetal', 3, 1),
        normalMap: rep('brushedMetalNormal', 3, 1),
        metalness: 1.0,
        roughness: 0.14,
        clearcoat: 0.5,
        clearcoatRoughness: 0.12,
        envMapIntensity: 1.8,
        emissiveIntensity: 2.4
      });
      return bindPalette(m, function (mat) {
        mat.color.copy(toColor(0xe8edf6)).lerp(laneColor(lane), 0.30);
        mat.emissive.copy(laneEmissive(lane));
      });
    });
  };

  /* --- NEON / TUBO DE LUZ --------------------------------------------------
   * Nao iluminado de proposito: e uma fonte, nao um receptor. toneMapped
   * false mantem o pixel acima de 1.0 para o UnrealBloomPass morder. */
  make.neonTube = function (color, opts) {
    opts = opts || {};
    var c = toColor(color == null ? 0xff2d7a : color);
    var inten = opts.intensity == null ? 1.35 : opts.intensity;
    var key = 'neonTube:' + c.getHexString() + ':' + inten.toFixed(2) + ':' + (opts.transparent ? 1 : 0);
    return cachedMat(key, function () {
      return new THREE.MeshBasicMaterial({
        color: c.clone().multiplyScalar(inten),
        toneMapped: false,
        transparent: !!opts.transparent,
        opacity: opts.opacity == null ? 1 : opts.opacity,
        blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: opts.additive ? false : true,
        side: opts.side || THREE.FrontSide,
        fog: false
      });
    });
  };

  /* --- VIDRO ---------------------------------------------------------------
   * Padrao: vidro "barato" (refracao fake por envMap + clearcoat) porque
   * transmission real custa um render target inteiro. opts.transmission=true
   * liga o caminho fisicamente correto quando o plano vale a pena. */
  make.glass = function (opts) {
    opts = opts || {};
    var tint = toColor(opts.color == null ? 0xdff0ff : opts.color);
    var key = 'glass:' + tint.getHexString() + ':' + (opts.transmission ? 1 : 0);
    return cachedMat(key, function () {
      var base = {
        color: tint,
        metalness: 0.0,
        roughness: opts.roughness == null ? 0.05 : opts.roughness,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        ior: 1.46,
        envMapIntensity: 1.7,
        side: THREE.DoubleSide
      };
      if (opts.transmission) {
        base.transmission = 0.96;
        base.thickness = opts.thickness == null ? 0.35 : opts.thickness;
        base.attenuationColor = tint.clone();
        base.attenuationDistance = 1.6;
        base.transparent = true;
      } else {
        base.transparent = true;
        base.opacity = opts.opacity == null ? 0.22 : opts.opacity;
        base.specularIntensity = 1.0;
      }
      return new THREE.MeshPhysicalMaterial(base);
    });
  };

  /* --- CROMADO -------------------------------------------------------------
   * Metal puro. O que salva do "cromo de plastico" e o roughnessMap de
   * riscos: sem microimperfeicao o reflexo fica perfeito demais e falso. */
  make.chrome = function (opts) {
    opts = opts || {};
    var tint = toColor(opts.color == null ? 0xf0f4fa : opts.color);
    return cachedMat('chrome:' + tint.getHexString(), function () {
      return new THREE.MeshStandardMaterial({
        color: tint,
        metalness: 1.0,
        roughness: 0.075,
        roughnessMap: rep('brushedMetalRough', 1, 1),
        normalMap: rep('brushedMetalNormal', 1, 1),
        normalScale: new THREE.Vector2(0.18, 0.18),
        envMapIntensity: 2.0
      });
    });
  };

  /* --- ALUMINIO ESCOVADO --------------------------------------------------- */
  make.brushedAluminum = function (opts) {
    opts = opts || {};
    var rx = opts.repeatX == null ? 1 : opts.repeatX;
    var ry = opts.repeatY == null ? 1 : opts.repeatY;
    var tint = toColor(opts.color == null ? 0xffffff : opts.color);
    return cachedMat('brushedAluminum:' + tint.getHexString() + ':' + rx + ':' + ry, function () {
      return new THREE.MeshStandardMaterial({
        color: tint,
        map: rep('brushedMetal', rx, ry),
        normalMap: rep('brushedMetalNormal', rx, ry),
        roughnessMap: rep('brushedMetalRough', rx, ry),
        metalness: 1.0,
        roughness: 0.82,
        envMapIntensity: 1.55,
        normalScale: new THREE.Vector2(0.9, 0.9)
      });
    });
  };

  /* --- TECIDO COM SHEEN ---------------------------------------------------- */
  make.fabricSheen = function (color, opts) {
    opts = opts || {};
    var c = toColor(color == null ? 0x2a1030 : color);
    var rx = opts.repeatX == null ? 6 : opts.repeatX;
    return cachedMat('fabricSheen:' + c.getHexString() + ':' + rx, function () {
      return new THREE.MeshPhysicalMaterial({
        color: c,
        map: rep('fabricWeave', rx, rx),
        normalMap: rep('fabricWeaveNormal', rx, rx),
        normalScale: new THREE.Vector2(0.55, 0.55),
        metalness: 0.0,
        roughness: opts.roughness == null ? 0.88 : opts.roughness,
        sheen: 1.0,
        sheenRoughness: opts.sheenRoughness == null ? 0.32 : opts.sheenRoughness,
        sheenColor: toColor(opts.sheenColor == null ? 0xffd6ea : opts.sheenColor),
        envMapIntensity: 0.5,
        side: opts.side || THREE.FrontSide
      });
    });
  };
  make.fabric = make.fabricSheen;      // alias do contrato

  /* --- MADEIRA NOBRE ------------------------------------------------------- */
  make.wood = function (opts) {
    opts = opts || {};
    var rx = opts.repeatX == null ? 1 : opts.repeatX;
    var ry = opts.repeatY == null ? 3 : opts.repeatY;
    return cachedMat('wood:' + rx + ':' + ry, function () {
      return new THREE.MeshPhysicalMaterial({
        map: rep('woodJacaranda', rx, ry),
        normalMap: rep('woodJacarandaNormal', rx, ry),
        roughnessMap: rep('woodJacarandaRough', rx, ry),
        metalness: 0.0,
        roughness: 1.0,
        clearcoat: 0.85,              // verniz de luthier
        clearcoatRoughness: 0.10,
        envMapIntensity: 0.95,
        normalScale: new THREE.Vector2(0.75, 0.75)
      });
    });
  };

  /* --- TRASTE / FIO DE NIQUEL ---------------------------------------------- */
  make.fretWire = function () {
    return cachedMat('fretWire', function () {
      return new THREE.MeshStandardMaterial({
        map: rep('fretMetal', 1, 4),
        normalMap: rep('fretMetalNormal', 1, 4),
        roughnessMap: rep('fretMetalRough', 1, 4),
        metalness: 1.0,
        roughness: 0.62,
        envMapIntensity: 1.7
      });
    });
  };

  /* --- TELAO DE LED --------------------------------------------------------
   * Aceita a textura viva do agente de palco. Sem toneMapping para o telao
   * poder estourar e gerar bloom, como telao de verdade faz na camera. */
  make.ledScreen = function (mapTexture, opts) {
    opts = opts || {};
    var key = 'ledScreen:' + (mapTexture && mapTexture.uuid ? mapTexture.uuid : 'grid') + ':' + (opts.intensity || 1);
    return cachedMat(key, function () {
      return new THREE.MeshBasicMaterial({
        map: mapTexture || getTex('ledGrid'),
        color: toColor(opts.color == null ? 0xffffff : opts.color).multiplyScalar(opts.intensity == null ? 1 : opts.intensity),
        toneMapped: false,
        fog: false,
        side: opts.side || THREE.FrontSide
      });
    });
  };

  /* Mascara de pixel do LED: um plano ligeiramente a frente do telao, em
   * multiply, transforma qualquer imagem em "painel de LED" de verdade. */
  make.ledMask = function (opts) {
    opts = opts || {};
    var rx = opts.repeat == null ? 24 : opts.repeat;
    return cachedMat('ledMask:' + rx, function () {
      return new THREE.MeshBasicMaterial({
        map: rep('ledGrid', rx, rx),
        blending: THREE.MultiplyBlending,
        transparent: true,
        opacity: opts.opacity == null ? 0.55 : opts.opacity,
        depthWrite: false,
        toneMapped: false,
        fog: false
      });
    });
  };

  /* --- BORRACHA ------------------------------------------------------------ */
  make.rubber = function (color, opts) {
    opts = opts || {};
    var c = toColor(color == null ? PIG.rubberBase : color);
    return cachedMat('rubber:' + c.getHexString(), function () {
      return new THREE.MeshStandardMaterial({
        color: c,
        roughnessMap: rep('grunge', 3, 3),
        normalMap: rep('microNormal', 5, 5),
        normalScale: new THREE.Vector2(0.55, 0.55),
        metalness: 0.0,
        roughness: 0.94,
        envMapIntensity: 0.28
      });
    });
  };

  /* --- PLASTICO (usado com parcimonia e sempre com verniz) ----------------- */
  make.plastic = function (color, opts) {
    opts = opts || {};
    var c = toColor(color == null ? 0x1b1f2a : color);
    return cachedMat('plastic:' + c.getHexString(), function () {
      return new THREE.MeshPhysicalMaterial({
        color: c,
        metalness: 0.0,
        roughness: opts.roughness == null ? 0.42 : opts.roughness,
        clearcoat: 0.55,
        clearcoatRoughness: 0.22,
        // casca de laranja fina: e o que separa plastico moldado de esfera CG
        normalMap: rep('microNormal', 3, 3),
        normalScale: new THREE.Vector2(0.22, 0.22),
        envMapIntensity: 0.7
      });
    });
  };

  /* --- EMISSIVO PURO (UI 3D, linhas de beat, logotipos) -------------------- */
  make.emissiveUnlit = function (color, intensity, opts) {
    opts = opts || {};
    var c = toColor(color == null ? 0xffffff : color);
    var inten = intensity == null ? 1 : intensity;
    var key = 'emissiveUnlit:' + c.getHexString() + ':' + inten.toFixed(3) + ':' +
              (opts.transparent ? 1 : 0) + ':' + (opts.map ? opts.map.uuid : '-');
    return cachedMat(key, function () {
      return new THREE.MeshBasicMaterial({
        color: c.clone().multiplyScalar(inten),
        map: opts.map || null,
        alphaMap: opts.alphaMap || null,
        transparent: opts.transparent !== false,
        opacity: opts.opacity == null ? 1 : opts.opacity,
        depthWrite: opts.depthWrite == null ? false : opts.depthWrite,
        side: opts.side || THREE.DoubleSide,
        toneMapped: false,
        fog: false
      });
    });
  };

  /* --- PARTICULA ADITIVA ---------------------------------------------------
   * depthWrite:false + AdditiveBlending + toneMapped:false = o combo correto
   * para faisca/chama/brilho nao criar buraco preto nem serrilhar. */
  make.particleAdditive = function (texture, opts) {
    opts = opts || {};
    var t = texture || getTex('softGlow');
    var c = toColor(opts.color == null ? 0xffffff : opts.color);
    var key = 'particleAdditive:' + (t && t.uuid ? t.uuid : 'none') + ':' + c.getHexString() +
              ':' + (opts.vertexColors ? 1 : 0) + ':' + (opts.opacity == null ? 1 : opts.opacity);
    return cachedMat(key, function () {
      return new THREE.MeshBasicMaterial({
        map: t,
        color: c,
        transparent: true,
        opacity: opts.opacity == null ? 1 : opts.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: opts.depthTest === false ? false : true,
        side: THREE.DoubleSide,
        vertexColors: !!opts.vertexColors,
        toneMapped: false,
        fog: false
      });
    });
  };

  /* Versao THREE.Points (GPU, milhares de particulas sem custo de geometria) */
  make.particlePoints = function (texture, opts) {
    opts = opts || {};
    var t = texture || getTex('softGlow');
    var key = 'particlePoints:' + (t && t.uuid ? t.uuid : 'none') + ':' + (opts.size || 1) + ':' + (opts.vertexColors ? 1 : 0);
    return cachedMat(key, function () {
      return new THREE.PointsMaterial({
        map: t,
        size: opts.size == null ? 0.22 : opts.size,
        sizeAttenuation: opts.sizeAttenuation !== false,
        color: toColor(opts.color == null ? 0xffffff : opts.color),
        transparent: true,
        blending: opts.blending || THREE.AdditiveBlending,
        depthWrite: false,
        vertexColors: !!opts.vertexColors,
        toneMapped: false,
        fog: false
      });
    });
  };

  /* Sprite aditivo (billboard automatico) para flare e numeros flutuantes. */
  make.sprite = function (texture, opts) {
    opts = opts || {};
    var t = texture || getTex('flare');
    var key = 'sprite:' + (t && t.uuid ? t.uuid : 'none') + ':' + (opts.additive === false ? 0 : 1);
    return cachedMat(key, function () {
      return new THREE.SpriteMaterial({
        map: t,
        color: toColor(opts.color == null ? 0xffffff : opts.color),
        transparent: true,
        opacity: opts.opacity == null ? 1 : opts.opacity,
        blending: opts.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: opts.depthTest === false ? false : true,
        toneMapped: false,
        fog: false,
        rotation: opts.rotation || 0
      });
    });
  };

  /* --- INLAY MARAJOARA -----------------------------------------------------
   * O friso incrustado na pista. alphaMap recorta o grafismo, o emissivo faz
   * ele brilhar como madreperola sob a luz do palco. */
  make.marajoaraInlay = function (color, opts) {
    opts = opts || {};
    var c = toColor(color == null ? 0xffe6b0 : color);
    var rx = opts.repeatX == null ? 1 : opts.repeatX;
    var ry = opts.repeatY == null ? 1 : opts.repeatY;
    var key = 'marajoaraInlay:' + c.getHexString() + ':' + rx + ':' + ry + ':' + (opts.emissive == null ? 0.3 : opts.emissive);
    return cachedMat(key, function () {
      // emissivo baixo por padrao: o inlay e ornamento, nao pode competir
      // com as gems pela atencao do jogador
      var em = opts.emissive == null ? 0.30 : opts.emissive;
      return new THREE.MeshStandardMaterial({
        color: c,
        alphaMap: rep('marajoaraBand', rx, ry),
        normalMap: rep('marajoaraBandNormal', rx, ry),
        normalScale: new THREE.Vector2(0.6, 0.6),
        emissive: c.clone(),
        emissiveIntensity: em,
        transparent: true,
        depthWrite: false,
        alphaTest: 0.04,
        metalness: 0.0,
        roughness: 0.34,
        envMapIntensity: 1.1,
        side: THREE.DoubleSide
      });
    });
  };

  /* Glifo marajoara solto (indice do atlas), para ornamento de UI/palco. */
  make.marajoaraGlyph = function (index, color, opts) {
    opts = opts || {};
    var c = toColor(color == null ? 0xffd9a0 : color);
    return cachedMat('marajoaraGlyph:' + (index | 0) + ':' + c.getHexString(), function () {
      return new THREE.MeshBasicMaterial({
        color: c,
        alphaMap: atlasFrame('marajoara', index),
        transparent: true,
        depthWrite: false,
        alphaTest: 0.02,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
        opacity: opts.opacity == null ? 1 : opts.opacity
      });
    });
  };

  /* --- PAINEL DE AZULEJO --------------------------------------------------- */
  make.azulejoPanel = function (opts) {
    opts = opts || {};
    var r = opts.repeat == null ? 3 : opts.repeat;
    return cachedMat('azulejoPanel:' + r, function () {
      return new THREE.MeshPhysicalMaterial({
        map: rep('azulejo', r, r),
        normalMap: rep('azulejoNormal', r, r),
        normalScale: new THREE.Vector2(0.6, 0.6),
        metalness: 0.0,
        roughness: 0.28,
        clearcoat: 1.0,               // esmalte ceramico vitrificado
        clearcoatRoughness: 0.06,
        envMapIntensity: 1.0
      });
    });
  };

  /* --- PUBLICO -------------------------------------------------------------
   * alphaTest em vez de transparent: mantem ordenacao correta com milhares de
   * silhuetas instanciadas e nao paga blending por pixel. */
  make.crowdSilhouette = function (color, opts) {
    opts = opts || {};
    var c = toColor(color == null ? PIG.crowdDark : color);
    return cachedMat('crowdSilhouette:' + c.getHexString() + ':' + (opts.vertexColors ? 1 : 0), function () {
      return new THREE.MeshBasicMaterial({
        color: c,
        map: getTex('crowdDots'),
        alphaTest: 0.42,
        transparent: false,
        side: THREE.DoubleSide,
        vertexColors: !!opts.vertexColors,
        fog: true
      });
    });
  };

  /* --- CONE VOLUMETRICO DE REFLETOR ---------------------------------------- */
  make.volumetricCone = function (color, opts) {
    opts = opts || {};
    var c = toColor(color == null ? 0xffffff : color);
    var key = 'volumetricCone:' + c.getHexString() + ':' + (opts.opacity == null ? 0.16 : opts.opacity);
    return cachedMat(key, function () {
      return new THREE.MeshBasicMaterial({
        color: c,
        alphaMap: tex.gradientRamp([0xffffff, 0x9a9a9a, 0x000000], { vertical: true, stops: [0, 0.45, 1], srgb: false }),
        transparent: true,
        opacity: opts.opacity == null ? 0.16 : opts.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false
      });
    });
  };

  /* --- HOLOGRAMA / SCANLINE ------------------------------------------------ */
  make.hologram = function (color, opts) {
    opts = opts || {};
    var c = toColor(color == null ? 0x39e0ff : color);
    return cachedMat('hologram:' + c.getHexString(), function () {
      return new THREE.MeshBasicMaterial({
        color: c,
        map: rep('hexGrid', 4, 4),
        alphaMap: rep('hexGrid', 4, 4),
        transparent: true,
        opacity: opts.opacity == null ? 0.55 : opts.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false
      });
    });
  };

  /* Copia independente de um material da fabrica — para quem precisa mutar
   * cor/opacidade sem afetar os outros donos do mesmo material. */
  function freshMat(name) {
    var fn = make[name];
    if (typeof fn !== 'function') return null;
    var args = Array.prototype.slice.call(arguments, 1);
    var base = fn.apply(make, args);
    if (!base) return null;
    var c = base.clone();
    c.userData.ghKey = (base.userData.ghKey || name) + ':fresh';
    if (base.userData.ghApplyPalette) bindPalette(c, base.userData.ghApplyPalette);
    allMaterials.push(c);
    return c;
  }

  /* ==========================================================================
   * 21. UTILITARIO PUBLICO: normalFromHeight
   * ==========================================================================
   * Aceita canvas, THREE.Texture (usa .image) ou nome de textura do registro.
   * Devolve THREE.Texture em espaco linear pronta para normalMap. O canvas
   * gerado fica acessivel em .image, para quem quiser recompor.
   *   opts: { blur:1, clamp:false, asCanvas:false, name:'' }
   * ======================================================================== */
  function normalFromHeight(source, strength, opts) {
    opts = opts || {};
    var cvv = null;
    if (typeof source === 'string') {
      var t0 = getTex(source);
      cvv = t0 && t0.image ? t0.image : null;
    } else if (source && source.isTexture) {
      cvv = source.image;
    } else if (source && source.getContext) {
      cvv = source;
    }
    if (!cvv || !cvv.width) return fallbackTexture();
    var blurAmt = opts.blur == null ? 0 : opts.blur;
    var src = blurAmt > 0 ? blurCanvas(cvv, blurAmt) : cvv;
    var field = canvasToField(src);
    var out = normalCanvasFromField(field, src.width, src.height, strength == null ? 1 : strength);
    if (opts.asCanvas) return out;
    return texFromCanvas(out, {
      clamp: !!opts.clamp,
      name: opts.name || 'normalFromHeight'
    });
  }

  /* Roughness procedural a partir do mesmo heightmap: cavidade retem
   * sujeira e espalha luz, crista e polida pelo uso. */
  function roughnessFromHeight(source, base, range, opts) {
    opts = opts || {};
    var cvv = (typeof source === 'string') ? (getTex(source).image)
            : (source && source.isTexture ? source.image : source);
    if (!cvv || !cvv.width) return fallbackTexture();
    var field = canvasToField(cvv);
    var b = base == null ? 0.35 : base;
    var r = range == null ? 0.45 : range;
    var i, n = field.length, out = new Float32Array(n);
    for (i = 0; i < n; i++) out[i] = clamp01(b + (1 - field[i]) * r);
    var canvas = fieldToCanvas(out, cvv.width, cvv.height);
    if (opts.asCanvas) return canvas;
    return texFromCanvas(canvas, { clamp: !!opts.clamp, name: opts.name || 'roughnessFromHeight' });
  }

  /* AO procedural a partir do heightmap (cavidade = sombra de contato). */
  function aoFromHeight(source, radius, opts) {
    opts = opts || {};
    var cvv = (typeof source === 'string') ? (getTex(source).image)
            : (source && source.isTexture ? source.image : source);
    if (!cvv || !cvv.width) return fallbackTexture();
    var field = canvasToField(cvv);
    var canvas = aoCanvasFromField(field, cvv.width, cvv.height, radius == null ? 5 : radius, 1.5);
    if (opts.asCanvas) return canvas;
    return texFromCanvas(canvas, { clamp: !!opts.clamp, name: opts.name || 'aoFromHeight' });
  }

  /* ==========================================================================
   * 22. INIT / PRELOAD / DISPOSE
   * ======================================================================== */

  /* Reaplica anisotropia em texturas ja criadas quando o renderer chega
   * depois delas (ordem de init entre agentes nao e garantida). */
  function refreshAnisotropy() {
    var i;
    for (i = 0; i < allTextures.length; i++) {
      var t = allTextures[i];
      if (t && t.generateMipmaps && t.anisotropy < maxAniso) {
        t.anisotropy = maxAniso;
        t.needsUpdate = true;
      }
    }
  }

  /* Envolve GH.Palette.setTheme para que trocar de tema repinte os materiais
   * que dependem de cor de raia/pista. Nao altera o comportamento original —
   * so pendura um efeito colateral depois dele. */
  function hookPalette() {
    var P = GH.Palette;
    if (!P || typeof P.setTheme !== 'function' || P.setTheme.__ghWrapped) return;
    var orig = P.setTheme;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      try { refreshPalette(); } catch (e) {}
      return r;
    };
    wrapped.__ghWrapped = true;
    try { P.setTheme = wrapped; } catch (e) {}
  }

  /* Auto-adocao do renderer.
   * O contrato diz que ENGINE chama GH.Materials.init(renderer) — mas se isso
   * nao acontecer (ordem de boot, modo captura, teste isolado), nao podemos
   * ficar sem envMap nem sem anisotropia. Entao qualquer pedido de textura ou
   * material tenta adotar GH.Engine.renderer sozinho. Barato: so roda de
   * verdade uma vez. */
  var _adoptGuard = false;
  function autoAdopt() {
    if (_adoptGuard) return;
    try {
      var E = GH.Engine;
      if (!initialized) {
        if (E && E.renderer) {
          _adoptGuard = true;
          try { init(E.renderer, E.scene || null); } finally { _adoptGuard = false; }
        }
      } else if (envMapTex && E && E.scene && E.scene.environment !== envMapTex) {
        // a cena pode ter nascido depois do init
        applyEnvironment(E.scene);
      }
    } catch (e) { _adoptGuard = false; }
  }

  /* Tentativas adiadas: cobrem o caso em que ninguem pede material cedo, mas
   * a cena ja existe e merece scene.environment desde o primeiro frame. */
  function scheduleAdopt() {
    var tries = 0;
    var tick = function () {
      tries++;
      try { autoAdopt(); } catch (e) {}
      if (!initialized && tries < 12) setTimeout(tick, tries < 4 ? 0 : 120);
    };
    setTimeout(tick, 0);
  }

  /* init(renderer, scene?)
   * Chamado pelo agente ENGINE assim que o WebGLRenderer existe. Idempotente:
   * chamar de novo so reaplica anisotropia/ambiente. */
  function init(rendererIn, sceneIn) {
    try {
      if (rendererIn) {
        renderer = rendererIn;
        if (renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
          maxAniso = Math.max(1, renderer.capabilities.getMaxAnisotropy());
        }
      }
    } catch (e) { maxAniso = 8; }

    refreshAnisotropy();
    hookPalette();
    refreshPalette();

    if (!envMapTex && renderer) {
      envMapTex = buildEnvMap();
      API.envMap = envMapTex;
    }

    var scene = sceneIn || (GH.Engine && GH.Engine.scene) || null;
    if (scene) applyEnvironment(scene);

    initialized = true;
    return API;
  }

  /* Gera antecipadamente um conjunto de texturas (tela de carregamento).
   * Sem lista, gera tudo — util no modo captura, onde nao existe frame
   * "sobrando" para pagar a geracao no meio da simulacao. */
  function preload(names) {
    var list = names && names.length ? names : tex.names();
    var i, done = 0;
    for (i = 0; i < list.length; i++) {
      try { getTex(list[i]); done++; } catch (e) {}
    }
    return done;
  }

  /* Diagnostico leve: quantos recursos vivos, quanto de canvas gerado. */
  function stats() {
    var texN = 0, k, pixels = 0;
    for (k in texCache) { if (texCache.hasOwnProperty(k)) texN++; }
    for (k in canvasCache) {
      if (!canvasCache.hasOwnProperty(k)) continue;
      var c = canvasCache[k];
      if (c && c.width) pixels += c.width * c.height;
      else if (c) {
        var kk;
        for (kk in c) { if (c.hasOwnProperty(kk) && c[kk] && c[kk].width) pixels += c[kk].width * c[kk].height; }
      }
    }
    return {
      textures: texN,
      texturesAllocated: allTextures.length,
      materials: allMaterials.length,
      canvasMegapixels: Math.round(pixels / 1e5) / 10,
      anisotropy: maxAniso,
      envMap: !!envMapTex,
      initialized: initialized
    };
  }

  function disposeAll() {
    var i, k;
    for (i = 0; i < allTextures.length; i++) {
      try { if (allTextures[i]) allTextures[i].dispose(); } catch (e) {}
    }
    for (i = 0; i < allMaterials.length; i++) {
      try { if (allMaterials[i]) allMaterials[i].dispose(); } catch (e) {}
    }
    try { if (envRT && envRT.dispose) envRT.dispose(); } catch (e) {}
    allTextures.length = 0;
    allMaterials.length = 0;
    paletteBound.length = 0;
    for (k in texCache) { if (texCache.hasOwnProperty(k)) delete texCache[k]; }
    for (k in canvasCache) { if (canvasCache.hasOwnProperty(k)) delete canvasCache[k]; }
    for (k in matCache) { if (matCache.hasOwnProperty(k)) delete matCache[k]; }
    envRT = null;
    envMapTex = null;
    _fallbackTex = null;
    API.envMap = null;
    initialized = false;
  }

  /* Escala global de resolucao de textura. Deve ser chamada ANTES da primeira
   * geracao (tipicamente por GH.Engine.setQuality no boot). */
  function setTextureScale(s) {
    texScale = clamp(s || 1, 0.25, 2);
    return texScale;
  }

  /* Perfil pronto por nivel de qualidade — o engine so precisa repassar. */
  function setQuality(q) {
    if (q === 'low') setTextureScale(0.5);
    else if (q === 'med') setTextureScale(0.75);
    else if (q === 'ultra') setTextureScale(1);
    else setTextureScale(1);
    return texScale;
  }

  /* Acesso ao canvas fonte (o agente de MENUS pode reaproveitar a arte
   * marajoara em HTML via toDataURL, sem gerar nada de novo). */
  function canvasOf(name) {
    var t = getTex(name);
    return (t && t.image) ? t.image : null;
  }
  function dataURLOf(name) {
    var c = canvasOf(name);
    try { return c ? c.toDataURL('image/png') : ''; } catch (e) { return ''; }
  }

  /* ==========================================================================
   * 23. API PUBLICA
   * ======================================================================== */

  var API = {
    // ciclo de vida
    init: init,
    disposeAll: disposeAll,
    preload: preload,
    prefetchTextures: prefetchTextures,     // cache entre aberturas (4B)
    saveTextureCache: saveTextureCache,
    setTextureScale: setTextureScale,
    setQuality: setQuality,
    stats: stats,

    // texturas
    tex: tex,
    gradientRamp: function (colors, opts) { return tex.gradientRamp(colors, opts); },
    canvas: canvasOf,
    dataURL: dataURLOf,

    // atlas
    atlas: ATLAS,
    atlasUV: atlasUV,
    frame: atlasFrame,
    setAtlasFrame: setAtlasFrame,

    // mapas derivados
    normalFromHeight: normalFromHeight,
    roughnessFromHeight: roughnessFromHeight,
    aoFromHeight: aoFromHeight,

    // ambiente
    envMap: null,
    applyEnvironment: applyEnvironment,

    // materiais
    make: make,
    fresh: freshMat,
    refreshPalette: refreshPalette,

    // introspeccao (util para depuracao dos outros agentes)
    get renderer() { return renderer; },
    get maxAnisotropy() { return maxAniso; },
    get ready() { return initialized; }
  };

  GH.Materials = API;

  /* Rede de seguranca: se o ENGINE esquecer de chamar init(), nos adotamos o
   * renderer assim que ele existir. Nunca lanca, nunca bloqueia o boot. */
  try { scheduleAdopt(); } catch (e) {}

})(window.GH = window.GH || {});

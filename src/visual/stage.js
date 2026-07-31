/* ===========================================================================
   GUITARRADA HERO — src/visual/stage.js
   ---------------------------------------------------------------------------
   O MUNDO ATRAS DA PISTA. Sem isto o jogo e uma pista flutuando no vazio;
   com isto e um SHOW.

   O que existe aqui:
     - CENARIO      ceu de entardecer + 4 camadas de parallax (Ver-o-Peso,
                    barcos, mangueiras, rio Guajara com reflexo do sol)
     - PUBLICO      ~4000 silhuetas instanciadas em leque com desnivel,
                    pulando em ONDA que atravessa a multidao no beat, bracos
                    levantados, + ~1700 celulares acesos
     - PALCO        praticavel, barricada, torres de PA, caixotes
     - BANDA        6 musicos low-poly com esqueleto procedural
     - TELAO DE LED painel com conteudo reativo em CanvasTexture (baixa freq.)
     - RIG DE LUZ   trelica + 18 moving heads com CONE VOLUMETRICO em shader
                    proprio (fresnel + ruido rolando), blinders, strobes
     - HAZE         planos cruzados de fumaca (aditivo) — sem isto o cone de
                    luz nao existe
     - CONFETE      pool instanciado para o final de 5 estrelas

   DECISOES DE GEOMETRIA (o resto do arquivo depende delas):
     - Camera de gameplay em (0, 3.05, 6.35) => o HORIZONTE cai em ~24% da
       altura da tela. Tudo que precisa ser lido em silhueta (cabecas do
       publico, banda, trelica) mora entre 3% e 40% da tela.
     - A pista (y=0) passa POR BAIXO do praticavel (topo y=2.30, frente
       z=-30): a highway "nasce" de dentro do palco, como no Guitar Hero.
     - O publico ocupa um LEQUE centrado em (0, -30) com raio 3..38, com o
       corredor da pista (|x| < ~3.5) vazio — espetaculo nunca tapa nota.

   PERFORMANCE:
     - Publico: 2 InstancedMesh de corpo 3D + 1 InstancedMesh de billboard
       cruzado. A animacao por frame escreve UM vec2 por instancia num
       InstancedBufferAttribute (nao a matriz inteira): ~25 KB/frame em vez
       de 260 KB.
     - Iluminacao do publico e FALSA: gradiente assado em cor de vertice
       (contraluz de cima/tras) x cor por instancia. Custo zero.
     - Nada no palco projeta sombra. Geometria mesclada onde da.

   Dono: agente PALCO. Comentarios em portugues, identificadores em ingles.
   =========================================================================== */
(function (GH) {
  'use strict';

  /* =========================================================================
     0. ATALHOS E ESTADO
     ========================================================================= */

  var TAU = Math.PI * 2;
  var PI = Math.PI;

  var U = null;                    /* GH.Util  — resolvido no init  */
  var P = null;                    /* GH.Palette                     */
  var M = null;                    /* GH.Materials                   */

  var scene = null;
  var group = null;                /* GH_Stage — raiz de tudo        */
  var inited = false;
  var disposed = false;

  /* recursos criados por nos (dispose limpa tudo) */
  var ownedGeo = [];
  var ownedMat = [];
  var ownedTex = [];

  /* tema corrente */
  var theme = null;
  var themeId = 'para';

  /* dinamica do show */
  var intensity = 0.5;             /* alvo vindo do Game            */
  var intensitySmooth = 0.5;       /* amortecido                    */
  var starPower = false;
  var spMix = 0;                   /* 0..1 amortecido               */
  var beatPos = 0;                 /* posicao em batidas (float)    */
  var barPos = 0;
  var lastBeatIndex = -1;
  var beatPulse = 0;               /* decai a cada beat             */
  var barPulse = 0;
  var elapsed = 0;                 /* tempo do palco (s)            */
  var idleBpm = 104;               /* relogio proprio fora da musica*/

  /* reacoes do publico */
  var crowdMood = 1;               /* 1 = animado, 0 = sentado/vaia */
  var crowdMoodTarget = 1;
  var crowdSurge = 0;              /* pico momentaneo de euforia    */
  var blinderHit = 0;              /* 0..1 decai                    */
  var strobeLevel = 0;             /* 0..1                          */
  var strobePhase = 0;

  /* diagnostico leve (nunca vaza para a UI) */
  var log = [];
  function warn(where, e) {
    if (log.length < 24) log.push(where + ': ' + (e && e.message ? e.message : e));
  }
  function safe(fn) { try { return fn(); } catch (e) { warn('stage', e); return null; } }

  /* =========================================================================
     1. GEOMETRIA MESTRE DO PALCO
     Estes numeros sao a fonte da verdade deste arquivo. Foram calculados
     contra a camera de gameplay do contrato — ver cabecalho.
     ========================================================================= */

  var GEO = {
    pitY:        0.95,    /* chao da plateia junto ao palco                */
    deckY:       2.30,    /* topo do praticavel                           */
    deckFrontZ: -30.0,
    deckBackZ:  -50.0,
    deckHalfW:   15.5,
    riserY:      3.06,    /* praticavel da bateria                        */

    ledZ:       -46.6, ledY0: 3.42, ledY1: 7.85, ledHalfW: 11.2,

    trussY:      8.45, trussZ: -27.4, trussHalfW: 15.2,
    truss2Y:     9.70, truss2Z: -42.0,
    towerX:      14.7,

    crowdCX:     0.0,  crowdCZ: -30.0,   /* foco do leque de publico       */
    crowdRMin:   3.4,  crowdRMax: 47.0,
    crowdZLimit: -3.5,                   /* nada mais perto que isto       */
    crowdMinCamDist: 11.0,               /* distancia minima da lente      */
    crowdSideOnlyZ: -11.0,               /* dai pra frente, so pelos lados */
    /* 8.0 abria um corredor de terreno CHAPADO de uns 4 metros entre o
       trilho da pista e a primeira fila — o "espaco morto" que aparecia como
       uma faixa vermelho-escura larga nos dois lados do quadro. Em 5.2 o
       publico encosta na barricada e vira MOLDURA da pista, que e o que
       Guitar Hero Live e Rock Band fazem. */
    crowdSideX:  5.2,
    corridorBase: 3.42, corridorSlope: 0.030,

    /* Cupula do ceu em vez de plano: qualquer camera, qualquer angulo, nunca
       aparece a borda do ceu (o plano mostrava o canto na cinematografica). */
    skyR:       165.0, skyCZ: -10.0,
    farZ:      -152.0,
    midZ:      -126.0,
    nearZ:     -105.0,
    waterZ0:    -96.0, waterZ1: -190.0, waterY: 0.28,
    groundY:     0.62
  };

  /* Quantidade de publico por nivel de qualidade (multiplicada por
     Engine.qualityScale.crowd quando ele existir). */
  var CROWD_TARGET = 4200;

  /* =========================================================================
     2. UTILITARIOS LOCAIS
     ========================================================================= */

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function damp(a, b, lambda, dt) { return b + (a - b) * Math.exp(-lambda * dt); }

  function keep(o) {
    if (!o) return o;
    if (o.isBufferGeometry) ownedGeo.push(o);
    else if (o.isMaterial) ownedMat.push(o);
    else if (o.isTexture) ownedTex.push(o);
    return o;
  }

  /* Cor do tema, sempre um THREE.Color novo (nunca devolvemos a cor da
     paleta viva — mutar ela quebraria todo mundo). */
  function tc(key, fallback) {
    try {
      var t = theme || (P && P.current);
      if (t && t[key] && t[key].isColor) return t[key].clone();
      if (t && t.hex && t.hex[key]) return new THREE.Color(t.hex[key]);
    } catch (e) { /* cai no fallback */ }
    return new THREE.Color(fallback === undefined ? 0x888888 : fallback);
  }
  function tcss(key, fallback) {
    var t = theme || (P && P.current);
    if (t && t.hex && t.hex[key]) return t.hex[key];
    return fallback || '#888888';
  }
  /* Cor n do array stageLight do tema. */
  function stageLightColor(i) {
    var t = theme || (P && P.current);
    if (t && t.stageLight && t.stageLight.length) {
      return t.stageLight[((i % t.stageLight.length) + t.stageLight.length) % t.stageLight.length].clone();
    }
    return new THREE.Color(0xff5a1e);
  }
  function stageLightCount() {
    var t = theme || (P && P.current);
    return (t && t.stageLight && t.stageLight.length) ? t.stageLight.length : 1;
  }
  function sunsetCss(i) {
    var t = theme || (P && P.current);
    if (t && t.hex && t.hex.sunset && t.hex.sunset.length) {
      return t.hex.sunset[clamp(i, 0, t.hex.sunset.length - 1)];
    }
    return '#ff9a3c';
  }

  /* --- merge manual de BufferGeometry (nao ha BufferGeometryUtils no vendor)
     Aceita [{geo, matrix}] e devolve UMA geometria nao-indexada com
     position/normal/uv/color. Usada em trelica, praticavel, corpo do publico
     e instrumentos: transforma dezenas de draw calls em uma. */
  function mergeGeometries(parts) {
    var i, total = 0, p, g, nonIndexed = [];
    for (i = 0; i < parts.length; i++) {
      g = parts[i].geo;
      if (g.index) g = g.toNonIndexed();
      nonIndexed.push(g);
      total += g.attributes.position.count;
    }
    var pos = new Float32Array(total * 3);
    var nor = new Float32Array(total * 3);
    var uv  = new Float32Array(total * 2);
    var col = new Float32Array(total * 3);
    var off = 0;
    var v = new THREE.Vector3();
    var nm = new THREE.Matrix3();
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      g = nonIndexed[i];
      var n = g.attributes.position.count;
      var mtx = p.matrix || null;
      var ap = g.attributes.position.array;
      var an = g.attributes.normal ? g.attributes.normal.array : null;
      var au = g.attributes.uv ? g.attributes.uv.array : null;
      var cr = p.color ? p.color.r : 1, cg = p.color ? p.color.g : 1, cb = p.color ? p.color.b : 1;
      if (mtx) nm.getNormalMatrix(mtx);
      for (var k = 0; k < n; k++) {
        v.set(ap[k * 3], ap[k * 3 + 1], ap[k * 3 + 2]);
        if (mtx) v.applyMatrix4(mtx);
        pos[(off + k) * 3] = v.x; pos[(off + k) * 3 + 1] = v.y; pos[(off + k) * 3 + 2] = v.z;
        if (an) {
          v.set(an[k * 3], an[k * 3 + 1], an[k * 3 + 2]);
          if (mtx) v.applyMatrix3(nm).normalize();
          nor[(off + k) * 3] = v.x; nor[(off + k) * 3 + 1] = v.y; nor[(off + k) * 3 + 2] = v.z;
        } else { nor[(off + k) * 3 + 1] = 1; }
        if (au) { uv[(off + k) * 2] = au[k * 2]; uv[(off + k) * 2 + 1] = au[k * 2 + 1]; }
        col[(off + k) * 3] = cr; col[(off + k) * 3 + 1] = cg; col[(off + k) * 3 + 2] = cb;
      }
      off += n;
      if (nonIndexed[i] !== parts[i].geo) nonIndexed[i].dispose();
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return out;
  }

  /* Matriz de conveniencia para o merge. */
  var _mtx = null, _q = null, _v3 = null, _eu = null;
  function TRS(x, y, z, rx, ry, rz, sx, sy, sz) {
    if (!_mtx) { _mtx = new THREE.Matrix4(); _q = new THREE.Quaternion(); _v3 = new THREE.Vector3(); _eu = new THREE.Euler(); }
    _eu.set(rx || 0, ry || 0, rz || 0);
    _q.setFromEuler(_eu);
    return new THREE.Matrix4().compose(
      new THREE.Vector3(x || 0, y || 0, z || 0), _q,
      new THREE.Vector3(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz)
    );
  }

  /* --- MATERIAL COM RIM LIGHT (fresnel) ------------------------------------
     MeshStandardMaterial + injecao de fresnel no emissivo. E o que impede a
     banda de sair "chapada": mesmo no escuro, a borda do corpo recebe a cor
     do contraluz. Uniforms sao POR MATERIAL (o three clona os uniforms de
     cada material antes de chamar onBeforeCompile). */
  function rimStandard(opts) {
    opts = opts || {};
    var m = new THREE.MeshStandardMaterial({
      color: opts.color === undefined ? 0x14101c : opts.color,
      roughness: opts.roughness === undefined ? 0.72 : opts.roughness,
      metalness: opts.metalness === undefined ? 0.10 : opts.metalness,
      envMapIntensity: opts.envMapIntensity === undefined ? 0.45 : opts.envMapIntensity,
      fog: opts.fog !== false,
      side: opts.side || THREE.FrontSide,
      vertexColors: !!opts.vertexColors
    });
    var u = {
      ghRimColor: { value: new THREE.Color(opts.rim === undefined ? 0xff3d8a : opts.rim) },
      ghRimPower: { value: opts.rimPower === undefined ? 2.4 : opts.rimPower },
      ghRimStrength: { value: opts.rimStrength === undefined ? 1.0 : opts.rimStrength },
      ghTopColor: { value: new THREE.Color(opts.top === undefined ? 0x000000 : opts.top) },
      ghTopStrength: { value: opts.topStrength === undefined ? 0.0 : opts.topStrength }
    };
    m.userData.ghU = u;
    m.onBeforeCompile = function (shader) {
      shader.uniforms.ghRimColor = u.ghRimColor;
      shader.uniforms.ghRimPower = u.ghRimPower;
      shader.uniforms.ghRimStrength = u.ghRimStrength;
      shader.uniforms.ghTopColor = u.ghTopColor;
      shader.uniforms.ghTopStrength = u.ghTopStrength;
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {',
          'uniform vec3 ghRimColor;\nuniform float ghRimPower;\nuniform float ghRimStrength;\n' +
          'uniform vec3 ghTopColor;\nuniform float ghTopStrength;\nvoid main() {')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' +
          'float ghNdV = clamp( dot( normalize( vViewPosition ), normal ), 0.0, 1.0 );\n' +
          'totalEmissiveRadiance += ghRimColor * pow( 1.0 - ghNdV, ghRimPower ) * ghRimStrength;\n' +
          'totalEmissiveRadiance += ghTopColor * ghTopStrength * clamp( normal.y * 0.5 + 0.5, 0.0, 1.0 );');
    };
    m.customProgramCacheKey = function () { return 'ghRim'; };
    return keep(m);
  }

  /* --- MATERIAL DE INSTANCIA COM DESLOCAMENTO (publico) --------------------
     Injeta um attribute instanciado `aOff` (vec2) somado em espaco de mundo
     DEPOIS da instanceMatrix. Assim o pulo/gingado do publico custa 2 floats
     por instancia por frame em vez de uma matriz 4x4 inteira. */
  function attachInstanceOffset(mat) {
    var prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader) {
      if (prev) prev(shader);
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'attribute vec2 aOff;\nvoid main() {')
        .replace('#include <project_vertex>',
          'vec4 mvPosition = vec4( transformed, 1.0 );\n' +
          '#ifdef USE_INSTANCING\n  mvPosition = instanceMatrix * mvPosition;\n#endif\n' +
          'mvPosition.x += aOff.x;\n  mvPosition.y += aOff.y;\n' +
          'mvPosition = modelViewMatrix * mvPosition;\n' +
          'gl_Position = projectionMatrix * mvPosition;');
    };
    mat.customProgramCacheKey = function () { return 'ghInstOff'; };
    return mat;
  }

  /* Escreve uma matriz de instancia (escala -> rotacao Y -> translacao)
     direto no Float32Array, sem alocar Object3D/Matrix4. */
  function writeInstance(arr, i, tx, ty, tz, cosY, sinY, sx, sy, sz) {
    var o = i * 16;
    arr[o] = cosY * sx; arr[o + 1] = 0; arr[o + 2] = -sinY * sx; arr[o + 3] = 0;
    arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
    arr[o + 8] = sinY * sz; arr[o + 9] = 0; arr[o + 10] = cosY * sz; arr[o + 11] = 0;
    arr[o + 12] = tx; arr[o + 13] = ty; arr[o + 14] = tz; arr[o + 15] = 1;
  }

  /* Canvas util (o modulo de materiais nao expoe um criador publico). */
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function canvasTexture(cv, opts) {
    opts = opts || {};
    var t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.encoding = THREE.sRGBEncoding;
    t.generateMipmaps = opts.mips !== false;
    t.minFilter = t.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    try {
      t.anisotropy = (M && M.maxAnisotropy) ? M.maxAnisotropy : 8;
    } catch (e) { t.anisotropy = 8; }
    t.needsUpdate = true;
    return keep(t);
  }

  /* Textura compartilhada do modulo de materiais (nunca gerar de novo). */
  function sharedTex(name) {
    try { if (M && M.tex && M.tex.get) return M.tex.get(name); } catch (e) { warn('tex:' + name, e); }
    return null;
  }
  function sharedCanvas(name) {
    try { if (M && M.canvas) return M.canvas(name); } catch (e) { warn('canvas:' + name, e); }
    return null;
  }

  /* RNG deterministico do palco. */
  function rng(seedExtra) {
    var s = 20260730 + (seedExtra || 0);
    try {
      if (U && U.RNG) return U.RNG(s);
    } catch (e) { /* fallback abaixo */ }
    var x = s >>> 0;
    return function () {
      x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
      return x / 4294967296;
    };
  }
  function rnd(r) { return (typeof r === 'function') ? r() : r.next(); }
  function rrange(r, a, b) { return a + (b - a) * rnd(r); }

  /* =========================================================================
     3. SUB-MODULOS (preenchidos pelas secoes seguintes)
     ========================================================================= */

  var backdrop = null;   /* ceu + camadas de parallax + rio                */
  var crowd = null;      /* publico instanciado + celulares                */
  var stageBuild = null; /* praticavel, barricada, PA, caixotes            */
  var band = null;       /* 6 musicos                                      */
  var led = null;        /* telao                                          */
  var rig = null;        /* trelica + moving heads + blinders + strobes    */
  var haze = null;       /* neblina volumetrica fake                       */
  var confetti = null;   /* pool de confete                                */
  var stageLights = null;/* 2 luzes reais proprias                         */

  /* =========================================================================
     4. CENARIO DE FUNDO — CEU E PARALLAX
     Cinco planos em profundidades diferentes: o parallax e REAL (vem da
     perspectiva), nao um truque de UV. Para o tema `para`, a silhueta do
     Mercado de Ferro do Ver-o-Peso com suas quatro torres, os armazens da
     Estacao das Docas, barcos regionais com mastro, mangueiras e o rio
     Guajara refletindo o sol.
     ========================================================================= */

  var backdropCache = {};    /* por tema: { sky, far, mid, near, water } */

  /* --- CEU -----------------------------------------------------------------
     Degrade vertical do entardecer + nuvens (reaproveitando a textura
     `fbmCloud` do modulo de materiais — nada de gerar ruido de novo) +
     disco solar com halo + estrelas na parte alta. */
  function buildSkyCanvas() {
    var W = 1024, H = 512;
    var cv = makeCanvas(W, H), g = cv.getContext('2d');

    /* Cupula: v=1 no zenite, v=0 no nadir, LINEAR no angulo polar. Logo o
       horizonte cai exatamente na metade da textura. */
    var HZ = 0.500;

    /* v=0 no topo do canvas = zenite; v=0.5 = horizonte. A faixa que a
       camera realmente ve fica entre 0.31 (35 graus acima) e 0.50, entao e
       ali que mora o por do sol inteiro. */
    var grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.00, shadeCss(tcss('sky', '#1e0b3a'), 0.20));
    grd.addColorStop(0.16, shadeCss(tcss('sky', '#1e0b3a'), 0.40));
    grd.addColorStop(0.275, shadeCss(tcss('sky', '#1e0b3a'), 0.95));
    grd.addColorStop(0.345, sunsetCss(4));
    grd.addColorStop(0.398, sunsetCss(3));
    grd.addColorStop(0.438, sunsetCss(2));
    grd.addColorStop(0.470, sunsetCss(1));
    grd.addColorStop(0.4935, sunsetCss(0));
    grd.addColorStop(HZ + 0.004, shadeCss(tcss('horizon', '#ff6a1e'), 0.92));
    grd.addColorStop(HZ + 0.055, shadeCss(tcss('fog', '#301246'), 0.85));
    grd.addColorStop(0.68, shadeCss(tcss('fog', '#301246'), 0.42));
    grd.addColorStop(1.00, shadeCss(tcss('shadow', '#0a0414'), 1.1));
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);

    /* estrelas: so na faixa alta, e so as que sobrevivem ao brilho do sol */
    var r = rng(11), i;
    g.globalCompositeOperation = 'lighter';
    for (i = 0; i < 420; i++) {
      var sy = rrange(r, 0, H * 0.34);
      var sx = rrange(r, 0, W);
      var a = (1 - sy / (H * 0.34)) * rrange(r, 0.12, 0.62);
      var rad = rrange(r, 0.5, 1.5);
      g.fillStyle = 'rgba(255,246,224,' + a.toFixed(3) + ')';
      g.beginPath(); g.arc(sx, sy, rad, 0, TAU); g.fill();
    }

    /* SOL: disco baixo, quase encostando no horizonte, com halo largo */
    var sunX = W * 0.615, sunY = H * (HZ - 0.013), sunR = H * 0.030;
    var halo = g.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 11);
    halo.addColorStop(0.00, hexA(sunsetCss(0), 0.95));
    halo.addColorStop(0.12, hexA(sunsetCss(1), 0.55));
    halo.addColorStop(0.35, hexA(sunsetCss(2), 0.22));
    halo.addColorStop(1.00, hexA(sunsetCss(3), 0.0));
    g.fillStyle = halo;
    g.fillRect(0, 0, W, H);
    var disc = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR);
    disc.addColorStop(0, '#fffdf2');
    disc.addColorStop(0.55, sunsetCss(0));
    disc.addColorStop(1, hexA(sunsetCss(1), 0.0));
    g.fillStyle = disc;
    g.beginPath(); g.arc(sunX, sunY, sunR * 1.6, 0, TAU); g.fill();
    g.globalCompositeOperation = 'source-over';

    /* NUVENS: bandas horizontais tiradas da textura procedural compartilhada,
       esticadas e recortadas — dao a nuvem "de fim de tarde do Para", aquela
       nuvem carregada e comprida. */
    var cloudCv = sharedCanvas('fbmCloud');
    if (cloudCv) {
      /* Faixas com altura, alfa, offset horizontal e RECORTE diferentes.
         Bandas iguais e igualmente espacadas viram alvo de tiro ao alvo —
         foi o que apareceu na terceira captura. Aqui cada faixa puxa um
         pedaco diferente do ruido, com escala horizontal diferente. */
      var bands = [
        { y: HZ - 0.212, h: 0.062, a: 0.20, c: sunsetCss(4), sx: 0.00, sy: 0.05, zx: 1.00, sk: 0.6 },
        { y: HZ - 0.171, h: 0.044, a: 0.26, c: sunsetCss(3), sx: 0.52, sy: 0.31, zx: 0.62, sk: 0.5 },
        { y: HZ - 0.132, h: 0.034, a: 0.34, c: sunsetCss(3), sx: 0.18, sy: 0.58, zx: 1.35, sk: 0.7 },
        { y: HZ - 0.101, h: 0.026, a: 0.40, c: sunsetCss(2), sx: 0.71, sy: 0.12, zx: 0.85, sk: 0.45 },
        { y: HZ - 0.075, h: 0.021, a: 0.46, c: sunsetCss(1), sx: 0.35, sy: 0.44, zx: 1.60, sk: 0.55 },
        { y: HZ - 0.054, h: 0.016, a: 0.50, c: sunsetCss(1), sx: 0.86, sy: 0.70, zx: 0.72, sk: 0.4 },
        { y: HZ - 0.037, h: 0.012, a: 0.52, c: sunsetCss(0), sx: 0.06, sy: 0.22, zx: 1.15, sk: 0.5 },
        { y: HZ - 0.024, h: 0.009, a: 0.44, c: '#fff0cf', sx: 0.62, sy: 0.86, zx: 1.90, sk: 0.35 }
      ];
      var tmp = makeCanvas(W, 64), tg = tmp.getContext('2d');
      var cw = cloudCv.width, ch = cloudCv.height;
      for (i = 0; i < bands.length; i++) {
        var b = bands[i];
        tg.clearRect(0, 0, W, 64);
        tg.globalCompositeOperation = 'source-over';
        var srcW = cw * 0.46 / b.zx;
        tg.drawImage(cloudCv, (cw * b.sx) % Math.max(1, cw - srcW), ch * b.sy * 0.7,
                     srcW, ch * 0.16, 0, 0, W, 64);
        /* recorte irregular: um segundo passe de ruido come as bordas */
        tg.globalCompositeOperation = 'destination-in';
        var fade = tg.createLinearGradient(0, 0, 0, 64);
        fade.addColorStop(0, 'rgba(0,0,0,0)');
        fade.addColorStop(0.42, 'rgba(0,0,0,' + b.sk.toFixed(2) + ')');
        fade.addColorStop(0.62, 'rgba(0,0,0,' + b.sk.toFixed(2) + ')');
        fade.addColorStop(1, 'rgba(0,0,0,0)');
        tg.fillStyle = fade;
        tg.fillRect(0, 0, W, 64);
        /* corta as pontas: a faixa nao pode dar a volta inteira no ceu */
        var side = tg.createLinearGradient(0, 0, W, 0);
        side.addColorStop(0.00, 'rgba(0,0,0,0)');
        side.addColorStop(0.10 + i * 0.02, 'rgba(0,0,0,1)');
        side.addColorStop(0.82 - i * 0.015, 'rgba(0,0,0,1)');
        side.addColorStop(1.00, 'rgba(0,0,0,0)');
        tg.fillStyle = side;
        tg.fillRect(0, 0, W, 64);
        /* tinge a nuvem com a cor do por do sol */
        tg.globalCompositeOperation = 'source-in';
        tg.fillStyle = b.c;
        tg.fillRect(0, 0, W, 64);
        tg.globalCompositeOperation = 'source-over';

        g.globalAlpha = b.a;
        g.globalCompositeOperation = 'lighter';
        g.drawImage(tmp, 0, H * b.y, W, H * b.h);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      }
    }

    /* faixa de brasa colada no horizonte: e ela que faz a silhueta do
       Ver-o-Peso "recortar" na frente da luz */
    var ember = g.createLinearGradient(0, H * (HZ - 0.022), 0, H * (HZ + 0.008));
    ember.addColorStop(0, hexA(sunsetCss(1), 0.0));
    ember.addColorStop(0.7, hexA(sunsetCss(0), 0.50));
    ember.addColorStop(1, hexA('#fff4d2', 0.68));
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = ember;
    g.fillRect(0, H * (HZ - 0.022), W, H * 0.030);
    g.globalCompositeOperation = 'source-over';

    return cv;
  }

  /* Escurece/clareia um '#rrggbb' mantendo string CSS. */
  function shadeCss(hex, k) {
    var c = new THREE.Color(hex);
    var h = { h: 0, s: 0, l: 0 };
    c.getHSL(h);
    c.setHSL(h.h, h.s, clamp01(h.l * k));
    return '#' + c.getHexString();
  }
  function hexA(hex, a) {
    var c = new THREE.Color(hex);
    return 'rgba(' + Math.round(clamp01(c.r) * 255) + ',' + Math.round(clamp01(c.g) * 255) +
           ',' + Math.round(clamp01(c.b) * 255) + ',' + a + ')';
  }

  /* --- CAMADA DISTANTE: outra margem do rio, ilhas, palmeiras minusculas -- */
  function buildFarCanvas() {
    var W = 1024, H = 128;
    var cv = makeCanvas(W, H), g = cv.getContext('2d');
    var r = rng(23);
    var base = shadeCss(tcss('fog', '#301246'), 1.35);
    /* linha de terra irregular na parte baixa */
    g.fillStyle = base;
    g.beginPath();
    g.moveTo(0, H);
    var x, y;
    for (x = 0; x <= W; x += 8) {
      var n = Math.sin(x * 0.012) * 4 + Math.sin(x * 0.041 + 1.7) * 2.4 + Math.sin(x * 0.0037) * 6;
      y = H * 0.72 - n - rrange(r, 0, 2.2);
      g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fill();
    /* pontinhas de mata / palmeiras */
    g.strokeStyle = base;
    g.lineWidth = 1.1;
    for (x = 0; x < W; x += 5) {
      if (rnd(r) > 0.55) continue;
      var hh = rrange(r, 3, 9);
      var yy = H * 0.72 - Math.sin(x * 0.012) * 4 - Math.sin(x * 0.041 + 1.7) * 2.4 - Math.sin(x * 0.0037) * 6;
      g.beginPath(); g.moveTo(x, yy); g.lineTo(x + rrange(r, -1.2, 1.2), yy - hh); g.stroke();
      g.beginPath(); g.arc(x, yy - hh, rrange(r, 1.4, 2.8), 0, PI, true); g.fill();
    }
    /* luzinhas da outra margem */
    g.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 90; i++) {
      var lx = rrange(r, 0, W);
      var ly = H * 0.72 - rrange(r, 0, 3);
      g.fillStyle = hexA(tcss('accent', '#ffb03a'), rrange(r, 0.25, 0.8));
      g.fillRect(lx, ly, 1.4, 1.2);
    }
    g.globalCompositeOperation = 'source-over';
    return cv;
  }

  /* --- CAMADA MEDIA: VER-O-PESO ------------------------------------------
     O Mercado de Ferro: corpo retangular longo, quatro TORRES de canto com
     cupula bulbosa e cata-vento, e a nave central mais alta. Ao lado, os
     galpoes da Estacao das Docas e a torre da Catedral. Tudo em silhueta
     com um fio de luz quente no contorno superior — e esse fio que faz o
     predio "recortar" contra o por do sol em vez de virar um borrao. */
  function buildMidCanvas() {
    var W = 1024, H = 256;
    var cv = makeCanvas(W, H), g = cv.getContext('2d');
    var GROUND = H * 0.90;
    var dark = shadeCss(tcss('shadow', '#0a0414'), 2.4);
    var rimC = tcss('horizon', '#ff6a1e');
    var r = rng(37);

    g.clearRect(0, 0, W, H);
    g.fillStyle = dark;

    /* --- helpers de desenho --- */
    function box(x, y, w, h) { g.fillRect(x, y, w, h); }
    function domeTower(cx, baseY, w, hBody) {
      /* fuste */
      g.fillRect(cx - w * 0.5, baseY - hBody, w, hBody);
      /* cornija */
      g.fillRect(cx - w * 0.72, baseY - hBody - w * 0.16, w * 1.44, w * 0.16);
      /* cupula bulbosa (dois arcos) */
      var dy = baseY - hBody - w * 0.16;
      g.beginPath();
      g.moveTo(cx - w * 0.62, dy);
      g.bezierCurveTo(cx - w * 0.78, dy - w * 0.72, cx - w * 0.30, dy - w * 1.22, cx, dy - w * 1.28);
      g.bezierCurveTo(cx + w * 0.30, dy - w * 1.22, cx + w * 0.78, dy - w * 0.72, cx + w * 0.62, dy);
      g.closePath();
      g.fill();
      /* lanternim + cata-vento */
      g.fillRect(cx - w * 0.10, dy - w * 1.28 - w * 0.30, w * 0.20, w * 0.30);
      g.fillRect(cx - w * 0.02, dy - w * 1.28 - w * 0.72, w * 0.04, w * 0.42);
      g.fillRect(cx - w * 0.18, dy - w * 1.28 - w * 0.66, w * 0.36, w * 0.045);
    }

    /* === MERCADO DE FERRO (o icone) === */
    var mcx = W * 0.50, mw = W * 0.30, mh = H * 0.20;
    var mx0 = mcx - mw * 0.5;
    box(mx0, GROUND - mh, mw, mh);
    /* nave central mais alta com frontao */
    var nw = mw * 0.30, nh = mh * 1.42;
    box(mcx - nw * 0.5, GROUND - nh, nw, nh);
    g.beginPath();
    g.moveTo(mcx - nw * 0.62, GROUND - nh);
    g.lineTo(mcx, GROUND - nh - nw * 0.34);
    g.lineTo(mcx + nw * 0.62, GROUND - nh);
    g.closePath(); g.fill();
    /* 4 torres de canto */
    var tw = mw * 0.085;
    domeTower(mx0 + tw * 0.9, GROUND, tw, mh * 1.22);
    domeTower(mx0 + mw - tw * 0.9, GROUND, tw, mh * 1.22);
    domeTower(mx0 + mw * 0.30, GROUND, tw * 0.82, mh * 1.05);
    domeTower(mx0 + mw * 0.70, GROUND, tw * 0.82, mh * 1.05);

    /* === GALPOES DA ESTACAO DAS DOCAS (a esquerda) === */
    var i, gx = W * 0.235;
    for (i = 0; i < 3; i++) {
      var gw = W * 0.055, gh = H * 0.115 + i * H * 0.008;
      box(gx, GROUND - gh, gw, gh);
      /* telhado de duas aguas */
      g.beginPath();
      g.moveTo(gx - gw * 0.06, GROUND - gh);
      g.lineTo(gx + gw * 0.5, GROUND - gh - gh * 0.30);
      g.lineTo(gx + gw * 1.06, GROUND - gh);
      g.closePath(); g.fill();
      gx += gw * 1.12;
    }
    /* guindaste de porto */
    g.lineWidth = 2.0; g.strokeStyle = dark;
    var kx = W * 0.196, ky = GROUND;
    g.beginPath(); g.moveTo(kx, ky); g.lineTo(kx + 3, ky - H * 0.20); g.lineTo(kx + W * 0.045, ky - H * 0.155);
    g.moveTo(kx + 3, ky - H * 0.20); g.lineTo(kx - W * 0.016, ky - H * 0.175);
    g.stroke();

    /* === CATEDRAL / TORRES DE IGREJA (a direita) === */
    var chx = W * 0.705;
    box(chx, GROUND - H * 0.12, W * 0.075, H * 0.12);
    domeTower(chx + W * 0.012, GROUND, W * 0.017, H * 0.20);
    domeTower(chx + W * 0.063, GROUND, W * 0.017, H * 0.20);
    g.beginPath();
    g.moveTo(chx + W * 0.020, GROUND - H * 0.155);
    g.bezierCurveTo(chx + W * 0.030, GROUND - H * 0.225, chx + W * 0.045, GROUND - H * 0.225,
                    chx + W * 0.055, GROUND - H * 0.155);
    g.closePath(); g.fill();

    /* === PREDIOS COMUNS espalhados === */
    for (i = 0; i < 44; i++) {
      var bx = rrange(r, -20, W + 20);
      /* evita empilhar em cima do mercado */
      if (bx > mx0 - 24 && bx < mx0 + mw + 24) continue;
      var bw = rrange(r, 10, 44);
      var bh = rrange(r, H * 0.035, H * 0.145);
      box(bx, GROUND - bh, bw, bh);
      if (rnd(r) < 0.35) box(bx + bw * 0.35, GROUND - bh - rrange(r, 4, 14), bw * 0.22, rrange(r, 4, 14));
    }

    /* === MANGUEIRAS: copa larga e redonda, marca registrada de Belem === */
    for (i = 0; i < 16; i++) {
      var tx = rrange(r, 0, W);
      if (tx > mx0 - 10 && tx < mx0 + mw + 10 && rnd(r) < 0.7) continue;
      var th = rrange(r, H * 0.055, H * 0.105);
      var cw = th * rrange(r, 1.0, 1.5);
      g.fillRect(tx - 1.6, GROUND - th, 3.2, th);
      g.beginPath();
      g.ellipse(tx, GROUND - th - cw * 0.30, cw * 0.62, cw * 0.44, 0, 0, TAU);
      g.fill();
      g.beginPath();
      g.ellipse(tx - cw * 0.28, GROUND - th - cw * 0.12, cw * 0.34, cw * 0.26, 0, 0, TAU);
      g.fill();
      g.beginPath();
      g.ellipse(tx + cw * 0.30, GROUND - th - cw * 0.16, cw * 0.32, cw * 0.24, 0, 0, TAU);
      g.fill();
    }

    /* === FIO DE LUZ NO CONTORNO SUPERIOR ===
       Truque de silhueta: pega o alfa ja desenhado, desloca 1.5px para baixo
       e subtrai — sobra so a crista, que pintamos com a cor do horizonte. */
    var edge = makeCanvas(W, H), eg = edge.getContext('2d');
    eg.drawImage(cv, 0, 0);
    eg.globalCompositeOperation = 'destination-out';
    eg.drawImage(cv, 0, 2.0);
    eg.globalCompositeOperation = 'source-in';
    var eg2 = eg.createLinearGradient(0, 0, W, 0);
    eg2.addColorStop(0.0, hexA(rimC, 0.35));
    eg2.addColorStop(0.55, hexA('#fff0c8', 0.95));
    eg2.addColorStop(1.0, hexA(rimC, 0.35));
    eg.fillStyle = eg2;
    eg.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(edge, 0, 0);
    g.globalCompositeOperation = 'source-over';

    /* janelas acesas */
    g.globalCompositeOperation = 'lighter';
    for (i = 0; i < 260; i++) {
      var wx = rrange(r, 0, W), wy = GROUND - rrange(r, 2, H * 0.14);
      g.fillStyle = hexA(tcss('accent', '#ffb03a'), rrange(r, 0.18, 0.7));
      g.fillRect(wx, wy, rrange(r, 1, 2.4), rrange(r, 1, 2.0));
    }
    g.globalCompositeOperation = 'source-over';
    return cv;
  }

  /* --- CAMADA PROXIMA: barcos, trapiche, mangueiras grandes --------------- */
  function buildNearCanvas() {
    var W = 1024, H = 256;
    var cv = makeCanvas(W, H), g = cv.getContext('2d');
    var GROUND = H * 0.86;
    var dark = shadeCss(tcss('shadow', '#0a0414'), 1.7);
    var r = rng(53);
    g.clearRect(0, 0, W, H);
    g.fillStyle = dark;
    g.strokeStyle = dark;

    /* --- barcos regionais: casco de dois conveses + mastro + bandeirolas --- */
    function boat(cx, scale) {
      var hw = 52 * scale, hh = 15 * scale;
      var y = GROUND;
      /* casco */
      g.beginPath();
      g.moveTo(cx - hw, y - hh);
      g.quadraticCurveTo(cx - hw * 1.05, y + hh * 0.25, cx - hw * 0.55, y + hh * 0.42);
      g.lineTo(cx + hw * 0.62, y + hh * 0.42);
      g.quadraticCurveTo(cx + hw * 1.08, y + hh * 0.20, cx + hw, y - hh);
      g.closePath(); g.fill();
      /* cabine / segundo convés */
      g.fillRect(cx - hw * 0.62, y - hh * 2.30, hw * 1.16, hh * 1.30);
      g.fillRect(cx - hw * 0.42, y - hh * 3.20, hw * 0.80, hh * 0.95);
      /* toldo */
      g.fillRect(cx - hw * 0.70, y - hh * 3.34, hw * 1.40, hh * 0.16);
      /* mastro + verga */
      g.lineWidth = 2.0 * scale;
      g.beginPath();
      g.moveTo(cx - hw * 0.05, y - hh * 3.30);
      g.lineTo(cx - hw * 0.05, y - hh * 8.6);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - hw * 0.05, y - hh * 8.6);
      g.lineTo(cx + hw * 0.62, y - hh * 4.4);
      g.moveTo(cx - hw * 0.05, y - hh * 8.6);
      g.lineTo(cx - hw * 0.70, y - hh * 4.4);
      g.stroke();
      /* bandeirolas de festa */
      g.lineWidth = 1.0 * scale;
      var i, n = 7;
      for (i = 0; i < n; i++) {
        var t = i / (n - 1);
        var bx = cx - hw * 0.05 + (t - 0.5) * hw * 1.3;
        var by = y - hh * 8.6 + Math.abs(t - 0.5) * hh * 8.4;
        g.beginPath();
        g.moveTo(bx, by); g.lineTo(bx + 3.4 * scale, by + 5.5 * scale); g.lineTo(bx - 3.4 * scale, by + 5.5 * scale);
        g.closePath(); g.fill();
      }
      /* janelinhas acesas */
      g.globalCompositeOperation = 'lighter';
      for (i = 0; i < 6; i++) {
        g.fillStyle = hexA(tcss('accent', '#ffb03a'), rrange(r, 0.35, 0.9));
        g.fillRect(cx - hw * 0.50 + i * hw * 0.19, y - hh * 2.00, 3.2 * scale, 3.0 * scale);
      }
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = dark;
    }

    boat(W * 0.115, 1.00);
    boat(W * 0.245, 0.78);
    boat(W * 0.845, 0.92);
    boat(W * 0.735, 0.68);

    /* --- trapiche / estacas na agua --- */
    g.fillRect(0, GROUND + 2, W, H * 0.035);
    var x;
    for (x = 6; x < W; x += 26) {
      g.fillRect(x, GROUND + 2, 4.5, H * 0.10 + Math.sin(x) * 3);
    }

    /* --- mangueiras grandes nas pontas (moldura organica do quadro) --- */
    function mango(cx, s) {
      var th = 62 * s;
      g.fillRect(cx - 4 * s, GROUND - th, 8 * s, th);
      g.lineWidth = 4 * s;
      g.beginPath();
      g.moveTo(cx, GROUND - th * 0.72); g.lineTo(cx - 26 * s, GROUND - th * 1.02);
      g.moveTo(cx, GROUND - th * 0.80); g.lineTo(cx + 24 * s, GROUND - th * 1.06);
      g.stroke();
      var i;
      for (i = 0; i < 9; i++) {
        var ax = cx + rrange(r, -46, 46) * s;
        var ay = GROUND - th - rrange(r, -6, 30) * s;
        g.beginPath();
        g.ellipse(ax, ay, rrange(r, 16, 30) * s, rrange(r, 12, 21) * s, rrange(r, -0.4, 0.4), 0, TAU);
        g.fill();
      }
    }
    mango(W * 0.035, 1.15);
    mango(W * 0.965, 1.05);
    mango(W * 0.395, 0.62);
    mango(W * 0.615, 0.55);

    /* contorno quente igual ao da camada media */
    var edge = makeCanvas(W, H), eg = edge.getContext('2d');
    eg.drawImage(cv, 0, 0);
    eg.globalCompositeOperation = 'destination-out';
    eg.drawImage(cv, 0, 2.4);
    eg.globalCompositeOperation = 'source-in';
    eg.fillStyle = hexA(tcss('horizon', '#ff6a1e'), 0.7);
    eg.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(edge, 0, 0);
    g.globalCompositeOperation = 'source-over';
    return cv;
  }

  /* --- RIO GUAJARA: plano horizontal com coluna de reflexo do sol -------- */
  function buildWaterCanvas() {
    var W = 256, H = 256;
    var cv = makeCanvas(W, H), g = cv.getContext('2d');
    /* v=0 e a margem distante (horizonte), v=1 e a margem perto do palco */
    /* v=0 e a margem distante (horizonte), v=1 e a margem perto do palco.
       O rio e ESCURO: agua a noite so devolve o que o ceu da, e devolve
       menos. Uma agua clara demais vira lava e rouba o olho da pista. */
    var grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.00, shadeCss(tcss('horizon', '#ff6a1e'), 0.42));
    grd.addColorStop(0.07, shadeCss(tcss('haze', '#ff7a4a'), 0.22));
    grd.addColorStop(0.22, shadeCss(tcss('fog', '#301246'), 0.42));
    grd.addColorStop(0.55, shadeCss(tcss('shadow', '#0a0414'), 1.3));
    grd.addColorStop(1.00, shadeCss(tcss('shadow', '#0a0414'), 0.75));
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);

    /* coluna do sol: alarga conforme se aproxima do observador */
    var r = rng(71), i;
    g.globalCompositeOperation = 'lighter';
    var sunX = W * 0.615;
    for (i = 0; i < 150; i++) {
      var t = i / 149;
      var y = t * H;
      var wdt = W * (0.010 + t * 0.12);
      var a = (1 - t) * (1 - t) * (1 - t) * 0.42 * (0.45 + 0.55 * Math.sin(i * 2.7));
      var col = g.createLinearGradient(sunX - wdt, 0, sunX + wdt, 0);
      col.addColorStop(0, hexA(sunsetCss(1), 0));
      col.addColorStop(0.5, hexA(sunsetCss(0), a));
      col.addColorStop(1, hexA(sunsetCss(1), 0));
      g.fillStyle = col;
      g.fillRect(sunX - wdt, y, wdt * 2, H / 150 * (0.35 + t * 1.6));
    }
    /* ondulacoes largas */
    for (i = 0; i < 90; i++) {
      var yy = rrange(r, 0, H);
      var tt = yy / H;
      g.strokeStyle = hexA(sunsetCss(2), (1 - tt) * (1 - tt) * 0.09 + 0.012);
      g.lineWidth = 0.6 + tt * 2.2;
      g.beginPath();
      var xx;
      for (xx = 0; xx <= W; xx += 16) {
        var oy = yy + Math.sin(xx * 0.07 + i) * (0.6 + tt * 2.4);
        if (xx === 0) g.moveTo(xx, oy); else g.lineTo(xx, oy);
      }
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    return cv;
  }

  /* --- montagem das camadas ------------------------------------------------ */
  function buildBackdrop() {
    var g = new THREE.Group();
    g.name = 'GH_Stage_Backdrop';

    var tex = backdropCache[themeId];
    if (!tex) {
      tex = backdropCache[themeId] = {
        sky:   canvasTexture(buildSkyCanvas(), { mips: false }),
        far:   canvasTexture(buildFarCanvas()),
        mid:   canvasTexture(buildMidCanvas()),
        near:  canvasTexture(buildNearCanvas()),
        water: canvasTexture(buildWaterCanvas(), { repeat: true })
      };
      /* GH.Art tem prioridade quando existir (hoje esta vazio) */
      var key = 'stage_backdrop_' + themeId;
      if (GH.Art && GH.Art.has && GH.Art.has(key)) {
        var art = GH.Art.texture(key);
        if (art) { tex.mid = keep(art); }
      }
    }

    function layer(t, w, h, y, z, opts) {
      opts = opts || {};
      var mat = new THREE.MeshBasicMaterial({
        map: t,
        transparent: false,
        alphaTest: opts.alphaTest === undefined ? 0 : opts.alphaTest,
        depthWrite: true,
        fog: false,
        color: opts.color || 0xffffff,
        toneMapped: opts.toneMapped !== false,
        side: THREE.FrontSide
      });
      keep(mat);
      var geo = keep(new THREE.PlaneGeometry(w, h));
      var m = new THREE.Mesh(geo, mat);
      m.position.set(0, y, z);
      m.renderOrder = opts.order || 0;
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      g.add(m);
      return m;
    }

    /* CEU — cupula opaca por dentro, atras de tudo. O equador fica na altura
       do olho da camera de gameplay, entao o horizonte da textura coincide
       com o horizonte real em qualquer angulo. */
    var skyMat = new THREE.MeshBasicMaterial({
      map: tex.sky, side: THREE.BackSide, fog: false, depthWrite: true, toneMapped: true
    });
    keep(skyMat);
    var skyGeo = keep(new THREE.SphereGeometry(GEO.skyR, 40, 24));
    var sky = new THREE.Mesh(skyGeo, skyMat);
    sky.position.set(0, 3.05, GEO.skyCZ);
    sky.renderOrder = -40;
    sky.frustumCulled = false;
    sky.matrixAutoUpdate = false;
    sky.updateMatrix();
    g.add(sky);

    /* Escalas calibradas: os predios do Ver-o-Peso tem ~10 unidades de altura
       a 135 de distancia (4 graus) — marco reconhecivel sem virar cenografia
       de teatro. */
    backdrop = {
      group: g,
      tex: tex,
      sky:  sky,
      far:  layer(tex.far, 440, 26, 6.1, GEO.farZ, { alphaTest: 0.03, order: -32 }),
      mid:  layer(tex.mid, 420, 38, 16.0, GEO.midZ, { alphaTest: 0.06, order: -28 }),
      near: layer(tex.near, 320, 26, 9.9, GEO.nearZ, { alphaTest: 0.10, order: -24 }),
      water: null
    };

    /* RIO: plano horizontal do fim do palco ate o horizonte */
    var wMat = new THREE.MeshBasicMaterial({
      map: tex.water, fog: false, depthWrite: true, toneMapped: true, side: THREE.FrontSide
    });
    keep(wMat);
    tex.water.wrapS = THREE.RepeatWrapping;
    tex.water.wrapT = THREE.ClampToEdgeWrapping;
    tex.water.repeat.set(3, 1);
    var wGeo = keep(new THREE.PlaneGeometry(380, GEO.waterZ0 - GEO.waterZ1, 1, 1));
    var water = new THREE.Mesh(wGeo, wMat);
    water.rotation.x = -PI / 2;
    water.position.set(0, GEO.waterY, (GEO.waterZ0 + GEO.waterZ1) * 0.5);
    water.renderOrder = -30;
    water.frustumCulled = false;
    g.add(water);
    backdrop.water = water;

    /* --- TERRENO DO EVENTO --------------------------------------------------
       Chao escuro por baixo de TUDO que nao e plateia. Sem ele, onde o leque
       do publico acaba enxerga-se o rio, e o rio (que devolve o por do sol)
       vira uma mancha de lava no terco direito. Recortado no corredor da
       pista para nao esconder a highway. */
    /* Chao de arena a noite = quase preto. O refletor RIM magenta do engine
       (intensidade 2.55) lava qualquer superficie grande e clara: com
       roughness alta e cor #0a0414*0.55 o chao vira uma base escura em que os
       pocos de luz dos refletores realmente aparecem. */
    /* Ainda mais escuro que antes: em 0.55 o terreno devolvia luz suficiente
       para virar uma chapa vermelha uniforme dos dois lados da pista. Em 0.22
       ele some no preto e o que se ve ali passa a ser SO a poca dos
       refletores — que e o que da profundidade num show de verdade. */
    /* MATERIAL NAO ILUMINADO DE PROPOSITO. Enquanto o terreno respondia as
       luzes, cada tema pintava aqueles ~10% de tela de uma cor chapada
       diferente (vermelho no para, AZUL no frevo) — o espaco morto do
       briefing. Sem iluminacao ele fica sempre preto profundo e o que se ve
       ali passa a ser so o que tem luz propria: os cones dos refletores, a
       fumaca e a plateia. E o fundo do Guitar Hero, e da o preto que o
       grading precisa para ancorar a faixa dinamica. */
    /* fog: FALSE. Este era o ultimo caminho por onde a cor chapada voltava:
       um MeshBasicMaterial preto ainda recebe o mix da neblina, e a neblina do
       tema frevo e um cinza-azulado claro. Resultado: ~10% da tela viravam uma
       CHAPA cinza-azul de valor unico, com a borda reta do slab aparecendo
       (medido no print de gameplay_chords). Sem neblina o terreno fica no
       preto que o grading precisa, e o que se ve ali passa a ser so o que tem
       luz propria — poca de refletor, fumaca e plateia. */
    var groundMat = new THREE.MeshBasicMaterial({
      color: tc('shadow', 0x0a0414).multiplyScalar(0.30),
      map: sharedTex('grunge') || null,
      fog: false
    });
    if (groundMat.map) {
      groundMat.map = groundMat.map.clone();
      groundMat.map.wrapS = groundMat.map.wrapT = THREE.RepeatWrapping;
      groundMat.map.repeat.set(26, 26);
      groundMat.map.needsUpdate = true;
      keep(groundMat.map);
    }
    keep(groundMat);
    function groundSlab(x0, x1, z0, z1) {
      var geo2 = keep(new THREE.PlaneGeometry(x1 - x0, z1 - z0, 1, 1));
      var m2 = new THREE.Mesh(geo2, groundMat);
      m2.rotation.x = -PI / 2;
      m2.position.set((x0 + x1) * 0.5, GEO.groundY, -(z0 + z1) * 0.5);
      m2.frustumCulled = false;
      m2.matrixAutoUpdate = false;
      m2.updateMatrix();
      m2.renderOrder = -22;
      g.add(m2);
    }
    /* z passado em modulo (o helper inverte) */
    /* BURACO NO CHAO (achado no print): o recorte antigo comecava em |x|=6,2 e
       em z=-4. O leque da plateia para no corredor (|x|~3,9) e em z=+3, entao
       sobrava uma FAIXA SEM CHAO NENHUM dos dois lados da pista, logo a frente
       da camera. Ela aparecia como uma cunha escura de borda reta contra o
       terreno — o "espaco morto chapado" do briefing. Agora o terreno vai ate
       a beira do corredor (|x|=3,2; a pista mais o trilho ocupam so 2,3) e
       passa da lente (z=+12), sem furo nenhum. */
    groundSlab(-250, -3.2, -12, 96);
    groundSlab(3.2, 250, -12, 96);
    groundSlab(-250, 250, 31, 96);

    /* TALUDE — o buraco que sobrou depois do conserto anterior.
       O terreno esta em y=0,62 e comeca em |x|=3,2; a pista com trilho vai so
       ate |x|=2,25. Sobrava uma fresta de ~0,95 un de cada lado, POR ONDE SE
       VIA O FUNDO DA CENA: perto da lente ela abre em perspectiva e vira a
       cunha de borda reta que aparecia azul no frevo e roxa no para (as duas
       "faixas chapadas" do briefing eram isto, nao o terreno). Aqui ela vira
       um talude de verdade, descendo do nivel do terreno ate a beira do
       conves, com queda de valor na cor de vertice — ou seja: geometria e
       gradiente onde antes havia furo e cor chapada. */
    g.add(buildVerge());

    /* chao de terra batida da plateia (leque com desnivel) */
    g.add(buildPitGround());

    group.add(g);
  }

  /* -------------------------------------------------------------------------
     TALUDE lateral da pista (os dois lados).
     Fecha a fresta entre a beira do conves (|x|=2,25) e o terreno (|x|=3,2,
     y=0,62). Tres colunas de vertices: pe (junto ao trilho, no escuro), meio
     (a quina que pega um fio de luz do trilho) e topo (cor do terreno). A cor
     de vertice da o degrade que um plano chapado nao teria.
     ----------------------------------------------------------------------- */
  function buildVerge() {
    var XS = [2.02, 2.62, 3.26];          /* pe, quina, topo               */
    var YS = [-0.055, 0.36, GEO.groundY]; /* desce ate abaixo do conves    */
    var ZS = [14, 2, -10, -26, -46, -70, -96];
    var base = tc('shadow', 0x0a0414);
    var edge = tc('neon', 0x22e3e8);
    var cols = [
      base.clone().multiplyScalar(0.20),
      base.clone().multiplyScalar(0.55).lerp(edge, 0.10),
      base.clone().multiplyScalar(0.30)
    ];

    var quads = (XS.length - 1) * (ZS.length - 1) * 2;   /* 2 lados */
    var pos = new Float32Array(quads * 6 * 3);
    var col = new Float32Array(quads * 6 * 3);
    var k = 0;

    function vtx(side, ix, iz, dim) {
      pos[k] = side * XS[ix];
      pos[k + 1] = YS[ix];
      pos[k + 2] = ZS[iz];
      var c = cols[ix];
      col[k] = c.r * dim; col[k + 1] = c.g * dim; col[k + 2] = c.b * dim;
      k += 3;
    }
    /* longe da lente o talude escurece: ele nunca pode competir com a pista */
    function dimAt(iz) {
      var z = ZS[iz];
      return clamp01(0.35 + 0.65 * clamp01((z + 86) / 70));
    }

    var side, ix, iz;
    for (side = -1; side <= 1; side += 2) {
      for (ix = 0; ix < XS.length - 1; ix++) {
        for (iz = 0; iz < ZS.length - 1; iz++) {
          var d0 = dimAt(iz), d1 = dimAt(iz + 1);
          /* winding invertido do lado esquerdo para a normal olhar para cima */
          if (side > 0) {
            vtx(side, ix, iz, d0); vtx(side, ix + 1, iz, d0); vtx(side, ix + 1, iz + 1, d1);
            vtx(side, ix, iz, d0); vtx(side, ix + 1, iz + 1, d1); vtx(side, ix, iz + 1, d1);
          } else {
            vtx(side, ix, iz, d0); vtx(side, ix + 1, iz + 1, d1); vtx(side, ix + 1, iz, d0);
            vtx(side, ix, iz, d0); vtx(side, ix, iz + 1, d1); vtx(side, ix + 1, iz + 1, d1);
          }
        }
      }
    }

    var geo = keep(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    var mat = keep(new THREE.MeshBasicMaterial({
      vertexColors: true, fog: false, side: THREE.DoubleSide
    }));
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'GH_Stage_Verge';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = -21;
    return mesh;
  }

  /* Chao da plateia: leque radial em torno de (0,-30) com o desnivel da
     arquibancada assado na geometria. */
  /* IMPORTANTE: o desnivel sobe em direcao ao FUNDO da plateia, que e onde a
     camera esta. Se ele subir demais, as ultimas filas ficam acima do olho e
     tapam o palco inteiro (foi exatamente o que aconteceu na primeira
     captura). Entao: rampa so a partir de r=13, degraus curtos e TETO em
     +2.35 — o publico do fundo fica na altura do ombro da camera, nunca
     acima da linha do horizonte. */
  var PIT_RISE_START = 13.0, PIT_STEP = 3.6, PIT_STEP_H = 0.30, PIT_MAX = 2.35;
  function pitHeightAt(r, z) {
    var h;
    if (r <= PIT_RISE_START) h = (r / PIT_RISE_START) * 0.12;
    else {
      var steps = Math.floor((r - PIT_RISE_START) / PIT_STEP);
      var frac = ((r - PIT_RISE_START) / PIT_STEP) - steps;
      h = 0.12 + Math.min(steps * PIT_STEP_H + Math.min(frac * 5, 1) * PIT_STEP_H * 0.22, PIT_MAX);
    }
    /* A arquibancada so sobe LONGE da lente. Perto da camera ela volta ao
       nivel do terreno: sem isso, (a) as ultimas filas ficam acima do olho e
       tapam o palco e (b) o corte do leque vira um barranco de 2 metros
       contra o chao plano. */
    if (z !== undefined) h *= clamp01((-z - 6.0) / 16.0);
    return GEO.pitY + h;
  }

  function buildPitGround() {
    var RINGS = 24, SEGS = 52;
    var verts = (RINGS) * (SEGS) * 6;
    var pos = new Float32Array(verts * 3);
    var nor = new Float32Array(verts * 3);
    var col = new Float32Array(verts * 3);
    var uv = new Float32Array(verts * 2);
    var k = 0, ku = 0;
    /* O chao da plateia e um plano acima da pista (y~1). Se ele cruzasse o
       corredor, esconderia a highway inteira — foi o que aconteceu na
       segunda captura, com a metade de baixo do quadro preta. Entao
       recortamos o corredor E paramos antes de chegar na camera. */
    /* O CHAO so respeita o corredor da pista. A regra "so pelos lados" vale
       para as PESSOAS, nunca para o terreno — senao aparece um degrau reto no
       meio do quadro. */
    function blocked(r, a) {
      var x = GEO.crowdCX + Math.sin(a) * r;
      var z = GEO.crowdCZ + Math.cos(a) * r;
      if (z > 3.0) return true;
      var minX = GEO.corridorBase + Math.abs(z) * GEO.corridorSlope + 0.5;
      return Math.abs(x) < minX;
    }
    var dark = tc('shadow', 0x0a0414).multiplyScalar(0.42);
    var lit = tc('groundGlow', 0xff6a1e).multiplyScalar(0.055);
    var tmp = new THREE.Color();

    function put(r, a) {
      var x = GEO.crowdCX + Math.sin(a) * r;
      var z = GEO.crowdCZ + Math.cos(a) * r;
      /* a borda externa desce ate o nivel do terreno e apaga: sem isso o
         poligono do chao vira um corte reto contra o rio */
      var out = clamp01((r - 42) / 12);
      var y = pitHeightAt(r, z) - 0.02;
      y = lerp(y, GEO.groundY - 0.06, out * out);
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      nor[k] = 0; nor[k + 1] = 1; nor[k + 2] = 0;
      /* mais claro perto do palco (o palco ilumina o chao) */
      var f = clamp01(1 - (r - 3) / 26);
      tmp.copy(dark).lerp(lit, f * f);
      var fade = 1 - out;
      col[k] = tmp.r * fade; col[k + 1] = tmp.g * fade; col[k + 2] = tmp.b * fade;
      uv[ku] = r * 0.25; uv[ku + 1] = a * 3;
      k += 3; ku += 2;
    }

    var i, j;
    for (i = 0; i < RINGS; i++) {
      var r0 = 2.2 + Math.pow(i / RINGS, 0.86) * 52;
      var r1 = 2.2 + Math.pow((i + 1) / RINGS, 0.86) * 52;
      for (j = 0; j < SEGS; j++) {
        var a0 = -PI * 0.64 + (j / SEGS) * PI * 1.28;
        var a1 = -PI * 0.64 + ((j + 1) / SEGS) * PI * 1.28;
        if (blocked(r0, a0) || blocked(r1, a0) || blocked(r0, a1) || blocked(r1, a1)) continue;
        put(r0, a0); put(r1, a0); put(r1, a1);
        put(r0, a0); put(r1, a1); put(r0, a1);
      }
    }
    var geo = keep(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, k), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, k), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, k), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, ku), 2));

    /* Mesma razao do terreno: com neblina ligada este leque inteiro assumia a
       cor da neblina do tema e virava chapa. Sem ela vale a cor de vertice,
       que ja tem queda radial (perto do palco quente, borda no preto). */
    var mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.FrontSide });
    keep(mat);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'GH_Stage_Pit';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  /* =========================================================================
     5. PUBLICO
     Um leque de ~4200 pessoas em torno de (0, -30), com o corredor da pista
     vazio. Tres InstancedMesh:
       nearA  corpo 3D, bracos abaixados (perto da camera)
       nearB  corpo 3D, bracos levantados
       far    billboard CRUZADO com o atlas de silhuetas (16 poses)
     A ONDA: cada pessoa tem um atraso proporcional a distancia do palco, e
     o pulo e uma senoide retificada na fase da batida. O resultado e uma
     onda que atravessa a multidao a ~34 unidades por segundo.
     ========================================================================= */

  /* --- corpo 3D low-poly com contraluz assado em cor de vertice ---------- */
  function buildBodyGeometry(armsUp) {
    var parts = [];
    var seg = 7;

    /* pernas (bloco unico — ninguem le perna em silhueta de multidao) */
    parts.push({ geo: new THREE.BoxGeometry(0.30, 0.80, 0.22), matrix: TRS(0, 0.40, 0) });
    /* tronco: cone truncado, ombros mais largos */
    parts.push({ geo: new THREE.CylinderGeometry(0.20, 0.155, 0.62, seg, 1), matrix: TRS(0, 1.10, 0) });
    /* ombros */
    parts.push({ geo: new THREE.SphereGeometry(0.098, 6, 4), matrix: TRS(-0.185, 1.34, 0) });
    parts.push({ geo: new THREE.SphereGeometry(0.098, 6, 4), matrix: TRS(0.185, 1.34, 0) });
    /* pescoco + cabeca */
    parts.push({ geo: new THREE.CylinderGeometry(0.052, 0.062, 0.09, 5, 1), matrix: TRS(0, 1.44, 0) });
    parts.push({ geo: new THREE.SphereGeometry(0.118, 7, 5), matrix: TRS(0, 1.58, 0) });

    if (armsUp) {
      /* bracos erguidos em V, levemente para fora */
      parts.push({ geo: new THREE.BoxGeometry(0.072, 0.44, 0.072), matrix: TRS(-0.245, 1.55, 0, 0, 0, 0.30) });
      parts.push({ geo: new THREE.BoxGeometry(0.062, 0.40, 0.062), matrix: TRS(-0.36, 1.93, 0, 0, 0, 0.42) });
      parts.push({ geo: new THREE.BoxGeometry(0.072, 0.44, 0.072), matrix: TRS(0.245, 1.55, 0, 0, 0, -0.30) });
      parts.push({ geo: new THREE.BoxGeometry(0.062, 0.40, 0.062), matrix: TRS(0.36, 1.93, 0, 0, 0, -0.42) });
      /* maos */
      parts.push({ geo: new THREE.SphereGeometry(0.055, 5, 4), matrix: TRS(-0.455, 2.13, 0) });
      parts.push({ geo: new THREE.SphereGeometry(0.055, 5, 4), matrix: TRS(0.455, 2.13, 0) });
    } else {
      /* bracos meio dobrados na frente (palma/celular) */
      parts.push({ geo: new THREE.BoxGeometry(0.072, 0.40, 0.072), matrix: TRS(-0.225, 1.14, 0.02, 0, 0, -0.12) });
      parts.push({ geo: new THREE.BoxGeometry(0.062, 0.32, 0.062), matrix: TRS(-0.19, 0.86, 0.17, 1.0, 0, 0) });
      parts.push({ geo: new THREE.BoxGeometry(0.072, 0.40, 0.072), matrix: TRS(0.225, 1.14, 0.02, 0, 0, 0.12) });
      parts.push({ geo: new THREE.BoxGeometry(0.062, 0.32, 0.062), matrix: TRS(0.19, 0.86, 0.17, 1.0, 0, 0) });
    }

    var geo = mergeGeometries(parts);
    var i;
    for (i = 0; i < parts.length; i++) parts[i].geo.dispose();

    /* CONTRALUZ ASSADA. A cor de vertice e um MULTIPLICADOR quase neutro
       (0.25 na sombra, ate 2.4 na crista iluminada) — a MATIZ da silhueta
       vem do instanceColor. Misturar duas cores escuras aqui foi o que
       transformou o publico num paredao preto na primeira captura. */
    var pos = geo.attributes.position.array;
    var nor = geo.attributes.normal.array;
    var col = geo.attributes.color.array;
    var n = geo.attributes.position.count;
    var warm = new THREE.Color(1.0, 0.62, 0.78);      /* viés do contraluz */
    for (i = 0; i < n; i++) {
      var ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
      var h = clamp01(pos[i * 3 + 1] / 2.2);
      /* de cima/atras => normal com y positivo ou z negativo recebe luz */
      var back = clamp01(-nz * 0.72 + ny * 0.58);
      var k = 0.28 + h * 0.42 + back * back * 2.05;
      col[i * 3] = k * (1 + (warm.r - 1) * back * 0.55);
      col[i * 3 + 1] = k * (1 + (warm.g - 1) * back * 0.55);
      col[i * 3 + 2] = k * (1 + (warm.b - 1) * back * 0.55);
    }
    geo.attributes.color.needsUpdate = true;
    return keep(geo);
  }

  /* --- billboard cruzado para o publico distante ------------------------- */
  function buildFarCrowdGeometry() {
    /* dois quads a 90 graus: nunca fica de perfil, truque classico de
       vegetacao aplicado a multidao */
    var pos = [], uv = [], nor = [], col = [];
    var quads = [
      [[-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, 0], [-0.5, 1, 0], [0, 0, 1]],
      [[0, 0, -0.5], [0, 0, 0.5], [0, 1, 0.5], [0, 1, -0.5], [1, 0, 0]]
    ];
    var uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    var idx = [0, 1, 2, 0, 2, 3];
    var qi, ii;
    for (qi = 0; qi < quads.length; qi++) {
      var q = quads[qi];
      for (ii = 0; ii < idx.length; ii++) {
        var v = q[idx[ii]];
        pos.push(v[0], v[1], v[2]);
        nor.push(q[4][0], q[4][1], q[4][2]);
        uv.push(uvs[idx[ii]][0], uvs[idx[ii]][1]);
        /* multiplicador neutro: escuro no pe, com um levantada quente no
           alto (ombro/cabeca pegam o contraluz do palco) */
        var k = 0.42 + v[1] * 1.05;
        col.push(k * 1.0, k * 0.90, k * 1.02);
      }
    }
    var geo = keep(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return geo;
  }

  /* Material do publico distante: atlas 4x4 com quadro escolhido por
     instancia via attribute `aUv`. */
  function makeFarCrowdMaterial() {
    var map = sharedTex('crowdDots');
    var mat = new THREE.MeshBasicMaterial({
      map: map,
      alphaTest: 0.42,
      transparent: false,
      side: THREE.DoubleSide,
      vertexColors: true,
      fog: true
    });
    keep(mat);
    var prev = null;
    mat.onBeforeCompile = function (shader) {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'attribute vec2 aOff;\nattribute vec2 aUv;\nvoid main() {')
        .replace('#include <uv_vertex>',
          '#include <uv_vertex>\n#ifdef USE_UV\n  vUv = vUv * 0.25 + aUv;\n#endif')
        .replace('#include <project_vertex>',
          'vec4 mvPosition = vec4( transformed, 1.0 );\n' +
          '#ifdef USE_INSTANCING\n  mvPosition = instanceMatrix * mvPosition;\n#endif\n' +
          'mvPosition.x += aOff.x;\n  mvPosition.y += aOff.y;\n' +
          'mvPosition = modelViewMatrix * mvPosition;\n' +
          'gl_Position = projectionMatrix * mvPosition;');
      if (prev) prev(shader);
    };
    mat.customProgramCacheKey = function () { return 'ghCrowdFar'; };
    return mat;
  }

  function makeNearCrowdMaterial() {
    var mat = new THREE.MeshBasicMaterial({
      vertexColors: true, fog: true, side: THREE.FrontSide
    });
    keep(mat);
    attachInstanceOffset(mat);
    return mat;
  }

  /* --- distribuicao do publico ------------------------------------------- */
  function buildCrowd() {
    var g = new THREE.Group();
    g.name = 'GH_Stage_Crowd';

    var qual = 1;
    try {
      if (GH.Engine && GH.Engine.qualityScale && GH.Engine.qualityScale.crowd) {
        qual = clamp(GH.Engine.qualityScale.crowd, 0.25, 1.4);
      }
    } catch (e) { qual = 1; }
    var total = Math.round(CROWD_TARGET * qual);

    var r = rng(101);
    var pts = [];
    var camZ = 6.35, camY = 3.05;
    var guard = 0;
    while (pts.length < total && guard < total * 6) {
      guard++;
      /* raio uniforme em AREA (mais gente longe, densidade constante) */
      var u = rnd(r);
      var rad = Math.sqrt(u * (GEO.crowdRMax * GEO.crowdRMax - GEO.crowdRMin * GEO.crowdRMin) +
                          GEO.crowdRMin * GEO.crowdRMin);
      var ang = (rnd(r) * 2 - 1) * PI * 0.72;
      var x = GEO.crowdCX + Math.sin(ang) * rad;
      var z = GEO.crowdCZ + Math.cos(ang) * rad;
      /* Ninguem entre a camera e a linha de acerto: uma silhueta a 7 unidades
         da lente vira um paredao preto de 2 metros na tela. */
      if (z > GEO.crowdZLimit) continue;
      /* corredor da pista SEMPRE vazio: espetaculo nunca tapa nota */
      var minX = GEO.corridorBase + Math.abs(z) * GEO.corridorSlope;
      /* na faixa proxima da lente so sobra gente BEM pelos lados: assim as
         silhuetas de primeiro plano dao profundidade sem entrar no quadro
         do gameplay */
      if (z > GEO.crowdSideOnlyZ) minX = Math.max(minX, GEO.crowdSideX);
      if (Math.abs(x) < minX) continue;
      /* jitter para nao virar grade radial */
      x += rrange(r, -0.5, 0.5);
      z += rrange(r, -0.5, 0.5);
      var y = pitHeightAt(rad, z);
      var d = Math.sqrt(x * x + (y - camY) * (y - camY) + (z - camZ) * (z - camZ));
      if (d < GEO.crowdMinCamDist) continue;       /* perto demais da lente */
      pts.push({
        x: x, y: y, z: z, r: rad, d: d,
        h: rrange(r, 0.86, 1.10),                  /* variacao de altura */
        yaw: Math.atan2(-x, camZ - z) + rrange(r, -0.42, 0.42),
        phase: rrange(r, 0, 1),
        tint: rrange(r, 0, 1),
        jumper: rnd(r) < (0.42 + 0.28 * clamp01(1 - rad / 30)),
        armsUp: rnd(r) < 0.38,
        frame: (rnd(r) * 16) | 0,
        phone: rnd(r) < 0.30
      });
    }

    /* separa por LOD: perto da camera vira corpo 3D, longe vira billboard */
    var nearA = [], nearB = [], far = [];
    var i, p;
    var nearBudget = Math.round(900 * qual);
    pts.sort(function (a, b) { return a.d - b.d; });
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      if (i < nearBudget && p.d < 30) {
        if (p.armsUp) nearB.push(p); else nearA.push(p);
      } else {
        far.push(p);
      }
    }

    var crowdBaseC = tc('crowdTint', 0x3a1a50);
    var geoA = buildBodyGeometry(false);
    var geoB = buildBodyGeometry(true);
    var geoF = buildFarCrowdGeometry();
    var matNear = makeNearCrowdMaterial();
    var matFar = makeFarCrowdMaterial();

    crowd = {
      group: g,
      sets: [],
      phones: null,
      waveSpeed: 34,
      jumpBase: 0.30
    };

    function makeSet(list, geo, mat, isFar) {
      if (!list.length) return null;
      var im = new THREE.InstancedMesh(geo, mat, list.length);
      im.frustumCulled = false;                  /* bounding sphere nao cobre instancias */
      im.castShadow = false;
      im.receiveShadow = false;
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      var arr = im.instanceMatrix.array;
      var off = new Float32Array(list.length * 2);
      var uvA = isFar ? new Float32Array(list.length * 2) : null;
      var colorArr = new Float32Array(list.length * 3);
      var tint = new THREE.Color();
      var ramp = (P && P.ramps && P.ramps.crowd) ? P.ramps.crowd : null;
      var k;
      for (k = 0; k < list.length; k++) {
        var q = list[k];
        var s = q.h;
        var sc = Math.cos(q.yaw), ss = Math.sin(q.yaw);
        /* O quadro do atlas e quadrado e a figura ocupa quase toda a altura
           da celula: para nao achatar ninguem, largura ~= altura. */
        var hFar = s * 2.30 * rrangeStable(q, 0.96, 1.05);
        var wFar = hFar * 0.85;
        writeInstance(arr, k, q.x, q.y, q.z, sc, ss,
                      isFar ? wFar : s * 0.98, isFar ? hFar : s, isFar ? wFar : s * 0.98);
        if (uvA) {
          var col = q.frame % 4, row = (q.frame / 4) | 0;
          uvA[k * 2] = col * 0.25;
          uvA[k * 2 + 1] = 1 - (row + 1) * 0.25;
        }
        /* COR DA SILHUETA (a matiz de verdade). A cor de vertice ja e o
           sombreamento; aqui entra so o tom da pessoa. Gente perto do palco
           pega mais luz que gente no fundo. */
        if (ramp && P.sampleRamp) P.sampleRamp(ramp, q.tint, tint);
        else tint.setRGB(0.10, 0.07, 0.18);
        var boost = 0.62 + 0.75 * clamp01(1 - q.r / 30);
        /* ~9% da plateia usa roupa clara e pega a luz do palco de verdade:
           e essa minoria que da GRAO a multidao em vez de carpete uniforme */
        var pale = (q.tint > 0.91) ? (2.6 + (q.tint - 0.91) * 14) : 1.0;
        colorArr[k * 3] = clamp01((tint.r * 1.25 * boost + crowdBaseC.r * 0.55) * pale);
        colorArr[k * 3 + 1] = clamp01((tint.g * 1.20 * boost + crowdBaseC.g * 0.55) * pale);
        colorArr[k * 3 + 2] = clamp01((tint.b * 1.35 * boost + crowdBaseC.b * 0.60) * pale);
      }
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor = new THREE.InstancedBufferAttribute(colorArr, 3);
      im.instanceColor.needsUpdate = true;
      geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2).setUsage(THREE.DynamicDrawUsage));
      if (uvA) geo.setAttribute('aUv', new THREE.InstancedBufferAttribute(uvA, 2));
      g.add(im);
      var set = { mesh: im, list: list, off: off, attr: geo.attributes.aOff };
      crowd.sets.push(set);
      return set;
    }

    /* pseudo-random estavel derivado da propria pessoa (sem consumir o RNG) */
    function rrangeStable(q, a, b) {
      var v = (Math.sin(q.x * 12.9898 + q.z * 78.233) * 43758.5453);
      v = v - Math.floor(v);
      return a + (b - a) * v;
    }

    /* IMPORTANTE: cada set precisa da SUA geometria (o attribute aOff e por
       geometria). nearA e nearB ja usam geometrias distintas; o far usa a
       dele. Se um set ficar vazio a geometria orfa e descartada no dispose. */
    makeSet(nearA, geoA, matNear, false);
    makeSet(nearB, geoB, matNear, false);
    makeSet(far, geoF, matFar, true);

    /* ---------------- CELULARES -------------------------------------------
       THREE.Points aditivo: milhares de telinhas acesas por ~12 KB de
       buffer. E o detalhe que mais grita "show lotado" num print. */
    var phones = [];
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      if (!p.phone) continue;
      phones.push(p);
    }
    if (phones.length) {
      var pn = phones.length;
      var ppos = new Float32Array(pn * 3);
      var pcol = new Float32Array(pn * 3);
      var pc = new THREE.Color();
      var white = new THREE.Color(0xffffff);
      for (i = 0; i < pn; i++) {
        p = phones[i];
        ppos[i * 3] = p.x + (p.armsUp ? 0.0 : 0.16);
        ppos[i * 3 + 1] = p.y + p.h * (p.armsUp ? 2.10 : 1.32);
        ppos[i * 3 + 2] = p.z + 0.12;
        /* telas variam entre branco-azulado e ambar (video vs foto) */
        pc.copy(tc('spotlight', 0xffd9a8)).lerp(white, p.tint * 0.8);
        var b = 0.55 + 0.45 * p.tint;
        pcol[i * 3] = pc.r * b; pcol[i * 3 + 1] = pc.g * b; pcol[i * 3 + 2] = pc.b * b;
      }
      var pg = keep(new THREE.BufferGeometry());
      pg.setAttribute('position', new THREE.BufferAttribute(ppos, 3).setUsage(THREE.DynamicDrawUsage));
      pg.setAttribute('color', new THREE.BufferAttribute(pcol, 3));
      var pmat = new THREE.PointsMaterial({
        map: sharedTex('softGlow'),
        size: 0.34,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        fog: false,
        opacity: 0.92
      });
      keep(pmat);
      var pmesh = new THREE.Points(pg, pmat);
      pmesh.frustumCulled = false;
      pmesh.renderOrder = 7;
      g.add(pmesh);
      crowd.phones = { mesh: pmesh, list: phones, pos: ppos, attr: pg.attributes.position, mat: pmat };
    }

    crowd.count = pts.length;
    group.add(g);
  }

  /* --- animacao do publico (loop quente) ---------------------------------- */
  var _crowdAcc = 0;
  function updateCrowd(dt) {
    if (!crowd) return;
    var energy = intensitySmooth;
    var mood = crowdMood;
    var amp = crowd.jumpBase * (0.40 + 0.85 * energy) * mood * (1 + crowdSurge * 1.1);
    var sway = 0.055 * (0.3 + energy) * mood;
    var beatF = beatPos;
    var spB = spMix;
    var i, s, k, list, off;

    for (s = 0; s < crowd.sets.length; s++) {
      var set = crowd.sets[s];
      list = set.list; off = set.off;
      for (k = 0; k < list.length; k++) {
        var q = list[k];
        /* ONDA: atraso proporcional a distancia do palco */
        var ph = beatF - q.r / crowd.waveSpeed * 2.0 + q.phase * 0.10;
        var fr = ph - Math.floor(ph);
        var bounce = Math.sin(fr * PI);
        bounce = bounce * bounce * bounce;          /* pico curto, queda longa */
        var jump = q.jumper ? bounce * amp * q.h : bounce * amp * 0.28 * q.h;
        /* star power: pulo mais alto e mais nervoso */
        if (spB > 0.01) jump *= (1 + spB * 0.55);
        off[k * 2] = Math.sin(beatF * PI + q.phase * 6.283) * sway * (q.jumper ? 1 : 0.5);
        off[k * 2 + 1] = jump;
      }
      set.attr.needsUpdate = true;
    }

    /* celulares acompanham o dono + tremor de mao + cintilancia */
    var ph2 = crowd.phones;
    if (ph2) {
      var pos = ph2.pos;
      list = ph2.list;
      var t = elapsed;
      for (i = 0; i < list.length; i++) {
        var p = list[i];
        var phz = beatF - p.r / crowd.waveSpeed * 2.0 + p.phase * 0.10;
        var f2 = phz - Math.floor(phz);
        var b2 = Math.sin(f2 * PI); b2 = b2 * b2 * b2;
        var j2 = (p.jumper ? b2 * amp * p.h : b2 * amp * 0.28 * p.h);
        pos[i * 3 + 1] = p.y + p.h * (p.armsUp ? 2.10 : 1.32) + j2 +
                         Math.sin(t * 2.1 + p.phase * 9.0) * 0.035;
        pos[i * 3] = p.x + (p.armsUp ? 0 : 0.16) + Math.sin(t * 1.7 + p.phase * 12.0) * 0.03;
      }
      ph2.attr.needsUpdate = true;
      ph2.mat.opacity = clamp01((0.55 + 0.45 * mood) * (0.72 + 0.35 * energy) + spMix * 0.25);
      ph2.mat.size = 0.30 + 0.10 * energy + spMix * 0.08;
    }
  }

  /* =========================================================================
     6. ESTRUTURA DO PALCO
     Praticavel, saia frontal com faixa marajoara, barricada, torres de PA,
     monitores de chao, caixotes. Tudo mesclado em poucas geometrias.
     ========================================================================= */

  function buildStageStructure() {
    var g = new THREE.Group();
    g.name = 'GH_Stage_Build';
    var DY = GEO.deckY, FZ = GEO.deckFrontZ, BZ = GEO.deckBackZ, HW = GEO.deckHalfW;
    var depth = FZ - BZ;                      /* 20 */
    var midZ = (FZ + BZ) * 0.5;

    /* --- 1. TABLADO ------------------------------------------------------- */
    var deckParts = [];
    /* tampo */
    deckParts.push({ geo: new THREE.BoxGeometry(HW * 2, 0.26, depth), matrix: TRS(0, DY - 0.13, midZ) });
    /* saia frontal (do chao ate o tampo) */
    deckParts.push({ geo: new THREE.BoxGeometry(HW * 2, DY - 0.26, 0.5), matrix: TRS(0, (DY - 0.26) * 0.5, FZ - 0.25) });
    /* laterais */
    deckParts.push({ geo: new THREE.BoxGeometry(0.5, DY - 0.26, depth), matrix: TRS(-HW + 0.25, (DY - 0.26) * 0.5, midZ) });
    deckParts.push({ geo: new THREE.BoxGeometry(0.5, DY - 0.26, depth), matrix: TRS(HW - 0.25, (DY - 0.26) * 0.5, midZ) });
    /* praticavel da bateria */
    deckParts.push({ geo: new THREE.BoxGeometry(6.4, GEO.riserY - DY, 4.6), matrix: TRS(0, (GEO.riserY + DY) * 0.5, -41.5) });
    /* praticaveis laterais do teclado e da percussao */
    deckParts.push({ geo: new THREE.BoxGeometry(4.4, 0.42, 3.2), matrix: TRS(-9.4, DY + 0.21, -38.5) });
    deckParts.push({ geo: new THREE.BoxGeometry(4.0, 0.42, 3.0), matrix: TRS(9.6, DY + 0.21, -38.8) });

    var deckGeo = mergeGeometries(deckParts);
    var i;
    for (i = 0; i < deckParts.length; i++) deckParts[i].geo.dispose();
    keep(deckGeo);
    var deckMat = rimStandard({
      color: 0x0b0910, roughness: 0.86, metalness: 0.12,
      rim: tc('highwayEdge', 0xff3d8a), rimPower: 3.0, rimStrength: 0.30,
      top: tc('spotlight', 0xffd9a8), topStrength: 0.055
    });
    var deck = new THREE.Mesh(deckGeo, deckMat);
    deck.frustumCulled = false;
    g.add(deck);

    /* --- 2. FAIXA MARAJOARA na saia do palco ------------------------------
       Reaproveita a textura marajoara compartilhada. E a assinatura
       paraense do cenario: nada de Guitar Hero generico repintado. */
    var band0 = sharedTex('marajoaraBand');
    if (band0) {
      var bandTex = band0.clone();
      bandTex.wrapS = THREE.RepeatWrapping;
      bandTex.wrapT = THREE.ClampToEdgeWrapping;
      bandTex.repeat.set(14, 1);
      bandTex.needsUpdate = true;
      keep(bandTex);
      var bandMat = new THREE.MeshBasicMaterial({
        map: bandTex, color: tc('accent', 0xffb03a).multiplyScalar(0.85),
        fog: true, toneMapped: true, transparent: true, opacity: 0.92, depthWrite: false
      });
      keep(bandMat);
      var bandGeo = keep(new THREE.PlaneGeometry(HW * 2 - 0.4, 0.86));
      var bandMesh = new THREE.Mesh(bandGeo, bandMat);
      bandMesh.position.set(0, DY - 0.72, FZ - 0.49);
      bandMesh.renderOrder = 2;
      bandMesh.frustumCulled = false;
      g.add(bandMesh);
      stageBuildRef.marajoara = bandMat;
    }

    /* --- 2b. RIBALTA (footlights) ----------------------------------------
       Fila de refletores rasos na boca de cena apontando para a banda. Sao
       eles que separam o musico do telao — sem ribalta, silhueta escura em
       frente a painel claro vira mancha. */
    var footMat = new THREE.MeshBasicMaterial({
      map: sharedTex('softGlow'),
      color: tc('spotlight', 0xffd9a8),
      transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide
    });
    keep(footMat);
    var footGeo = keep(new THREE.PlaneGeometry(0.9, 0.9));
    var fx;
    for (fx = -12; fx <= 12; fx += 1.6) {
      var fq = new THREE.Mesh(footGeo, footMat);
      fq.position.set(fx, GEO.deckY + 0.16, FZ + 0.55);
      fq.renderOrder = 11;
      fq.frustumCulled = false;
      g.add(fq);
    }
    stageBuildRef.footMat = footMat;
    /* luz real de ribalta: quente, curta, so lambe a banda por baixo */
    var footLight = new THREE.PointLight(tc('spotlight', 0xffd9a8), 34, 22, 2);
    footLight.position.set(0, GEO.deckY + 1.1, FZ + 1.0);
    footLight.castShadow = false;
    g.add(footLight);
    stageBuildRef.footLight = footLight;

    /* --- 3. NEON NA BORDA DO TABLADO -------------------------------------- */
    var edgeMat = new THREE.MeshBasicMaterial({
      color: tc('highwayEdge', 0xff3d8a), toneMapped: false, fog: false
    });
    keep(edgeMat);
    var edgeGeo = keep(new THREE.BoxGeometry(HW * 2, 0.075, 0.075));
    var edgeMesh = new THREE.Mesh(edgeGeo, edgeMat);
    edgeMesh.position.set(0, DY + 0.02, FZ - 0.02);
    edgeMesh.frustumCulled = false;
    g.add(edgeMesh);
    stageBuildRef.edgeNeon = edgeMat;

    /* --- 4. BARRICADA na frente do palco ---------------------------------- */
    var barParts = [];
    var bx;
    for (bx = -17; bx <= 17; bx += 1.7) {
      if (Math.abs(bx) < GEO.corridorBase + 1.2) continue;
      barParts.push({ geo: new THREE.BoxGeometry(0.10, 1.05, 0.10), matrix: TRS(bx, GEO.pitY + 0.52, FZ + 1.9) });
    }
    barParts.push({ geo: new THREE.BoxGeometry(13.6, 0.11, 0.11), matrix: TRS(-11.2, GEO.pitY + 1.02, FZ + 1.9) });
    barParts.push({ geo: new THREE.BoxGeometry(13.6, 0.11, 0.11), matrix: TRS(11.2, GEO.pitY + 1.02, FZ + 1.9) });
    var barGeo = keep(mergeGeometries(barParts));
    for (i = 0; i < barParts.length; i++) barParts[i].geo.dispose();
    var metalMat = rimStandard({
      color: 0x171a22, roughness: 0.42, metalness: 0.92,
      rim: tc('neon', 0x25e8ce), rimPower: 2.2, rimStrength: 0.55,
      envMapIntensity: 1.1
    });
    var bar = new THREE.Mesh(barGeo, metalMat);
    bar.frustumCulled = false;
    g.add(bar);

    /* --- 5. TORRES DE PA (line array) ------------------------------------- */
    var paParts = [];
    function paStack(px) {
      var j;
      for (j = 0; j < 8; j++) {
        var w = 2.0 - j * 0.06;
        var yy = DY + 6.6 - j * 0.72;
        var tilt = -0.06 - j * 0.045;
        paParts.push({ geo: new THREE.BoxGeometry(w, 0.62, 1.05), matrix: TRS(px, yy, -33.0 + j * 0.10, tilt, 0, 0) });
      }
      /* subwoofers empilhados no chao do palco */
      for (j = 0; j < 2; j++) {
        paParts.push({ geo: new THREE.BoxGeometry(2.1, 1.15, 1.5), matrix: TRS(px, DY + 0.58 + j * 1.18, -33.4) });
      }
      /* torre de sustentacao */
      paParts.push({ geo: new THREE.BoxGeometry(0.16, 7.2, 0.16), matrix: TRS(px - 1.1, DY + 3.6, -33.9) });
      paParts.push({ geo: new THREE.BoxGeometry(0.16, 7.2, 0.16), matrix: TRS(px + 1.1, DY + 3.6, -33.9) });
    }
    paStack(-GEO.towerX + 1.4);
    paStack(GEO.towerX - 1.4);
    /* monitores de chao virados para a banda */
    var mons = [-6.5, -2.2, 2.2, 6.5];
    for (i = 0; i < mons.length; i++) {
      paParts.push({ geo: new THREE.BoxGeometry(1.25, 0.52, 0.72), matrix: TRS(mons[i], DY + 0.24, -32.2, -0.42, 0, 0) });
    }
    /* caixotes de equipamento */
    for (i = 0; i < 6; i++) {
      var cx2 = (i < 3 ? -12.2 - i * 1.5 : 12.2 + (i - 3) * 1.5);
      paParts.push({ geo: new THREE.BoxGeometry(1.4, 0.95, 1.1), matrix: TRS(cx2, DY + 0.48, -44.5 + (i % 2) * 1.4) });
    }
    var paGeo = keep(mergeGeometries(paParts));
    for (i = 0; i < paParts.length; i++) paParts[i].geo.dispose();
    var paMat = rimStandard({
      color: 0x0a0b10, roughness: 0.78, metalness: 0.30,
      rim: tc('neon', 0x25e8ce), rimPower: 2.6, rimStrength: 0.62,
      top: tc('spotlight', 0xffd9a8), topStrength: 0.10
    });
    var pa = new THREE.Mesh(paGeo, paMat);
    pa.frustumCulled = false;
    g.add(pa);

    stageBuildRef.group = g;
    stageBuildRef.deckMat = deckMat;
    stageBuildRef.metalMat = metalMat;
    stageBuildRef.paMat = paMat;
    stageBuild = stageBuildRef;
    group.add(g);
  }
  var stageBuildRef = {};

  /* =========================================================================
     7. TELAO DE LED
     CanvasTexture redesenhada a ~14 Hz (nao todo frame). Quatro modos que
     trocam a cada 4 compassos: equalizador, grafismo marajoara, onda e
     tipografia. A grade de pixel e desenhada NO CANVAS — assim o painel le
     como LED de verdade sem custar um segundo material.
     ========================================================================= */

  var LED_W = 640, LED_H = 128;

  function buildLed() {
    var cv = makeCanvas(LED_W, LED_H);
    var tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    keep(tex);

    var mat = new THREE.MeshBasicMaterial({
      map: tex, toneMapped: false, fog: false, side: THREE.FrontSide
    });
    keep(mat);
    var geo = keep(new THREE.PlaneGeometry(GEO.ledHalfW * 2, GEO.ledY1 - GEO.ledY0));
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, (GEO.ledY0 + GEO.ledY1) * 0.5, GEO.ledZ);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;

    /* moldura preta com um fio de neon em volta */
    var frameParts = [];
    var W2 = GEO.ledHalfW + 0.45, H0 = GEO.ledY0 - 0.45, H1 = GEO.ledY1 + 0.45;
    frameParts.push({ geo: new THREE.BoxGeometry(W2 * 2, 0.45, 0.5), matrix: TRS(0, H1 - 0.22, GEO.ledZ - 0.1) });
    frameParts.push({ geo: new THREE.BoxGeometry(W2 * 2, 0.45, 0.5), matrix: TRS(0, H0 + 0.22, GEO.ledZ - 0.1) });
    frameParts.push({ geo: new THREE.BoxGeometry(0.45, H1 - H0, 0.5), matrix: TRS(-W2 + 0.22, (H0 + H1) * 0.5, GEO.ledZ - 0.1) });
    frameParts.push({ geo: new THREE.BoxGeometry(0.45, H1 - H0, 0.5), matrix: TRS(W2 - 0.22, (H0 + H1) * 0.5, GEO.ledZ - 0.1) });
    var fgeo = keep(mergeGeometries(frameParts));
    var i;
    for (i = 0; i < frameParts.length; i++) frameParts[i].geo.dispose();
    var fmat = rimStandard({
      color: 0x05060a, roughness: 0.55, metalness: 0.7,
      rim: tc('neon', 0x25e8ce), rimPower: 2.0, rimStrength: 0.5
    });
    var frame = new THREE.Mesh(fgeo, fmat);
    frame.frustumCulled = false;

    /* halo aditivo na frente do telao: o painel "sangra" luz no haze */
    var haloMat = new THREE.MeshBasicMaterial({
      map: sharedTex('softGlow'),
      color: tc('ledScreen', 0xff2e9a),
      transparent: true, opacity: 0.20, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide
    });
    keep(haloMat);
    var haloGeo = keep(new THREE.PlaneGeometry(GEO.ledHalfW * 2.9, (GEO.ledY1 - GEO.ledY0) * 2.4));
    var halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.set(0, (GEO.ledY0 + GEO.ledY1) * 0.5, GEO.ledZ + 0.6);
    halo.renderOrder = 9;
    halo.frustumCulled = false;

    var g = new THREE.Group();
    g.name = 'GH_Stage_LED';
    g.add(frame, mesh, halo);
    group.add(g);

    led = {
      group: g, canvas: cv, ctx: cv.getContext('2d'), tex: tex, mat: mat,
      halo: haloMat, frameMat: fmat,
      acc: 0, hz: 14, mode: 0, modeT: 0, bars: new Float32Array(30),
      barsTarget: new Float32Array(30), scroll: 0
    };
    drawLed(0);
  }

  var LED_WORDS = ['GUITARRADA', 'VER-O-PESO', 'BELEM DO PARA', 'XIMBINHA'];

  function drawLed(dt) {
    if (!led) return;
    var g = led.ctx, W = LED_W, H = LED_H;
    var e = intensitySmooth;
    var i;

    /* fundo */
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#04030a';
    g.fillRect(0, 0, W, H);

    var c0 = tcss('stageLight0', null) || (theme && theme.hex.stageLight ? theme.hex.stageLight[0] : '#ff5a1e');
    var cA = (theme && theme.hex.stageLight) ? theme.hex.stageLight[0] : '#ff5a1e';
    var cB = (theme && theme.hex.stageLight && theme.hex.stageLight.length > 1) ? theme.hex.stageLight[1] : '#ff2e9a';
    var cC = (theme && theme.hex.stageLight && theme.hex.stageLight.length > 2) ? theme.hex.stageLight[2] : '#22e0c6';
    if (spMix > 0.5) { cA = '#f2fbff'; cB = '#8fd8ff'; cC = '#3aa8ff'; }

    /* brilho de fundo pulsando no compasso */
    var bg = g.createRadialGradient(W * 0.5, H * 0.55, 10, W * 0.5, H * 0.55, W * 0.62);
    bg.addColorStop(0, hexA(cB, 0.32 + 0.30 * beatPulse * e));
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    var mode = led.mode;

    if (mode === 0) {
      /* --- EQUALIZADOR --- */
      var n = led.bars.length;
      var bw = W / n;
      for (i = 0; i < n; i++) {
        var h = led.bars[i] * H * 0.86;
        var x = i * bw;
        var grd = g.createLinearGradient(0, H, 0, H - h);
        grd.addColorStop(0, cC);
        grd.addColorStop(0.55, cA);
        grd.addColorStop(1, '#fff6df');
        g.fillStyle = grd;
        g.fillRect(x + bw * 0.14, H - h, bw * 0.72, h);
        /* espelho fraco em cima */
        g.globalAlpha = 0.18;
        g.fillRect(x + bw * 0.14, 0, bw * 0.72, h * 0.34);
        g.globalAlpha = 1;
      }
    } else if (mode === 1) {
      /* --- GRAFISMO MARAJOARA (reaproveita o atlas compartilhado) --- */
      var mc = sharedCanvas('marajoara');
      if (mc) {
        var cell = mc.width / 4;
        var cols = 8;
        for (i = 0; i < cols; i++) {
          var idx = (i + ((barPos | 0) % 4)) % 16;
          var sc = idx % 4, sr = (idx / 4) | 0;
          var dw = W / cols, dh = H;
          g.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(i * 0.9 + elapsed * 1.4));
          g.drawImage(mc, sc * cell, sr * cell, cell, cell, i * dw, 0, dw, dh);
          g.globalAlpha = 1;
        }
        /* tinge com a cor do tema */
        g.globalCompositeOperation = 'source-atop';
        var mg = g.createLinearGradient(0, 0, W, 0);
        mg.addColorStop(0, cA); mg.addColorStop(0.5, cB); mg.addColorStop(1, cC);
        g.fillStyle = mg;
        g.globalAlpha = 0.75;
        g.fillRect(0, 0, W, H);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      }
    } else if (mode === 2) {
      /* --- ONDAS / OSCILOSCOPIO --- */
      var k;
      for (k = 0; k < 4; k++) {
        g.strokeStyle = [cA, cB, cC, '#fff2d8'][k];
        g.globalAlpha = 0.85 - k * 0.16;
        g.lineWidth = 3.4 - k * 0.6;
        g.beginPath();
        for (i = 0; i <= W; i += 6) {
          var u = i / W;
          var amp = H * (0.10 + 0.24 * e) * (0.5 + 0.5 * Math.sin(u * PI));
          var y = H * 0.5 +
                  Math.sin(u * 14 + elapsed * 3.1 + k * 1.2) * amp +
                  Math.sin(u * 33 - elapsed * 4.6 + k) * amp * 0.35;
          if (i === 0) g.moveTo(i, y); else g.lineTo(i, y);
        }
        g.stroke();
      }
      g.globalAlpha = 1;
    } else {
      /* --- TIPOGRAFIA --- */
      var word = LED_WORDS[(barPos / 4 | 0) % LED_WORDS.length];
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = '900 ' + Math.round(H * 0.62) + 'px "Segoe UI", Arial, sans-serif';
      g.fillStyle = hexA(cB, 0.35);
      g.fillText(word, W * 0.5 + 4, H * 0.52 + 4);
      var tg = g.createLinearGradient(0, H * 0.15, 0, H * 0.85);
      tg.addColorStop(0, '#fff8e2');
      tg.addColorStop(0.5, cA);
      tg.addColorStop(1, cB);
      g.fillStyle = tg;
      g.fillText(word, W * 0.5, H * 0.5);
      g.lineWidth = 2;
      g.strokeStyle = hexA(cC, 0.8);
      g.strokeText(word, W * 0.5, H * 0.5);
    }

    /* varredura horizontal (o telao nunca fica estatico) */
    led.scroll = (led.scroll + dt * (40 + 160 * e)) % (W * 2);
    var sw = g.createLinearGradient(led.scroll - W, 0, led.scroll, 0);
    sw.addColorStop(0, 'rgba(255,255,255,0)');
    sw.addColorStop(0.85, hexA('#ffffff', 0.05 + 0.09 * e));
    sw.addColorStop(1, 'rgba(255,255,255,0)');
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = sw;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';

    /* GRADE DE PIXEL: e isto que faz o painel virar LED e nao um jpeg */
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = '#000000';
    var step = 5;
    for (i = 0; i < W; i += step) g.fillRect(i, 0, 1.6, H);
    for (i = 0; i < H; i += step) g.fillRect(0, i, W, 1.6);
    g.globalCompositeOperation = 'source-over';

    /* vinheta suave */
    var vg = g.createLinearGradient(0, 0, W, 0);
    vg.addColorStop(0, 'rgba(0,0,0,0.45)');
    vg.addColorStop(0.08, 'rgba(0,0,0,0)');
    vg.addColorStop(0.92, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);

    led.tex.needsUpdate = true;
  }

  function updateLed(dt) {
    if (!led) return;
    var i, n = led.bars.length;
    /* alvo do equalizador: espectro falso reagindo a batida e a intensidade */
    for (i = 0; i < n; i++) {
      var f = i / (n - 1);
      var base = Math.pow(1 - f, 0.9) * 0.55 + 0.12;
      var wob = 0.5 + 0.5 * Math.sin(elapsed * (2.2 + i * 0.31) + i * 1.7);
      var kick = beatPulse * (1 - f * 0.5);
      led.barsTarget[i] = clamp01((base * (0.35 + 0.9 * intensitySmooth) + wob * 0.22 + kick * 0.45));
    }
    var k = 1 - Math.exp(-dt * 15);
    for (i = 0; i < n; i++) led.bars[i] += (led.barsTarget[i] - led.bars[i]) * k;

    led.acc += dt;
    var per = 1 / led.hz;
    if (led.acc >= per) {
      drawLed(led.acc);
      led.acc = 0;
    }
    /* brilho do painel e do halo seguem a energia do show */
    var b = 0.75 + 0.55 * intensitySmooth + beatPulse * 0.25 + spMix * 0.3;
    led.mat.color.setScalar(b);
    led.halo.opacity = clamp01(0.10 + 0.22 * intensitySmooth + beatPulse * 0.12 + spMix * 0.2);
  }

  /* =========================================================================
     8. BANDA
     Seis musicos low-poly com esqueleto procedural. Cada um e um Group com
     poucos meshes mesclados: corpo (pernas+tronco+cabeca), dois bracos de
     dois segmentos e o instrumento. A animacao e toda derivada da posicao
     em batidas — nao ha keyframe, nao ha estado escondido.
       guitarrista   palhetada em oitavos, mao esquerda passeando no braco
       baixista      palhetada em semínimas, gingado largo
       baterista     baquetas batendo no beat, prato balancando
       percussionista maos alternadas no curimbo
       tecladista    maos descendo no acorde a cada tempo
       metais        naipe balancando, sino do trompete subindo no refrao
     ========================================================================= */

  /* Escala 1.18: num plano geral de arena um musico de 1,80 m vira 30 px.
     Os jogos de referencia exageram a banda de proposito — heroi de palco
     precisa ler em silhueta. */
  /* Escala 1,38 e o naipe agrupado 1,5 un mais a frente: com 1,18 e a banda
     espalhada de x=-9,8 a x=+9,9 nenhum instrumento era legivel no plano
     geral (medido em stage_wide) — o contrato pede guitarrista, baixista,
     baterista e percussionista TOCANDO, e eles precisam ler em silhueta. */
  var BAND_SCALE = 1.38;
  var BAND_SPEC = [
    { role: 'guitar',  x: -4.3,  z: -32.4, yaw: 0.20, h: 1.00, hue: 0 },
    { role: 'bass',    x: 4.7,   z: -32.9, yaw: -0.24, h: 1.05, hue: 1 },
    { role: 'drums',   x: 0.0,   z: -38.6, yaw: 0.00, h: 0.98, hue: 2 },
    { role: 'keys',    x: -8.2,  z: -35.8, yaw: 0.55, h: 0.97, hue: 1 },
    { role: 'perc',    x: 8.3,   z: -36.1, yaw: -0.58, h: 1.02, hue: 0 },
    { role: 'horn',    x: -1.3,  z: -34.9, yaw: 0.08, h: 1.01, hue: 2 }
  ];

  function bandBodyGeometry(spec) {
    var parts = [];
    /* pernas */
    parts.push({ geo: new THREE.BoxGeometry(0.19, 0.86, 0.20), matrix: TRS(-0.11, 0.43, 0) });
    parts.push({ geo: new THREE.BoxGeometry(0.19, 0.86, 0.20), matrix: TRS(0.11, 0.43, 0) });
    /* sapato */
    parts.push({ geo: new THREE.BoxGeometry(0.21, 0.09, 0.32), matrix: TRS(-0.11, 0.045, 0.05) });
    parts.push({ geo: new THREE.BoxGeometry(0.21, 0.09, 0.32), matrix: TRS(0.11, 0.045, 0.05) });
    /* quadril + tronco (cone truncado) */
    parts.push({ geo: new THREE.BoxGeometry(0.36, 0.20, 0.24), matrix: TRS(0, 0.94, 0) });
    parts.push({ geo: new THREE.CylinderGeometry(0.235, 0.175, 0.60, 8, 1), matrix: TRS(0, 1.34, 0) });
    /* ombros */
    parts.push({ geo: new THREE.SphereGeometry(0.115, 7, 5), matrix: TRS(-0.225, 1.60, 0) });
    parts.push({ geo: new THREE.SphereGeometry(0.115, 7, 5), matrix: TRS(0.225, 1.60, 0) });
    /* pescoco + cabeca */
    parts.push({ geo: new THREE.CylinderGeometry(0.058, 0.070, 0.10, 6, 1), matrix: TRS(0, 1.70, 0) });
    parts.push({ geo: new THREE.SphereGeometry(0.135, 9, 7), matrix: TRS(0, 1.86, 0.005) });
    /* cabelo/chapeu — silhuetas diferentes por musico */
    if (spec.role === 'guitar') {
      parts.push({ geo: new THREE.SphereGeometry(0.147, 9, 6, 0, TAU, 0, PI * 0.62), matrix: TRS(0, 1.87, -0.012) });
    } else if (spec.role === 'perc') {
      /* chapeu de palha */
      parts.push({ geo: new THREE.CylinderGeometry(0.30, 0.32, 0.03, 12, 1), matrix: TRS(0, 1.97, 0) });
      parts.push({ geo: new THREE.CylinderGeometry(0.115, 0.135, 0.10, 10, 1), matrix: TRS(0, 2.02, 0) });
    } else if (spec.role === 'bass') {
      parts.push({ geo: new THREE.SphereGeometry(0.150, 9, 6, 0, TAU, 0, PI * 0.48), matrix: TRS(0, 1.88, 0) });
    } else if (spec.role === 'keys') {
      parts.push({ geo: new THREE.SphereGeometry(0.145, 9, 6, 0, TAU, 0, PI * 0.55), matrix: TRS(0, 1.88, 0) });
    } else if (spec.role === 'horn') {
      /* boina */
      parts.push({ geo: new THREE.CylinderGeometry(0.155, 0.145, 0.055, 10, 1), matrix: TRS(0, 1.98, 0.01) });
    }
    var geo = mergeGeometries(parts);
    var i;
    for (i = 0; i < parts.length; i++) parts[i].geo.dispose();
    return keep(geo);
  }

  function armGeometry(len, thick) {
    /* origem no ombro, braco descendo em -Y */
    var g = new THREE.CylinderGeometry(thick * 0.86, thick, len, 6, 1);
    g.translate(0, -len * 0.5, 0);
    return keep(g);
  }

  function guitarGeometry(kind) {
    var parts = [];
    var bodyLen = kind === 'bass' ? 0.52 : 0.46;
    var neckLen = kind === 'bass' ? 0.92 : 0.80;
    /* corpo: dois discos achatados que se cruzam (silhueta de guitarra) */
    parts.push({ geo: new THREE.CylinderGeometry(0.24, 0.24, 0.075, 12, 1), matrix: TRS(0.10, 0, 0, PI * 0.5, 0, 0) });
    parts.push({ geo: new THREE.CylinderGeometry(0.185, 0.185, 0.075, 12, 1), matrix: TRS(-0.16, 0.02, 0, PI * 0.5, 0, 0) });
    /* braco */
    parts.push({ geo: new THREE.BoxGeometry(neckLen, 0.055, 0.075), matrix: TRS(-0.16 - neckLen * 0.5, 0.03, 0.02) });
    /* headstock */
    parts.push({ geo: new THREE.BoxGeometry(0.19, 0.075, 0.045), matrix: TRS(-0.16 - neckLen - 0.09, 0.035, 0.02, 0, 0, 0.16) });
    /* captadores / ponte */
    parts.push({ geo: new THREE.BoxGeometry(0.055, 0.10, 0.028), matrix: TRS(0.03, 0.0, 0.045) });
    parts.push({ geo: new THREE.BoxGeometry(0.045, 0.12, 0.028), matrix: TRS(0.17, 0.0, 0.045) });
    var g = mergeGeometries(parts);
    var i;
    for (i = 0; i < parts.length; i++) parts[i].geo.dispose();
    return keep(g);
  }

  function drumKitGeometry() {
    var parts = [];
    /* bumbo */
    parts.push({ geo: new THREE.CylinderGeometry(0.42, 0.42, 0.50, 16, 1), matrix: TRS(0, 0.42, 0.30, 0, 0, PI * 0.5) });
    /* caixa */
    parts.push({ geo: new THREE.CylinderGeometry(0.20, 0.20, 0.17, 14, 1), matrix: TRS(-0.42, 0.62, -0.02, 0.14, 0, 0.10) });
    /* tons */
    parts.push({ geo: new THREE.CylinderGeometry(0.17, 0.17, 0.22, 13, 1), matrix: TRS(-0.20, 0.94, 0.22, -0.30, 0, 0.05) });
    parts.push({ geo: new THREE.CylinderGeometry(0.19, 0.19, 0.24, 13, 1), matrix: TRS(0.20, 0.94, 0.22, -0.30, 0, -0.05) });
    /* surdo de chao */
    parts.push({ geo: new THREE.CylinderGeometry(0.25, 0.25, 0.36, 14, 1), matrix: TRS(0.55, 0.55, -0.05) });
    /* estantes */
    var st = [[-0.78, 0.62, -0.35], [0.80, 0.66, -0.30], [-0.05, 0.72, -0.55]];
    var i;
    for (i = 0; i < st.length; i++) {
      parts.push({ geo: new THREE.CylinderGeometry(0.022, 0.022, st[i][1] * 2, 5, 1), matrix: TRS(st[i][0], st[i][1], st[i][2]) });
    }
    var g = mergeGeometries(parts);
    for (i = 0; i < parts.length; i++) parts[i].geo.dispose();
    return keep(g);
  }

  function curimboGeometry() {
    var parts = [];
    /* tambor de curimbo: tronco escavado, deitado, o musico senta em cima */
    parts.push({ geo: new THREE.CylinderGeometry(0.30, 0.34, 1.25, 14, 1), matrix: TRS(0, 0.34, 0, 0, 0, PI * 0.5) });
    parts.push({ geo: new THREE.CylinderGeometry(0.305, 0.305, 0.05, 14, 1), matrix: TRS(-0.63, 0.34, 0, 0, 0, PI * 0.5) });
    /* pes de madeira */
    parts.push({ geo: new THREE.BoxGeometry(0.12, 0.12, 0.42), matrix: TRS(-0.42, 0.06, 0) });
    parts.push({ geo: new THREE.BoxGeometry(0.12, 0.12, 0.42), matrix: TRS(0.42, 0.06, 0) });
    var g = mergeGeometries(parts);
    var i;
    for (i = 0; i < parts.length; i++) parts[i].geo.dispose();
    return keep(g);
  }

  function keyboardGeometry() {
    var parts = [];
    parts.push({ geo: new THREE.BoxGeometry(1.42, 0.10, 0.36), matrix: TRS(0, 0.94, 0, -0.06, 0, 0) });
    parts.push({ geo: new THREE.BoxGeometry(1.42, 0.09, 0.10), matrix: TRS(0, 1.00, -0.16) });
    /* estante em X */
    parts.push({ geo: new THREE.BoxGeometry(0.05, 1.05, 0.05), matrix: TRS(-0.45, 0.46, 0, 0, 0, 0.22) });
    parts.push({ geo: new THREE.BoxGeometry(0.05, 1.05, 0.05), matrix: TRS(-0.45, 0.46, 0, 0, 0, -0.22) });
    parts.push({ geo: new THREE.BoxGeometry(0.05, 1.05, 0.05), matrix: TRS(0.45, 0.46, 0, 0, 0, 0.22) });
    parts.push({ geo: new THREE.BoxGeometry(0.05, 1.05, 0.05), matrix: TRS(0.45, 0.46, 0, 0, 0, -0.22) });
    var g = mergeGeometries(parts);
    var i;
    for (i = 0; i < parts.length; i++) parts[i].geo.dispose();
    return keep(g);
  }

  function hornGeometry() {
    var parts = [];
    /* trompete: tubo + campana */
    parts.push({ geo: new THREE.CylinderGeometry(0.028, 0.028, 0.48, 8, 1), matrix: TRS(0, 0, 0, PI * 0.5, 0, 0) });
    parts.push({ geo: new THREE.CylinderGeometry(0.115, 0.035, 0.22, 12, 1), matrix: TRS(0, 0, 0.34, PI * 0.5, 0, 0) });
    parts.push({ geo: new THREE.BoxGeometry(0.05, 0.075, 0.10), matrix: TRS(0, 0.045, -0.06) });
    var g = mergeGeometries(parts);
    var i;
    for (i = 0; i < parts.length; i++) parts[i].geo.dispose();
    return keep(g);
  }

  function buildBand() {
    var g = new THREE.Group();
    g.name = 'GH_Stage_Band';

    /* materiais: escuros, com contraluz forte. A cor de pele/roupa varia
       pouco de proposito — a banda tem que ler como SILHUETA. */
    var skinMat = rimStandard({
      color: 0x100c16, roughness: 0.68, metalness: 0.05,
      rim: tc('highwayEdge', 0xff3d8a), rimPower: 2.0, rimStrength: 1.35,
      top: tc('spotlight', 0xffd9a8), topStrength: 0.18
    });
    var instMat = rimStandard({
      color: 0x1a1118, roughness: 0.30, metalness: 0.65,
      rim: tc('neon', 0x25e8ce), rimPower: 1.8, rimStrength: 1.0,
      top: tc('accent', 0xffb03a), topStrength: 0.22, envMapIntensity: 1.4
    });
    var brassMat = rimStandard({
      color: 0x4a3210, roughness: 0.22, metalness: 1.0,
      rim: tc('accent', 0xffb03a), rimPower: 1.6, rimStrength: 1.5,
      envMapIntensity: 1.8
    });
    var cymbalMat = rimStandard({
      color: 0x3a2c10, roughness: 0.30, metalness: 1.0,
      rim: tc('accent', 0xffb03a), rimPower: 1.5, rimStrength: 1.3,
      envMapIntensity: 1.8, side: THREE.DoubleSide
    });

    var members = [];
    var upperLen = 0.34, foreLen = 0.32;
    var i, s;

    for (i = 0; i < BAND_SPEC.length; i++) {
      s = BAND_SPEC[i];
      var root = new THREE.Group();
      root.position.set(s.x, GEO.deckY, s.z);
      root.rotation.y = s.yaw;
      root.scale.setScalar(s.h * BAND_SCALE);

      /* praticaveis extras */
      if (s.role === 'drums') root.position.y = GEO.riserY;
      if (s.role === 'keys' || s.role === 'perc') root.position.y = GEO.deckY + 0.42;

      var hips = new THREE.Group();          /* balanco de quadril */
      var torso = new THREE.Group();         /* inclinacao/cabecada */
      var body = new THREE.Mesh(bandBodyGeometry(s), skinMat);
      body.frustumCulled = false;
      torso.add(body);
      hips.add(torso);
      root.add(hips);

      /* bracos: shoulder -> upper -> elbow -> fore */
      function makeArm(side) {
        var sh = new THREE.Group();
        sh.position.set(side * 0.225, 1.60, 0);
        var up = new THREE.Mesh(armGeometry(upperLen, 0.062), skinMat);
        up.frustumCulled = false;
        sh.add(up);
        var el = new THREE.Group();
        el.position.set(0, -upperLen, 0);
        var fo = new THREE.Mesh(armGeometry(foreLen, 0.052), skinMat);
        fo.frustumCulled = false;
        el.add(fo);
        var hand = new THREE.Mesh(new THREE.SphereGeometry(0.062, 6, 5), skinMat);
        hand.position.y = -foreLen;
        hand.frustumCulled = false;
        keep(hand.geometry);
        el.add(hand);
        sh.add(el);
        torso.add(sh);
        return { shoulder: sh, elbow: el, hand: hand };
      }
      var armL = makeArm(-1);
      var armR = makeArm(1);

      var m = {
        spec: s, root: root, hips: hips, torso: torso,
        armL: armL, armR: armR, extra: {}
      };

      /* --- instrumentos --- */
      if (s.role === 'guitar' || s.role === 'bass') {
        var gu = new THREE.Mesh(guitarGeometry(s.role), instMat);
        gu.position.set(0.06, 1.05, 0.30);
        gu.rotation.set(0, 0, 0.22);
        gu.frustumCulled = false;
        torso.add(gu);
        m.extra.guitar = gu;
        /* LED do captador — um pontinho quente que o bloom pega */
        var pick = new THREE.Mesh(
          keep(new THREE.SphereGeometry(0.028, 6, 5)),
          keep(new THREE.MeshBasicMaterial({ color: tc('accent', 0xffb03a), toneMapped: false, fog: false }))
        );
        pick.position.set(0.20, 1.05, 0.36);
        pick.frustumCulled = false;
        torso.add(pick);
        m.extra.pickup = pick;
      } else if (s.role === 'drums') {
        var kit = new THREE.Mesh(drumKitGeometry(), instMat);
        kit.position.set(0, 0, 0.60);
        kit.frustumCulled = false;
        root.add(kit);
        m.extra.kit = kit;
        /* pratos separados: balancam quando batem */
        var cymGeo = keep(new THREE.CylinderGeometry(0.30, 0.30, 0.012, 18, 1));
        var c1 = new THREE.Group(); c1.position.set(-0.78, 1.28, 0.25);
        var cm1 = new THREE.Mesh(cymGeo, cymbalMat); cm1.frustumCulled = false; c1.add(cm1);
        var c2 = new THREE.Group(); c2.position.set(0.86, 1.34, 0.30);
        var cm2 = new THREE.Mesh(cymGeo, cymbalMat); cm2.frustumCulled = false; c2.add(cm2);
        var c3 = new THREE.Group(); c3.position.set(-0.05, 1.06, 0.05);
        var cm3 = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.20, 0.20, 0.010, 14, 1)), cymbalMat);
        cm3.frustumCulled = false; c3.add(cm3);
        root.add(c1, c2, c3);
        m.extra.cymbals = [c1, c2, c3];
        /* baquetas */
        var stickGeo = keep(new THREE.CylinderGeometry(0.011, 0.016, 0.42, 5, 1));
        stickGeo.translate(0, -0.21, 0);
        var stL = new THREE.Mesh(stickGeo, instMat); stL.frustumCulled = false;
        var stR = new THREE.Mesh(stickGeo, instMat); stR.frustumCulled = false;
        stL.rotation.x = -0.7; stR.rotation.x = -0.7;
        armL.hand.add(stL); armR.hand.add(stR);
        m.extra.sticks = [stL, stR];
      } else if (s.role === 'perc') {
        var cur = new THREE.Mesh(curimboGeometry(), keep(rimStandard({
          color: 0x2a1508, roughness: 0.80, metalness: 0.0,
          rim: tc('accent', 0xffb03a), rimPower: 2.0, rimStrength: 0.9,
          top: tc('spotlight', 0xffd9a8), topStrength: 0.16
        })));
        cur.position.set(0, 0, 0.62);
        cur.frustumCulled = false;
        root.add(cur);
        m.extra.drum = cur;
        /* o percussionista senta escanchado: abaixamos o corpo */
        hips.position.y = 0.30;
      } else if (s.role === 'keys') {
        var kb = new THREE.Mesh(keyboardGeometry(), instMat);
        kb.position.set(0, 0, 0.48);
        kb.frustumCulled = false;
        root.add(kb);
        m.extra.keys = kb;
        /* teclas acesas */
        var kled = new THREE.Mesh(
          keep(new THREE.PlaneGeometry(1.30, 0.05)),
          keep(new THREE.MeshBasicMaterial({
            color: tc('neon', 0x25e8ce), toneMapped: false, fog: false,
            transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false
          }))
        );
        kled.position.set(0, 1.01, 0.30);
        kled.rotation.x = -PI * 0.5 + 0.06;
        kled.frustumCulled = false;
        root.add(kled);
        m.extra.keyLed = kled;
      } else if (s.role === 'horn') {
        var hn = new THREE.Mesh(hornGeometry(), brassMat);
        hn.position.set(0, -0.02, 0.12);
        hn.frustumCulled = false;
        armR.hand.add(hn);
        m.extra.horn = hn;
      }

      /* pedestal de microfone para guitarrista e baixista */
      if (s.role === 'guitar' || s.role === 'horn') {
        var micParts = [
          { geo: new THREE.CylinderGeometry(0.018, 0.018, 1.45, 6, 1), matrix: TRS(0, 0.72, 0) },
          { geo: new THREE.CylinderGeometry(0.14, 0.16, 0.03, 10, 1), matrix: TRS(0, 0.015, 0) },
          { geo: new THREE.CylinderGeometry(0.032, 0.032, 0.14, 8, 1), matrix: TRS(0, 1.48, 0.06, 0.4, 0, 0) }
        ];
        var micGeo = keep(mergeGeometries(micParts));
        var mp;
        for (mp = 0; mp < micParts.length; mp++) micParts[mp].geo.dispose();
        var mic = new THREE.Mesh(micGeo, instMat);
        mic.position.set(0.0, 0, 0.62);
        mic.frustumCulled = false;
        root.add(mic);
      }

      g.add(root);
      members.push(m);
    }

    band = {
      group: g, members: members,
      skinMat: skinMat, instMat: instMat, brassMat: brassMat, cymbalMat: cymbalMat
    };
    group.add(g);
  }

  /* --- animacao da banda --------------------------------------------------- */
  function updateBand(dt) {
    if (!band) return;
    var e = 0.35 + 0.65 * intensitySmooth;
    var b = beatPos;
    var i;
    for (i = 0; i < band.members.length; i++) {
      var m = band.members[i];
      var s = m.spec;
      var ph = b + i * 0.13;
      var sway = Math.sin(ph * PI) ;                    /* meia batida */
      var bob = Math.sin(ph * TAU * 0.5);
      var kick = Math.max(0, Math.sin((b - Math.floor(b)) * PI));
      kick = kick * kick * kick;

      /* base comum: gingado de quadril + peso no corpo */
      m.hips.rotation.y = sway * 0.11 * e;
      m.hips.rotation.z = Math.sin(ph * PI * 0.5) * 0.045 * e;
      var baseY = (s.role === 'perc') ? 0.30 : 0;
      m.hips.position.y = baseY - kick * 0.045 * e;
      m.torso.rotation.x = 0.06 + bob * 0.05 * e;
      m.torso.rotation.z = -sway * 0.05 * e;

      if (s.role === 'guitar') {
        /* braco direito: palhetada em oitavos, arco curto e seco */
        var strum = (b * 2) % 1;
        var arc = Math.sin(strum * TAU);
        m.armR.shoulder.rotation.x = -0.30 + arc * 0.42 * e;
        m.armR.shoulder.rotation.z = -0.55 + arc * 0.16;
        m.armR.elbow.rotation.x = -1.05 - arc * 0.22;
        /* braco esquerdo: passeia pelo braco da guitarra */
        var pos = 0.5 + 0.5 * Math.sin(b * 0.55 + 1.3);
        m.armL.shoulder.rotation.x = -1.02 - pos * 0.30;
        m.armL.shoulder.rotation.z = 0.62 + pos * 0.30;
        m.armL.elbow.rotation.x = -1.28 + pos * 0.20;
        /* cabecada no refrao */
        m.torso.rotation.x = 0.10 + kick * 0.16 * e + bob * 0.04;
        if (m.extra.pickup) {
          m.extra.pickup.material.color.copy(tc('accent', 0xffb03a))
            .multiplyScalar(1.2 + kick * 1.6 + spMix * 1.5);
        }
      } else if (s.role === 'bass') {
        var pk = b % 1;
        var arcB = Math.sin(pk * TAU) * 0.55 + 0.45;
        m.armR.shoulder.rotation.x = -0.36 + arcB * 0.22 * e;
        m.armR.shoulder.rotation.z = -0.52;
        m.armR.elbow.rotation.x = -1.10 - arcB * 0.18;
        var posB = 0.5 + 0.5 * Math.sin(b * 0.38);
        m.armL.shoulder.rotation.x = -0.95 - posB * 0.25;
        m.armL.shoulder.rotation.z = 0.58 + posB * 0.26;
        m.armL.elbow.rotation.x = -1.20;
        m.hips.rotation.y = sway * 0.18 * e;
      } else if (s.role === 'drums') {
        /* baqueta esquerda na caixa (contratempo), direita no chimbal */
        var hL = Math.abs(Math.sin((b + 0.5) * PI));
        var hR = Math.abs(Math.sin(b * TAU * 0.5 + PI * 0.5));
        m.armL.shoulder.rotation.x = -0.62 - hL * 0.55 * e;
        m.armL.shoulder.rotation.z = 0.50;
        m.armL.elbow.rotation.x = -0.80 - hL * 0.35;
        m.armR.shoulder.rotation.x = -0.78 - hR * 0.60 * e;
        m.armR.shoulder.rotation.z = -0.62;
        m.armR.elbow.rotation.x = -0.72 - hR * 0.40;
        m.torso.rotation.x = 0.16 + kick * 0.06;
        if (m.extra.cymbals) {
          var c;
          for (c = 0; c < m.extra.cymbals.length; c++) {
            var amt = (c === 2 ? hR : kick) * 0.22 * e;
            m.extra.cymbals[c].rotation.x = 0.14 + Math.sin(elapsed * 22 + c) * amt;
            m.extra.cymbals[c].rotation.z = Math.cos(elapsed * 19 + c * 2) * amt * 0.7;
          }
        }
      } else if (s.role === 'perc') {
        /* maos alternadas no couro do curimbo */
        var hA = Math.max(0, Math.sin(b * TAU * 0.5));
        var hB = Math.max(0, Math.sin(b * TAU * 0.5 + PI));
        m.armL.shoulder.rotation.x = -0.55 - hA * 0.70 * e;
        m.armL.shoulder.rotation.z = 0.42;
        m.armL.elbow.rotation.x = -0.55 - hA * 0.30;
        m.armR.shoulder.rotation.x = -0.55 - hB * 0.70 * e;
        m.armR.shoulder.rotation.z = -0.42;
        m.armR.elbow.rotation.x = -0.55 - hB * 0.30;
        m.torso.rotation.x = 0.22 + (hA + hB) * 0.05;
      } else if (s.role === 'keys') {
        var kA = Math.max(0, Math.sin(b * PI));
        m.armL.shoulder.rotation.x = -0.92 - kA * 0.10;
        m.armL.shoulder.rotation.z = 0.30;
        m.armL.elbow.rotation.x = -0.62 - kA * 0.16;
        m.armR.shoulder.rotation.x = -0.92 - kA * 0.10;
        m.armR.shoulder.rotation.z = -0.30;
        m.armR.elbow.rotation.x = -0.62 - kA * 0.16;
        m.torso.rotation.x = 0.20 + kA * 0.05;
        if (m.extra.keyLed) {
          m.extra.keyLed.material.opacity = 0.35 + 0.55 * kA * e + spMix * 0.2;
        }
      } else if (s.role === 'horn') {
        /* sopro: os dois bracos seguram o trompete, sino sobe no refrao */
        var lift = 0.5 + 0.5 * Math.sin(b * PI * 0.5);
        var up = clamp01(intensitySmooth * 1.2) * lift;
        m.armR.shoulder.rotation.x = -1.35 - up * 0.42;
        m.armR.shoulder.rotation.z = -0.28;
        m.armR.elbow.rotation.x = -0.85 + up * 0.30;
        m.armL.shoulder.rotation.x = -1.28 - up * 0.36;
        m.armL.shoulder.rotation.z = 0.34;
        m.armL.elbow.rotation.x = -0.92 + up * 0.26;
        m.torso.rotation.x = 0.04 - up * 0.16;
        m.hips.rotation.y = sway * 0.16 * e;
      }
    }

    /* contraluz da banda muda com o star power */
    if (band.skinMat && band.skinMat.userData.ghU) {
      var u = band.skinMat.userData.ghU;
      u.ghRimStrength.value = 1.05 + 0.9 * intensitySmooth + spMix * 1.4;
    }
  }

  /* =========================================================================
     9. RIG DE LUZ
     Trelica de aluminio (uma geometria mesclada), 18 moving heads, blinders
     apontando para a plateia e strobes. Cada refletor tem um CONE
     VOLUMETRICO com shader proprio: fresnel na casca (o feixe fica mais
     forte na silhueta, como luz real espalhando no haze), decaimento ao
     longo do comprimento e ruido rolando por dentro.
     ========================================================================= */

  var CONE_VERT = [
    'varying vec2 vGhUv;',
    'varying vec3 vGhN;',
    'varying vec3 vGhV;',
    'varying float vGhDist;',
    'void main() {',
    '  vGhUv = uv;',
    '  vec4 mv = modelViewMatrix * vec4( position, 1.0 );',
    '  vGhN = normalize( normalMatrix * normal );',
    '  vGhV = normalize( -mv.xyz );',
    '  vGhDist = -mv.z;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var CONE_FRAG = [
    'uniform vec3 uColor;',
    'uniform float uOpacity;',
    'uniform float uTime;',
    'uniform float uCore;',
    'uniform float uNoiseAmt;',
    'uniform sampler2D uNoise;',
    'varying vec2 vGhUv;',
    'varying vec3 vGhN;',
    'varying vec3 vGhV;',
    'varying float vGhDist;',
    'void main() {',
    /* vGhUv.y = 1 no apice (a lente), 0 na base do cone */
    '  float along = clamp( vGhUv.y, 0.0, 1.0 );',
    '  float fall = pow( along, 1.15 );',
    /* fresnel: casca do cone brilha mais que o miolo */
    '  float ndv = abs( dot( normalize( vGhN ), normalize( vGhV ) ) );',
    '  float edge = pow( 1.0 - ndv, 1.9 );',
    /* fumaca rolando dentro do feixe */
    '  vec2 nuv = vec2( vGhUv.x * 2.6 + uTime * 0.021, vGhUv.y * 1.1 - uTime * 0.075 );',
    '  float n = texture2D( uNoise, nuv ).r;',
    '  float dens = mix( 1.0, 0.45 + n * 1.05, uNoiseAmt );',
    /* nucleo quente logo abaixo da lente */
    '  float core = pow( along, 7.0 ) * uCore;',
    /* atenuacao por distancia da camera: feixe longe nao estoura a imagem */
    '  float far = 1.0 - clamp( ( vGhDist - 70.0 ) / 60.0, 0.0, 0.75 );',
    /* ATENUACAO PERTO DA LENTE. Havia so o corte de longe; quando um refletor
       varria em direcao a camera, o cone atravessava o plano proximo e o
       recorte deixava um POLIGONO CHAPADO de borda reta cobrindo um terco do
       quadro (a "cunha azul" de gameplay_chords). Sumindo antes de encostar,
       o feixe nunca vira geometria visivel — que e como a camera de verdade
       se comporta com um feixe que passa raspando. */
    '  float near = smoothstep( 3.0, 16.0, vGhDist );',
    '  float a = ( edge * 0.95 + 0.14 ) * fall * dens * uOpacity * far * near + core * 0.55 * near;',
    '  if ( a <= 0.002 ) discard;',
    '  vec3 col = uColor * ( 0.55 + edge * 1.15 ) + vec3( core * 0.8 );',
    '  gl_FragColor = vec4( col, clamp( a, 0.0, 1.0 ) );',
    '}'
  ].join('\n');

  function makeConeMaterial(color) {
    var m = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: 0.22 },
        uTime: { value: 0 },
        uCore: { value: 0.35 },
        uNoiseAmt: { value: 0.8 },
        uNoise: { value: sharedTex('noise') }
      },
      vertexShader: CONE_VERT,
      fragmentShader: CONE_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false
    });
    return keep(m);
  }

  /* Padroes de varredura. Cada padrao devolve {pan, tilt} para o refletor i. */
  var RIG_PATTERNS = ['fan', 'cross', 'sweep', 'audience', 'band', 'sky', 'pulse'];

  function buildRig() {
    var g = new THREE.Group();
    g.name = 'GH_Stage_Rig';
    var i, j;

    /* ---------- 1. TRELICA (geometria mesclada) ---------- */
    var trussParts = [];
    function trussBeam(x0, y0, z0, x1, y1, z1, r) {
      /* 4 banzos + zigue-zague, tudo alinhado ao eixo do segmento */
      var dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      var yaw = Math.atan2(dx, dz);
      var pitch = Math.asin(clamp(dy / len, -1, 1));
      var cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
      var basis = new THREE.Matrix4().compose(
        new THREE.Vector3(cx, cy, cz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, yaw, 0, 'YXZ')),
        new THREE.Vector3(1, 1, 1)
      );
      var offs = [[-r, r], [r, r], [-r, -r], [r, -r]];
      var k;
      for (k = 0; k < 4; k++) {
        var chord = new THREE.CylinderGeometry(r * 0.20, r * 0.20, len, 6, 1);
        chord.rotateX(PI * 0.5);
        chord.translate(offs[k][0], offs[k][1], 0);
        chord.applyMatrix4(basis);
        trussParts.push({ geo: chord });
      }
      var n = Math.max(2, Math.round(len / (r * 2.6)));
      for (k = 0; k < n; k++) {
        var zz = -len * 0.5 + (k + 0.5) * (len / n);
        var d1 = new THREE.CylinderGeometry(r * 0.10, r * 0.10, r * 2.9, 4, 1);
        d1.rotateZ(PI * 0.5);
        d1.translate(0, r, zz);
        d1.applyMatrix4(basis);
        trussParts.push({ geo: d1 });
        var d2 = new THREE.CylinderGeometry(r * 0.10, r * 0.10, r * 2.9, 4, 1);
        d2.rotateZ(PI * 0.5);
        d2.translate(0, -r, zz);
        d2.applyMatrix4(basis);
        trussParts.push({ geo: d2 });
        var d3 = new THREE.CylinderGeometry(r * 0.10, r * 0.10, r * 2.9, 4, 1);
        d3.rotateX(PI * 0.5);
        d3.rotateY(PI * 0.32 * (k % 2 ? 1 : -1));
        d3.translate(-r, 0, zz);
        d3.applyMatrix4(basis);
        trussParts.push({ geo: d3 });
        var d4 = new THREE.CylinderGeometry(r * 0.10, r * 0.10, r * 2.9, 4, 1);
        d4.rotateX(PI * 0.5);
        d4.rotateY(PI * 0.32 * (k % 2 ? -1 : 1));
        d4.translate(r, 0, zz);
        d4.applyMatrix4(basis);
        trussParts.push({ geo: d4 });
      }
    }

    var TW = GEO.trussHalfW;
    trussBeam(-TW, GEO.trussY, GEO.trussZ, TW, GEO.trussY, GEO.trussZ, 0.26);
    trussBeam(-TW, GEO.truss2Y, GEO.truss2Z, TW, GEO.truss2Y, GEO.truss2Z, 0.26);
    /* ligacoes frente-fundo */
    trussBeam(-TW + 0.6, GEO.trussY + 0.35, GEO.trussZ, -TW + 0.6, GEO.truss2Y + 0.35, GEO.truss2Z, 0.20);
    trussBeam(TW - 0.6, GEO.trussY + 0.35, GEO.trussZ, TW - 0.6, GEO.truss2Y + 0.35, GEO.truss2Z, 0.20);
    /* torres verticais */
    trussBeam(-GEO.towerX, GEO.deckY, GEO.trussZ, -GEO.towerX, GEO.trussY + 1.4, GEO.trussZ, 0.30);
    trussBeam(GEO.towerX, GEO.deckY, GEO.trussZ, GEO.towerX, GEO.trussY + 1.4, GEO.trussZ, 0.30);
    trussBeam(-GEO.towerX, GEO.deckY, GEO.truss2Z, -GEO.towerX, GEO.truss2Y + 1.0, GEO.truss2Z, 0.26);
    trussBeam(GEO.towerX, GEO.deckY, GEO.truss2Z, GEO.towerX, GEO.truss2Y + 1.0, GEO.truss2Z, 0.26);

    var trussGeo = keep(mergeGeometries(trussParts));
    for (i = 0; i < trussParts.length; i++) trussParts[i].geo.dispose();
    var trussMat = rimStandard({
      color: 0x22262f, roughness: 0.44, metalness: 0.95,
      rim: tc('neon', 0x25e8ce), rimPower: 1.9, rimStrength: 0.48,
      top: tc('spotlight', 0xffd9a8), topStrength: 0.16, envMapIntensity: 1.5
    });
    var truss = new THREE.Mesh(trussGeo, trussMat);
    truss.frustumCulled = false;
    g.add(truss);

    /* ---------- 2. MOVING HEADS ---------- */
    var yokeParts = [
      { geo: new THREE.BoxGeometry(0.34, 0.16, 0.30), matrix: TRS(0, 0.12, 0) },       /* base */
      { geo: new THREE.BoxGeometry(0.07, 0.34, 0.10), matrix: TRS(-0.19, -0.13, 0) },   /* garfo */
      { geo: new THREE.BoxGeometry(0.07, 0.34, 0.10), matrix: TRS(0.19, -0.13, 0) }
    ];
    var yokeGeo = keep(mergeGeometries(yokeParts));
    for (i = 0; i < yokeParts.length; i++) yokeParts[i].geo.dispose();
    var headGeo = keep(new THREE.CylinderGeometry(0.145, 0.115, 0.42, 10, 1));
    var lensGeo = keep(new THREE.CircleGeometry(0.115, 12));
    var fixMat = rimStandard({
      color: 0x14161d, roughness: 0.40, metalness: 0.85,
      rim: tc('neon', 0x25e8ce), rimPower: 2.2, rimStrength: 0.55, envMapIntensity: 1.2
    });

    var heads = [];
    var nFront = 12, nBack = 6;

    function addHead(px, py, pz, opts) {
      var idx = heads.length;
      var pivot = new THREE.Group();
      pivot.position.set(px, py, pz);
      var yoke = new THREE.Mesh(yokeGeo, fixMat);
      yoke.frustumCulled = false;
      pivot.add(yoke);

      var tiltG = new THREE.Group();
      tiltG.position.y = -0.20;
      pivot.add(tiltG);

      var body = new THREE.Mesh(headGeo, fixMat);
      body.position.y = -0.18;
      body.frustumCulled = false;
      tiltG.add(body);

      var color = opts.color.clone();
      var lensMat = new THREE.MeshBasicMaterial({
        color: color, toneMapped: false, fog: false, side: THREE.DoubleSide,
        transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false
      });
      keep(lensMat);
      var lens = new THREE.Mesh(lensGeo, lensMat);
      lens.position.y = -0.395;
      lens.rotation.x = -PI * 0.5;
      lens.renderOrder = 8;
      lens.frustumCulled = false;
      tiltG.add(lens);

      /* halo da lente: um flare pequeno que faz o refletor "acender" */
      var glowMat = new THREE.MeshBasicMaterial({
        map: sharedTex('softGlow'), color: color,
        transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide
      });
      keep(glowMat);
      var glow = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.15, 1.15)), glowMat);
      glow.position.y = -0.42;
      glow.rotation.x = -PI * 0.5;
      glow.renderOrder = 9;
      glow.frustumCulled = false;
      tiltG.add(glow);

      /* CONE VOLUMETRICO */
      var len = opts.len || 24;
      var rad = opts.rad || (len * Math.tan(opts.spread || 0.11));
      var coneGeo = keep(new THREE.ConeGeometry(rad, len, 22, 1, true));
      var coneMat = makeConeMaterial(color);
      var cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.y = -0.40 - len * 0.5;
      cone.renderOrder = 12;
      cone.frustumCulled = false;
      tiltG.add(cone);

      g.add(pivot);
      heads.push({
        pivot: pivot, tilt: tiltG, lens: lensMat, glow: glowMat, cone: cone,
        coneMat: coneMat, baseColor: color, len: len,
        pan: 0, tilt0: 0, panT: 0, tiltT: 0, index: idx,
        kind: opts.kind || 'beam', on: 1, level: 1, group: opts.group || 0,
        dirCache: new THREE.Vector3()
      });
      return heads[heads.length - 1];
    }

    var nCols = stageLightCount();
    for (i = 0; i < nFront; i++) {
      var t = nFront > 1 ? i / (nFront - 1) : 0.5;
      addHead(lerp(-TW + 1.0, TW - 1.0, t), GEO.trussY - 0.34, GEO.trussZ, {
        color: stageLightColor(i % nCols), len: 27, spread: 0.105, kind: 'beam', group: 0
      });
    }
    for (i = 0; i < nBack; i++) {
      var t2 = nBack > 1 ? i / (nBack - 1) : 0.5;
      addHead(lerp(-TW + 2.4, TW - 2.4, t2), GEO.truss2Y - 0.34, GEO.truss2Z, {
        color: stageLightColor((i + 1) % nCols), len: 40, spread: 0.070, kind: 'sky', group: 1
      });
    }
    /* 4 washes baixos no chao do palco apontando para cima (uplight) */
    for (i = 0; i < 4; i++) {
      var ux = [-11.5, -4.0, 4.0, 11.5][i];
      var h = addHead(ux, GEO.deckY + 0.30, -45.6, {
        color: stageLightColor((i + 2) % nCols), len: 16, spread: 0.22, kind: 'up', group: 2
      });
      h.pivot.rotation.z = PI;              /* vira o cone para cima */
    }

    /* ---------- 3. BLINDERS ---------- */
    var blinders = [];
    var blParts = [];
    function blinderBank(bx) {
      var r, c;
      for (r = 0; r < 2; r++) {
        for (c = 0; c < 4; c++) {
          blParts.push({
            geo: new THREE.BoxGeometry(0.42, 0.42, 0.34),
            matrix: TRS(bx + (c - 1.5) * 0.46, GEO.trussY + 0.62 + r * 0.46, GEO.trussZ + 0.10)
          });
        }
      }
    }
    blinderBank(-8.6);
    blinderBank(8.6);
    var blGeo = keep(mergeGeometries(blParts));
    for (i = 0; i < blParts.length; i++) blParts[i].geo.dispose();
    var blHousing = new THREE.Mesh(blGeo, fixMat);
    blHousing.frustumCulled = false;
    g.add(blHousing);

    /* lentes dos blinders (aditivo, viradas para a camera) */
    var blLensMat = new THREE.MeshBasicMaterial({
      map: sharedTex('softGlow'), color: new THREE.Color(0xffe9c4),
      transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide
    });
    keep(blLensMat);
    var blQuad = keep(new THREE.PlaneGeometry(1.5, 1.5));
    for (i = 0; i < 16; i++) {
      var bank = i < 8 ? -8.6 : 8.6;
      var ii = i % 8;
      var rr = (ii / 4) | 0, cc = ii % 4;
      var bl = new THREE.Mesh(blQuad, blLensMat);
      bl.position.set(bank + (cc - 1.5) * 0.46, GEO.trussY + 0.62 + rr * 0.46, GEO.trussZ + 0.34);
      bl.renderOrder = 14;
      bl.frustumCulled = false;
      g.add(bl);
      blinders.push(bl);
    }
    /* dois flares grandes: e o "estouro" do blinder no refrao */
    var blFlareMat = new THREE.MeshBasicMaterial({
      map: sharedTex('flare'), color: new THREE.Color(0xfff0d0),
      transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide
    });
    keep(blFlareMat);
    var blFlareGeo = keep(new THREE.PlaneGeometry(14, 8));
    var flareL = new THREE.Mesh(blFlareGeo, blFlareMat);
    flareL.position.set(-8.6, GEO.trussY + 0.9, GEO.trussZ + 0.9);
    flareL.renderOrder = 16; flareL.frustumCulled = false;
    var flareR = new THREE.Mesh(blFlareGeo, blFlareMat);
    flareR.position.set(8.6, GEO.trussY + 0.9, GEO.trussZ + 0.9);
    flareR.renderOrder = 16; flareR.frustumCulled = false;
    g.add(flareL, flareR);

    /* ---------- 4. STROBES nas torres ---------- */
    var strobeMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xffffff), toneMapped: false, fog: false,
      transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false
    });
    keep(strobeMat);
    var strobeGeo = keep(new THREE.PlaneGeometry(0.9, 3.2));
    var strobes = [];
    for (i = 0; i < 6; i++) {
      var sx = (i < 3 ? -GEO.towerX : GEO.towerX);
      var sy = GEO.deckY + 1.6 + (i % 3) * 2.4;
      var st = new THREE.Mesh(strobeGeo, strobeMat);
      st.position.set(sx, sy, GEO.trussZ + 0.34);
      st.renderOrder = 14;
      st.frustumCulled = false;
      g.add(st);
      strobes.push(st);
    }

    /* ---------- 5. LUZES REAIS (poucas, caras) ---------- */
    var lights = new THREE.Group();
    var keyL = new THREE.PointLight(tc('spotlight', 0xffd9a8), 70, 42, 2);
    keyL.position.set(0, GEO.deckY + 6.0, -30.0);
    keyL.castShadow = false;
    var backL = new THREE.PointLight(tc('neon', 0x25e8ce), 90, 40, 2);
    backL.position.set(0, GEO.deckY + 3.4, -45.0);
    backL.castShadow = false;
    lights.add(keyL, backL);
    g.add(lights);
    stageLights = { key: keyL, back: backL, keyBase: 70, backBase: 90 };

    rig = {
      group: g, heads: heads, blinders: blinders, blLens: blLensMat,
      blFlare: blFlareMat, strobes: strobes, strobeMat: strobeMat,
      trussMat: trussMat, fixMat: fixMat,
      pattern: 'fan', patternT: 0, seed: 0
    };
    group.add(g);
    aimRig(0, true);
  }

  /* Sorteia novo destino de pan/tilt para todos os refletores. */
  function aimRig(barIndex, immediate) {
    if (!rig) return;
    var i, h;
    var pat = rig.pattern;
    var n = rig.heads.length;
    var sgn;
    for (i = 0; i < n; i++) {
      h = rig.heads[i];
      var t = n > 1 ? i / (n - 1) : 0.5;
      sgn = (i % 2) ? 1 : -1;
      var pan = 0, tl = 0.55;

      if (h.group === 2) {
        /* uplights: sempre para cima, so abrem e fecham */
        pan = (t - 0.5) * 0.7;
        tl = 0.10 + 0.22 * Math.sin(barIndex * 0.7 + i);
      } else if (h.group === 1) {
        /* refletores do fundo: leque para o ceu */
        pan = (t - 0.5) * 1.15;
        tl = (pat === 'sky') ? 2.30 + (t - 0.5) * 0.35 : 2.05 + Math.sin(barIndex + i) * 0.25;
      } else if (pat === 'fan') {
        pan = (t - 0.5) * 1.45;
        tl = 0.62 + Math.abs(t - 0.5) * 0.30;
      } else if (pat === 'cross') {
        pan = sgn * (0.55 + 0.45 * Math.abs(t - 0.5) * 2);
        tl = 0.72;
      } else if (pat === 'sweep') {
        pan = Math.sin(barIndex * 0.9 + t * 4.2) * 0.95;
        tl = 0.55 + 0.30 * Math.sin(t * 6.0 + barIndex);
      } else if (pat === 'audience') {
        pan = (t - 0.5) * 1.9;
        tl = 1.02 + Math.abs(t - 0.5) * 0.22;      /* mais deitado: varre a plateia */
      } else if (pat === 'band') {
        /* converge no meio do palco */
        pan = -(t - 0.5) * 0.55;
        tl = 0.24 + Math.abs(t - 0.5) * 0.12;
      } else if (pat === 'sky') {
        pan = (t - 0.5) * 1.1;
        tl = -0.40 - Math.abs(t - 0.5) * 0.25;
      } else {                                      /* pulse */
        pan = sgn * 0.30 + (t - 0.5) * 0.5;
        tl = 0.48 + (i % 3) * 0.22;
      }
      h.panT = pan;
      h.tiltT = tl;
      if (immediate) { h.pan = pan; h.tilt0 = tl; }
    }
  }

  /* temporarios do loop quente: alocados UMA vez */
  var _coneDir = null, _camPos = null, _toCam = null, _wq = null, _wp = null;
  function updateRig(dt) {
    if (!rig) return;
    if (!_coneDir) {
      _coneDir = new THREE.Vector3(); _camPos = new THREE.Vector3();
      _toCam = new THREE.Vector3(); _wq = new THREE.Quaternion(); _wp = new THREE.Vector3();
    }
    var e = intensitySmooth;
    var i, h;

    var cam = (GH.Engine && GH.Engine.camera) ? GH.Engine.camera : null;
    if (cam) _camPos.setFromMatrixPosition(cam.matrixWorld);

    /* strobe: so em intensidade alta ou star power */
    var strobeWant = clamp01((e - 0.72) / 0.28) * 0.6 + spMix * 0.8 + blinderHit * 0.5;
    strobeLevel = damp(strobeLevel, clamp01(strobeWant), 6, dt);
    strobePhase += dt * (14 + 26 * strobeLevel);
    var strobeOn = strobeLevel > 0.05 ? (Math.sin(strobePhase) > 0.55 ? 1 : 0) : 0;
    rig.strobeMat.opacity = strobeOn * strobeLevel * 0.85;

    /* blinders */
    blinderHit = Math.max(0, blinderHit - dt * 2.4);
    var blBase = clamp01((e - 0.55) / 0.45) * 0.16;
    rig.blLens.opacity = clamp01(blBase + blinderHit * 0.95);
    rig.blFlare.opacity = clamp01(blinderHit * 0.65 + blBase * 0.25);
    if (spMix > 0.02) {
      rig.blLens.color.setRGB(0.85, 0.94, 1.0);
      rig.blFlare.color.setRGB(0.88, 0.96, 1.0);
    } else {
      rig.blLens.color.setRGB(1.0, 0.91, 0.77);
      rig.blFlare.color.setRGB(1.0, 0.94, 0.82);
    }

    /* moving heads */
    var lam = 4.5 + 7 * e;
    for (i = 0; i < rig.heads.length; i++) {
      h = rig.heads[i];
      h.pan = damp(h.pan, h.panT, lam, dt);
      h.tilt0 = damp(h.tilt0, h.tiltT, lam, dt);
      /* micro-oscilacao continua: nada parado, nada linear */
      var wob = Math.sin(elapsed * (0.9 + i * 0.11) + i) * 0.055 * (0.4 + e);
      h.pivot.rotation.y = h.pan + wob;
      h.tilt.rotation.x = h.tilt0 + Math.sin(elapsed * (0.7 + i * 0.07) + i * 2) * 0.035 * (0.4 + e);

      /* nivel do refletor: pisca por grupo no beat, apaga no strobe */
      var chase = 0.55 + 0.45 * Math.sin(beatPos * PI + i * 0.8);
      var lvl = (0.30 + 0.70 * e) * (0.55 + 0.45 * chase) + beatPulse * 0.30;
      if (strobeOn && strobeLevel > 0.4) lvl *= 0.35;
      h.level = damp(h.level, clamp01(lvl), 12, dt);

      /* protege a legibilidade: se o feixe aponta para a camera, abaixa */
      var vis = 1;
      if (cam) {
        /* o feixe sai no -Y local do grupo de tilt */
        h.tilt.getWorldQuaternion(_wq);
        _coneDir.set(0, -1, 0).applyQuaternion(_wq);
        _wp.setFromMatrixPosition(h.cone.matrixWorld);
        _toCam.copy(_camPos).sub(_wp).normalize();
        var d = _coneDir.dot(_toCam);
        vis = 1 - clamp01((d - 0.72) / 0.28) * 0.82;
      }

      var op = (0.10 + 0.20 * e + spMix * 0.10) * h.level * vis;
      if (h.group === 1) op *= 1.25;                 /* feixes do ceu aparecem mais */
      if (h.group === 2) op *= 0.85;
      h.coneMat.uniforms.uOpacity.value = op;
      h.coneMat.uniforms.uTime.value = elapsed;
      h.coneMat.uniforms.uCore.value = 0.22 + 0.35 * h.level;
      h.lens.opacity = clamp01(0.35 + 0.65 * h.level);
      h.glow.opacity = clamp01(0.20 + 0.70 * h.level) * (0.5 + 0.5 * e);
    }

    /* luzes reais respiram com o show */
    if (stageLights) {
      stageLights.key.intensity = stageLights.keyBase * (0.45 + 0.75 * e + beatPulse * 0.3);
      stageLights.back.intensity = stageLights.backBase * (0.40 + 0.85 * e + beatPulse * 0.45);
    }
  }

  /* =========================================================================
     10. HAZE / FUMACA
     Uma unica geometria com ~26 quads em posicoes e rotacoes assadas, cada
     um lendo uma regiao diferente da textura de fumaca. Aditivo, sem
     depthWrite. Sem isto os cones de luz nao existem.
     ========================================================================= */

  function buildHaze() {
    var r = rng(211);
    var quads = [];
    var i;

    function quad(x, y, z, w, h, yaw, uOff, vOff, tint) {
      quads.push({ x: x, y: y, z: z, w: w, h: h, yaw: yaw, u: uOff, v: vOff, tint: tint });
    }

    /* cortina de haze no volume do palco (planos verticais girados) */
    for (i = 0; i < 14; i++) {
      var z = -18 - rrange(r, 0, 30);
      quad(rrange(r, -20, 20), rrange(r, 1.4, 8.4), z,
           rrange(r, 14, 26), rrange(r, 6, 12),
           rrange(r, -1.0, 1.0), rnd(r), rnd(r), rrange(r, 0.55, 1.0));
    }
    /* fumaca rasteira no chao do palco e na barricada */
    for (i = 0; i < 7; i++) {
      quad(rrange(r, -14, 14), GEO.deckY + rrange(r, 0.1, 0.9), -32 - rrange(r, 0, 14),
           rrange(r, 12, 20), rrange(r, 2.5, 4.5), rrange(r, -0.5, 0.5),
           rnd(r), rnd(r), rrange(r, 0.7, 1.0));
    }
    /* bafo de gelo seco saindo pela frente do palco */
    for (i = 0; i < 5; i++) {
      quad(rrange(r, -13, 13), GEO.pitY + rrange(r, 0.2, 1.4), -26 - rrange(r, 0, 5),
           rrange(r, 10, 16), rrange(r, 2.0, 3.4), rrange(r, -0.4, 0.4),
           rnd(r), rnd(r), rrange(r, 0.5, 0.9));
    }

    var n = quads.length;
    var pos = new Float32Array(n * 6 * 3);
    var uv = new Float32Array(n * 6 * 2);
    var col = new Float32Array(n * 6 * 3);
    var nor = new Float32Array(n * 6 * 3);
    var order = [0, 1, 2, 0, 2, 3];
    var base = tc('smoke', 0x5a3070);
    var k = 0, ku = 0;
    for (i = 0; i < n; i++) {
      var q = quads[i];
      var c = Math.cos(q.yaw), s = Math.sin(q.yaw);
      var corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
      var j;
      for (j = 0; j < 6; j++) {
        var cn = corners[order[j]];
        var lx = cn[0] * q.w, ly = cn[1] * q.h;
        pos[k] = q.x + lx * c;
        pos[k + 1] = q.y + ly;
        pos[k + 2] = q.z + lx * s;
        nor[k] = -s; nor[k + 1] = 0; nor[k + 2] = c;
        /* cada quad le um pedaco diferente da textura => nada repetido */
        uv[ku] = (cn[0] + 0.5) * 0.75 + q.u * 0.25;
        uv[ku + 1] = (cn[1] + 0.5) * 0.75 + q.v * 0.25;
        col[k] = base.r * q.tint; col[k + 1] = base.g * q.tint; col[k + 2] = base.b * q.tint;
        k += 3; ku += 2;
      }
    }
    var geo = keep(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    var tex0 = sharedTex('smoke');
    var tex = tex0 ? tex0.clone() : null;
    if (tex) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      keep(tex);
    }
    var mat = new THREE.MeshBasicMaterial({
      map: tex, vertexColors: true,
      transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, toneMapped: false, fog: false,
      side: THREE.DoubleSide
    });
    keep(mat);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'GH_Stage_Haze';
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    group.add(mesh);
    haze = { mesh: mesh, mat: mat, tex: tex, drift: 0 };
  }

  function updateHaze(dt) {
    if (!haze) return;
    haze.drift += dt;
    if (haze.tex) {
      haze.tex.offset.x = Math.sin(haze.drift * 0.045) * 0.09 + haze.drift * 0.006;
      haze.tex.offset.y = Math.sin(haze.drift * 0.031 + 1.3) * 0.05;
    }
    /* o haze respira: mais denso quando o show sobe, some quando cai */
    var target = 0.09 + 0.20 * intensitySmooth + spMix * 0.08 + beatPulse * 0.03;
    haze.mat.opacity = damp(haze.mat.opacity, target, 3, dt);
    /* deriva lenta do bloco inteiro: a fumaca anda pelo palco */
    haze.mesh.position.x = Math.sin(haze.drift * 0.07) * 1.4;
    haze.mesh.position.z = Math.sin(haze.drift * 0.05 + 2.1) * 1.0;
  }

  /* =========================================================================
     11. CONFETE (5 estrelas / fim de show)
     Pool instanciado de papeis coloridos. So gasta CPU enquanto ha confete
     no ar; parado, o mesh fica invisivel e sai do render.
     ========================================================================= */

  var CONFETTI_N = 260;

  function buildConfetti() {
    var geo = keep(new THREE.PlaneGeometry(0.16, 0.24));
    var mat = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide, fog: true,
      transparent: true, opacity: 1, depthWrite: true
    });
    keep(mat);
    var im = new THREE.InstancedMesh(geo, mat, CONFETTI_N);
    im.frustumCulled = false;
    im.visible = false;
    im.renderOrder = 5;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    var colors = new Float32Array(CONFETTI_N * 3);
    im.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    group.add(im);

    var parts = [];
    var i;
    for (i = 0; i < CONFETTI_N; i++) {
      parts.push({ life: 0, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, s: 1 });
      /* fora de cena enquanto morto */
      writeInstance(im.instanceMatrix.array, i, 0, -999, 0, 1, 0, 0.001, 0.001, 0.001);
    }
    im.instanceMatrix.needsUpdate = true;
    confetti = { mesh: im, parts: parts, alive: 0, mat: mat, colors: colors, next: 0 };
  }

  function burstConfetti(amount) {
    if (!confetti) return;
    var r = rng(((elapsed * 1000) | 0) + 17);
    var n = Math.min(CONFETTI_N, Math.round(amount || CONFETTI_N));
    var pal = [];
    var i;
    for (i = 0; i < stageLightCount(); i++) pal.push(stageLightColor(i));
    pal.push(tc('accent', 0xffb03a));
    pal.push(new THREE.Color(0xffffff));
    pal.push(tc('neon', 0x25e8ce));

    for (i = 0; i < n; i++) {
      var idx = confetti.next++ % CONFETTI_N;
      var p = confetti.parts[idx];
      p.life = rrange(r, 3.4, 7.0);
      p.x = rrange(r, -16, 16);
      p.y = GEO.trussY + rrange(r, 0.4, 2.6);
      p.z = rrange(r, -44, -26);
      p.vx = rrange(r, -1.8, 1.8);
      p.vy = rrange(r, 0.4, 2.6);
      p.vz = rrange(r, -0.6, 2.4);
      p.rx = rrange(r, 0, TAU); p.ry = rrange(r, 0, TAU); p.rz = rrange(r, 0, TAU);
      p.wx = rrange(r, -7, 7); p.wy = rrange(r, -7, 7); p.wz = rrange(r, -5, 5);
      p.s = rrange(r, 0.7, 1.6);
      var c = pal[(rnd(r) * pal.length) | 0];
      confetti.colors[idx * 3] = c.r * 1.7;
      confetti.colors[idx * 3 + 1] = c.g * 1.7;
      confetti.colors[idx * 3 + 2] = c.b * 1.7;
    }
    confetti.mesh.instanceColor.needsUpdate = true;
    confetti.mesh.visible = true;
    confetti.alive = 1;
  }

  var _cq = null, _cv = null, _cs = null, _ce = null, _cm = null;
  function updateConfetti(dt) {
    if (!confetti || !confetti.alive) return;
    if (!_cq) {
      _cq = new THREE.Quaternion(); _cv = new THREE.Vector3();
      _cs = new THREE.Vector3(); _ce = new THREE.Euler(); _cm = new THREE.Matrix4();
    }
    var arr = confetti.mesh.instanceMatrix.array;
    var any = 0, i;
    for (i = 0; i < CONFETTI_N; i++) {
      var p = confetti.parts[i];
      if (p.life <= 0) continue;
      any = 1;
      p.life -= dt;
      /* gravidade + arrasto + flutuacao lateral (papel nao cai reto) */
      p.vy -= 5.4 * dt;
      p.vy *= (1 - 1.9 * dt);
      p.vx += Math.sin(elapsed * 3.1 + i) * 1.6 * dt;
      p.vz += Math.cos(elapsed * 2.4 + i * 0.7) * 1.1 * dt;
      p.vx *= (1 - 1.2 * dt);
      p.vz *= (1 - 1.2 * dt);
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.rx += p.wx * dt; p.ry += p.wy * dt; p.rz += p.wz * dt;
      if (p.y < GEO.pitY - 0.4) { p.life = 0; }
      var fade = clamp01(p.life * 0.8) * p.s;
      _ce.set(p.rx, p.ry, p.rz);
      _cq.setFromEuler(_ce);
      _cv.set(p.x, p.y, p.z);
      _cs.set(fade, fade, fade);
      _cm.compose(_cv, _cq, _cs);
      _cm.toArray(arr, i * 16);
      if (p.life <= 0) writeInstance(arr, i, 0, -999, 0, 1, 0, 0.001, 0.001, 0.001);
    }
    confetti.mesh.instanceMatrix.needsUpdate = true;
    if (!any) { confetti.alive = 0; confetti.mesh.visible = false; }
  }

  /* =========================================================================
     12. TEMA
     ========================================================================= */

  function resolveTheme(t) {
    if (!t) return (P && P.current) || null;
    if (typeof t === 'string') {
      if (P && P.themes && P.themes[t]) return P.themes[t];
      return (P && P.current) || null;
    }
    if (t.hex && t.sky) return t;
    return (P && P.current) || null;
  }

  function applyTheme() {
    if (!inited) return;
    var i;

    /* --- fundo: troca as texturas (cacheadas por tema) --- */
    var tex = backdropCache[themeId];
    if (!tex) {
      tex = backdropCache[themeId] = {
        sky:   canvasTexture(buildSkyCanvas(), { mips: false }),
        far:   canvasTexture(buildFarCanvas()),
        mid:   canvasTexture(buildMidCanvas()),
        near:  canvasTexture(buildNearCanvas()),
        water: canvasTexture(buildWaterCanvas(), { repeat: true })
      };
      tex.water.wrapS = THREE.RepeatWrapping;
      tex.water.wrapT = THREE.ClampToEdgeWrapping;
      tex.water.repeat.set(3, 1);
    }
    if (backdrop) {
      backdrop.sky.material.map = tex.sky;   backdrop.sky.material.needsUpdate = true;
      backdrop.far.material.map = tex.far;   backdrop.far.material.needsUpdate = true;
      backdrop.mid.material.map = tex.mid;   backdrop.mid.material.needsUpdate = true;
      backdrop.near.material.map = tex.near; backdrop.near.material.needsUpdate = true;
      backdrop.water.material.map = tex.water; backdrop.water.material.needsUpdate = true;
      backdrop.tex = tex;
    }

    /* --- rim lights de todos os materiais do palco --- */
    var rimA = tc('highwayEdge', 0xff3d8a);
    var rimB = tc('neon', 0x25e8ce);
    var topC = tc('spotlight', 0xffd9a8);
    function setRim(mat, c, t) {
      if (mat && mat.userData && mat.userData.ghU) {
        mat.userData.ghU.ghRimColor.value.copy(c);
        if (t) mat.userData.ghU.ghTopColor.value.copy(t);
      }
    }
    if (band) {
      setRim(band.skinMat, rimA, topC);
      setRim(band.instMat, rimB, tc('accent', 0xffb03a));
      setRim(band.brassMat, tc('accent', 0xffb03a));
      setRim(band.cymbalMat, tc('accent', 0xffb03a));
    }
    if (stageBuild) {
      setRim(stageBuild.deckMat, rimA, topC);
      setRim(stageBuild.metalMat, rimB);
      setRim(stageBuild.paMat, rimB, topC);
      if (stageBuild.edgeNeon) stageBuild.edgeNeon.color.copy(rimA);
      if (stageBuild.marajoara) stageBuild.marajoara.color.copy(tc('accent', 0xffb03a).multiplyScalar(0.85));
    }
    if (rig) {
      setRim(rig.trussMat, rimB, topC);
      setRim(rig.fixMat, rimB);
      var n = stageLightCount();
      for (i = 0; i < rig.heads.length; i++) {
        var h = rig.heads[i];
        var c = stageLightColor((i + h.group) % n);
        h.baseColor.copy(c);
        if (!starPower) {
          h.coneMat.uniforms.uColor.value.copy(c);
          h.lens.color.copy(c);
          h.glow.color.copy(c);
        }
      }
    }
    if (stageLights) {
      stageLights.key.color.copy(topC);
      stageLights.back.color.copy(rimB);
    }
    if (led) {
      led.halo.color.copy(tc('ledScreen', 0xff2e9a));
      drawLed(0);
    }
    if (haze) {
      var base = tc('smoke', 0x5a3070);
      var col = haze.mesh.geometry.attributes.color;
      var arr = col.array;
      /* preserva a variacao por quad, so troca a matiz */
      for (i = 0; i < arr.length; i += 3) {
        var lum = Math.max(arr[i], arr[i + 1], arr[i + 2]);
        var k = lum > 0 ? lum : 1;
        arr[i] = base.r * k; arr[i + 1] = base.g * k; arr[i + 2] = base.b * k;
      }
      col.needsUpdate = true;
    }
  }

  /* Aplica (ou tira) o visual de Star Power: tudo vira prateado/eletrico. */
  function applyStarPowerLook() {
    if (!rig) return;
    var i, n = stageLightCount();
    var core = (P && P.sp && P.sp.core) ? P.sp.core.clone() : new THREE.Color(0xf2fbff);
    var glow = (P && P.sp && P.sp.glow) ? P.sp.glow.clone() : new THREE.Color(0x8fd8ff);
    var edge = (P && P.sp && P.sp.edge) ? P.sp.edge.clone() : new THREE.Color(0x3aa8ff);
    for (i = 0; i < rig.heads.length; i++) {
      var h = rig.heads[i];
      var target = starPower ? (i % 3 === 0 ? core : (i % 3 === 1 ? glow : edge))
                             : stageLightColor((i + h.group) % n);
      h.coneMat.uniforms.uColor.value.copy(target);
      h.lens.color.copy(target);
      h.glow.color.copy(target);
    }
    if (stageLights) {
      stageLights.back.color.copy(starPower ? glow : tc('neon', 0x25e8ce));
    }
    if (band) {
      var rimC = starPower ? glow : tc('highwayEdge', 0xff3d8a);
      if (band.skinMat.userData.ghU) band.skinMat.userData.ghU.ghRimColor.value.copy(rimC);
      if (band.instMat.userData.ghU) band.instMat.userData.ghU.ghRimColor.value.copy(starPower ? core : tc('neon', 0x25e8ce));
    }
    if (stageBuild && stageBuild.edgeNeon) {
      stageBuild.edgeNeon.color.copy(starPower ? core : tc('highwayEdge', 0xff3d8a));
    }
  }

  /* =========================================================================
     13. CAMERA RIG
     Presets cinematograficos do palco. Registrados no Engine para que
     cap=stage_wide (que resolve para 'cinematic') caia num enquadramento
     desenhado PARA esta cena: banda e telao no terco esquerdo, trelica
     cortando o topo, pista subindo da direita inferior.
     ========================================================================= */

  var CAM = {
    /* Enquadramento antigo: lente a 46 unidades do palco com fov 54. A banda
       saia com poucos pixels — o contrato pede guitarrista, baixista,
       baterista e percussionista "tocando animados" e nao dava para ler
       instrumento nenhum — e o terco inferior esquerdo virava chao vazio.
       Avancando a lente para dentro da plateia e fechando o fov o palco cresce
       ~1,7x e o primeiro plano passa a ser publico com celular aceso. */
    stage_wide: { pos: [-7.50, 5.05, 5.20], look: [0.95, 2.75, -27.00], fov: 47, sway: 1.20, shake: 1.10, roll: -0.020 },
    stage_band: { pos: [-2.40, 4.10, -14.0], look: [0.60, 3.20, -38.00], fov: 44, sway: 0.85, shake: 0.90, roll: 0.010 },
    stage_crowd: { pos: [9.20, 3.60, -6.00], look: [-6.00, 2.60, -30.00], fov: 58, sway: 1.35, shake: 1.20, roll: 0.030 },
    stage_sky: { pos: [0.00, 2.20, 2.00], look: [0.00, 9.50, -34.00], fov: 60, sway: 1.0, shake: 1.0, roll: 0 }
  };

  var cameraRig = {
    presets: CAM,
    /* nomes que este modulo garante existirem no Engine */
    names: ['stage_wide', 'stage_band', 'stage_crowd', 'stage_sky'],
    register: function () {
      var E = GH.Engine;
      if (!E || typeof E.defineCamPreset !== 'function') return false;
      var k;
      for (k in CAM) {
        if (!Object.prototype.hasOwnProperty.call(CAM, k)) continue;
        try { E.defineCamPreset(k, CAM[k]); } catch (e) { warn('defineCamPreset', e); }
      }
      /* 'cinematic' e o preset que cap=stage_wide resolve. Ele foi escrito
         antes do palco existir; agora que existe geometria de verdade, o
         dono do palco entrega o enquadramento certo dela. */
      try { E.defineCamPreset('cinematic', CAM.stage_wide); } catch (e) { warn('cinematic', e); }
      return true;
    },
    apply: function (name, dur) {
      var E = GH.Engine;
      if (!E || typeof E.camPreset !== 'function') return false;
      try { E.camPreset(CAM[name] ? name : 'cinematic', dur === undefined ? 1.1 : dur); } catch (e) { return false; }
      return true;
    },
    /* pontos de interesse, para quem quiser mirar a camera na mao */
    focus: {
      band:  { x: 0, y: GEO.deckY + 1.6, z: -37.5 },
      led:   { x: 0, y: (GEO.ledY0 + GEO.ledY1) * 0.5, z: GEO.ledZ },
      crowd: { x: 0, y: GEO.pitY + 1.4, z: -16.0 },
      truss: { x: 0, y: GEO.trussY, z: GEO.trussZ }
    }
  };

  /* =========================================================================
     14. REACAO DO PUBLICO
     ========================================================================= */

  function crowdReaction(kind) {
    switch (kind) {
      case 'boo':
      case 'fail':
        crowdMoodTarget = 0.16;
        crowdSurge = 0;
        blinderHit = 0;
        break;
      case 'miss':
        crowdMoodTarget = Math.max(0.45, crowdMoodTarget - 0.12);
        break;
      case 'idle':
        crowdMoodTarget = 0.55;
        break;
      case 'anticipation':
      case 'countdown':
        crowdMoodTarget = 0.80;
        break;
      case 'start':
      case 'section':
        crowdMoodTarget = 1.0;
        crowdSurge = Math.max(crowdSurge, 0.35);
        blinderHit = Math.max(blinderHit, 0.55);
        if (rig) { rig.pattern = 'fan'; aimRig(barPos | 0, false); }
        break;
      case 'streak':
      case 'phrase':
        crowdMoodTarget = 1.0;
        crowdSurge = Math.max(crowdSurge, 0.45);
        break;
      case 'cheer':
        crowdMoodTarget = 1.0;
        crowdSurge = Math.max(crowdSurge, 0.7);
        blinderHit = Math.max(blinderHit, 0.7);
        break;
      case 'spready':
        crowdSurge = Math.max(crowdSurge, 0.3);
        break;
      case 'starpower':
        crowdMoodTarget = 1.0;
        crowdSurge = 1.0;
        blinderHit = 1.0;
        if (rig) { rig.pattern = 'audience'; aimRig(barPos | 0, false); }
        break;
      case 'ecstatic':
      case 'confetti':
      case 'fivestars':
        crowdMoodTarget = 1.0;
        crowdSurge = 1.0;
        blinderHit = 1.0;
        burstConfetti(CONFETTI_N);
        break;
      default:
        crowdMoodTarget = Math.max(crowdMoodTarget, 0.8);
        break;
    }
    return GH.Stage;
  }

  /* O Game roteia crowdReaction so para GH.FX. Escutamos o Scoring por conta
     propria (assinatura ADITIVA — nao interfere no ouvinte do Game) para que
     falha e 5 estrelas cheguem ao publico do mesmo jeito. */
  function hookScoring() {
    var S = GH.Scoring;
    if (!S || typeof S.onEvent !== 'function') return;
    try {
      S.onEvent(function (e) {
        if (!e || !inited) return;
        if (e.type === 'fail') crowdReaction('boo');
        else if (e.type === 'finish') {
          var st = e.stats || e;
          var stars = st.starsDisplay !== undefined ? st.starsDisplay : (st.stars || 0);
          if (st.failed) crowdReaction('boo');
          else if (stars >= 5) crowdReaction('ecstatic');
          else crowdReaction('cheer');
        }
      });
    } catch (err) { warn('hookScoring', err); }
  }

  /* =========================================================================
     15. INIT / UPDATE / API
     ========================================================================= */

  function init(sceneIn) {
    if (inited) return GH.Stage;
    if (typeof THREE === 'undefined') return GH.Stage;
    U = GH.Util; P = GH.Palette; M = GH.Materials;
    scene = sceneIn || (GH.Engine && GH.Engine.scene) || null;
    if (!scene) return GH.Stage;

    theme = (P && P.current) || null;
    themeId = (theme && theme.id) || 'para';

    group = new THREE.Group();
    group.name = 'GH_Stage';
    group.frustumCulled = false;
    scene.add(group);
    GH.Stage.group = group;

    /* ordem importa: o fundo primeiro (renderOrder negativo), depois a
       estrutura, depois o que emite luz */
    safe(function () { buildBackdrop(); });
    safe(function () { buildStageStructure(); });
    safe(function () { buildLed(); });
    safe(function () { buildBand(); });
    safe(function () { buildRig(); });
    safe(function () { buildCrowd(); });
    safe(function () { buildHaze(); });
    safe(function () { buildConfetti(); });

    inited = true;
    disposed = false;

    safe(function () { cameraRig.register(); });
    safe(function () { hookScoring(); });
    safe(function () { applyTheme(); });

    /* segue trocas de tema feitas por outros modulos */
    try {
      if (P && typeof P.onChange === 'function') {
        P.onChange(function (t) {
          if (!inited) return;
          if (t && t.id && t.id !== themeId) { theme = t; themeId = t.id; safe(applyTheme); }
        });
      }
    } catch (e) { warn('palette.onChange', e); }

    return GH.Stage;
  }

  function update(dt, songTime) {
    if (!inited || disposed) return;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;
    elapsed += dt;

    /* --- relogio musical --- */
    var C = GH.Conductor;
    var playing = false, b = NaN;
    try {
      if (C) {
        playing = !!C.isPlaying;
        b = C.beat;
      }
    } catch (e) { playing = false; }
    if (playing && isFinite(b)) {
      /* salto grande (seek/captura) => reposiciona sem interpolar */
      if (Math.abs(b - beatPos) > 2.5) beatPos = b;
      else beatPos = b;
      barPos = beatPos / 4;
    } else {
      beatPos += dt * (idleBpm / 60);
      barPos = beatPos / 4;
    }

    /* beat implicito: garante pulso mesmo sem callback do Conductor */
    var bi = Math.floor(beatPos);
    if (bi !== lastBeatIndex) {
      if (lastBeatIndex !== -1e9) onInternalBeat(bi);
      lastBeatIndex = bi;
    }

    /* --- amortecimentos --- */
    intensitySmooth = damp(intensitySmooth, intensity, 3.2, dt);
    spMix = damp(spMix, starPower ? 1 : 0, 5.0, dt);
    crowdMood = damp(crowdMood, crowdMoodTarget, 2.2, dt);
    crowdSurge = Math.max(0, crowdSurge - dt * 0.85);
    beatPulse = Math.max(0, beatPulse - dt * 3.4);
    barPulse = Math.max(0, barPulse - dt * 1.6);
    /* o publico se recupera sozinho de uma vaia */
    if (crowdMoodTarget < 0.9) crowdMoodTarget = Math.min(1, crowdMoodTarget + dt * 0.12);

    safe(function () { updateCrowd(dt); });
    safe(function () { updateBand(dt); });
    safe(function () { updateRig(dt); });
    safe(function () { updateLed(dt); });
    safe(function () { updateHaze(dt); });
    safe(function () { updateConfetti(dt); });

    /* rio: leve deriva das ondas */
    if (backdrop && backdrop.tex && backdrop.tex.water) {
      backdrop.tex.water.offset.x = elapsed * 0.004;
    }
  }

  /* Batida detectada internamente (funciona com ou sem Conductor). */
  function onInternalBeat(i) {
    beatPulse = 1;
    if (led && (i % 2 === 0)) led.modeT++;
    /* muda a mira do rig a cada 2 batidas */
    if (rig && (i % 2 === 0)) aimRig(i, false);
    /* blinder no tempo forte quando o show esta alto */
    if ((i % 4) === 0) {
      barPulse = 1;
      if (intensitySmooth > 0.72 || starPower) blinderHit = Math.max(blinderHit, 0.65);
      /* padrao novo a cada 4 compassos */
      if (rig && ((i / 4) | 0) % 4 === 0) {
        var r = rng(i * 7 + 3);
        var pool = starPower ? ['audience', 'cross', 'sweep', 'pulse'] : RIG_PATTERNS;
        rig.pattern = pool[(rnd(r) * pool.length) | 0];
      }
      /* telao troca de modo a cada 4 compassos */
      if (led && (((i / 4) | 0) % 4 === 0)) led.mode = (led.mode + 1) % 4;
    }
  }

  /* --- API publica --------------------------------------------------------- */

  function setTheme(t) {
    var r = resolveTheme(t);
    if (!r) return GH.Stage;
    if (r.id === themeId && theme === r) return GH.Stage;
    theme = r;
    themeId = r.id || themeId;
    safe(applyTheme);
    if (starPower) safe(applyStarPowerLook);
    return GH.Stage;
  }

  function setIntensity(v) {
    if (typeof v !== 'number' || !isFinite(v)) return GH.Stage;
    intensity = clamp01(v);
    return GH.Stage;
  }

  function setStarPower(on) {
    on = !!on;
    if (on === starPower) return GH.Stage;
    starPower = on;
    safe(applyStarPowerLook);
    if (on) {
      crowdSurge = 1;
      blinderHit = 1;
      crowdMoodTarget = 1;
      if (rig) { rig.pattern = 'audience'; aimRig(barPos | 0, false); }
    }
    return GH.Stage;
  }

  function beat(i) {
    beatPulse = 1;
    if (typeof i === 'number' && isFinite(i)) {
      lastBeatIndex = Math.floor(beatPos);
      if (rig && (i % 2 === 0)) aimRig(i, false);
    }
    return GH.Stage;
  }

  function bar(i) {
    barPulse = 1;
    if (rig) {
      var r = rng((i | 0) * 13 + 5);
      var pool = starPower ? ['audience', 'cross', 'sweep', 'pulse'] : RIG_PATTERNS;
      rig.pattern = pool[(rnd(r) * pool.length) | 0];
      aimRig(i | 0, false);
    }
    if (led && (i | 0) % 4 === 0) led.mode = (led.mode + 1) % 4;
    if ((intensitySmooth > 0.7 || starPower) && (i | 0) % 2 === 0) {
      blinderHit = Math.max(blinderHit, 0.8);
    }
    return GH.Stage;
  }

  function reset() {
    intensity = 0.5;
    crowdMoodTarget = 1;
    crowdSurge = 0;
    blinderHit = 0;
    if (starPower) { starPower = false; safe(applyStarPowerLook); }
    if (confetti) {
      var i;
      for (i = 0; i < CONFETTI_N; i++) {
        confetti.parts[i].life = 0;
        writeInstance(confetti.mesh.instanceMatrix.array, i, 0, -999, 0, 1, 0, 0.001, 0.001, 0.001);
      }
      confetti.mesh.instanceMatrix.needsUpdate = true;
      confetti.mesh.visible = false;
      confetti.alive = 0;
    }
    return GH.Stage;
  }

  function setVisible(v) {
    if (group) group.visible = !!v;
    return GH.Stage;
  }

  function dispose() {
    if (!inited) return GH.Stage;
    var i;
    try { if (scene && group) scene.remove(group); } catch (e) { /* ok */ }
    for (i = 0; i < ownedGeo.length; i++) { try { ownedGeo[i].dispose(); } catch (e) {} }
    for (i = 0; i < ownedMat.length; i++) { try { ownedMat[i].dispose(); } catch (e) {} }
    for (i = 0; i < ownedTex.length; i++) { try { ownedTex[i].dispose(); } catch (e) {} }
    ownedGeo.length = 0; ownedMat.length = 0; ownedTex.length = 0;
    backdropCache = {};
    backdrop = crowd = stageBuild = band = led = rig = haze = confetti = stageLights = null;
    group = null;
    inited = false;
    disposed = true;
    return GH.Stage;
  }

  function stats() {
    return {
      crowd: crowd ? crowd.count : 0,
      phones: (crowd && crowd.phones) ? crowd.phones.list.length : 0,
      band: band ? band.members.length : 0,
      movingHeads: rig ? rig.heads.length : 0,
      pattern: rig ? rig.pattern : '-',
      ledMode: led ? led.mode : -1,
      theme: themeId,
      intensity: Math.round(intensitySmooth * 100) / 100,
      starPower: starPower,
      mood: Math.round(crowdMood * 100) / 100,
      geometries: ownedGeo.length,
      materials: ownedMat.length,
      textures: ownedTex.length,
      errors: log.slice()
    };
  }

  GH.Stage = {
    init: init,
    update: update,
    dispose: dispose,
    reset: reset,

    group: null,
    cameraRig: cameraRig,

    setTheme: setTheme,
    setIntensity: setIntensity,
    setStarPower: setStarPower,
    beat: beat,
    bar: bar,
    crowdReaction: crowdReaction,
    confetti: burstConfetti,
    setVisible: setVisible,

    stats: stats,
    get inited() { return inited; },
    get intensity() { return intensitySmooth; },
    get themeName() { return themeId; }
  };

})(window.GH = window.GH || {});

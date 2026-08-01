/* ===========================================================================
   GUITARRADA HERO — src/visual/effects.js   (GH.FX)
   ---------------------------------------------------------------------------
   O ESPETACULO. Cada acerto tem que ser gostoso de ver.

   Contrato (secao 6 do ARCHITECTURE.md):
     GH.FX = { init(scene, camera), update(dt),
               hit(lane, quality), miss(lane), openHit(),
               flames(lane, on), starPower(on), streakLevel(n),
               crowdReaction(kind), reset() }

   ARQUITETURA
   -----------
   Tudo desenha em POUCOS draw calls. O tijolo e o SpriteBatch: uma
   InstancedBufferGeometry de quad unitario com atributos por instancia
   (posicao, tamanho, rotacao, cor, opacidade, recorte de atlas, modo de
   billboard e "dessaturacao"). Um batch por textura:

     glow    softGlow    flashes, colunas de raia, halos, flashes do publico
     spark   sparkle     faiscas cintilantes, particulas de star power
     trail   streak      faiscas alongadas alinhadas a velocidade
     ring    shockwave   aneis de choque (deitados no chao da pista)
     flame   flame(4x2)  CHAMAS DE COMBO — atlas animado de 8 quadros
     smoke   smoke       neblina/haze aditivo do palco
     dark    smoke       fumaca ESCURA do erro (blend normal, escurece mesmo)
     flare   flare       flare anamorfico nos momentos grandes

   Fora dos batches:
     - campo de POEIRA: THREE.Points com shader proprio, animado 100% na GPU
       (deriva, cintilancia, mascara de facho) — custo de CPU zero;
     - AURA de star power: chao energizado + dois trilhos + onda que varre;
     - ESCURECIMENTO de raia no erro (blend normal, unica coisa que subtrai);
     - duas PointLight (acerto e star power) com contagem FIXA, para nao
       recompilar shader nenhum em tempo de execucao.

   ESPACO DE COR: o EffectComposer do engine trabalha em LINEAR e a conversao
   final para sRGB acontece no shader de grade. Entao este modulo:
     - decodifica sRGB->linear a textura dentro do fragmento;
     - usa THREE.Color da paleta direto (com ColorManagement ligado eles JA
       estao em linear);
     - empurra o nucleo dos efeitos acima de 1.0 para o bloom (limiar 0.85)
       morder so no que e emissivo.

   QUEM CHAMA update(): GH.Game. Este modulo NAO se registra no Engine.
   =========================================================================== */
(function (GH) {
  'use strict';

  /* =========================================================================
     0. ATALHOS, CONSTANTES E ESTADO
     ========================================================================= */

  var TAU = Math.PI * 2;
  var mSin = Math.sin, mCos = Math.cos, mSqrt = Math.sqrt, mExp = Math.exp,
      mAtan2 = Math.atan2, mMin = Math.min, mMax = Math.max, mAbs = Math.abs;

  var scene = null, camera = null;
  var group = null;
  var inited = false;
  var disposed = false;

  /* relogio proprio, acumulado a partir do dt — deterministico no modo captura */
  var elapsed = 0;

  /* RNG proprio com semente fixa: o print sai igual toda vez */
  var rng = null;
  function rnd() { return rng ? rng() : Math.random(); }
  function rrange(a, b) { return a + (b - a) * rnd(); }
  function rsign() { return rnd() < 0.5 ? -1 : 1; }

  /* Layout canonico (nunca redefinido aqui) */
  var LAY = null;
  var LANES = 5;
  var SURFACE_Y = 0;
  var STRIKE_Z = 0;
  var HALF_W = 1.8;
  var LANE_W = 0.72;
  var SPAWN_Z = -46;

  /* Altura de trabalho dos efeitos na linha de acerto */
  var FX_Y = 0.055;

  /* Cores resolvidas da paleta (THREE.Color, ja em luz linear) */
  var C = {
    lane: [], laneGlow: [], laneEm: [], laneRim: [],
    white: null, spCore: null, spGlow: null, spEdge: null, spTint: null,
    danger: null, gold: null, accent: null, neon: null, haze: null,
    spotlight: null, smoke: null, perfect: null, good: null
  };

  /* Escalas por qualidade — quantas particulas cada evento vale */
  var QUALITY_SCALE = { low: 0.42, med: 0.68, high: 1.0, ultra: 1.22 };
  var qScale = 1.0;

  /* --- FILA DE EMISSAO AMORTIZADA ------------------------------------------
     Alguns eventos nascem enormes num frame so: ativar star power dispara ~90
     faiscas de rastro + aneis + coluna + flare TUDO junto, e a comemoracao
     idem. Um frame gordo desses e o que atrasa o tick do agendador de audio
     (setInterval de 25 ms, janela de 0,20 s, mesma thread do rAF) e faz a
     musica estalar.

     A cura nao e emitir menos — e emitir ao longo de alguns frames. A 60 fps,
     espalhar por 4 frames sao 67 ms: o olho le como um jorro, nao como um
     degrau. O visual continua o mesmo; some so o degrau de custo.           */
  var burstQ = [];          /* [{ left, per, fn }] */
  var BURST_FRAMES = 4;     /* em quantos frames um jorro se espalha */

  function emitBurst(count, fn) {
    var n = Math.max(0, Math.round(count));
    if (n <= 0) return;
    /* a primeira leva sai AGORA: o feedback nunca pode chegar atrasado */
    var per = Math.max(1, Math.ceil(n / BURST_FRAMES));
    var first = Math.min(n, per);
    for (var i = 0; i < first; i++) if (fn(i, n) === false) return;
    if (n > first) burstQ.push({ i: first, left: n - first, total: n, per: per, fn: fn });
  }

  function drainBursts() {
    if (!burstQ.length) return;
    for (var b = burstQ.length - 1; b >= 0; b--) {
      var job = burstQ[b];
      var k = Math.min(job.per, job.left);
      for (var j = 0; j < k; j++) {
        if (job.fn(job.i++, job.total) === false) { job.left = 0; break; }
        job.left--;
      }
      if (job.left <= 0) { burstQ[b] = burstQ[burstQ.length - 1]; burstQ.pop(); }
    }
  }

  /* Estado dinamico */
  var st = {
    spOn: false,          /* star power pedido */
    spAmt: 0,             /* 0..1 amortecido */
    spSince: 0,           /* segundos desde a virada */
    level: 1,             /* nivel de combo (1..4) */
    levelSmooth: 1,
    intensity: 0.5,       /* energia do show 0..1 */
    beatPhase: 0,
    lastBeat: -1,
    lastStreak: 0,
    crowdRate: 1.4,       /* flashes de celular por segundo */
    crowdBurst: 0,
    hitLightE: 0,         /* energia da luz de acerto */
    spLightE: 0,
    strikeGlow: 0,        /* brilho residual da linha de acerto */
    waveT: -1,            /* progresso da onda de SP (-1 = parada) */
    waveDir: 1,
    sustainAcc: [0, 0, 0, 0, 0],
    laneAfter: [0, 0, 0, 0, 0],   /* rastro luminoso do ultimo acerto na raia */
    laneAfterQ: [0, 0, 0, 0, 0],  /* 1 = era perfeito */
    dimAmt: [0, 0, 0, 0, 0],
    dimTint: [0, 0, 0, 0, 0],
    flameOn: [false, false, false, false, false],
    flameAmt: [0, 0, 0, 0, 0],
    flameAcc: [0, 0, 0, 0, 0],
    flameEmber: [0, 0, 0, 0, 0],
    flameKick: [0, 0, 0, 0, 0],   /* estouro instantaneo no beat/acerto */
    spEmitAcc: 0,
    spArcAcc: 0,
    crowdAcc: 0,
    hazeAcc: 0,
    emberAcc: 0
  };

  /* =========================================================================
     1. HELPERS DE MODULO (sempre defensivos — nada aqui derruba o jogo)
     ========================================================================= */

  function U() { return GH.Util; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function damp(a, b, lambda, dt) { return b + (a - b) * mExp(-lambda * dt); }
  function easeOutCubic(t) { var u = 1 - t; return 1 - u * u * u; }
  function easeOutQuint(t) { var u = 1 - t, u2 = u * u; return 1 - u2 * u2 * u; }

  /* Textura de GH.Materials com rede de seguranca. */
  function tex(name) {
    try {
      if (GH.Materials && GH.Materials.tex) return GH.Materials.tex.get(name);
    } catch (e) { /* cai no null */ }
    return null;
  }

  /* Cor da paleta -> THREE.Color (clone proprio, nunca mutamos a paleta). */
  function pcolor(getter, fallbackHex) {
    try {
      var c = getter();
      if (c && c.isColor) return c.clone();
      if (typeof c === 'string' || typeof c === 'number') return new THREE.Color(c);
    } catch (e) { /* fallback */ }
    return new THREE.Color(fallbackHex);
  }

  function resolveColors() {
    var P = GH.Palette;
    var i;
    C.lane.length = 0; C.laneGlow.length = 0; C.laneEm.length = 0; C.laneRim.length = 0;
    for (i = 0; i < LANES; i++) {
      (function (idx) {
        C.lane.push(pcolor(function () { return P.lanes[idx]; }, 0xffffff));
        C.laneGlow.push(pcolor(function () { return P.laneGlow[idx]; }, 0xffffff));
        C.laneEm.push(pcolor(function () { return P.laneEmissive[idx]; }, 0xffffff));
        C.laneRim.push(pcolor(function () { return P.laneRim[idx]; }, 0xffffff));
      })(i);
    }
    C.white   = new THREE.Color(0xffffff);
    C.spCore  = pcolor(function () { return P.sp.core; }, 0xf2fbff);
    C.spGlow  = pcolor(function () { return P.sp.glow; }, 0x8fd8ff);
    C.spEdge  = pcolor(function () { return P.sp.edge; }, 0x3aa8ff);
    C.spTint  = pcolor(function () { return P.sp.tint; }, 0xb9e6ff);
    C.danger  = pcolor(function () { return P.ui.danger; }, 0xff3b4e);
    C.gold    = pcolor(function () { return P.ui.gold; }, 0xffcf4a);
    C.perfect = pcolor(function () { return P.judgment.perfect; }, 0xffe45c);
    C.good    = pcolor(function () { return P.judgment.good; }, 0x8fd8ff);
    C.accent  = pcolor(function () { return P.current.accent; }, 0xffb03a);
    C.neon    = pcolor(function () { return P.current.neon; }, 0x25e8ce);
    C.haze    = pcolor(function () { return P.current.haze; }, 0xff7a4a);
    C.spotlight = pcolor(function () { return P.current.spotlight; }, 0xffd9a8);
    C.smoke   = pcolor(function () { return P.current.smoke; }, 0x5a3070);
  }

  function laneX(i) { return LAY ? LAY.laneX(i) : (i - 2) * 0.72; }

  /* A pista do GH.Highway tem COROA (o conves e levemente abaulado, como um
     braco de guitarra). Quem cola geometria no chao precisa seguir essa curva,
     senao a peca flutua ~7 cm na borda e o angulo rasante entrega. O raio vem
     do proprio Highway quando ele existe; 26.0 e o valor de referencia. */
  var CROWN_R = 26.0;
  function crownY(x) {
    var r2 = CROWN_R * CROWN_R - x * x;
    return (r2 > 0 ? mSqrt(r2) : 0) - CROWN_R;
  }
  function readCrown() {
    var H = GH.Highway;
    if (!H) return;
    var r = H.CROWN_R;
    if (r == null && typeof H.debug === 'function') {
      try { var d = H.debug(); if (d && d.CROWN_R) r = d.CROWN_R; } catch (e) { /* ok */ }
    }
    if (typeof r === 'number' && r > 1) CROWN_R = r;
  }

  /* =========================================================================
     2. SHADERS
     ========================================================================= */

  /* --- particulas instanciadas ------------------------------------------- */
  var SPRITE_VERT = [
    'attribute vec3  aOffset;',
    'attribute vec2  aSize;',
    'attribute float aRot;',
    'attribute vec3  aColor;',
    'attribute float aOpacity;',
    'attribute vec4  aUv;',
    'attribute float aBill;',
    'attribute float aTint;',
    '',
    'varying vec2  vUv;',
    'varying vec3  vColor;',
    'varying float vOpacity;',
    'varying float vTint;',
    '',
    'void main() {',
    '  vUv      = aUv.xy + uv * aUv.zw;',
    '  vColor   = aColor;',
    '  vOpacity = aOpacity;',
    '  vTint    = aTint;',
    '',
    '  vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);',
    '  vec2 p  = position.xy * aSize;',
    '  float c = cos(aRot), s = sin(aRot);',
    '  vec2 pr = vec2(p.x * c - p.y * s, p.x * s + p.y * c);',
    '',
    '  if (aBill < 0.5) {',
    /* billboard de tela: sempre de frente para a camera */
    '    mv.xy += pr;',
    '  } else if (aBill < 1.5) {',
    /* travado no eixo Y do mundo: chamas e colunas ficam SEMPRE em pe */
    '    vec3 upV    = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);',
    '    vec3 dirV   = normalize(-mv.xyz);',
    '    vec3 rightV = cross(upV, dirV);',
    '    float rl    = length(rightV);',
    '    rightV      = rl > 0.0001 ? rightV / rl : vec3(1.0, 0.0, 0.0);',
    '    mv.xyz += rightV * pr.x + upV * pr.y;',
    '  } else {',
    /* deitado no plano XZ: aneis de choque colados na pista */
    '    mv.xyz += (viewMatrix * vec4(pr.x, 0.0, pr.y, 0.0)).xyz;',
    '  }',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var SPRITE_FRAG = [
    'uniform sampler2D uMap;',
    'uniform float uGlobal;',
    '',
    'varying vec2  vUv;',
    'varying vec3  vColor;',
    'varying float vOpacity;',
    'varying float vTint;',
    '',
    /* sRGB -> linear exato: o composer trabalha em luz linear */
    'vec3 srgbToLinear(vec3 c) {',
    '  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));',
    '}',
    '',
    'void main() {',
    '  vec4 t = texture2D(uMap, vUv);',
    '  float a = t.a * vOpacity * uGlobal;',
    '  if (a <= 0.0025) discard;',
    '  vec3 lin = srgbToLinear(t.rgb);',
    /* vTint=1 transforma a textura em mascara pura: e assim que a chama
       laranja do atlas vira azul-branca no 4x e prateada no star power */
    '  float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));',
    '  vec3 rgb = mix(lin, vec3(lum), vTint) * vColor;',
    '  gl_FragColor = vec4(rgb, a);',
    '}'
  ].join('\n');

  /* --- poeira atmosferica (100% na GPU) ---------------------------------- */
  var DUST_VERT = [
    'attribute float aSeed;',
    'attribute float aScale;',
    '',
    'uniform float uTime;',
    'uniform float uSize;',
    'uniform float uIntensity;',
    'uniform float uSp;',
    'uniform float uBoxY;',
    'uniform vec3  uColA;',
    'uniform vec3  uColB;',
    '',
    'varying float vAlpha;',
    'varying vec3  vTint;',
    '',
    'void main() {',
    '  float s = aSeed;',
    '  vec3 p = position;',
    /* sobe devagar e recicla no topo — nunca acaba, nunca aparece "nascendo" */
    '  p.y = mod(p.y + uTime * (0.055 + s * 0.11), uBoxY) - 0.25;',
    '  p.x += sin(uTime * (0.17 + s * 0.21) + s * 31.4) * (0.30 + s * 0.35);',
    '  p.z += cos(uTime * (0.12 + s * 0.18) + s * 17.7) * (0.30 + s * 0.30);',
    '',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  float dist = max(1.0, -mv.z);',
    '  gl_PointSize = uSize * aScale * (13.0 / dist);',
    '',
    /* cintilancia: cada mota pisca no seu proprio ritmo */
    '  float tw = 0.42 + 0.58 * sin(uTime * (1.7 + s * 3.4) + s * 12.9);',
    '  tw = tw * tw;',
    /* mascara de facho: poeira so aparece de verdade dentro da luz */
    '  float shaft = smoothstep(11.0, 1.0, abs(p.x)) * smoothstep(-0.4, 2.6, p.y);',
    '  shaft = mix(shaft, shaft * 0.45 + 0.18, 0.35);',
    /* some no fundo e nao encosta na lente */
    '  float fade = smoothstep(52.0, 12.0, dist) * smoothstep(1.2, 5.0, dist);',
    '  vAlpha = tw * shaft * fade * (0.22 + uIntensity * 0.40 + uSp * 0.34);',
    '  vTint  = mix(uColA, uColB, s) * (1.0 + uSp * 1.1);',
    '}'
  ].join('\n');

  var DUST_FRAG = [
    'varying float vAlpha;',
    'varying vec3  vTint;',
    'void main() {',
    '  vec2 d = gl_PointCoord - vec2(0.5);',
    '  float r = dot(d, d);',
    '  float a = exp(-r * 16.0) * vAlpha;',
    '  if (a <= 0.002) discard;',
    '  gl_FragColor = vec4(vTint, a);',
    '}'
  ].join('\n');

  /* =========================================================================
     3. SPRITE BATCH — o motor de particulas
     ========================================================================= */

  var batches = [];
  var baseQuad = null;

  function makeQuadGeometry() {
    if (!baseQuad) baseQuad = new THREE.PlaneGeometry(1, 1);
    var g = new THREE.InstancedBufferGeometry();
    g.setIndex(baseQuad.index.clone());
    g.setAttribute('position', baseQuad.attributes.position.clone());
    g.setAttribute('uv', baseQuad.attributes.uv.clone());
    return g;
  }

  function makeInstAttr(cap, items) {
    var a = new THREE.InstancedBufferAttribute(new Float32Array(cap * items), items);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  }

  /* Batch(name, texName, capacity, opts)
       opts.blending  — THREE.AdditiveBlending (padrao) ou NormalBlending
       opts.order     — renderOrder
       opts.depthTest — false desliga o teste (usado no flare) */
  function Batch(name, texName, cap, opts) {
    opts = opts || {};
    this.name = name;
    this.cap = cap;
    this.count = 0;
    this.parts = [];
    this.free = [];
    this.texName = texName;

    var geo = makeQuadGeometry();
    this.aOffset  = makeInstAttr(cap, 3);
    this.aSize    = makeInstAttr(cap, 2);
    this.aRot     = makeInstAttr(cap, 1);
    this.aColor   = makeInstAttr(cap, 3);
    this.aOpacity = makeInstAttr(cap, 1);
    this.aUv      = makeInstAttr(cap, 4);
    this.aBill    = makeInstAttr(cap, 1);
    this.aTint    = makeInstAttr(cap, 1);
    geo.setAttribute('aOffset', this.aOffset);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aRot', this.aRot);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aOpacity', this.aOpacity);
    geo.setAttribute('aUv', this.aUv);
    geo.setAttribute('aBill', this.aBill);
    geo.setAttribute('aTint', this.aTint);
    geo.instanceCount = 0;
    /* esfera gigante + frustumCulled off: as posicoes vivem nos atributos,
       o three nao tem como saber a extensao real */
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    this.geometry = geo;

    var t = tex(texName);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: t },
        uGlobal: { value: 1.0 }
      },
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      transparent: true,
      blending: opts.blending || THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: opts.depthTest === false ? false : true,
      side: THREE.DoubleSide,
      fog: false
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'GH_FX_' + name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.order == null ? 20 : opts.order;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    /* quadros do atlas (offX, offY, repX, repY) */
    this.frames = null;
    if (opts.atlas) this.frames = buildAtlasFrames(opts.atlas);

    batches.push(this);
  }

  function buildAtlasFrames(atlasName) {
    var out = [];
    var A = null;
    try { A = GH.Materials && GH.Materials.atlas ? GH.Materials.atlas[atlasName] : null; } catch (e) { A = null; }
    if (!A) { out.push([0, 0, 1, 1]); return out; }
    for (var i = 0; i < A.count; i++) {
      var col = i % A.cols, row = (i / A.cols) | 0;
      out.push([col / A.cols, 1 - (row + 1) / A.rows, 1 / A.cols, 1 / A.rows]);
    }
    return out;
  }

  /* --- particula ---------------------------------------------------------- */
  function newParticle() {
    return {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      gy: 0, drag: 0, turb: 0, turbF: 3, seed: 0,
      age: 0, life: 1,
      sz0: 1, sz1: 1, asp: 1, szEase: 1,
      rot: 0, rotV: 0, align: 0, stretch: 0,
      r0: 1, g0: 1, b0: 1, r1: 1, g1: 1, b1: 1,
      a0: 1, fin: 0.08, fout: 0.5,
      bill: 0, tint: 0, anchor: 0, baseY: 0,
      bounce: 0, floorY: -1e9,
      frame0: 0, fps: 0, frames: 0, frameLoop: 1
    };
  }

  function resetParticle(p) {
    p.vx = p.vy = p.vz = 0;
    p.gy = 0; p.drag = 0; p.turb = 0; p.turbF = 3;
    p.age = 0; p.life = 1;
    p.sz0 = 1; p.sz1 = 1; p.asp = 1; p.szEase = 1;
    p.rot = 0; p.rotV = 0; p.align = 0; p.stretch = 0;
    p.r0 = p.g0 = p.b0 = 1; p.r1 = p.g1 = p.b1 = 1;
    p.a0 = 1; p.fin = 0.08; p.fout = 0.5;
    p.bill = 0; p.tint = 0; p.anchor = 0; p.baseY = 0;
    p.bounce = 0; p.floorY = -1e9;
    p.frame0 = 0; p.fps = 0; p.frames = 0; p.frameLoop = 1;
    p.seed = rnd() * 100;
    return p;
  }

  /* Pega uma particula livre. Devolve null se o orcamento estourou — CADA
     emissor tem que aguentar receber null (e por isso que o jogo nunca
     engasga num trecho absurdamente denso). */
  function spawn(b) {
    if (b.parts.length >= b.cap) return null;
    var p = b.free.length ? b.free.pop() : newParticle();
    resetParticle(p);
    b.parts.push(p);
    return p;
  }

  function setCol(p, c0, k0, c1, k1) {
    p.r0 = c0.r * k0; p.g0 = c0.g * k0; p.b0 = c0.b * k0;
    if (c1) { p.r1 = c1.r * k1; p.g1 = c1.g * k1; p.b1 = c1.b * k1; }
    else { p.r1 = p.r0 * 0.15; p.g1 = p.g0 * 0.15; p.b1 = p.b0 * 0.15; }
  }

  /* --- integracao + escrita nos atributos --------------------------------- */
  function updateBatch(b, dt) {
    var arr = b.parts;
    var n = 0, i;
    var off = b.aOffset.array, sz = b.aSize.array, rot = b.aRot.array,
        col = b.aColor.array, op = b.aOpacity.array, uvv = b.aUv.array,
        bil = b.aBill.array, tin = b.aTint.array;
    var frames = b.frames;

    for (i = arr.length - 1; i >= 0; i--) {
      var p = arr[i];
      p.age += dt;
      if (p.age >= p.life) {
        arr[i] = arr[arr.length - 1];
        arr.pop();
        b.free.push(p);
        continue;
      }
      var t = p.age / p.life;

      /* ---- fisica ---- */
      if (p.drag > 0) {
        var k = mExp(-p.drag * dt);
        p.vx *= k; p.vy *= k; p.vz *= k;
      }
      if (p.gy !== 0) p.vy += p.gy * dt;
      if (p.turb > 0) {
        var tt = p.age * p.turbF + p.seed;
        p.vx += mSin(tt * 2.13 + p.seed) * p.turb * dt;
        p.vy += mCos(tt * 1.61 + p.seed * 1.7) * p.turb * 0.55 * dt;
        p.vz += mSin(tt * 1.37 + p.seed * 2.3) * p.turb * 0.7 * dt;
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      /* ricochete na superficie da pista: faisca que bate e volta */
      if (p.bounce > 0 && p.y < p.floorY && p.vy < 0) {
        p.y = p.floorY;
        p.vy = -p.vy * p.bounce;
        p.vx *= 0.72; p.vz *= 0.72;
        if (p.vy < 0.35) p.bounce = 0;
      }

      /* ---- tamanho ---- */
      var e = p.szEase === 0 ? t
            : (p.szEase === 1 ? easeOutCubic(t)
            : (1 - (2 * t - 1) * (2 * t - 1)));          /* 2 = cresce e volta */
      var s = p.sz0 + (p.sz1 - p.sz0) * e;
      var w = s, h = s * p.asp;

      if (p.stretch > 0) {
        var spd = mSqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
        w = s * (1 + spd * p.stretch);
      }

      /* ---- rotacao ---- */
      if (p.align) p.rot = mAtan2(p.vy, p.vx);
      else if (p.rotV !== 0) p.rot += p.rotV * dt;

      /* ---- alfa ---- */
      var a = p.a0;
      if (p.fin > 0) { var fi = t / p.fin; if (fi < 1) a *= fi * fi; }
      if (p.fout > 0) { var fo = (1 - t) / p.fout; if (fo < 1) a *= fo * fo; }
      if (a <= 0.0015) { continue; }

      /* ---- ancoragem no chao (chamas e colunas nascem do aro) ---- */
      var py = p.y;
      if (p.anchor === 1) py = p.baseY + h * 0.5;

      /* ---- escrita ---- */
      var i3 = n * 3, i2 = n * 2, i4 = n * 4;
      off[i3] = p.x; off[i3 + 1] = py; off[i3 + 2] = p.z;
      sz[i2] = w; sz[i2 + 1] = h;
      rot[n] = p.rot;
      col[i3]     = p.r0 + (p.r1 - p.r0) * t;
      col[i3 + 1] = p.g0 + (p.g1 - p.g0) * t;
      col[i3 + 2] = p.b0 + (p.b1 - p.b0) * t;
      op[n] = a;
      bil[n] = p.bill;
      tin[n] = p.tint;

      if (p.frames > 1 && frames) {
        var fi2 = p.frame0 + p.age * p.fps;
        var idx;
        if (p.frameLoop) idx = ((fi2 % p.frames) + p.frames) % p.frames;
        else idx = mMin(p.frames - 1, mMax(0, fi2));
        var f = frames[idx | 0] || frames[0];
        uvv[i4] = f[0]; uvv[i4 + 1] = f[1]; uvv[i4 + 2] = f[2]; uvv[i4 + 3] = f[3];
      } else {
        uvv[i4] = 0; uvv[i4 + 1] = 0; uvv[i4 + 2] = 1; uvv[i4 + 3] = 1;
      }
      n++;
    }

    b.count = n;
    b.geometry.instanceCount = n;
    b.mesh.visible = n > 0;
    if (n > 0) {
      markRange(b.aOffset, n * 3);
      markRange(b.aSize, n * 2);
      markRange(b.aRot, n);
      markRange(b.aColor, n * 3);
      markRange(b.aOpacity, n);
      markRange(b.aUv, n * 4);
      markRange(b.aBill, n);
      markRange(b.aTint, n);
    }
  }

  /* Sobe para a GPU so a fatia usada — o resto do buffer nao viaja. */
  function markRange(attr, count) {
    attr.updateRange.offset = 0;
    attr.updateRange.count = count;
    attr.needsUpdate = true;
  }

  /* =========================================================================
     4. OS BATCHES
     ========================================================================= */

  var bGlow = null, bSpark = null, bTrail = null, bRing = null,
      bFlame = null, bSmoke = null, bDark = null, bFlare = null;

  function buildBatches() {
    var q = qScale;
    bRing  = new Batch('ring',  'shockwave', Math.round(70 * q) + 24,  { order: 31 });
    bGlow  = new Batch('glow',  'softGlow',  Math.round(300 * q) + 60, { order: 32 });
    bFlame = new Batch('flame', 'flame',     Math.round(320 * q) + 60, { order: 33, atlas: 'flame' });
    bTrail = new Batch('trail', 'streak',    Math.round(300 * q) + 60, { order: 34 });
    bSpark = new Batch('spark', 'sparkle',   Math.round(520 * q) + 80, { order: 35 });
    bSmoke = new Batch('smoke', 'smoke',     Math.round(90 * q) + 24,  { order: 28 });
    bFlare = new Batch('flare', 'flare',     28,                       { order: 36 });
    /* a UNICA coisa que subtrai luz: fumaca escura do erro */
    bDark  = new Batch('dark',  'smoke',     Math.round(60 * q) + 16,
                       { order: 30, blending: THREE.NormalBlending });

    /* smoke/haze entram antes das gems para nao lavar a leitura das notas */
    group.add(bSmoke.mesh, bDark.mesh, bRing.mesh, bGlow.mesh, bFlame.mesh,
              bTrail.mesh, bSpark.mesh, bFlare.mesh);
  }

  /* =========================================================================
     5. CAMPO DE POEIRA (atmosfera)
     ========================================================================= */

  var dust = { points: null, mat: null, geo: null, count: 0, boxY: 8.5 };

  function buildDust() {
    var count = Math.round(1250 * qScale);
    if (count < 220) count = 220;
    var pos = new Float32Array(count * 3);
    var seed = new Float32Array(count);
    var scale = new Float32Array(count);
    var i;
    for (i = 0; i < count; i++) {
      /* concentrado sobre a pista, mas com cauda ate o palco */
      var xr = rnd();
      var x = (xr < 0.62) ? rrange(-3.6, 3.6) : rrange(-13, 13);
      var z = rrange(-36, 7);
      var y = rnd() * dust.boxY;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      seed[i] = rnd();
      /* poucas motas grandes, muitas minusculas */
      scale[i] = 0.30 + Math.pow(rnd(), 2.6) * 1.35;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3, -14), 60);

    var colA = C.spotlight.clone().multiplyScalar(0.85);
    var colB = C.haze.clone().multiplyScalar(0.55);

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 4.4 },
        uIntensity: { value: 0.5 },
        uSp: { value: 0 },
        uBoxY: { value: dust.boxY },
        uColA: { value: new THREE.Vector3(colA.r, colA.g, colA.b) },
        uColB: { value: new THREE.Vector3(colB.r, colB.g, colB.b) }
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false
    });

    var pts = new THREE.Points(geo, mat);
    pts.name = 'GH_FX_dust';
    pts.frustumCulled = false;
    pts.renderOrder = 27;
    pts.matrixAutoUpdate = false;
    pts.updateMatrix();
    group.add(pts);

    dust.points = pts; dust.mat = mat; dust.geo = geo;
    dust.count = count;
  }

  /* =========================================================================
     6. AURA DE STAR POWER + ESCURECIMENTO DE RAIA
     ========================================================================= */

  var aura = {
    floor: null, railL: null, railR: null, wave: null, waveMat: null,
    floorMat: null, railMat: null, canopy: null, canopyMat: null
  };
  var laneDim = [];

  function buildAura() {
    var M2 = GH.Materials;
    var depth = 54;
    var midZ = -20;

    /* --- chao energizado: malha hexagonal correndo sob as notas ---------- */
    var hex = null;
    try { hex = M2.tex.clone('hexGrid', 3, 16); } catch (e) { hex = tex('hexGrid'); }
    aura.floorMat = new THREE.MeshBasicMaterial({
      map: hex,
      color: C.spGlow.clone().multiplyScalar(1.35),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false
    });
    /* o plano acompanha a COROA do conves: sem isso a aura flutuaria ~7 cm
       nas bordas e o angulo rasante entregaria o truque */
    var fg = new THREE.PlaneGeometry(HALF_W * 2 - 0.02, depth, 10, 1);
    var fp = fg.attributes.position;
    for (var vi = 0; vi < fp.count; vi++) {
      /* antes da rotacao -90 em X, o eixo lateral do plano e o X local e a
         altura vira o Z local (que aponta para cima depois da rotacao) */
      fp.setZ(vi, crownY(fp.getX(vi)));
    }
    fp.needsUpdate = true;
    fg.computeVertexNormals();
    aura.floor = new THREE.Mesh(fg, aura.floorMat);
    aura.floor.rotation.x = -Math.PI / 2;
    aura.floor.position.set(0, SURFACE_Y + 0.014, midZ);
    aura.floor.renderOrder = 29;
    aura.floor.visible = false;
    group.add(aura.floor);

    /* --- trilhos eletricos nas duas bordas -------------------------------- */
    var ramp = null;
    try {
      ramp = M2.tex.gradientRamp(
        [C.spCore.getHex(), C.spGlow.getHex(), C.spEdge.getHex(), 0x000000],
        { vertical: true, stops: [0, 0.30, 0.62, 1], alpha: [0.0, 0.95, 0.55, 0.0], srgb: true }
      );
    } catch (e) { ramp = tex('softGlow'); }
    aura.railMat = new THREE.MeshBasicMaterial({
      map: ramp,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false
    });
    var rg = new THREE.PlaneGeometry(depth, 1.05);
    aura.railL = new THREE.Mesh(rg, aura.railMat);
    aura.railL.rotation.y = Math.PI / 2;
    aura.railL.position.set(-HALF_W - 0.05, SURFACE_Y + 0.44, midZ);
    aura.railL.renderOrder = 29;
    aura.railL.visible = false;
    aura.railR = new THREE.Mesh(rg, aura.railMat);
    aura.railR.rotation.y = Math.PI / 2;
    aura.railR.position.set(HALF_W + 0.05, SURFACE_Y + 0.44, midZ);
    aura.railR.renderOrder = 29;
    aura.railR.visible = false;
    group.add(aura.railL, aura.railR);

    /* --- teto de energia: um veu por cima da pista, muito sutil ----------- */
    var canopyTex = null;
    try { canopyTex = M2.tex.clone('scratches', 3, 14); } catch (e) { canopyTex = null; }
    aura.canopyMat = new THREE.MeshBasicMaterial({
      map: canopyTex,
      color: C.spTint.clone().multiplyScalar(0.55),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false
    });
    aura.canopy = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2 + 1.2, depth), aura.canopyMat);
    aura.canopy.rotation.x = -Math.PI / 2;
    aura.canopy.position.set(0, SURFACE_Y + 2.55, midZ);
    aura.canopy.renderOrder = 29;
    aura.canopy.visible = false;
    group.add(aura.canopy);

    /* --- onda que varre do fundo para a frente --------------------------- */
    var waveRamp = null;
    try {
      waveRamp = M2.tex.gradientRamp(
        [0x000000, C.spEdge.getHex(), C.spCore.getHex(), C.spGlow.getHex(), 0x000000],
        { vertical: true, stops: [0, 0.28, 0.5, 0.72, 1], alpha: [0, 0.55, 1, 0.55, 0], srgb: true }
      );
    } catch (e) { waveRamp = tex('softGlow'); }
    aura.waveMat = new THREE.MeshBasicMaterial({
      map: waveRamp,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false
    });
    aura.wave = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2 + 3.4, 4.6), aura.waveMat);
    aura.wave.position.set(0, SURFACE_Y + 1.5, SPAWN_Z);
    aura.wave.renderOrder = 37;
    aura.wave.visible = false;
    group.add(aura.wave);

    /* --- escurecimento de raia no erro (a unica coisa que SUBTRAI luz) ---- */
    var dimAlpha = null;
    try {
      dimAlpha = M2.tex.gradientRamp([0xffffff, 0xffffff],
        { vertical: true, stops: [0, 1], alpha: [0.0, 1.0], srgb: false });
    } catch (e) { dimAlpha = null; }
    var dg = new THREE.PlaneGeometry(LANE_W * 0.94, 3.4);
    for (var i = 0; i < LANES; i++) {
      var mat = new THREE.MeshBasicMaterial({
        color: 0x080008,
        alphaMap: dimAlpha,
        transparent: true,
        opacity: 0,
        blending: THREE.NormalBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false
      });
      var m = new THREE.Mesh(dg, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(laneX(i), SURFACE_Y + crownY(laneX(i)) + 0.021, STRIKE_Z - 1.45);
      m.renderOrder = 30;
      m.visible = false;
      group.add(m);
      laneDim.push({ mesh: m, mat: mat });
    }
  }

  /* =========================================================================
     7. LUZES (contagem FIXA — nunca recompila shader em runtime)
     ========================================================================= */

  var lights = { hit: null, sp: null };

  function buildLights() {
    lights.hit = new THREE.PointLight(0xffffff, 0, 9.5, 2);
    lights.hit.position.set(0, 0.72, STRIKE_Z + 0.25);
    lights.hit.castShadow = false;
    lights.sp = new THREE.PointLight(C.spGlow.getHex(), 0, 22, 2);
    lights.sp.position.set(0, 2.1, STRIKE_Z - 6.5);
    lights.sp.castShadow = false;
    group.add(lights.hit, lights.sp);
  }

  /* =========================================================================
     8. EMISSORES — ACERTO
     ========================================================================= */

  /* Cores de rascunho: o loop quente NAO aloca nada.
     _mix e o retorno de mixC() — quem precisa segurar o valor por mais de uma
     linha copia para _f0/_f1/_f2 (ou clona, se for evento raro). */
  var _mix = null, _f0 = null, _f1 = null, _f2 = null;

  function mixC(a, b, t) {
    _mix.r = a.r + (b.r - a.r) * t;
    _mix.g = a.g + (b.g - a.g) * t;
    _mix.b = a.b + (b.b - a.b) * t;
    return _mix;
  }

  /* hit(lane, quality) — o coracao do jogo.
     PERFEITO: nucleo mais branco, anel DUPLO, flare anamorfico, mais faisca.
     BOM:      mesma linguagem, tudo mais macio e mais curto. */
  function hit(lane, quality) {
    if (!inited) return;
    lane = lane | 0;
    if (lane < 0 || lane > 4) lane = 2;
    var perfect = (quality === 'perfect');
    var sp = st.spAmt > 0.4;
    var x = laneX(lane);
    var lc = C.lane[lane], lg = C.laneGlow[lane], lr = C.laneRim[lane];
    /* no star power tudo vira prata/ciano — a raia so da o toque */
    var main = sp ? mixC(lg, C.spGlow, 0.72).clone() : lg;
    var p, i, n;

    /* --- 1. FLASH: o clarao redondo que o olho pega primeiro -------------- */
    p = spawn(bGlow);
    if (p) {
      p.x = x; p.y = FX_Y + 0.24; p.z = STRIKE_Z;
      p.bill = 0;
      p.sz0 = perfect ? 0.66 : 0.52;
      p.sz1 = perfect ? 1.32 : 1.02;
      p.asp = 1; p.szEase = 1;
      p.life = perfect ? 0.26 : 0.21;
      p.a0 = perfect ? 0.56 : 0.42;
      p.fin = 0.05; p.fout = 0.92;
      setCol(p, mixC(main, C.white, perfect ? 0.50 : 0.32).clone(), perfect ? 1.7 : 1.3, main, 0.5);
    }

    /* --- 2. NUCLEO branco estourado (e o que morde o bloom) --------------- */
    p = spawn(bGlow);
    if (p) {
      p.x = x; p.y = FX_Y + 0.20; p.z = STRIKE_Z + 0.02;
      p.bill = 0;
      p.sz0 = perfect ? 0.30 : 0.23;
      p.sz1 = perfect ? 0.55 : 0.41;
      p.life = perfect ? 0.15 : 0.12;
      p.a0 = 1; p.fin = 0.02; p.fout = 0.98;
      setCol(p, C.white, perfect ? 2.0 : 1.4, mixC(C.white, main, 0.6).clone(), 0.9);
    }

    /* --- 3. FLARE anamorfico (so no perfeito: e o premio) ----------------- */
    if (perfect) {
      p = spawn(bFlare);
      if (p) {
        p.x = x; p.y = FX_Y + 0.26; p.z = STRIKE_Z + 0.06;
        p.bill = 0;
        p.sz0 = 1.1; p.sz1 = 2.3; p.szEase = 1;
        p.life = 0.30; p.a0 = 0.62; p.fin = 0.03; p.fout = 0.95;
        setCol(p, mixC(C.white, main, 0.30).clone(), 1.8, main, 0.30);
      }
    }

    /* --- 4. ANEL DE CHOQUE deitado na pista ------------------------------- */
    p = spawn(bRing);
    if (p) {
      p.x = x; p.y = SURFACE_Y + 0.026; p.z = STRIKE_Z;
      p.bill = 2;
      p.sz0 = 0.44; p.sz1 = perfect ? 2.75 : 2.05; p.szEase = 1;
      p.life = perfect ? 0.40 : 0.32;
      p.a0 = perfect ? 1.0 : 0.72; p.fin = 0.02; p.fout = 0.88;
      setCol(p, mixC(main, C.white, 0.45).clone(), perfect ? 2.9 : 2.0, main, 0.4);
    }
    /* anel DUPLO do perfeito: um segundo, branco, mais rapido e mais fino */
    if (perfect) {
      p = spawn(bRing);
      if (p) {
        p.x = x; p.y = SURFACE_Y + 0.034; p.z = STRIKE_Z;
        p.bill = 2;
        p.sz0 = 0.28; p.sz1 = 1.55; p.szEase = 1;
        p.life = 0.22; p.a0 = 1; p.fin = 0.01; p.fout = 0.95;
        setCol(p, C.white, 3.6, mixC(C.white, main, 0.7).clone(), 0.9);
      }
    }

    /* --- 5. ESTOURO NO ARO: aro fino, rapidissimo, colado no fret --------- */
    p = spawn(bRing);
    if (p) {
      p.x = x; p.y = SURFACE_Y + 0.048; p.z = STRIKE_Z;
      p.bill = 2;
      p.sz0 = 0.30; p.sz1 = 0.92; p.szEase = 1;
      p.life = 0.17; p.a0 = 1; p.fin = 0.0; p.fout = 0.9;
      setCol(p, C.white, 3.2, main, 1.4);
    }

    /* --- 6. BRILHO VERTICAL NA RAIA (a coluna de luz) --------------------- */
    p = spawn(bGlow);
    if (p) {
      p.x = x; p.z = STRIKE_Z; p.baseY = SURFACE_Y - 0.15; p.anchor = 1;
      p.bill = 1;
      p.sz0 = perfect ? 0.68 : 0.54; p.sz1 = perfect ? 0.36 : 0.28;
      p.asp = perfect ? 2.5 : 2.1; p.szEase = 1;
      p.life = perfect ? 0.34 : 0.26;
      p.a0 = perfect ? 0.74 : 0.52; p.fin = 0.04; p.fout = 0.90;
      setCol(p, mixC(main, C.white, 0.35).clone(), 1.9, main, 0.4);
    }
    /* nucleo fino da coluna */
    p = spawn(bGlow);
    if (p) {
      p.x = x; p.z = STRIKE_Z + 0.01; p.baseY = SURFACE_Y - 0.1; p.anchor = 1;
      p.bill = 1;
      p.sz0 = 0.24; p.sz1 = 0.09; p.asp = perfect ? 6.0 : 4.6; p.szEase = 1;
      p.life = perfect ? 0.25 : 0.19;
      p.a0 = 0.88; p.fin = 0.02; p.fout = 0.95;
      setCol(p, C.white, perfect ? 2.2 : 1.5, main, 0.5);
    }

    /* --- 7. FAISCAS alongadas com gravidade, arrasto e ricochete ---------- */
    n = Math.round((perfect ? 23 : 14) * qScale);
    if (sp) n = Math.round(n * 1.15);
    for (i = 0; i < n; i++) {
      p = spawn(bTrail);
      if (!p) break;
      var ang = rrange(0, TAU);
      var spread = rrange(0.25, 1.0);
      var speed = rrange(2.6, perfect ? 7.6 : 5.8);
      p.x = x + mCos(ang) * 0.05;
      p.y = FX_Y + 0.10;
      p.z = STRIKE_Z + mSin(ang) * 0.05;
      p.vx = mCos(ang) * speed * spread;
      p.vy = rrange(1.9, perfect ? 6.4 : 4.9);
      p.vz = mSin(ang) * speed * spread * 0.55 + rrange(0.2, 2.4);
      p.gy = -11.5;
      p.drag = rrange(1.9, 3.2);
      p.life = rrange(0.34, perfect ? 0.78 : 0.60);
      p.sz0 = rrange(0.15, 0.27); p.sz1 = p.sz0 * 0.35; p.szEase = 0;
      p.asp = 0.20; p.stretch = 0.055;
      p.align = 1;
      p.a0 = 1; p.fin = 0.0; p.fout = 0.55;
      p.bounce = 0.42; p.floorY = SURFACE_Y + 0.02;
      setCol(p, mixC(C.white, main, rrange(0.05, 0.45)).clone(), perfect ? 3.0 : 2.2,
                mixC(main, C.danger, 0.15).clone(), 0.30);
    }

    /* --- 8. CINTILANCIA: estrelinhas de 4 pontas que giram --------------- */
    n = Math.round((perfect ? 10 : 6) * qScale);
    for (i = 0; i < n; i++) {
      p = spawn(bSpark);
      if (!p) break;
      var a2 = rrange(0, TAU);
      p.x = x + mCos(a2) * rrange(0.03, 0.30);
      p.y = FX_Y + rrange(0.05, 0.55);
      p.z = STRIKE_Z + rrange(-0.16, 0.32);
      p.vx = mCos(a2) * rrange(0.6, 2.6);
      p.vy = rrange(0.8, 3.4);
      p.vz = rrange(0.1, 1.6);
      p.gy = -5.4; p.drag = 2.6;
      p.life = rrange(0.28, 0.58);
      p.sz0 = rrange(0.17, 0.36); p.sz1 = 0.02; p.szEase = 1;
      p.rot = rrange(0, TAU); p.rotV = rsign() * rrange(1.5, 5.5);
      p.a0 = 1; p.fin = 0.05; p.fout = 0.7;
      setCol(p, mixC(C.white, main, 0.25).clone(), perfect ? 3.4 : 2.4, main, 0.5);
    }

    /* --- 9. LUZ REAL: a pista recebe a cor da raia por um instante -------- */
    lights.hit.color.copy(main);
    /* 17 candelas a 0,7 m da pista viravam um disco branco-laranja de meia
     * tela que engolia as cinco gems. Metade disso ainda pinta a madeira com
     * a cor da raia — que e o efeito que se quer — sem apagar a nota. */
    st.hitLightE = mMax(st.hitLightE, perfect ? 8 : 5.5);
    lights.hit.position.x = damp(lights.hit.position.x, x, 30, 1 / 60);

    /* --- 10. tela ---------------------------------------------------------- */
    st.strikeGlow = mMin(1.6, st.strikeGlow + (perfect ? 0.55 : 0.34));
    st.flameKick[lane] = 1;
    st.laneAfter[lane] = 1;
    st.laneAfterQ[lane] = perfect ? 1 : 0;
    eng('bloomPulse', perfect ? 0.075 : 0.040, 5.4);
  }

  /* Rastro luminoso do acerto: a raia continua "quente" por meio segundo.
     E o que faz QUALQUER quadro do jogo parecer vivo, e nao um frame morto
     entre duas notas. */
  function updateLaneAfterglow(dt) {
    for (var i = 0; i < LANES; i++) {
      if (st.laneAfter[i] <= 0.004) { st.laneAfter[i] = 0; continue; }
      st.laneAfter[i] = damp(st.laneAfter[i], 0, 4.6, dt);
      var a = st.laneAfter[i];
      var x = laneX(i);
      var perfect = st.laneAfterQ[i] === 1;
      var base = st.spAmt > 0.4 ? _f2.copy(mixC(C.laneGlow[i], C.spGlow, 0.65)) : C.laneGlow[i];

      /* poca de luz no aro */
      var p = spawn(bGlow);
      if (p) {
        p.x = x; p.y = SURFACE_Y + crownY(x) + 0.026; p.z = STRIKE_Z;
        p.bill = 2;
        /* poca CONTIDA: com 1,4 unidade de largura (o dobro da raia) e alfa
         * 0,42, cinco raias acesas viravam um unico ovalo laranja de meia
         * tela por cima dos aros. Aqui ela fica do tamanho da raia. */
        p.sz0 = (0.60 + 0.34 * a) * (perfect ? 1.10 : 1);
        p.sz1 = p.sz0; p.szEase = 0;
        p.life = 0.055; p.a0 = 0.26 * a; p.fin = 0.2; p.fout = 0.8;
        setCol(p, mixC(C.white, base, 0.62), 1.5 + 0.5 * a, base, 0.8);
      }
      /* halo vertical macio: da volume ao aro sem tapar a nota que vem */
      p = spawn(bGlow);
      if (p) {
        p.x = x; p.z = STRIKE_Z; p.baseY = SURFACE_Y - 0.10; p.anchor = 1;
        p.bill = 1;
        p.sz0 = 0.46 + 0.20 * a; p.sz1 = p.sz0; p.asp = 1.5 + 0.9 * a; p.szEase = 0;
        p.life = 0.055; p.a0 = 0.30 * a; p.fin = 0.2; p.fout = 0.8;
        setCol(p, base, 1.5, base, 1.1);
      }
    }
  }

  /* =========================================================================
     9. EMISSORES — ERRO
     ========================================================================= */

  function miss(lane) {
    if (!inited) return;
    var all = (lane == null || lane < 0 || lane > 4);
    var lanes = all ? [0, 1, 2, 3, 4] : [lane | 0];
    var i, j, p;

    for (j = 0; j < lanes.length; j++) {
      var ln = lanes[j];
      var x = laneX(ln);
      var w = all ? 0.55 : 1.0;      /* erro geral: cada raia recebe menos */

      /* --- flash vermelho curto e seco --- */
      p = spawn(bGlow);
      if (p) {
        p.x = x; p.y = FX_Y + 0.18; p.z = STRIKE_Z;
        p.bill = 0;
        p.sz0 = 0.75 * (all ? 0.8 : 1); p.sz1 = 1.6 * (all ? 0.8 : 1); p.szEase = 1;
        p.life = 0.20; p.a0 = 0.95 * w; p.fin = 0.02; p.fout = 0.9;
        setCol(p, C.danger, 3.0, C.danger, 0.4);
      }

      /* --- anel que IMPLODE: leitura instantanea de "deu errado" --- */
      p = spawn(bRing);
      if (p) {
        p.x = x; p.y = SURFACE_Y + 0.028; p.z = STRIKE_Z;
        p.bill = 2;
        p.sz0 = 1.7; p.sz1 = 0.25; p.szEase = 1;
        p.life = 0.26; p.a0 = 0.85 * w; p.fin = 0.05; p.fout = 0.75;
        setCol(p, C.danger, 2.4, C.danger, 0.6);
      }

      /* --- fumaca ESCURA (blend normal: escurece de verdade) --- */
      var nSmoke = Math.round((all ? 1 : 3) * qScale) + 1;
      for (i = 0; i < nSmoke; i++) {
        p = spawn(bDark);
        if (!p) break;
        p.x = x + rrange(-0.16, 0.16);
        p.y = FX_Y + rrange(0.05, 0.25);
        p.z = STRIKE_Z + rrange(-0.20, 0.25);
        p.vx = rrange(-0.5, 0.5); p.vy = rrange(0.55, 1.35); p.vz = rrange(-0.1, 0.45);
        p.drag = 1.1; p.turb = 0.9; p.turbF = 1.7;
        p.life = rrange(0.75, 1.35);
        p.sz0 = rrange(0.42, 0.70); p.sz1 = rrange(1.5, 2.4); p.szEase = 1;
        p.rot = rrange(0, TAU); p.rotV = rsign() * rrange(0.25, 0.9);
        p.a0 = rrange(0.30, 0.52) * w; p.fin = 0.16; p.fout = 0.70;
        /* fumaca com blend normal: a "cor" e o quanto ela ainda deixa passar */
        p.r0 = 0.030; p.g0 = 0.014; p.b0 = 0.030;
        p.r1 = 0.010; p.g1 = 0.005; p.b1 = 0.012;
      }

      /* --- faiscas mortas caindo (sem vida, sem brilho) --- */
      var nSp = Math.round((all ? 3 : 7) * qScale);
      for (i = 0; i < nSp; i++) {
        p = spawn(bTrail);
        if (!p) break;
        var ang = rrange(0, TAU);
        p.x = x; p.y = FX_Y + 0.08; p.z = STRIKE_Z;
        p.vx = mCos(ang) * rrange(0.6, 2.4);
        p.vy = rrange(0.5, 2.2);
        p.vz = mSin(ang) * rrange(0.3, 1.2) + rrange(0, 0.8);
        p.gy = -13; p.drag = 2.2;
        p.life = rrange(0.30, 0.55);
        p.sz0 = rrange(0.10, 0.17); p.sz1 = p.sz0 * 0.3; p.szEase = 0;
        p.asp = 0.20; p.stretch = 0.048; p.align = 1;
        p.a0 = 0.85 * w; p.fout = 0.6;
        setCol(p, C.danger, 1.6, C.danger, 0.12);
      }

      /* --- a raia escurece por um instante e perde o rastro quente --- */
      st.dimAmt[ln] = mMax(st.dimAmt[ln], all ? 0.42 : 0.62);
      st.laneAfter[ln] = 0;
    }

    /* --- tremor pequeno e seco (o game ja da o flash vermelho) --- */
    eng('shake', all ? 0.10 : 0.15, 0.16);
    st.strikeGlow *= 0.35;
  }

  /* =========================================================================
     10. EMISSORES — NOTA ABERTA
     ========================================================================= */

  function openHit() {
    if (!inited) return;
    var p, i;
    var col = C.accent;
    var sp = st.spAmt > 0.4;
    var main = sp ? mixC(col, C.spGlow, 0.8).clone() : col.clone();

    /* --- barra larga atravessando as 5 raias --- */
    p = spawn(bGlow);
    if (p) {
      p.x = 0; p.z = STRIKE_Z; p.baseY = SURFACE_Y - 0.35; p.anchor = 1;
      p.bill = 1;
      p.sz0 = HALF_W * 2 + 0.5; p.sz1 = HALF_W * 2 + 1.6;
      p.asp = 0.22; p.szEase = 1;
      p.life = 0.42; p.a0 = 1; p.fin = 0.03; p.fout = 0.85;
      setCol(p, mixC(C.white, main, 0.35).clone(), 3.0, main, 0.6);
    }
    /* --- nucleo fino da barra --- */
    p = spawn(bGlow);
    if (p) {
      p.x = 0; p.z = STRIKE_Z + 0.02; p.baseY = SURFACE_Y - 0.05; p.anchor = 1;
      p.bill = 1;
      p.sz0 = HALF_W * 2 + 0.2; p.sz1 = HALF_W * 2 + 0.9;
      p.asp = 0.075; p.szEase = 1;
      p.life = 0.30; p.a0 = 1; p.fin = 0.01; p.fout = 0.9;
      setCol(p, C.white, 4.2, main, 1.0);
    }

    /* --- onda deitada cobrindo a pista inteira --- */
    p = spawn(bRing);
    if (p) {
      p.x = 0; p.y = SURFACE_Y + 0.030; p.z = STRIKE_Z;
      p.bill = 2;
      p.sz0 = 1.0; p.sz1 = 8.6; p.szEase = 1;
      p.life = 0.55; p.a0 = 0.95; p.fin = 0.02; p.fout = 0.8;
      setCol(p, mixC(main, C.white, 0.45).clone(), 2.6, main, 0.35);
    }
    p = spawn(bRing);
    if (p) {
      p.x = 0; p.y = SURFACE_Y + 0.040; p.z = STRIKE_Z;
      p.bill = 2;
      p.sz0 = 0.6; p.sz1 = 4.6; p.szEase = 1;
      p.life = 0.32; p.a0 = 1; p.fin = 0.0; p.fout = 0.9;
      setCol(p, C.white, 3.2, main, 0.8);
    }

    /* --- duas frentes de luz correndo para fora --- */
    for (i = 0; i < 2; i++) {
      p = spawn(bGlow);
      if (!p) break;
      var dir = i === 0 ? -1 : 1;
      p.x = 0; p.z = STRIKE_Z; p.baseY = SURFACE_Y - 0.2; p.anchor = 1;
      p.vx = dir * 8.4; p.drag = 1.6;
      p.bill = 1;
      p.sz0 = 0.55; p.sz1 = 0.9; p.asp = 3.2; p.szEase = 1;
      p.life = 0.46; p.a0 = 0.85; p.fin = 0.02; p.fout = 0.7;
      setCol(p, mixC(C.white, main, 0.3).clone(), 2.6, main, 0.4);
    }

    /* --- flare central --- */
    p = spawn(bFlare);
    if (p) {
      p.x = 0; p.y = FX_Y + 0.30; p.z = STRIKE_Z + 0.06;
      p.bill = 0;
      p.sz0 = 2.0; p.sz1 = 4.6; p.szEase = 1;
      p.life = 0.38; p.a0 = 1; p.fin = 0.02; p.fout = 0.9;
      setCol(p, mixC(C.white, main, 0.25).clone(), 2.8, main, 0.4);
    }

    /* --- faiscas ao longo de TODA a linha de acerto --- */
    var n = Math.round(46 * qScale);
    for (i = 0; i < n; i++) {
      p = spawn(bTrail);
      if (!p) break;
      var fx = rrange(-HALF_W - 0.2, HALF_W + 0.2);
      p.x = fx; p.y = FX_Y + 0.06; p.z = STRIKE_Z;
      p.vx = (fx / HALF_W) * rrange(0.5, 3.2);
      p.vy = rrange(2.2, 6.6);
      p.vz = rrange(-0.4, 2.6);
      p.gy = -11.5; p.drag = 2.4;
      p.life = rrange(0.35, 0.75);
      p.sz0 = rrange(0.14, 0.25); p.sz1 = p.sz0 * 0.3; p.szEase = 0;
      p.asp = 0.20; p.stretch = 0.055; p.align = 1;
      p.a0 = 1; p.fout = 0.55;
      p.bounce = 0.4; p.floorY = SURFACE_Y + 0.02;
      setCol(p, mixC(C.white, main, rrange(0, 0.5)).clone(), 2.8, main, 0.25);
    }

    st.strikeGlow = mMin(2.0, st.strikeGlow + 0.9);
    st.hitLightE = mMax(st.hitLightE, 15);
    lights.hit.color.copy(main);
    lights.hit.position.x = 0;
    eng('shake', 0.26, 0.30);
    eng('flash', '#' + main.getHexString(), 0.16, 0.22);
    eng('bloomPulse', 0.40, 3.0);
    for (i = 0; i < LANES; i++) st.flameKick[i] = 1;
  }

  /* =========================================================================
     11. CHAMAS DE COMBO — o efeito mais iconico do genero
     ========================================================================= */

  /* Perfil por nivel de combo. tint=1 transforma o atlas de fogo numa mascara
     e a cor passa a ser 100% nossa (e assim que a chama fica azul-branca no 4x
     e prateada/ciano no star power). */
  function flameProfile() {
    var sp = st.spAmt;
    var lv = clamp(st.levelSmooth, 1, 4);
    var prof = {
      w: 0, h: 0, rate: 0, tint: 0, mul: 1, ember: 0,
      c0: C.white, c1: C.white, k0: 1, k1: 1
    };

    /* Interpolacao continua entre os quatro degraus classicos.
       w/h sao a LARGURA e a ALTURA da lingua de fogo em unidades de mundo —
       referencia: a raia tem 0.72 de largura, entao uma chama de 0.40 x 1.05
       ja e do tamanho da raia e meia. Passar disso vira sopa de luz e come as
       notas: a legibilidade manda (secao 9.7 do contrato). */
    var t;
    if (lv < 2) {
      /* 1x nao acende (o Game so liga as chamas a partir de 2x) */
      prof.w = 0.30; prof.h = 0.50; prof.rate = 12; prof.tint = 0.05;
      prof.c0 = _f0.copy(C.gold); prof.k0 = 1.05; prof.c1 = _f1.copy(C.danger); prof.k1 = 0.22;
      prof.ember = 4;
    } else if (lv < 3) {
      t = lv - 2;                                   /* 2x -> 3x: amarela */
      prof.w = 0.38 + 0.05 * t; prof.h = 0.80 + 0.30 * t;
      prof.rate = 20 + 3 * t;
      prof.tint = 0.06 + 0.10 * t;
      prof.c0 = _f0.copy(mixC(C.gold, C.accent, t)); prof.k0 = 1.15 + 0.12 * t;
      prof.c1 = _f1.copy(C.danger); prof.k1 = 0.20;
      prof.ember = 7 + 4 * t;
    } else if (lv < 4) {
      t = lv - 3;                                   /* 3x -> 4x: laranja -> azul */
      prof.w = 0.43 + 0.07 * t; prof.h = 1.10 + 0.42 * t;
      prof.rate = 23 + 5 * t;
      prof.tint = 0.16 + 0.70 * t;
      prof.c0 = _f0.copy(mixC(C.accent, C.spCore, t)); prof.k0 = 1.27 + 0.28 * t;
      prof.c1 = _f1.copy(mixC(C.danger, C.spEdge, t)); prof.k1 = 0.20 + 0.30 * t;
      prof.ember = 11 + 6 * t;
    } else {
      /* 4x cheio: azul-branca */
      prof.w = 0.45; prof.h = 1.52; prof.rate = 28; prof.tint = 0.86;
      prof.c0 = _f0.copy(mixC(C.spCore, C.spGlow, 0.55)); prof.k0 = 1.22;
      prof.c1 = _f1.copy(C.spEdge); prof.k1 = 0.50;
      prof.ember = 17;
    }

    /* Star power: ciano/prateada, maior e mais rapida — o 8x do contrato.
       ATENCAO ao ganho: acima de ~1.0 de luminancia o ACES + a curva S do
       grade lavam a cor e a chama vira uma mancha BRANCA (medido: com k0 1.9
       o azul (1.17/1.59/1.88) chegava na tela como branco-amarelado). Aqui a
       regra e: a lingua fica logo abaixo do estouro e SO o nucleo estoura. */
    if (sp > 0.02) {
      prof.w = prof.w * (1 + 0.10 * sp);
      prof.h = prof.h * (1 + 0.34 * sp);
      prof.rate = prof.rate * (1 + 0.28 * sp);
      prof.tint = prof.tint + (1 - prof.tint) * sp;
      prof.c0 = _f0.copy(mixC(prof.c0, mixC(C.spGlow, C.spCore, 0.22), sp));
      prof.k0 = prof.k0 * (1 - 0.22 * sp);
      prof.c1 = _f1.copy(mixC(prof.c1, C.spGlow, sp)); prof.k1 = prof.k1 * (1 + 1.1 * sp);
      prof.ember = prof.ember * (1 + 0.7 * sp);
    }
    return prof;
  }

  /* flames(lane, on) — liga/desliga a coluna de fogo de um traste. */
  function flames(lane, on) {
    if (!inited) return;
    lane = lane | 0;
    if (lane < 0 || lane > 4) return;
    var was = st.flameOn[lane];
    st.flameOn[lane] = !!on;
    /* ao acender, um estouro imediato: a chama nasce com forca, nao "aparece" */
    if (on && !was) {
      st.flameKick[lane] = 1.4;
      st.flameAmt[lane] = mMax(st.flameAmt[lane], 0.28);
      burstFlame(lane, 1.0);
    }
  }

  /* Baforada instantanea de fogo (usada ao acender e nos beats fortes). */
  function burstFlame(lane, k) {
    var prof = flameProfile();
    var x = laneX(lane);
    var n = Math.round(5 * k * qScale) + 2;
    for (var i = 0; i < n; i++) {
      var p = spawn(bFlame);
      if (!p) break;
      setupFlameParticle(p, x, prof, k * 1.25);
    }
  }

  function setupFlameParticle(p, x, prof, boost) {
    var s = rrange(0.80, 1.10) * (0.85 + 0.15 * clamp01(boost));
    p.x = x + rrange(-0.055, 0.055);
    p.z = STRIKE_Z + rrange(-0.07, 0.07);
    /* a base afunda um dedo abaixo do conves: o quadro do atlas tem uma faixa
       quentissima colada no chao que, somada em 8-10 linguas, virava uma barra
       branca atravessando a linha de acerto. Afundando, o teste de
       profundidade do proprio conves corta essa faixa de graca. */
    p.baseY = SURFACE_Y + crownY(x) - 0.085;
    p.anchor = 1;
    p.bill = 1;
    p.sz0 = prof.w * s;
    p.sz1 = prof.w * s * 0.42;
    p.asp = (prof.h / prof.w) * rrange(0.88, 1.16);
    p.szEase = 1;
    p.vy = rrange(0.35, 0.95) * (0.7 + prof.h * 0.55);
    p.vx = rrange(-0.22, 0.22);
    p.vz = rrange(-0.10, 0.10);
    p.drag = 1.45;
    p.turb = 0.9; p.turbF = 5.5;
    p.life = rrange(0.30, 0.48);
    /* alfa baixo de proposito: a coluna e a SOMA de varias linguas, e o que
       tem que estourar e so o nucleo — nao a raia inteira */
    p.a0 = rrange(0.21, 0.33);
    p.fin = 0.20; p.fout = 0.66;
    p.tint = prof.tint;
    p.frames = 8;
    p.fps = rrange(15, 26);
    p.frame0 = (rnd() * 8) | 0;
    p.frameLoop = 1;
    setCol(p, prof.c0, prof.k0 * rrange(0.85, 1.15), prof.c1, prof.k1);
  }

  function updateFlames(dt) {
    var prof = flameProfile();
    var i, p;
    var anyOn = false;

    for (i = 0; i < LANES; i++) {
      /* No star power TODOS os trastes queimam, como no Guitar Hero — o traste
         recem-acertado so queima mais forte. Sem esse piso a pista fica com
         chama piscando de forma aleatoria durante o SP. */
      var floorAmt = st.spAmt > 0.30 ? 0.58 * st.spAmt : 0;
      var target = st.flameOn[i] ? 1 : floorAmt;
      st.flameAmt[i] = damp(st.flameAmt[i], target, target > st.flameAmt[i] ? 11 : 7, dt);
      if (st.flameKick[i] > 0) st.flameKick[i] = mMax(0, st.flameKick[i] - dt * 3.6);
      var amt = st.flameAmt[i];
      if (amt < 0.03) { st.flameAcc[i] = 0; st.flameEmber[i] = 0; continue; }
      anyOn = true;
      var x = laneX(i);
      var kick = 1 + st.flameKick[i] * 0.85;
      /* respiracao no beat: a chama "puxa" junto com a musica */
      var breathe = 1 + 0.16 * mSin(st.beatPhase * TAU) * amt;

      /* --- linguas de fogo --- */
      st.flameAcc[i] += prof.rate * amt * kick * breathe * qScale * dt;
      var n = st.flameAcc[i] | 0;
      st.flameAcc[i] -= n;
      if (n > 8) n = 8;
      for (var j = 0; j < n; j++) {
        p = spawn(bFlame);
        if (!p) break;
        setupFlameParticle(p, x, prof, amt * kick * breathe);
      }

      /* --- brasas subindo (o que da leitura de calor de verdade) --- */
      st.flameEmber[i] += prof.ember * amt * qScale * dt;
      var ne = st.flameEmber[i] | 0;
      st.flameEmber[i] -= ne;
      if (ne > 4) ne = 4;
      for (j = 0; j < ne; j++) {
        p = spawn(bSpark);
        if (!p) break;
        p.x = x + rrange(-0.16, 0.16);
        p.y = SURFACE_Y + rrange(0.05, 0.30);
        p.z = STRIKE_Z + rrange(-0.10, 0.10);
        p.vx = rrange(-0.5, 0.5);
        p.vy = rrange(1.6, 3.8) * (0.65 + prof.h * 0.30);
        p.vz = rrange(-0.25, 0.35);
        p.drag = 0.85; p.turb = 1.9; p.turbF = 3.1;
        p.life = rrange(0.45, 1.05);
        p.sz0 = rrange(0.09, 0.21); p.sz1 = 0.01; p.szEase = 1;
        p.rot = rrange(0, TAU); p.rotV = rsign() * rrange(0.6, 2.6);
        p.a0 = rrange(0.5, 0.85); p.fin = 0.06; p.fout = 0.72;
        setCol(p, prof.c0, prof.k0 * 1.15, prof.c1, prof.k1 * 0.6);
      }

      /* --- NUCLEO da chama: pequeno, quente e estourado. E ele que faz o
             fogo parecer fogo em vez de uma mancha colorida — o bloom morde
             so aqui, e a lingua fica com o degrade certo em volta. --- */
      p = spawn(bGlow);
      if (p) {
        p.x = x + rrange(-0.03, 0.03);
        p.z = STRIKE_Z; p.baseY = SURFACE_Y - 0.02; p.anchor = 1;
        p.bill = 1;
        p.sz0 = prof.w * 0.52 * amt * rrange(0.88, 1.12);
        p.sz1 = p.sz0 * 0.75; p.asp = 1.9 + 0.5 * mSin(elapsed * 17 + i);
        p.szEase = 1;
        p.life = 0.10; p.a0 = 0.23 * amt * kick; p.fin = 0.22; p.fout = 0.78;
        setCol(p, prof.c0, prof.k0 * 1.10, prof.c0, prof.k0 * 0.7);
      }

      /* --- brilho quente no chao, sob a chama --- */
      if ((elapsed * 60 | 0) % 2 === 0) {
        p = spawn(bGlow);
        if (p) {
          p.x = x; p.y = SURFACE_Y + crownY(x) + 0.030; p.z = STRIKE_Z;
          p.bill = 2;
          p.sz0 = prof.w * 1.55 * amt * rrange(0.9, 1.1);
          p.sz1 = p.sz0 * 1.12; p.szEase = 0;
          p.life = 0.09; p.a0 = 0.13 * amt; p.fin = 0.2; p.fout = 0.8;
          setCol(p, prof.c0, prof.k0 * 0.48, prof.c1, prof.k1 * 0.3);
        }
      }
    }

    /* halo quente somado na luz de acerto enquanto o combo queima */
    if (anyOn) st.hitLightE = mMax(st.hitLightE, 5.5 * clamp01(prof.h * 0.5));
  }

  /* =========================================================================
     12. STAR POWER — que o print seja espetacular
     ========================================================================= */

  function starPower(on) {
    if (!inited) return;
    on = !!on;
    if (on === st.spOn) return;
    st.spOn = on;
    st.spSince = 0;

    if (on) {
      /* --- onda de energia varrendo do fundo para a frente --- */
      st.waveT = 0;
      st.waveDir = 1;
      aura.wave.visible = true;

      /* --- estouro na linha de acerto --- */
      var i, p;
      var nRing = 3;
      for (i = 0; i < nRing; i++) {
        p = spawn(bRing);
        if (!p) break;
        p.x = 0; p.y = SURFACE_Y + 0.032 + i * 0.006; p.z = STRIKE_Z;
        p.bill = 2;
        p.sz0 = 0.8 + i * 0.6; p.sz1 = 7.5 + i * 3.2; p.szEase = 1;
        p.life = 0.55 + i * 0.18; p.a0 = 1 - i * 0.22; p.fin = 0.02; p.fout = 0.8;
        setCol(p, i === 0 ? C.spCore : C.spGlow, 3.0 - i * 0.6, C.spEdge, 0.5);
      }

      p = spawn(bFlare);
      if (p) {
        p.x = 0; p.y = FX_Y + 0.55; p.z = STRIKE_Z + 0.1;
        p.bill = 0; p.sz0 = 1.8; p.sz1 = 4.6; p.szEase = 1;
        p.life = 0.75; p.a0 = 1; p.fin = 0.02; p.fout = 0.9;
        setCol(p, C.spCore, 3.2, C.spGlow, 0.5);
      }

      /* --- explosao de faiscas prateadas ---
         Amortizada (ver emitBurst): mesma quantidade, espalhada por 4 frames.
         Era o maior jorro de frame unico do jogo inteiro. */
      emitBurst(90 * qScale, function () {
        var p2 = spawn(bTrail);
        if (!p2) return false;
        var ang = rrange(0, TAU);
        var sp2 = rrange(3.0, 12.5);
        p2.x = rrange(-HALF_W, HALF_W) * 0.55;
        p2.y = FX_Y + rrange(0.02, 0.3);
        p2.z = STRIKE_Z + rrange(-0.4, 0.4);
        p2.vx = mCos(ang) * sp2;
        p2.vy = mAbs(mSin(ang)) * sp2 * 0.8 + rrange(1.5, 5);
        p2.vz = rrange(-1.5, 4.5);
        p2.gy = -8.5; p2.drag = 1.8;
        p2.life = rrange(0.5, 1.3);
        p2.sz0 = rrange(0.15, 0.28); p2.sz1 = p2.sz0 * 0.25; p2.szEase = 0;
        p2.asp = 0.20; p2.stretch = 0.052; p2.align = 1;
        p2.a0 = 1; p2.fout = 0.6;
        setCol(p2, C.spCore, 3.2, C.spGlow, 0.4);
        return true;
      });

      /* --- coluna central de energia --- */
      p = spawn(bGlow);
      if (p) {
        p.x = 0; p.z = STRIKE_Z; p.baseY = SURFACE_Y - 0.4; p.anchor = 1;
        p.bill = 1;
        p.sz0 = 2.4; p.sz1 = 4.6; p.asp = 2.4; p.szEase = 1;
        p.life = 0.9; p.a0 = 0.9; p.fin = 0.04; p.fout = 0.85;
        setCol(p, C.spCore, 2.6, C.spGlow, 0.35);
      }

      aura.floor.visible = true;
      aura.railL.visible = true;
      aura.railR.visible = true;
      aura.canopy.visible = true;
      eng('bloomPulse', 0.55, 1.9);
    } else {
      /* --- dissipacao: a energia se solta e sobe --- */
      emitBurst(70 * qScale, function () {
        var q = spawn(bSpark);
        if (!q) return false;
        q.x = rrange(-HALF_W - 0.4, HALF_W + 0.4);
        q.y = SURFACE_Y + rrange(0.05, 2.2);
        q.z = rrange(-16, 3);
        q.vx = q.x * rrange(0.25, 0.9);
        q.vy = rrange(1.2, 4.2);
        q.vz = rrange(-0.5, 2.5);
        q.drag = 1.1; q.turb = 1.4;
        q.life = rrange(0.7, 1.6);
        q.sz0 = rrange(0.10, 0.24); q.sz1 = 0.01; q.szEase = 1;
        q.rot = rrange(0, TAU); q.rotV = rsign() * rrange(1, 4);
        q.a0 = 0.9; q.fin = 0.04; q.fout = 0.7;
        setCol(q, C.spCore, 2.4, C.spEdge, 0.2);
        return true;
      });
      st.waveT = -1;
      aura.wave.visible = false;
      eng('bloomPulse', 0.28, 2.4);
    }
  }

  function updateStarPower(dt) {
    st.spSince += dt;
    st.spAmt = damp(st.spAmt, st.spOn ? 1 : 0, st.spOn ? 4.2 : 2.6, dt);
    var a = st.spAmt;

    /* --- onda de varredura --- */
    if (st.waveT >= 0) {
      st.waveT += dt / 0.78;
      if (st.waveT >= 1) {
        st.waveT = -1;
        aura.wave.visible = false;
      } else {
        var wt = st.waveT;
        var z = SPAWN_Z * (1 - easeOutQuint(wt)) + 9.5 * easeOutQuint(wt);
        aura.wave.position.z = z;
        aura.wave.position.y = SURFACE_Y + 1.5;
        var sc = 0.6 + 1.1 * easeOutCubic(wt);
        aura.wave.scale.set(1, sc, 1);
        aura.waveMat.opacity = (wt < 0.12 ? wt / 0.12 : 1) * (1 - wt * wt) * 0.95;
        /* rastro da onda: faiscas nascendo onde ela passa */
        if (wt < 0.85) {
          var n = Math.round(9 * qScale);
          for (var i = 0; i < n; i++) {
            var p = spawn(bTrail);
            if (!p) break;
            p.x = rrange(-HALF_W - 0.3, HALF_W + 0.3);
            p.y = SURFACE_Y + rrange(0.03, 1.9);
            p.z = z + rrange(-0.6, 0.6);
            p.vx = rrange(-1.2, 1.2);
            p.vy = rrange(0.6, 3.4);
            p.vz = rrange(3.5, 11);
            p.drag = 1.4;
            p.life = rrange(0.30, 0.62);
            p.sz0 = rrange(0.14, 0.26); p.sz1 = p.sz0 * 0.3; p.szEase = 0;
            p.asp = 0.20; p.stretch = 0.046; p.align = 1;
            p.a0 = 1; p.fout = 0.6;
            setCol(p, C.spCore, 3.0, C.spGlow, 0.4);
          }
        }
      }
    }

    if (a < 0.004) {
      if (aura.floor.visible) {
        aura.floor.visible = false;
        aura.railL.visible = false;
        aura.railR.visible = false;
        aura.canopy.visible = false;
      }
      lights.sp.intensity = damp(lights.sp.intensity, 0, 5, dt);
      return;
    }

    aura.floor.visible = true;
    aura.railL.visible = true;
    aura.railR.visible = true;
    aura.canopy.visible = true;

    /* --- pulsacao da aura no compasso --- */
    var puls = 0.72 + 0.28 * mSin(st.beatPhase * TAU * 2);
    aura.floorMat.opacity = 0.50 * a * puls;
    aura.railMat.opacity = 0.60 * a * (0.78 + 0.22 * puls);
    aura.canopyMat.opacity = 0.055 * a * puls;

    /* --- correnteza: as texturas correm com a pista --- */
    if (aura.floorMat.map) {
      aura.floorMat.map.offset.y = (aura.floorMat.map.offset.y - dt * 0.65) % 1;
    }
    if (aura.canopyMat.map) {
      aura.canopyMat.map.offset.y = (aura.canopyMat.map.offset.y - dt * 0.34) % 1;
      aura.canopyMat.map.offset.x = (aura.canopyMat.map.offset.x + dt * 0.05) % 1;
    }

    /* --- particulas subindo continuamente por toda a pista --- */
    st.spEmitAcc += 46 * a * qScale * dt;
    var ne = st.spEmitAcc | 0;
    st.spEmitAcc -= ne;
    if (ne > 8) ne = 8;
    for (var j = 0; j < ne; j++) {
      var q = spawn(bSpark);
      if (!q) break;
      q.x = rrange(-HALF_W - 0.15, HALF_W + 0.15);
      q.y = SURFACE_Y + rrange(0.0, 0.35);
      q.z = rrange(-22, 4);
      q.vx = rrange(-0.35, 0.35);
      q.vy = rrange(1.0, 3.0);
      q.vz = rrange(0.2, 1.6);
      q.drag = 0.55; q.turb = 0.9; q.turbF = 2.1;
      q.life = rrange(1.0, 2.3);
      q.sz0 = rrange(0.10, 0.26); q.sz1 = 0.01; q.szEase = 1;
      q.rot = rrange(0, TAU); q.rotV = rsign() * rrange(0.5, 2.4);
      q.a0 = rrange(0.38, 0.80) * a; q.fin = 0.12; q.fout = 0.65;
      setCol(q, C.spCore, 2.1, C.spGlow, 0.30);
    }

    /* --- arcos eletricos cruzando a pista de vez em quando --- */
    st.spArcAcc += 6.5 * a * dt;
    if (st.spArcAcc >= 1) {
      st.spArcAcc -= 1;
      var arcZ = rrange(-22, 1);
      var dir = rsign();
      var na = Math.round(7 * qScale) + 2;
      for (var k = 0; k < na; k++) {
        var r = spawn(bTrail);
        if (!r) break;
        r.x = -dir * (HALF_W + 0.25);
        r.y = SURFACE_Y + rrange(0.04, 0.55);
        r.z = arcZ + rrange(-0.25, 0.25);
        r.vx = dir * rrange(9, 17);
        r.vy = rrange(-0.4, 1.4);
        r.vz = rrange(-0.6, 0.6);
        r.drag = 0.5;
        r.life = rrange(0.18, 0.34);
        r.sz0 = rrange(0.16, 0.30); r.sz1 = p_zero(); r.szEase = 0;
        r.asp = 0.17; r.stretch = 0.055; r.align = 1;
        r.a0 = 1; r.fout = 0.6;
        setCol(r, C.spCore, 3.4, C.spGlow, 0.4);
      }
    }

    /* --- luz de star power respirando sobre a pista --- */
    lights.sp.intensity = 7 * a * (0.75 + 0.25 * puls);
    lights.sp.position.z = STRIKE_Z - 6.5 - 2.5 * mSin(elapsed * 0.7);
  }

  function p_zero() { return 0.012; }

  /* =========================================================================
     13. SUSTAIN — fagulhas continuas enquanto a nota longa e segurada
     ========================================================================= */

  var sustainLanes = [0, 0, 0, 0, 0];   /* 1 enquanto o traste esta segurando */

  function sustain(lane, on) {
    if (lane == null) return;
    if (lane < 0) { for (var i = 0; i < LANES; i++) sustainLanes[i] = on ? 1 : 0; return; }
    if (lane > 4) return;
    sustainLanes[lane | 0] = on ? 1 : 0;
  }

  /* Le GH.Scoring direto: assim as fagulhas de sustain funcionam mesmo que
     ninguem chame FX.sustain(). */
  function pollSustains() {
    var S = GH.Scoring;
    var i;
    for (i = 0; i < LANES; i++) sustainLanes[i] = 0;
    if (!S || typeof S.activeSustains !== 'function') return;
    var list;
    try { list = S.activeSustains(); } catch (e) { return; }
    if (!list || !list.length) return;
    for (i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s) continue;
      if (s.open) { for (var j = 0; j < LANES; j++) sustainLanes[j] = 1; continue; }
      var ln = s.lanes;
      if (!ln) continue;
      for (var k = 0; k < ln.length; k++) {
        var v = ln[k] | 0;
        if (v >= 0 && v < LANES) sustainLanes[v] = 1;
      }
    }
  }

  function updateSustains(dt) {
    var sp = st.spAmt;
    for (var i = 0; i < LANES; i++) {
      if (!sustainLanes[i]) { st.sustainAcc[i] = 0; continue; }
      var x = laneX(i);
      var base = sp > 0.3 ? _f2.copy(mixC(C.laneGlow[i], C.spGlow, 0.7)) : C.laneGlow[i];

      /* fagulhas saindo do aro sem parar */
      st.sustainAcc[i] += 44 * qScale * dt;
      var n = st.sustainAcc[i] | 0;
      st.sustainAcc[i] -= n;
      if (n > 4) n = 4;
      for (var j = 0; j < n; j++) {
        var p = spawn(bTrail);
        if (!p) break;
        var ang = rrange(0, TAU);
        p.x = x + mCos(ang) * rrange(0.02, 0.22);
        p.y = SURFACE_Y + rrange(0.03, 0.14);
        p.z = STRIKE_Z + mSin(ang) * rrange(0.02, 0.16);
        p.vx = mCos(ang) * rrange(0.4, 2.2);
        p.vy = rrange(1.4, 4.2);
        p.vz = mSin(ang) * rrange(0.2, 1.2) + rrange(0.1, 1.0);
        p.gy = -9.5; p.drag = 2.4;
        p.life = rrange(0.24, 0.50);
        p.sz0 = rrange(0.11, 0.19); p.sz1 = p.sz0 * 0.28; p.szEase = 0;
        p.asp = 0.20; p.stretch = 0.050; p.align = 1;
        p.a0 = 1; p.fout = 0.55;
        setCol(p, mixC(C.white, base, 0.35), 2.6, base, 0.3);
      }

      /* pulso luminoso preso no aro (o "queimando" do sustain) */
      if (((elapsed * 60) | 0) % 3 === 0) {
        var g = spawn(bGlow);
        if (g) {
          g.x = x; g.y = SURFACE_Y + 0.034; g.z = STRIKE_Z;
          g.bill = 2;
          g.sz0 = 0.50 + 0.12 * mSin(elapsed * 22 + i);
          g.sz1 = g.sz0 * 1.25; g.szEase = 0;
          g.life = 0.10; g.a0 = 0.26; g.fin = 0.25; g.fout = 0.75;
          setCol(g, mixC(C.white, base, 0.5), 1.6, base, 0.4);
        }
      }
      st.hitLightE = mMax(st.hitLightE, 8);
      lights.hit.color.lerp(base, 0.25);
    }
  }

  /* =========================================================================
     14. SEQUENCIA (STREAK)
     ========================================================================= */

  var MILESTONES = [10, 20, 30, 50, 75, 100, 150, 200, 300, 400, 500];

  function streakLevel(n) {
    if (!inited) return;
    var lv = clamp((n | 0), 0, 4);
    st.level = lv < 1 ? 1 : lv;
  }

  /* Comemoracao crescente: anel + luz + faisca. O texto e do HUD. */
  function celebrate(streak) {
    var k = clamp01((MILESTONES.indexOf(streak) + 1) / MILESTONES.length);
    var scale = 0.55 + k * 1.25;
    var col = k > 0.5 ? C.gold : C.perfect;
    var i, p;

    for (i = 0; i < 2; i++) {
      p = spawn(bRing);
      if (!p) break;
      p.x = 0; p.y = SURFACE_Y + 0.030 + i * 0.008; p.z = STRIKE_Z;
      p.bill = 2;
      p.sz0 = 0.7 + i * 0.5; p.sz1 = (5.0 + i * 2.6) * scale; p.szEase = 1;
      p.life = 0.5 + i * 0.2; p.a0 = 0.95 - i * 0.3; p.fin = 0.02; p.fout = 0.8;
      setCol(p, i === 0 ? C.white : col, 2.8 - i * 0.7, col, 0.35);
    }

    p = spawn(bGlow);
    if (p) {
      p.x = 0; p.z = STRIKE_Z; p.baseY = SURFACE_Y - 0.3; p.anchor = 1;
      p.bill = 1;
      p.sz0 = 1.4 * scale; p.sz1 = 2.6 * scale; p.asp = 2.2; p.szEase = 1;
      p.life = 0.55; p.a0 = 0.85; p.fin = 0.04; p.fout = 0.85;
      setCol(p, mixC(C.white, col, 0.4).clone(), 2.6, col, 0.35);
    }

    p = spawn(bFlare);
    if (p) {
      p.x = 0; p.y = FX_Y + 0.45; p.z = STRIKE_Z + 0.08;
      p.bill = 0; p.sz0 = 1.6 * scale; p.sz1 = 4.0 * scale; p.szEase = 1;
      p.life = 0.45; p.a0 = 0.95; p.fin = 0.02; p.fout = 0.9;
      setCol(p, mixC(C.white, col, 0.25).clone(), 2.6, col, 0.3);
    }

    /* jorro da comemoracao, tambem amortizado em 4 frames */
    emitBurst((22 + 44 * k) * qScale, function () {
      var p2 = spawn(bTrail);
      if (!p2) return false;
      var ang = rrange(0, TAU);
      var speed = rrange(3.5, 10 + 6 * k);
      p2.x = rrange(-0.6, 0.6); p2.y = FX_Y + 0.1; p2.z = STRIKE_Z;
      p2.vx = mCos(ang) * speed;
      p2.vy = mAbs(mSin(ang)) * speed * 0.75 + rrange(1.5, 5.5);
      p2.vz = rrange(-1, 4);
      p2.gy = -10.5; p2.drag = 1.9;
      p2.life = rrange(0.45, 1.1);
      p2.sz0 = rrange(0.14, 0.25); p2.sz1 = p2.sz0 * 0.25; p2.szEase = 0;
      p2.asp = 0.20; p2.stretch = 0.055; p2.align = 1;
      p2.a0 = 1; p2.fout = 0.6;
      setCol(p2, mixC(C.white, col, rrange(0, 0.5)).clone(), 3.0, col, 0.25);
      return true;
    });

    crowdReaction(k > 0.45 ? 'ecstatic' : 'streak');
    st.hitLightE = mMax(st.hitLightE, 11 + 6 * k);
    lights.hit.color.copy(col);
    lights.hit.position.x = 0;
    eng('shake', 0.10 + 0.16 * k, 0.28);
    eng('bloomPulse', 0.22 + 0.30 * k, 2.6);
  }

  /* Detecta os marcos 10/20/50/100... lendo GH.Scoring. Um salto grande
     (forceState do modo captura) NAO comemora — seria um efeito fantasma. */
  function pollStreak() {
    var S = GH.Scoring;
    if (!S) return;
    var s = S.streak | 0;
    if (s === st.lastStreak) return;
    var prev = st.lastStreak;
    st.lastStreak = s;
    if (s <= prev) return;
    if (s - prev > 12) return;                 /* sincronizacao, nao progresso */
    for (var i = 0; i < MILESTONES.length; i++) {
      var m = MILESTONES[i];
      if (prev < m && s >= m) { celebrate(m); return; }
    }
  }

  /* =========================================================================
     15. PUBLICO — flashes de celular/camera no escuro
     ========================================================================= */

  var CROWD_KINDS = {
    idle:         { rate: 1.4,  burst: 0 },
    anticipation: { rate: 3.2,  burst: 4 },
    start:        { rate: 6.0,  burst: 26 },
    countdown:    { rate: 3.0,  burst: 5 },
    cheer:        { rate: 5.0,  burst: 15 },
    ecstatic:     { rate: 9.5,  burst: 42 },
    streak:       { rate: 6.5,  burst: 20 },
    starpower:    { rate: 13.0, burst: 58 },
    spready:      { rate: 4.0,  burst: 9 },
    phrase:       { rate: 4.2,  burst: 7 },
    section:      { rate: 5.0,  burst: 13 },
    miss:         { rate: 0.7,  burst: 0 },
    boo:          { rate: 0.4,  burst: 0 }
  };

  function crowdReaction(kind) {
    if (!inited) return;
    var k = CROWD_KINDS[kind] || CROWD_KINDS.idle;
    st.crowdRate = mMax(st.crowdRate, k.rate);
    st.crowdBurst += k.burst * qScale;
  }

  function crowdFlash() {
    var p = spawn(bGlow);
    if (!p) return;
    /* volume do publico: nas laterais e atras da pista, nunca sobre as notas */
    var side = rsign();
    var far = rnd();
    p.x = side * rrange(2.6, 17) * (0.5 + far * 0.7);
    p.y = rrange(0.4, 5.4);
    p.z = rrange(-40, -13);
    p.bill = 0;
    p.sz0 = rrange(0.09, 0.26); p.sz1 = p.sz0 * rrange(1.6, 2.6); p.szEase = 1;
    p.life = rrange(0.09, 0.19);
    p.a0 = rrange(0.55, 1.0); p.fin = 0.05; p.fout = 0.8;
    setCol(p, C.white, rrange(2.2, 4.2), C.spTint, 0.4);
  }

  function updateCrowd(dt) {
    /* a euforia sempre volta devagar para o repouso */
    st.crowdRate = damp(st.crowdRate, 1.4 + st.intensity * 2.6 + st.spAmt * 4.5, 0.55, dt);
    st.crowdAcc += st.crowdRate * qScale * dt;
    var n = st.crowdAcc | 0;
    st.crowdAcc -= n;
    if (st.crowdBurst > 0) {
      var b = mMin(st.crowdBurst, 60 * dt * 26);
      st.crowdBurst -= b;
      n += b | 0;
      if (st.crowdBurst < 0.5) st.crowdBurst = 0;
    }
    if (n > 26) n = 26;
    for (var i = 0; i < n; i++) crowdFlash();
  }

  /* =========================================================================
     16. ATMOSFERA CONTINUA — haze e brasas de ambiente
     ========================================================================= */

  function updateAtmosphere(dt) {
    /* --- baforadas de neblina flutuando no facho (bem sutis) --- */
    st.hazeAcc += 0.55 * dt;
    if (st.hazeAcc >= 1) {
      st.hazeAcc -= 1;
      var p = spawn(bSmoke);
      if (p) {
        p.x = rrange(-9, 9);
        p.y = rrange(0.9, 4.2);
        p.z = rrange(-30, -3);
        p.vx = rrange(-0.10, 0.10);
        p.vy = rrange(0.02, 0.12);
        p.vz = rrange(-0.05, 0.10);
        p.turb = 0.05; p.turbF = 0.4;
        p.life = rrange(7, 13);
        p.sz0 = rrange(2.4, 5.2); p.sz1 = rrange(5.0, 9.5); p.szEase = 0;
        p.rot = rrange(0, TAU); p.rotV = rsign() * rrange(0.02, 0.07);
        p.a0 = rrange(0.020, 0.052) * (0.6 + st.intensity * 0.8);
        p.fin = 0.25; p.fout = 0.45;
        setCol(p, C.haze, 0.42, C.smoke, 0.18);
      }
    }

    /* --- brasas soltas subindo do palco: vida constante na cena --- */
    st.emberAcc += (2.2 + st.intensity * 5.5 + st.spAmt * 6) * qScale * dt;
    var ne = st.emberAcc | 0;
    st.emberAcc -= ne;
    if (ne > 3) ne = 3;
    for (var i = 0; i < ne; i++) {
      var q = spawn(bSpark);
      if (!q) break;
      q.x = rrange(-11, 11);
      q.y = rrange(-0.2, 1.4);
      q.z = rrange(-30, -4);
      q.vx = rrange(-0.25, 0.25);
      q.vy = rrange(0.55, 1.7);
      q.vz = rrange(-0.15, 0.15);
      q.drag = 0.35; q.turb = 0.45; q.turbF = 1.1;
      q.life = rrange(2.2, 4.6);
      q.sz0 = rrange(0.07, 0.17); q.sz1 = 0.01; q.szEase = 1;
      q.rot = rrange(0, TAU); q.rotV = rsign() * rrange(0.3, 1.2);
      q.a0 = rrange(0.25, 0.7); q.fin = 0.18; q.fout = 0.55;
      var warm = st.spAmt > 0.4 ? C.spGlow : C.haze;
      setCol(q, warm, 1.5, C.danger, 0.12);
    }
  }

  /* =========================================================================
     17. BRILHO RESIDUAL DA LINHA DE ACERTO
     ========================================================================= */

  function updateStrike(dt) {
    st.strikeGlow = damp(st.strikeGlow, 0, 5.2, dt);
    if (st.strikeGlow < 0.05) return;
    /* uma lamina de luz deitada na linha de acerto, viva depois de cada nota */
    var p = spawn(bGlow);
    if (!p) return;
    p.x = 0; p.y = SURFACE_Y + 0.020; p.z = STRIKE_Z;
    p.bill = 2;
    p.sz0 = HALF_W * 2 + 0.6; p.sz1 = p.sz0; p.szEase = 0;
    p.asp = 0.085;
    /* parte do orcamento de energia da linha de acerto: esta lamina cobre a
       largura toda do conves, entao entra baixa (ver highway.updateStrike) */
    p.life = 0.055; p.a0 = clamp01(st.strikeGlow * 0.15); p.fin = 0.2; p.fout = 0.8;
    var c = st.spAmt > 0.4 ? C.spGlow : C.accent;
    setCol(p, c, 1.5, c, 1.0);
  }

  /* =========================================================================
     18. ESCURECIMENTO DE RAIA (erro)
     ========================================================================= */

  function updateDim(dt) {
    for (var i = 0; i < LANES; i++) {
      if (st.dimAmt[i] <= 0.001) {
        if (laneDim[i].mesh.visible) { laneDim[i].mesh.visible = false; laneDim[i].mat.opacity = 0; }
        continue;
      }
      st.dimAmt[i] = damp(st.dimAmt[i], 0, 5.5, dt);
      if (st.dimAmt[i] < 0.004) st.dimAmt[i] = 0;
      laneDim[i].mesh.visible = st.dimAmt[i] > 0;
      laneDim[i].mat.opacity = st.dimAmt[i];
    }
  }

  /* =========================================================================
     19. LUZES DINAMICAS
     ========================================================================= */

  function updateLights(dt) {
    st.hitLightE = damp(st.hitLightE, 0, 7.5, dt);
    lights.hit.intensity = st.hitLightE;
    lights.hit.position.y = 0.62 + st.hitLightE * 0.006;
  }

  /* =========================================================================
     20. PONTE COM O ENGINE (sempre com guarda)
     ========================================================================= */

  function eng(fn, a, b, c) {
    var E = GH.Engine;
    if (!E || typeof E[fn] !== 'function') return;
    try { E[fn](a, b, c); } catch (e) { /* nunca derruba o show */ }
  }

  /* =========================================================================
     21. LEITURA DE ESTADO (funciona mesmo sem o barramento do Game)
     ========================================================================= */

  function pollState(dt) {
    var S = GH.Scoring;
    if (S) {
      var bm = S.baseMultiplier | 0;
      if (bm >= 1) st.level = clamp(bm, 1, 4);
      /* energia do show: multiplicador + vida + star power */
      var target = clamp01(((S.multiplier || 1) / 8) * 0.55 +
                           clamp01(S.health == null ? 1 : S.health) * 0.30 +
                           (S.starPowerActive ? 0.30 : 0));
      st.intensity = damp(st.intensity, target, 1.6, dt);
    }
    st.levelSmooth = damp(st.levelSmooth, st.level, 6.5, dt);

    /* fase do beat: alimenta a respiracao das chamas e o pulso da aura */
    var Cd = GH.Conductor;
    if (Cd) {
      var b = Cd.beat;
      if (typeof b === 'number' && isFinite(b)) {
        st.beatPhase = b - Math.floor(b);
        var bi = Math.floor(b);
        if (bi !== st.lastBeat) {
          if (st.lastBeat >= 0 && bi > st.lastBeat && bi - st.lastBeat < 4) onBeat(bi);
          st.lastBeat = bi;
        }
      }
    } else {
      st.beatPhase = (st.beatPhase + dt * 2) % 1;
    }
  }

  /* Batida: as chamas dao um "puxao" e a poeira estremece. */
  function onBeat(index) {
    var strong = ((index | 0) % 4 === 0);
    for (var i = 0; i < LANES; i++) {
      if (st.flameAmt[i] > 0.1) st.flameKick[i] = mMax(st.flameKick[i], strong ? 0.55 : 0.26);
    }
    /* pulso de bloom no beat. O engine ja da o seu (kick + bloom) pelo gancho
       proprio no Conductor; aqui so somamos a parte que depende da ENERGIA do
       show, para o compasso "respirar" mais forte no auge da musica. */
    if (strong) eng('bloomPulse', 0.04 + 0.10 * st.intensity + 0.10 * st.spAmt, 4.6);
    if (st.spAmt > 0.3 && strong) {
      /* no star power cada compasso solta um anel largo pela pista */
      var p = spawn(bRing);
      if (p) {
        p.x = 0; p.y = SURFACE_Y + 0.024; p.z = STRIKE_Z - 2.0;
        p.bill = 2;
        p.sz0 = 1.2; p.sz1 = 9.0; p.szEase = 1;
        p.life = 0.85; p.a0 = 0.42 * st.spAmt; p.fin = 0.05; p.fout = 0.8;
        setCol(p, C.spGlow, 1.8, C.spEdge, 0.25);
      }
    }
  }

  /* =========================================================================
     22. UPDATE
     ========================================================================= */

  function update(dt) {
    if (!inited || disposed) return;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 1 / 12) dt = 1 / 12;         /* nunca deixa a fisica explodir */
    elapsed += dt;

    pollState(dt);
    pollStreak();
    pollSustains();

    updateFlames(dt);
    updateStarPower(dt);
    updateSustains(dt);
    updateLaneAfterglow(dt);
    updateCrowd(dt);
    updateAtmosphere(dt);
    updateStrike(dt);
    updateDim(dt);
    updateLights(dt);

    /* poeira: tudo acontece no shader, aqui so avancam os uniformes */
    if (dust.mat) {
      dust.mat.uniforms.uTime.value = elapsed;
      dust.mat.uniforms.uIntensity.value = st.intensity;
      dust.mat.uniforms.uSp.value = st.spAmt;
    }

    drainBursts();

    for (var i = 0; i < batches.length; i++) updateBatch(batches[i], dt);
  }

  /* =========================================================================
     23. RESET / DISPOSE
     ========================================================================= */

  function reset() {
    if (!inited) return;
    var i, b;
    burstQ.length = 0;      /* jorro pendente de outra musica nao vaza pra ca */
    for (i = 0; i < batches.length; i++) {
      b = batches[i];
      while (b.parts.length) b.free.push(b.parts.pop());
      b.count = 0;
      b.geometry.instanceCount = 0;
      b.mesh.visible = false;
    }
    for (i = 0; i < LANES; i++) {
      st.flameOn[i] = false; st.flameAmt[i] = 0; st.flameAcc[i] = 0;
      st.flameEmber[i] = 0; st.flameKick[i] = 0;
      st.dimAmt[i] = 0; st.sustainAcc[i] = 0; sustainLanes[i] = 0;
      st.laneAfter[i] = 0; st.laneAfterQ[i] = 0;
      if (laneDim[i]) { laneDim[i].mesh.visible = false; laneDim[i].mat.opacity = 0; }
    }
    st.spOn = false; st.spAmt = 0; st.spSince = 0;
    st.level = 1; st.levelSmooth = 1;
    st.lastStreak = 0; st.lastBeat = -1;
    st.crowdRate = 1.4; st.crowdBurst = 0; st.crowdAcc = 0;
    st.hitLightE = 0; st.spLightE = 0; st.strikeGlow = 0;
    st.waveT = -1; st.spEmitAcc = 0; st.spArcAcc = 0;
    st.hazeAcc = 0; st.emberAcc = 0;
    st.intensity = 0.5;

    if (aura.wave) { aura.wave.visible = false; aura.waveMat.opacity = 0; }
    if (aura.floor) { aura.floor.visible = false; aura.floorMat.opacity = 0; }
    if (aura.railL) { aura.railL.visible = false; aura.railR.visible = false; aura.railMat.opacity = 0; }
    if (aura.canopy) { aura.canopy.visible = false; aura.canopyMat.opacity = 0; }
    if (lights.hit) lights.hit.intensity = 0;
    if (lights.sp) lights.sp.intensity = 0;

    /* o RNG volta ao inicio: duas capturas iguais dao o MESMO frame */
    if (rng && rng.reseed) rng.reseed(0x6217);
  }

  function dispose() {
    if (!inited) return;
    reset();
    var i;
    for (i = 0; i < batches.length; i++) {
      try { batches[i].geometry.dispose(); } catch (e) { /* ok */ }
      try { batches[i].material.dispose(); } catch (e) { /* ok */ }
      if (batches[i].mesh.parent) batches[i].mesh.parent.remove(batches[i].mesh);
    }
    batches.length = 0;
    if (dust.geo) { try { dust.geo.dispose(); } catch (e) { /* ok */ } }
    if (dust.mat) { try { dust.mat.dispose(); } catch (e) { /* ok */ } }
    var meshes = [aura.floor, aura.railL, aura.railR, aura.canopy, aura.wave];
    for (i = 0; i < meshes.length; i++) {
      if (!meshes[i]) continue;
      try { meshes[i].geometry.dispose(); } catch (e) { /* ok */ }
      try { meshes[i].material.dispose(); } catch (e) { /* ok */ }
    }
    for (i = 0; i < laneDim.length; i++) {
      try { laneDim[i].mat.dispose(); } catch (e) { /* ok */ }
    }
    laneDim.length = 0;
    if (baseQuad) { try { baseQuad.dispose(); } catch (e) { /* ok */ } baseQuad = null; }
    if (group && group.parent) group.parent.remove(group);
    group = null;
    inited = false;
    disposed = true;
    GH.FX.group = null;
  }

  /* =========================================================================
     24. QUALIDADE E TEMA
     ========================================================================= */

  /* DEGRADACAO QUE CHEGA AQUI DE VERDADE.
     Antes isto so era chamado uma vez, no init(): quando o GH.Engine baixava
     a qualidade sozinho por fps ruim, nao saia UMA particula da tela. Agora o
     engine empurra a mudanca (pushQualityToSubsystems) e passa junto a tabela
     GH.Engine.qualityScale, que e a fonte da verdade — `particles` ja vem
     calibrado por nivel. O nome continua aceito para compatibilidade. */
  function setQuality(q, scale) {
    var s = (scale && typeof scale.particles === 'number') ? scale.particles : QUALITY_SCALE[q];
    qScale = (typeof s === 'number' && isFinite(s)) ? clamp(s, 0.15, 1.6) : 1.0;
    if (dust.mat) dust.mat.uniforms.uSize.value = 4.4 * (qScale > 1 ? 1.1 : 1);
    /* poeira: o campo e um Points unico, entao "menos poeira" e desenhar
       menos vertices do MESMO buffer — sem realocar nada. */
    if (dust.geo && dust.count) {
      dust.geo.setDrawRange(0, Math.max(180, Math.round(dust.count * clamp(qScale, 0.25, 1))));
    }
    return qScale;
  }

  /* --- AQUECIMENTO ---------------------------------------------------------
     Medido em shots/_perfload.html: dois programas GLSL de MeshBasicMaterial
     so eram compilados na primeira vez que o jogador ERRAVA uma nota — porque
     o escurecimento de raia e a fumaca escura ficam `visible = false` ate la,
     e o `renderer.compile` do three nao cobre todas as variantes de um
     material que nunca passou pelo render de verdade.

     Compilar shader trava a thread principal por dezenas ou centenas de
     milissegundos no driver. Cair isso no primeiro erro do jogador — ou seja,
     no pior momento possivel — era exatamente o estalo relatado.

     Aqui deixamos TUDO visivel por um frame (o frame de aquecimento do
     GH.Engine, que roda no carregamento) e devolvemos o estado depois. */
  var warmSaved = null;
  function warmup() {
    if (!inited) return GH.FX;
    warmSaved = [];
    var i, b;
    for (i = 0; i < batches.length; i++) {
      b = batches[i];
      warmSaved.push({ o: b.mesh, v: b.mesh.visible, c: b.geometry.instanceCount });
      b.mesh.visible = true;
      /* uma instancia basta para o material passar pelo render */
      if (b.geometry.instanceCount < 1) b.geometry.instanceCount = 1;
    }
    var extras = [aura.floor, aura.railL, aura.railR, aura.canopy, aura.wave];
    for (i = 0; i < extras.length; i++) {
      if (!extras[i]) continue;
      warmSaved.push({ o: extras[i], v: extras[i].visible, c: -1 });
      extras[i].visible = true;
    }
    for (i = 0; i < laneDim.length; i++) {
      warmSaved.push({ o: laneDim[i].mesh, v: laneDim[i].mesh.visible, c: -1 });
      laneDim[i].mesh.visible = true;
    }
    return GH.FX;
  }

  function warmupDone() {
    if (!warmSaved) return GH.FX;
    for (var i = 0; i < warmSaved.length; i++) {
      var s = warmSaved[i];
      s.o.visible = s.v;
      if (s.c >= 0 && s.o.geometry) s.o.geometry.instanceCount = s.c;
    }
    warmSaved = null;
    return GH.FX;
  }

  function hookEngine() {
    var E = GH.Engine;
    if (!E || typeof E.on !== 'function') return;
    E.on('warmup', function () { try { warmup(); } catch (e) { /* nunca derruba o boot */ } });
    E.on('warmedup', function () { try { warmupDone(); } catch (e) { /* ok */ } });
    try { setQuality(E.quality, E.qualityScale); } catch (e) { /* ok */ }
  }

  /* Reaplica as cores quando o tema muda (o menu pode trocar de musica). */
  function setTheme() {
    if (!inited) return;
    resolveColors();
    if (aura.floorMat) aura.floorMat.color.copy(C.spGlow).multiplyScalar(1.35);
    if (aura.canopyMat) aura.canopyMat.color.copy(C.spTint).multiplyScalar(0.55);
    if (dust.mat) {
      var a = C.spotlight.clone().multiplyScalar(0.85);
      var b = C.haze.clone().multiplyScalar(0.55);
      dust.mat.uniforms.uColA.value.set(a.r, a.g, a.b);
      dust.mat.uniforms.uColB.value.set(b.r, b.g, b.b);
    }
    if (lights.sp) lights.sp.color.copy(C.spGlow);
  }

  function setIntensity(v) { st.intensity = clamp01(v); }

  /* =========================================================================
     25. INIT
     ========================================================================= */

  function init(sc, cam) {
    if (inited) return GH.FX;
    if (!window.THREE) return GH.FX;
    scene = sc || (GH.Engine ? GH.Engine.scene : null);
    camera = cam || (GH.Engine ? GH.Engine.camera : null);
    if (!scene) return GH.FX;

    LAY = GH.Layout || null;
    if (LAY) {
      LANES = LAY.LANES || 5;
      SURFACE_Y = LAY.SURFACE_Y || 0;
      STRIKE_Z = LAY.STRIKE_Z || 0;
      HALF_W = LAY.HALF_W || 1.8;
      LANE_W = LAY.LANE_W || 0.72;
      SPAWN_Z = LAY.SPAWN_Z || -46;
    }

    var Ut = U();
    rng = (Ut && Ut.RNG) ? Ut.RNG(0x6217) : null;
    if (rng && !rng.reseed) rng = null;
    readCrown();

    _mix = new THREE.Color(1, 1, 1);
    _f0 = new THREE.Color(1, 1, 1);
    _f1 = new THREE.Color(1, 1, 1);
    _f2 = new THREE.Color(1, 1, 1);
    resolveColors();

    try { setQuality(GH.Engine ? GH.Engine.quality : 'high', GH.Engine ? GH.Engine.qualityScale : null); } catch (e) { qScale = 1; }

    group = new THREE.Group();
    group.name = 'GH_FX';
    group.matrixAutoUpdate = false;      /* fica na identidade: o shader conta com isso */
    group.updateMatrix();
    scene.add(group);

    buildBatches();
    buildDust();
    buildAura();
    buildLights();

    try { hookEngine(); } catch (e) { /* engine sem eventos: segue sem aquecimento */ }

    /* segue a troca de tema da paleta sem que ninguem precise avisar */
    try { if (GH.Palette && GH.Palette.onChange) GH.Palette.onChange(setTheme); } catch (e) { /* ok */ }

    inited = true;
    disposed = false;
    GH.FX.group = group;
    GH.FX.ready = true;
    return GH.FX;
  }

  /* =========================================================================
     26. DIAGNOSTICO
     ========================================================================= */

  function stats() {
    var out = { ready: inited, qScale: qScale, elapsed: elapsed, live: 0, batches: {} };
    for (var i = 0; i < batches.length; i++) {
      out.batches[batches[i].name] = batches[i].count + '/' + batches[i].cap;
      out.live += batches[i].count;
    }
    out.sp = st.spAmt.toFixed(2);
    out.level = st.levelSmooth.toFixed(2);
    out.flames = st.flameAmt.map(function (v) { return v.toFixed(2); }).join(',');
    return out;
  }

  /* =========================================================================
     27. API PUBLICA
     ========================================================================= */

  GH.FX = {
    /* contrato */
    init: init,
    update: update,
    hit: hit,
    miss: miss,
    openHit: openHit,
    flames: flames,
    starPower: starPower,
    streakLevel: streakLevel,
    crowdReaction: crowdReaction,
    reset: reset,

    /* extras uteis para os outros agentes */
    sustain: sustain,
    celebrate: celebrate,
    setStarPower: starPower,
    setIntensity: setIntensity,
    setQuality: setQuality,
    warmup: warmup,
    setTheme: setTheme,
    dispose: dispose,
    stats: stats,

    group: null,
    ready: false,
    /* o Game conduz o update deste modulo — nao nos registramos no Engine */
    selfDriven: false
  };

})(window.GH = window.GH || {});

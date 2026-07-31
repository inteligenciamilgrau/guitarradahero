/* =========================================================================
   GUITARRADA HERO — src/core/engine.js
   Dono: agente ENGINE.

   Responsavel por: WebGLRenderer, cena, camera + rig cinematografico,
   iluminacao base de palco, neblina, EffectComposer (bloom + grade custom +
   antialiasing), loop de tempo com auto-degradacao de qualidade e o modo
   captura deterministico.

   Three.js r147 UMD (global THREE). Nada de import/export. Nada de fetch.
   Tudo procedural.
   ========================================================================= */
(function (GH) {
  'use strict';

  /* =======================================================================
     0. UTILITARIOS LOCAIS
     O engine carrega logo depois de util.js, mas nunca depende dele no topo
     do IIFE (contrato, secao 2). Estas funcoes sao autossuficientes; se
     GH.Util existir na hora do init(), usamos o RNG dele so pra semear o
     ruido do sway (determinismo do modo captura).
     ======================================================================= */

  var TAU = Math.PI * 2;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smootherstep(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
  function easeOutCubic(t) { t = clamp(t, 0, 1); var u = 1 - t; return 1 - u * u * u; }
  function easeInOutSine(t) { t = clamp(t, 0, 1); return 0.5 - 0.5 * Math.cos(Math.PI * t); }
  /* amortecimento independente de framerate (Lengyel) */
  function damp(a, b, lambda, dt) { return lerp(a, b, 1 - Math.exp(-lambda * dt)); }

  /* --- ruido de valor 1D deterministico, usado no sway/tremor da camera --- */
  function hashInt(n) {
    n = (n << 13) ^ n;
    n = (n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff;
    return 1.0 - n / 1073741824.0; /* -1..1 */
  }
  function noise1(x) {
    var i = Math.floor(x);
    var f = x - i;
    var u = f * f * f * (f * (f * 6 - 15) + 10);
    return lerp(hashInt(i | 0), hashInt((i + 1) | 0), u);
  }
  /* fbm de 3 oitavas — movimento organico, nunca periodico obvio */
  function fbm1(x) {
    return noise1(x) * 0.62 + noise1(x * 2.13 + 41.7) * 0.26 + noise1(x * 4.31 + 91.3) * 0.12;
  }

  /* converte hex/string/THREE.Color/array em THREE.Color (defensivo) */
  function toColor(v, fallbackHex) {
    var c = new THREE.Color();
    var fb = (fallbackHex === undefined) ? 0xffffff : fallbackHex;
    try {
      if (v === null || v === undefined) return c.setHex(fb);
      if (v.isColor === true) return c.copy(v);
      if (typeof v === 'number') return c.setHex(v);
      if (typeof v === 'string') return c.set(v);
      if (typeof v.length === 'number' && v.length >= 3) return c.setRGB(+v[0], +v[1], +v[2]);
      if (typeof v.r === 'number') return c.setRGB(v.r, v.g, v.b);
      if (typeof v.hex === 'number') return c.setHex(v.hex);
    } catch (e) { /* cor invalida -> fallback */ }
    return c.setHex(fb);
  }

  /* procura a primeira chave existente num objeto de tema */
  function themePick(theme, keys, fallbackHex) {
    if (theme) {
      for (var i = 0; i < keys.length; i++) {
        var v = theme[keys[i]];
        if (v !== undefined && v !== null) return toColor(v, fallbackHex);
      }
    }
    return toColor(fallbackHex, fallbackHex);
  }

  /* Fator que iguala o FLUXO de uma luz colorida entre temas.
     ColorManagement.legacyMode = false: r/g/b de um THREE.Color ja sao LUZ
     LINEAR, entao a luminancia aqui e fisica. Um magenta (#ff3d8a, luma 0.27)
     e um amarelo (#ffe14d, luma 0.76) com a MESMA intensidade entregam quase
     tres vezes mais luz no segundo caso — foi o que amarelou a pista inteira
     no tema frevo. Dividindo pela luminancia, todo tema entrega a mesma
     energia e so muda de cor. */
  function lumaNorm(c) {
    var l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    return clamp(0.27 / Math.max(l, 0.03), 0.35, 1.35);
  }

  function warn(msg, err) {
    var line = '[GH.Engine] ' + msg + (err && err.message ? (' :: ' + err.message) : '');
    state.log.push(line);
    if (state.log.length > 40) state.log.shift();
    if (window.console && console.warn) console.warn(line);
  }

  /* =======================================================================
     1. SHADER "guitarradaGrade"
     Uma passada so, escrita a mao, que faz TODO o acabamento de imagem:

       distorcao de barril -> aberracao cromatica radial -> halo de brilho ->
       scanline -> grading lift/gamma/gain -> saturacao -> curva S ->
       tint sombra/realce -> flash de tela -> vinheta superelipse ->
       grao de filme -> dither -> linear->sRGB -> fade

     Detalhe importante do r147: quando o three renderiza para um render
     target NAO-XR ele forca LinearEncoding, ou seja, o EffectComposer
     trabalha em linear e o `renderer.outputEncoding` NAO e aplicado nas
     passadas de pos-processamento (elas sao ShaderMaterial cru). Por isso a
     conversao linear->sRGB e feita AQUI, no fim desta passada, antes do
     SMAA/FXAA (que, alias, preferem trabalhar em espaco gama).
     ======================================================================= */

  var GuitarradaGradeShader = {

    name: 'guitarradaGrade',

    uniforms: {
      tDiffuse:        { value: null },
      uResolution:     { value: new THREE.Vector2(1600, 900) },
      uAspect:         { value: 16 / 9 },
      uTime:           { value: 0 },

      /* energia musical 0..1 e star power 0..1 — modulam CA, grao e halo */
      uIntensity:      { value: 0.0 },
      uStarPower:      { value: 0.0 },

      /* nivel de detalhe do shader por qualidade (0 = barato, 1 = completo) */
      uDetail:         { value: 1.0 },

      /* lente */
      uBarrel:         { value: 0.055 },
      uAberration:     { value: 0.0022 },

      /* vinheta */
      uVignette:       { value: 0.46 },
      uVignetteStart:  { value: 0.58 },
      uVignetteEnd:    { value: 1.48 },
      uVignetteRound:  { value: 2.7 },

      /* filme */
      uGrain:          { value: 0.030 },
      uScanline:       { value: 0.010 },
      uScanCount:      { value: 540.0 },
      uHalo:           { value: 0.10 },

      /* grading.
         uGamma < 1 escurece meio-tom e sombra PRESERVANDO o realce — e o que
         devolve faixa dinamica de verdade no fluxo legado do r147 (onde o hex
         da paleta entra como se fosse linear e sai claro demais).
         uBlack e o ponto de preto: onde o sinal vira preto de verdade. */
      uExposure:       { value: 1.0 },
      uBlack:          { value: 0.030 },
      uLift:           { value: new THREE.Vector3(0.004, 0.003, 0.011) },
      /* GRADING FINAL (conferido no conjunto das 10 cenas).
         O gama estava em 0.66 — pow(x, 1.52) — e esmagava o meio-tom. Fazia
         sentido quando a cena inteira era clara demais; depois de escurecer o
         conves, o rim e o bloom, ele passou a apagar a madeira da pista e o
         volume da plateia. Em 0.70 o preto continua ancorado (uBlack cuida
         disso) e o meio-tom volta a ter materia. Saturacao baixou de 1.12
         para 1.08: as silhuetas azuis do publico estavam beirando o corte de
         gamut e o realce laranja do palco ficava eletrico. */
      uGamma:          { value: new THREE.Vector3(0.702, 0.696, 0.722) },
      uGain:           { value: new THREE.Vector3(1.040, 1.005, 0.985) },
      uSaturation:     { value: 1.08 },
      uContrast:       { value: 0.235 },
      uShadowTint:     { value: new THREE.Vector3(0.93, 0.975, 1.10) },
      uHighlightTint:  { value: new THREE.Vector3(1.055, 1.010, 0.945) },

      /* flash de tela (acerto / erro / star power) */
      uFlashColor:     { value: new THREE.Vector3(1, 1, 1) },
      uFlashAmount:    { value: 0.0 },

      /* saida */
      uOutputSRGB:     { value: 1.0 },
      uFade:           { value: 1.0 }
    },

    vertexShader: [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',
      '}'
    ].join('\n'),

    fragmentShader: [
      'varying vec2 vUv;',
      '',
      'uniform sampler2D tDiffuse;',
      'uniform vec2  uResolution;',
      'uniform float uAspect;',
      'uniform float uTime;',
      'uniform float uIntensity;',
      'uniform float uStarPower;',
      'uniform float uDetail;',
      'uniform float uBarrel;',
      'uniform float uAberration;',
      'uniform float uVignette;',
      'uniform float uVignetteStart;',
      'uniform float uVignetteEnd;',
      'uniform float uVignetteRound;',
      'uniform float uGrain;',
      'uniform float uScanline;',
      'uniform float uScanCount;',
      'uniform float uHalo;',
      'uniform float uExposure;',
      'uniform float uBlack;',
      'uniform vec3  uLift;',
      'uniform vec3  uGamma;',
      'uniform vec3  uGain;',
      'uniform float uSaturation;',
      'uniform float uContrast;',
      'uniform vec3  uShadowTint;',
      'uniform vec3  uHighlightTint;',
      'uniform vec3  uFlashColor;',
      'uniform float uFlashAmount;',
      'uniform float uOutputSRGB;',
      'uniform float uFade;',
      '',
      '#define GH_PI 3.141592653589793',
      '',
      '/* hash 3D -> 1D sem textura (Dave Hoskins). Base do grao e do dither. */',
      'float hash13( vec3 p3 ) {',
      '  p3 = fract( p3 * vec3( 0.1031, 0.1030, 0.0973 ) );',
      '  p3 += dot( p3, p3.yzx + 33.33 );',
      '  return fract( ( p3.x + p3.y ) * p3.z );',
      '}',
      '',
      'float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }',
      '',
      '/* transferencia sRGB de verdade (piecewise), nao um pow(1/2.2) chutado */',
      'vec3 linearToSRGB( vec3 c ) {',
      '  c = max( c, vec3( 0.0 ) );',
      '  vec3 lo = c * 12.92;',
      '  vec3 hi = 1.055 * pow( c, vec3( 0.41666667 ) ) - 0.055;',
      '  return mix( hi, lo, step( c, vec3( 0.0031308 ) ) );',
      '}',
      '',
      '/* Distorcao de barril MUITO sutil.',
      '   Encolhemos o raio (fator < 1) em vez de estica-lo: assim nunca se',
      '   amostra fora do frame e nao aparece aquele borrao de borda. */',
      'vec2 lensWarp( vec2 uv, float k ) {',
      '  vec2 c = uv - 0.5;',
      '  float r2 = dot( c, c );',
      '  float f = 1.0 - k * ( 0.55 * r2 + 0.45 * r2 * r2 );',
      '  return 0.5 + c * f;',
      '}',
      '',
      'void main() {',
      '',
      '  vec2 uv0 = vUv;',
      '',
      '  /* ---------- 1. lente: barril + zoom implicito ---------- */',
      '  vec2 uv = lensWarp( uv0, uBarrel );',
      '  vec2 cc = uv - 0.5;',
      '  float r2 = dot( cc, cc );',
      '',
      '  /* ---------- 2. aberracao cromatica radial ----------',
      '     Zero no centro (onde estao as notas, precisa ficar limpo) e cresce',
      '     na periferia. A energia da musica e o star power abrem a franja. */',
      '  float caAmt = uAberration * ( 0.30 + 1.70 * r2 )',
      '              * ( 1.0 + uIntensity * 0.85 + uStarPower * 1.70 );',
      '  vec2 caOff = cc * caAmt;',
      '',
      '  vec3 col;',
      '  if ( uDetail > 0.5 ) {',
      '    /* 5 amostras: franja suave, sem degrau de cor */',
      '    float rr = texture2D( tDiffuse, clamp( uv + caOff,        vec2( 0.0 ), vec2( 1.0 ) ) ).r;',
      '    vec2  yg = texture2D( tDiffuse, clamp( uv + caOff * 0.5,  vec2( 0.0 ), vec2( 1.0 ) ) ).rg;',
      '    vec3  gg = texture2D( tDiffuse, uv ).rgb;',
      '    vec2  cb = texture2D( tDiffuse, clamp( uv - caOff * 0.5,  vec2( 0.0 ), vec2( 1.0 ) ) ).gb;',
      '    float bb = texture2D( tDiffuse, clamp( uv - caOff,        vec2( 0.0 ), vec2( 1.0 ) ) ).b;',
      '    col = vec3( ( rr + yg.r ) * 0.5,',
      '                ( yg.g + gg.g + cb.r ) * 0.3333333,',
      '                ( bb + cb.g ) * 0.5 );',
      '  } else {',
      '    /* modo barato: 3 amostras */',
      '    col.r = texture2D( tDiffuse, clamp( uv + caOff, vec2( 0.0 ), vec2( 1.0 ) ) ).r;',
      '    col.g = texture2D( tDiffuse, uv ).g;',
      '    col.b = texture2D( tDiffuse, clamp( uv - caOff, vec2( 0.0 ), vec2( 1.0 ) ) ).b;',
      '  }',
      '',
      '  col *= uExposure;',
      '',
      '  /* ---------- 3. halo de brilho (bloom-halo curto) ----------',
      '     Seis amostras num hexagono giratorio, so no que passa do limiar.',
      '     Da aquele "veiling glare" de lente de camera de show. */',
      '  if ( uHalo > 0.001 && uDetail > 0.5 ) {',
      '    vec2 px = 1.0 / uResolution;',
      '    float rot = uTime * 0.13;',
      '    vec3 halo = vec3( 0.0 );',
      '    for ( int i = 0; i < 6; i++ ) {',
      '      float a = float( i ) * ( GH_PI / 3.0 ) + rot;',
      '      vec2 o = vec2( cos( a ), sin( a ) ) * px * 5.0;',
      '      vec3 s = texture2D( tDiffuse, clamp( uv + o, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb;',
      '      halo += max( s - 0.70, vec3( 0.0 ) );',
      '    }',
      '    col += halo * ( uHalo * 0.2666667 ) * ( 1.0 + uStarPower * 0.8 );',
      '  }',
      '',
      '  /* ---------- 4. vinheta em superelipse (ainda em LINEAR) ----------',
      '     Queda de luz e um fenomeno de lente: multiplicar em linear da o',
      '     escurecimento macio e natural, sem esmagar a sombra.',
      '     E nao e um circulo duro: expoente ~2.7 + correcao de aspecto dao um',
      '     retangulo arredondado, que e o que uma lente faz numa tela 16:9. */',
      '  vec2 vd = ( uv0 - 0.5 ) * 2.0;',
      '  vd.x *= mix( 1.0, uAspect, 0.42 ) * 0.86;',
      '  float ve = max( uVignetteRound, 1.2 );',
      '  float rv = pow( pow( abs( vd.x ), ve ) + pow( abs( vd.y ), ve ), 1.0 / ve );',
      '  float vig = 1.0 - uVignette * smoothstep( uVignetteStart, uVignetteEnd, rv );',
      '  col *= vig;',
      '',
      '  /* ======================================================================',
      '     A PARTIR DAQUI TRABALHAMOS EM ESPACO DE EXIBICAO (sRGB).',
      '     Grading, grao e dither em linear arruinam o preto: somar 0.02 a um',
      '     valor linear de 0.002 vira quase 3 paradas depois da transferencia.',
      '     Entao converte-se PRIMEIRO, e so entao se pinta a imagem.',
      '     ====================================================================== */',
      '  col = max( col, vec3( 0.0 ) );',
      '  col = mix( col, linearToSRGB( col ), uOutputSRGB );',
      '  col = clamp( col, vec3( 0.0 ), vec3( 1.0 ) );',
      '',
      '  /* ---------- 5. ponto de preto ----------',
      '     Reancora o preto sem tocar no branco: (x - k) / (1 - k). Sem isto',
      '     a cena inteira flutua sobre um cinza e nada parece "noite". */',
      '  col = clamp( ( col - uBlack ) / max( 1.0 - uBlack, 0.0001 ), vec3( 0.0 ), vec3( 1.0 ) );',
      '',
      '  /* ---------- 6. grading lift / gamma / gain ----------',
      '     lift levanta a sombra sem lavar o realce; gain puxa o topo; gamma',
      '     por canal (uGamma < 1 = escurece meio-tom, preserva realce). */',
      '  col = col * uGain + uLift * ( 1.0 - col );',
      '  col = pow( max( col, vec3( 0.0 ) ), 1.0 / max( uGamma, vec3( 0.05 ) ) );',
      '',
      '  /* ---------- 7. saturacao ---------- */',
      '  float l = luma( col );',
      '  col = mix( vec3( l ), col, uSaturation );',
      '',
      '  /* ---------- 8. curva de contraste em S ----------',
      '     smoothstep como curva; misturada com o original pra dosar. */',
      '  vec3 sc = clamp( col, vec3( 0.0 ), vec3( 1.0 ) );',
      '  sc = sc * sc * ( 3.0 - 2.0 * sc );',
      '  col = mix( col, sc, uContrast );',
      '',
      '  /* ---------- 9. split-tone: sombra fria, realce quente ---------- */',
      '  float l2 = luma( col );',
      '  col *= mix( uShadowTint, uHighlightTint, smoothstep( 0.02, 0.85, l2 ) );',
      '',
      '  /* ---------- 10. dessaturacao do canto (a vinheta ja escureceu) ------ */',
      '  col = mix( col, vec3( luma( col ) ), ( 1.0 - vig ) * 0.30 );',
      '',
      '  /* ---------- 11. flash de tela (screen blend + pitada aditiva) ------ */',
      '  if ( uFlashAmount > 0.0005 ) {',
      '    vec3 f = clamp( uFlashColor * uFlashAmount, vec3( 0.0 ), vec3( 1.0 ) );',
      '    col = 1.0 - ( 1.0 - clamp( col, vec3( 0.0 ), vec3( 1.0 ) ) ) * ( 1.0 - f );',
      '    col += f * 0.18;',
      '  }',
      '',
      '  /* ---------- 12. scanline (opcional, quase invisivel) ---------- */',
      '  if ( uScanline > 0.0005 ) {',
      '    float sl = 0.5 + 0.5 * sin( uv0.y * uScanCount * GH_PI );',
      '    col *= 1.0 - uScanline * sl;',
      '  }',
      '',
      '  /* ---------- 13. grao de filme animado ----------',
      '     Dois quadros de ruido interpolados: cintila como filme, nao como',
      '     chuvisco de TV. Mais grao no meio-tom/sombra, como negativo real,',
      '     e quase nada no realce (senao vira sujeira na nota estourada). */',
      '  float gt = uTime * 47.0;',
      '  float gA = hash13( vec3( gl_FragCoord.xy, floor( gt ) ) );',
      '  float gB = hash13( vec3( gl_FragCoord.xy + 19.71, floor( gt ) + 1.0 ) );',
      '  float g = mix( gA, gB, fract( gt ) ) - 0.5;',
      '  float lg = luma( col );',
      '  float gw = uGrain * ( 0.35 + 0.65 * ( 1.0 - smoothstep( 0.05, 0.80, lg ) ) )',
      '           * smoothstep( 0.0, 0.05, lg )',
      '           * ( 1.0 + uIntensity * 0.25 );',
      '  col += g * gw;',
      '',
      '  /* ---------- 14. dither por hash (mata banding no degrade) ---------- */',
      '  float d = hash13( vec3( gl_FragCoord.xy, 7.13 ) ) - 0.5;',
      '  col += d * ( 1.0 / 255.0 );',
      '',
      '  /* ---------- 15. fade de transicao ---------- */',
      '  col *= clamp( uFade, 0.0, 1.0 );',
      '',
      '  gl_FragColor = vec4( clamp( col, vec3( 0.0 ), vec3( 1.0 ) ), 1.0 );',
      '}'
    ].join('\n')
  };

  /* material do grade criado ja no load: assim GH.Engine.grade.uniforms existe
     antes mesmo do init(), e a identidade do objeto de uniforms nunca muda. */
  var gradeMaterial = new THREE.ShaderMaterial({
    name: 'guitarradaGrade',
    uniforms: THREE.UniformsUtils.clone(GuitarradaGradeShader.uniforms),
    vertexShader: GuitarradaGradeShader.vertexShader,
    fragmentShader: GuitarradaGradeShader.fragmentShader,
    depthTest: false,
    depthWrite: false
  });
  var gradeUniforms = gradeMaterial.uniforms;

  /* =======================================================================
     2. PRESETS DE CAMERA
     pos/look em unidades do mundo canonico (secao 3 do contrato).
     sway  = multiplicador do balanco procedural
     shake = multiplicador do tremor
     ======================================================================= */

  var CAM_PRESETS = {
    /* jogo normal — o enquadramento do contrato */
    gameplay:      { pos: [0.00, 3.05,  6.35], look: [ 0.00, 0.35,  -6.00], fov: 46, sway: 0.55, shake: 1.00, roll: 0.000 },
    /* variacao mais fechada pra solos */
    gameplay_close:{ pos: [0.00, 2.62,  5.50], look: [ 0.00, 0.28,  -7.60], fov: 44, sway: 0.45, shake: 1.05, roll: 0.000 },
    /* contagem regressiva: um passo atras, respirando */
    countdown:     { pos: [0.00, 3.62,  7.70], look: [ 0.00, 0.45,  -6.40], fov: 49, sway: 0.80, shake: 0.70, roll: 0.000 },
    /* plano cinematografico do palco (cap=stage_wide) */
    /* Fallback: quem manda de verdade neste preset e o GH.Stage.cameraRig,
       que o redefine no Engine assim que o palco existe (defineCamPreset).
       Mantido alinhado com ele para o caso de o palco falhar ao montar. */
    cinematic:     { pos: [-7.40, 4.55,  0.50], look: [ 0.80, 2.80, -30.00], fov: 43, sway: 1.35, shake: 1.25, roll: -0.028 },
    /* tela de titulo */
    title:         { pos: [ 0.85, 2.95,  9.40], look: [-0.45, 1.70,  -9.20], fov: 50, sway: 1.10, shake: 0.85, roll: 0.014 },
    /* selecao de musica / dificuldade */
    songselect:    { pos: [ 0.00, 2.55,  8.70], look: [ 0.00, 1.45,  -8.20], fov: 48, sway: 0.90, shake: 0.60, roll: 0.000 },
    /* resultados */
    results:       { pos: [ 0.00, 2.35,  7.60], look: [ 0.00, 1.15,  -3.60], fov: 40, sway: 0.80, shake: 0.50, roll: 0.000 },
    /* pausa: quase parada, so respirando */
    pause:         { pos: [ 0.00, 3.35,  6.95], look: [ 0.00, 0.50,  -5.60], fov: 43, sway: 0.22, shake: 0.00, roll: 0.000 }
  };
  /* apelidos usados pelas cenas de captura e pelo game.js */
  var CAM_ALIASES = {
    stage_wide: 'cinematic',
    wide: 'cinematic',
    difficulty: 'songselect',
    gameplay_sp: 'gameplay',
    gameplay_chords: 'gameplay',
    gameplay_miss: 'gameplay',
    playing: 'gameplay',
    boot: 'title'
  };

  /* =======================================================================
     3. TABELA DE QUALIDADE
     Cada nivel realmente mexe em pixelRatio, sombras, bloom, AA, shader e
     na contagem de particulas que os outros modulos leem.
     ======================================================================= */

  var QUALITY_TIERS = {
    low:   { renderScale: 0.70, shadows: false, shadowMapSize:  512, bloomScale: 0.30, aa: 'fxaa', msaa: 0,
             particles: 0.35, crowd: 0.30, detail: 0.0, reflections: false, texScale: 0.50, maxLights: 4,  anisotropy: 1 },
    med:   { renderScale: 0.85, shadows: true,  shadowMapSize: 1024, bloomScale: 0.45, aa: 'fxaa', msaa: 0,
             particles: 0.65, crowd: 0.60, detail: 0.0, reflections: false, texScale: 0.75, maxLights: 6,  anisotropy: 4 },
    high:  { renderScale: 1.00, shadows: true,  shadowMapSize: 2048, bloomScale: 0.60, aa: 'smaa', msaa: 0,
             particles: 1.00, crowd: 1.00, detail: 1.0, reflections: true,  texScale: 1.00, maxLights: 8,  anisotropy: 8 },
    ultra: { renderScale: 1.00, shadows: true,  shadowMapSize: 4096, bloomScale: 0.80, aa: 'smaa', msaa: 4,
             particles: 1.35, crowd: 1.35, detail: 1.0, reflections: true,  texScale: 1.00, maxLights: 10, anisotropy: 16 }
  };
  var QUALITY_ORDER = ['low', 'med', 'high', 'ultra'];

  /* =======================================================================
     4. ESTADO PRIVADO
     ======================================================================= */

  var state = {
    inited: false,
    canvas: null,
    running: false,
    frozen: false,
    wasRunningBeforeLoss: false,
    rafId: 0,
    lastTime: 0,
    frame: 0,            /* contador de frames renderizados */
    elapsed: 0,          /* tempo simulado acumulado (deterministico) */
    wallElapsed: 0,      /* tempo de parede, so pra diagnostico */
    exposureRef: 1.05,
    exposureBase: 1.05,
    bloomBase: 0.62,
    aaMode: 'smaa',
    hookTry: 0,
    settingsHooked: false,
    contextLost: false,
    composerOk: true,
    log: [],

    /* tamanho logico em CSS px e tamanho fisico em px de dispositivo */
    width: 1600, height: 900, pixelRatio: 1,
    forcedSize: null,

    /* passes */
    renderTarget: null,
    msaaSamples: 0,
    smaaReady: false,

    /* qualidade */
    quality: 'high',
    requestedQuality: 'high',
    autoQuality: true,
    autoDowngrades: 0,
    qualityCooldown: 0,

    /* fps */
    fps: 60, fpsInstant: 60, fpsAvg: 60, fpsSamples: [], fpsAccum: 0, fpsFrames: 0,
    slowSeconds: 0, fastSeconds: 0,

    /* dinamica de camera */
    rig: null,

    /* efeitos de tela */
    flashColor: new THREE.Color(1, 1, 1),
    flashAmount: 0,
    flashDecay: 6,
    bloomPulse: 0,
    bloomPulseDecay: 3.4,
    intensity: 0, intensityTarget: 0,
    starPower: 0, starPowerTarget: 0,

    /* tema */
    themeName: 'para',
    fogDensityBase: 0.0225,

    /* updaters */
    updaters: [],
    lateUpdaters: [],
    updaterLock: 0,
    pendingAdd: [],
    pendingAddLate: [],
    pendingRemove: [],
    updaterErrors: null,

    /* integracao opcional com o Conductor (kick no beat) */
    beatHooked: false
  };

  /* Cores padrao — espelham o tema "para" (Ver-o-Peso) de GH.Palette.
     Usadas quando a paleta ainda nao carregou ou nao expoe a chave procurada,
     pra que o engine sozinho ja tenha a cara certa do jogo. */
  var DEFAULT_THEME = {
    bg:      0x1e0b3a,   /* sky      — roxo profundo do entardecer */
    fog:     0x301246,   /* fog      — bruma roxa da baia */
    sky:     0xff7a4a,   /* haze     — bruma quente iluminada */
    ground:  0x3a1a50,   /* crowdTint— tom do publico no escuro */
    key:     0xffd9a8,   /* spotlight— refletor quente */
    fill:    0x25e8ce,   /* neon     — turquesa do rio Guajara */
    rim:     0xff3d8a,   /* highwayEdge — magenta da borda da pista */
    accent:  0x25e8ce,
    accent2: 0xff6a1e    /* groundGlow — laranja queimado do sol */
  };

  /* =======================================================================
     5. RIG DE CAMERA
     Base (preset, com tween) + sway procedural + respiracao + kick de beat +
     punch de acerto + tremor com mola. Tudo somado no fim do frame.
     ======================================================================= */

  function makeRig() {
    return {
      /* preset atual e transicao */
      name: 'gameplay',
      basePos:   new THREE.Vector3(0, 3.05, 6.35),
      baseLook:  new THREE.Vector3(0, 0.35, -6.0),
      baseFov:   46,
      baseRoll:  0,
      baseSway:  0.55,
      baseShake: 1.0,

      fromPos:  new THREE.Vector3(0, 3.05, 6.35),
      fromLook: new THREE.Vector3(0, 0.35, -6.0),
      fromFov:  46, fromRoll: 0, fromSway: 0.55, fromShake: 1.0,

      toPos:    new THREE.Vector3(0, 3.05, 6.35),
      toLook:   new THREE.Vector3(0, 0.35, -6.0),
      toFov:    46, toRoll: 0, toSway: 0.55, toShake: 1.0,

      tw: 1, twDur: 1,

      /* multiplicadores globais que outros modulos podem ajustar */
      swayScale: 1.0,
      shakeScale: 1.0,
      kickScale: 1.0,
      enabled: true,

      /* semente do ruido — trocada pelo RNG do modo captura */
      seed: 137.77,

      /* mola do kick (dolly no eixo de visao) */
      kickPos: 0, kickVel: 0, kickK: 210, kickC: 19,

      /* mola do punch (empurrao 3D no acerto) */
      punchPos: new THREE.Vector3(), punchVel: new THREE.Vector3(),
      punchK: 260, punchC: 22,

      /* tremor: trauma decai, e o deslocamento persegue o alvo por mola */
      trauma: 0, traumaDecay: 2.2, traumaFreq: 26,
      shakePos: new THREE.Vector3(), shakeVel: new THREE.Vector3(),
      shakeRot: new THREE.Vector3(), shakeRotVel: new THREE.Vector3(),
      shakeK: 340, shakeC: 17,

      /* zoom extra (star power / cinematica) */
      fovOffset: 0, fovOffsetTarget: 0,

      /* vetores de trabalho — zero alocacao no loop quente */
      _pos: new THREE.Vector3(),
      _look: new THREE.Vector3(),
      _fwd: new THREE.Vector3()
    };
  }

  function resolvePresetName(name) {
    if (!name) return 'gameplay';
    if (CAM_PRESETS[name]) return name;
    if (CAM_ALIASES[name] && CAM_PRESETS[CAM_ALIASES[name]]) return CAM_ALIASES[name];
    return 'gameplay';
  }

  /* aplica um preset como destino da transicao */
  function camPreset(name, durationSec) {
    var rig = state.rig;
    if (!rig) return;
    var key = resolvePresetName(name);
    var p = CAM_PRESETS[key];
    var dur = (durationSec === undefined) ? 1.1 : Math.max(0, durationSec);

    /* de onde saimos = onde a base esta AGORA (nao o destino antigo) */
    rig.fromPos.copy(rig.basePos);
    rig.fromLook.copy(rig.baseLook);
    rig.fromFov = rig.baseFov;
    rig.fromRoll = rig.baseRoll;
    rig.fromSway = rig.baseSway;
    rig.fromShake = rig.baseShake;

    rig.toPos.set(p.pos[0], p.pos[1], p.pos[2]);
    rig.toLook.set(p.look[0], p.look[1], p.look[2]);
    rig.toFov = p.fov;
    rig.toRoll = p.roll || 0;
    rig.toSway = (p.sway === undefined) ? 1 : p.sway;
    rig.toShake = (p.shake === undefined) ? 1 : p.shake;

    rig.name = key;

    if (dur <= 0.0001) {
      rig.tw = 1; rig.twDur = 1;
      rig.basePos.copy(rig.toPos);
      rig.baseLook.copy(rig.toLook);
      rig.baseFov = rig.toFov;
      rig.baseRoll = rig.toRoll;
      rig.baseSway = rig.toSway;
      rig.baseShake = rig.toShake;
    } else {
      rig.tw = 0; rig.twDur = dur;
    }
  }

  /* mola de 1 grau de liberdade (semi-implicito, estavel).
     Escreve em _sp1 pra nao alocar array nenhum no loop quente. */
  var _sp1 = { p: 0, v: 0 };
  function spring1(pos, vel, k, c, dt) {
    var v = vel + (-k * pos - c * vel) * dt;
    _sp1.v = v;
    _sp1.p = pos + v * dt;
    return _sp1;
  }
  function spring3(posV, velV, k, c, dt) {
    velV.x += (-k * posV.x - c * velV.x) * dt;
    velV.y += (-k * posV.y - c * velV.y) * dt;
    velV.z += (-k * posV.z - c * velV.z) * dt;
    posV.x += velV.x * dt;
    posV.y += velV.y * dt;
    posV.z += velV.z * dt;
  }
  /* mola perseguindo um alvo (usada pelo tremor) */
  function springTo3(posV, velV, tx, ty, tz, k, c, dt) {
    velV.x += (k * (tx - posV.x) - c * velV.x) * dt;
    velV.y += (k * (ty - posV.y) - c * velV.y) * dt;
    velV.z += (k * (tz - posV.z) - c * velV.z) * dt;
    posV.x += velV.x * dt;
    posV.y += velV.y * dt;
    posV.z += velV.z * dt;
  }

  function updateCameraRig(dt) {
    var rig = state.rig;
    var cam = GH.Engine.camera;
    if (!rig || !cam) return;

    var t = state.elapsed + rig.seed;

    /* ---- 1. transicao entre presets ---- */
    if (rig.tw < 1) {
      rig.tw = Math.min(1, rig.tw + dt / Math.max(0.0001, rig.twDur));
      var e = smootherstep(rig.tw);
      rig.basePos.lerpVectors(rig.fromPos, rig.toPos, e);
      rig.baseLook.lerpVectors(rig.fromLook, rig.toLook, e);
      rig.baseFov = lerp(rig.fromFov, rig.toFov, e);
      rig.baseRoll = lerp(rig.fromRoll, rig.toRoll, e);
      rig.baseSway = lerp(rig.fromSway, rig.toSway, e);
      rig.baseShake = lerp(rig.fromShake, rig.toShake, e);
    }

    /* ---- 2. dinamicas (molas) ---- */
    var kr = spring1(rig.kickPos, rig.kickVel, rig.kickK, rig.kickC, dt);
    rig.kickPos = kr.p; rig.kickVel = kr.v;
    if (Math.abs(rig.kickPos) < 1e-5 && Math.abs(rig.kickVel) < 1e-4) { rig.kickPos = 0; rig.kickVel = 0; }

    spring3(rig.punchPos, rig.punchVel, rig.punchK, rig.punchC, dt);

    rig.trauma = Math.max(0, rig.trauma - rig.traumaDecay * dt);
    var tr = rig.trauma * rig.trauma; /* quadratico: decai bonito */
    if (tr > 1e-6) {
      var ft = t * rig.traumaFreq;
      var tx = fbm1(ft) * tr;
      var ty = fbm1(ft + 57.3) * tr;
      var tz = fbm1(ft + 113.9) * tr * 0.6;
      springTo3(rig.shakePos, rig.shakeVel, tx, ty, tz, rig.shakeK, rig.shakeC, dt);
      springTo3(rig.shakeRot, rig.shakeRotVel,
        fbm1(ft + 211.1) * tr, fbm1(ft + 307.7) * tr, fbm1(ft + 401.3) * tr,
        rig.shakeK * 0.8, rig.shakeC * 1.1, dt);
    } else {
      springTo3(rig.shakePos, rig.shakeVel, 0, 0, 0, rig.shakeK, rig.shakeC, dt);
      springTo3(rig.shakeRot, rig.shakeRotVel, 0, 0, 0, rig.shakeK * 0.8, rig.shakeC * 1.1, dt);
      if (rig.shakePos.lengthSq() < 1e-10) { rig.shakePos.set(0, 0, 0); rig.shakeVel.set(0, 0, 0); }
    }

    rig.fovOffset = damp(rig.fovOffset, rig.fovOffsetTarget, 5.5, dt);

    /* ---- 3. sway procedural (respiracao do operador de camera) ----
       Amplitude minuscula de proposito: a pista precisa continuar legivel.
       Frequencias irracionais entre si pra nunca "bater" e virar padrao. */
    var swayAmp = 0.030 * rig.baseSway * rig.swayScale * (rig.enabled ? 1 : 0);
    var sx = fbm1(t * 0.171) * swayAmp * 1.00 + Math.sin(t * 0.53) * swayAmp * 0.18;
    var sy = fbm1(t * 0.213 + 31.4) * swayAmp * 0.72 + Math.sin(t * 1.45) * swayAmp * 0.30; /* respiracao */
    var sz = fbm1(t * 0.127 + 77.7) * swayAmp * 0.85;
    var swayRoll = fbm1(t * 0.109 + 151.1) * 0.0075 * rig.baseSway * rig.swayScale;
    /* o alvo balanca menos que a camera: enquadramento nao "nada" */
    var lx = fbm1(t * 0.147 + 211.9) * swayAmp * 0.34;
    var ly = fbm1(t * 0.191 + 263.3) * swayAmp * 0.26;

    /* ---- 4. monta a posicao final ---- */
    var pos = rig._pos.copy(rig.basePos);
    var look = rig._look.copy(rig.baseLook);

    var shk = rig.baseShake * rig.shakeScale;
    pos.x += sx + rig.shakePos.x * 0.160 * shk + rig.punchPos.x;
    pos.y += sy + rig.shakePos.y * 0.140 * shk + rig.punchPos.y;
    pos.z += sz + rig.shakePos.z * 0.100 * shk + rig.punchPos.z;
    look.x += lx + rig.shakePos.x * 0.055 * shk;
    look.y += ly + rig.shakePos.y * 0.048 * shk;

    /* kick: dolly no eixo de visao + leve subida */
    var fwd = rig._fwd.subVectors(look, pos);
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    fwd.normalize();
    pos.addScaledVector(fwd, rig.kickPos * 2.60 * rig.kickScale);
    pos.y += rig.kickPos * 0.90 * rig.kickScale;

    cam.position.copy(pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(look);

    /* roll: preset + sway + tremor rotacional */
    var roll = rig.baseRoll + swayRoll + rig.shakeRot.z * 0.075 * shk;
    if (Math.abs(roll) > 1e-6) cam.rotateZ(roll);
    /* pitch/yaw do tremor aplicados em espaco local (depois do lookAt) */
    if (tr > 1e-6 || rig.shakeRot.lengthSq() > 1e-9) {
      cam.rotateX(rig.shakeRot.y * 0.042 * shk);
      cam.rotateY(rig.shakeRot.x * 0.042 * shk);
    }

    /* fov: preset + kick + offset (star power abre um pouco) */
    var fov = rig.baseFov + rig.kickPos * 9.0 + rig.fovOffset;
    if (Math.abs(cam.fov - fov) > 0.0015) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  /* =======================================================================
     6. ILUMINACAO BASE DE PALCO
     key/fill/rim direcionais + hemisferica com as cores do tema + duas luzes
     pontuais de acento (linha de acerto e fundo do palco). Sombra so na key.
     ======================================================================= */

  function buildLights(scene) {
    var L = {};

    L.group = new THREE.Group();
    L.group.name = 'GH_Lights';

    /* piso minimo de luz: evita preto morto sem lavar a imagem.
       Baixo de proposito — a faixa dinamica AAA pede preto profundo. */
    L.ambient = new THREE.AmbientLight(0x2a3350, 0.10);

    /* hemisferica: bruma do tema em cima, tom do publico embaixo */
    L.hemi = new THREE.HemisphereLight(DEFAULT_THEME.sky, DEFAULT_THEME.ground, 0.34);
    L.hemi.position.set(0, 20, 0);

    /* KEY — vem de cima/direita/frente. E quem faz a sombra. */
    L.key = new THREE.DirectionalLight(DEFAULT_THEME.key, 3.10);
    L.key.position.set(5.4, 9.2, 5.6);
    L.key.castShadow = true;
    L.key.shadow.mapSize.set(2048, 2048);
    L.key.shadow.camera.near = 0.5;
    L.key.shadow.camera.far = 48;
    L.key.shadow.camera.left = -14;
    L.key.shadow.camera.right = 14;
    L.key.shadow.camera.top = 17;
    L.key.shadow.camera.bottom = -13;
    L.key.shadow.bias = -0.0006;
    L.key.shadow.normalBias = 0.022;
    L.key.shadow.radius = 2.5;
    L.keyTarget = new THREE.Object3D();
    L.keyTarget.position.set(0, 0, -5);
    L.key.target = L.keyTarget;

    /* FILL — frio, do lado oposto, sem sombra */
    L.fill = new THREE.DirectionalLight(DEFAULT_THEME.fill, 0.70);
    L.fill.position.set(-6.8, 4.4, 4.2);
    L.fillTarget = new THREE.Object3D();
    L.fillTarget.position.set(0, 0.4, -6);
    L.fill.target = L.fillTarget;

    /* RIM — magenta vindo de tras do palco, recorta as silhuetas */
    /* RIM: contraluz que desenha a borda da pista. Media 2.55 lavava o conves
       inteiro com a cor do tema (magenta no para, AMARELO no frevo) e as gems
       perdiam o contraste — medido nos prints. Aqui ele volta a ser um
       contraluz, nao um banho. */
    L.rim = new THREE.DirectionalLight(DEFAULT_THEME.rim, 1.05);
    L.rim.position.set(-2.6, 5.8, -14.0);
    L.rimTarget = new THREE.Object3D();
    L.rimTarget.position.set(0, 1.2, 2.0);
    L.rim.target = L.rimTarget;

    /* RIM 2 — contraluz quente do outro lado, fecha o tres-pontos por tras */
    L.rim2 = new THREE.DirectionalLight(DEFAULT_THEME.accent2, 0.52);
    L.rim2.position.set(7.5, 4.2, -12.0);
    L.rim2.target = L.rimTarget;

    /* luz pontual na linha de acerto: da volume nas gems que passam ali.
       physicallyCorrectLights = true -> intensidade em candela, com 1/d^2. */
    L.strike = new THREE.PointLight(DEFAULT_THEME.accent, 2.0, 11, 2);
    L.strike.position.set(0, 1.35, 0.55);

    /* brilho do fundo do palco: puxa o olho pra profundidade */
    L.backGlow = new THREE.PointLight(DEFAULT_THEME.accent2, 20, 46, 2);
    L.backGlow.position.set(0, 3.4, -24);

    L.group.add(L.ambient, L.hemi, L.key, L.keyTarget, L.fill, L.fillTarget,
                L.rim, L.rim2, L.rimTarget, L.strike, L.backGlow);
    scene.add(L.group);

    /* intensidades base guardadas: os pulsos multiplicam sobre elas */
    L.base = {
      ambient: L.ambient.intensity, hemi: L.hemi.intensity, key: L.key.intensity,
      fill: L.fill.intensity, rim: L.rim.intensity, rim2: L.rim2.intensity,
      strike: L.strike.intensity, backGlow: L.backGlow.intensity
    };

    /* ajuste do volume de sombra (o agente de palco pode chamar) */
    L.setShadowBounds = function (halfX, zNear, zFar, top) {
      var c = L.key.shadow.camera;
      c.left = -Math.abs(halfX); c.right = Math.abs(halfX);
      c.top = (top === undefined) ? 17 : top;
      c.bottom = -Math.abs((top === undefined ? 17 : top) * 0.76);
      c.near = (zNear === undefined) ? 0.5 : zNear;
      c.far = (zFar === undefined) ? 48 : zFar;
      c.updateProjectionMatrix();
      if (L.key.shadow.map) { L.key.shadow.map.dispose(); L.key.shadow.map = null; }
    };

    return L;
  }

  /* pulso de luz no beat — as pontuais respiram junto com a musica */
  function updateLights(dt) {
    var L = GH.Engine.lights;
    if (!L || !L.base) return;
    var pulse = state.bloomPulse;
    var sp = state.starPower;
    L.strike.intensity = L.base.strike * (1 + pulse * 0.85 + sp * 0.55);
    L.backGlow.intensity = L.base.backGlow * (1 + pulse * 0.35 + sp * 0.40);
    L.rim.intensity = L.base.rim * (1 + pulse * 0.18 + sp * 0.30);
  }

  /* =======================================================================
     7. TEMA / NEBLINA
     ======================================================================= */

  function currentTheme() {
    try {
      if (GH.Palette) {
        if (GH.Palette.themes && GH.Palette.themes[state.themeName]) return GH.Palette.themes[state.themeName];
        if (GH.Palette.current) return GH.Palette.current;
      }
    } catch (e) { /* paleta ainda nao carregou */ }
    return null;
  }

  /* Mapeia o tema de GH.Palette para o rig de luz.
     As chaves reais do palette.js sao: sky, horizon, fog, highway, highwayEdge,
     neon, crowdTint, accent, haze, spotlight, groundGlow, shadow, mirror,
     stageLight[3], sunset[5], mood{bloom,exposure,fogNear,fogFar,ambient}.
     Ainda assim procuramos nomes genericos antes, pra nunca quebrar caso a
     paleta mude de forma. */
  function applyTheme(name) {
    if (typeof name === 'string' && name) state.themeName = name;
    var th = (name && typeof name === 'object') ? name : currentTheme();
    if (th && th.id) state.themeName = th.id;

    /* neblina e fundo: onde a pista morre no horizonte */
    var cFog    = themePick(th, ['fog', 'fogColor'], DEFAULT_THEME.fog);
    var cBg     = themePick(th, ['sky', 'bg', 'background'], DEFAULT_THEME.bg);
    /* hemisferica: "ceu" = a bruma iluminada do tema, "chao" = tom do publico */
    var cSky    = themePick(th, ['haze', 'horizon', 'hemiSky'], DEFAULT_THEME.sky);
    var cGround = themePick(th, ['crowdTint', 'highway', 'ground', 'shadow'], DEFAULT_THEME.ground);
    /* tres pontos */
    var cKey    = themePick(th, ['spotlight', 'key', 'keyLight'], DEFAULT_THEME.key);
    var cFill   = themePick(th, ['neon', 'fill', 'mirror'], DEFAULT_THEME.fill);
    var cRim    = themePick(th, ['highwayEdge', 'rim', 'uiAccent'], DEFAULT_THEME.rim);
    var cAcc    = themePick(th, ['neon', 'accent'], DEFAULT_THEME.accent);
    var cAcc2   = themePick(th, ['groundGlow', 'horizon', 'accent'], DEFAULT_THEME.accent2);

    /* mood: numeros de apoio do tema (bloom, exposicao, alcance da nevoa) */
    var mood = (th && th.mood) ? th.mood : null;
    var moodBloom = (mood && isFinite(mood.bloom)) ? clamp(mood.bloom, 0.4, 2.0) : 1.0;
    var moodExpo  = (mood && isFinite(mood.exposure)) ? clamp(mood.exposure, 0.6, 1.6) : 1.0;
    var moodAmb   = (mood && isFinite(mood.ambient)) ? clamp(mood.ambient, 0.05, 1.0) : 0.40;
    var moodFar   = (mood && isFinite(mood.fogFar)) ? clamp(mood.fogFar, 20, 120) : 50;

    /* BLOOM: 0.62 estourava a linha de acerto num disco branco-laranja que
       engolia as gems. O contrato e claro — espetaculo nunca vence
       legibilidade. 0.38 ainda da o veu de luz do palco sem comer a nota. */
    state.bloomBase = 0.38 * moodBloom;
    /* exposicao do tema com teto: o frevo pedia 1.12 e lavava a pista */
    state.exposureBase = state.exposureRef * Math.min(moodExpo, 1.03);
    if (GH.Engine.renderer) GH.Engine.renderer.toneMappingExposure = state.exposureBase;

    /* FogExp2 a partir do fogFar do tema: ~27% de visibilidade la no fundo,
       o suficiente pra pista sumir com elegancia sem esconder as notas. */
    state.fogDensityBase = clamp(1.15 / moodFar, 0.010, 0.050);

    /* O fluxo legado de cor do r147 entrega o hex bem mais claro do que ele
       parece no editor. Pro CEU e pra NEVOA — que ocupam metade da tela e
       nao tem material nenhum pra segurar — isso vira um cinza-lilas leitoso.
       Entao escurecemos o fundo (so o fundo, nunca material dos outros) e
       aproximamos a nevoa dele: assim a pista some no horizonte sem costura. */
    /* Mais fundo ainda que antes. A NEBLINA e o que pinta o terreno da
       plateia dos dois lados da pista: no tema frevo (fog #134e92) ela
       levantava aqueles ~10% de tela para um azul medio CHAPADO — o espaco
       morto do briefing, so que azul. Em 0.42 o ar do lugar continua tendo
       cor, mas o valor cai para a faixa de noite e o preto volta a ser preto. */
    var cBgDeep = cBg.clone().multiplyScalar(0.32);
    var cFogDeep = cFog.clone().multiplyScalar(0.42).lerp(cBgDeep, 0.55);

    var scene = GH.Engine.scene;
    if (scene) {
      if (scene.fog && scene.fog.isFogExp2) {
        scene.fog.color.copy(cFogDeep);
        scene.fog.density = state.fogDensityBase;
      } else {
        scene.fog = new THREE.FogExp2(cFogDeep.getHex(), state.fogDensityBase);
      }
      GH.Engine.fog = scene.fog;
      if (scene.background && scene.background.isColor) scene.background.copy(cBgDeep);
      else if (!scene.background) scene.background = cBgDeep.clone();
    }
    if (GH.Engine.renderer) GH.Engine.renderer.setClearColor(cBgDeep, 1);

    var L = GH.Engine.lights;
    if (L) {
      L.hemi.color.copy(cSky);
      L.hemi.groundColor.copy(cGround);
      L.key.color.copy(cKey);
      L.fill.color.copy(cFill);
      L.rim.color.copy(cRim);
      L.rim2.color.copy(cAcc2);
      L.strike.color.copy(cAcc);
      L.backGlow.color.copy(cAcc2);

      /* o "ambient" do tema diz o quanto o ar do lugar e claro.
         Faixa curta e baixa: preto profundo primeiro, luz depois. */
      L.hemi.intensity = L.base.hemi = 0.16 + 0.42 * moodAmb;
      L.ambient.intensity = L.base.ambient = 0.045 + 0.14 * moodAmb;

      /* NORMALIZACAO DE FLUXO DAS CONTRALUZES.
         A cor vem do tema e a luminancia dela varia MUITO entre temas
         (magenta do para ~0.25 de luma; amarelo do frevo ~0.85). Com
         intensidade fixa, o frevo virava um banho de mostarda sobre a pista
         inteira. Aqui o fluxo e dividido pela luminancia normalizada, entao
         todo tema entrega a MESMA quantidade de luz — so muda a cor. */
      L.base.rim   = 1.05 * lumaNorm(cRim);
      L.base.rim2  = 0.52 * lumaNorm(cAcc2);
      L.base.fill  = 0.70 * lumaNorm(cFill);
      L.rim.intensity  = L.base.rim;
      L.rim2.intensity = L.base.rim2;
      L.fill.intensity = L.base.fill;
    }

    GH.Engine.themeColors = {
      bg: cBgDeep, fog: cFogDeep, bgRaw: cBg, fogRaw: cFog,
      sky: cSky, ground: cGround,
      key: cKey, fill: cFill, rim: cRim, accent: cAcc, accent2: cAcc2
    };
    GH.Engine.themeName = state.themeName;
    dispatch('theme', state.themeName);
  }

  function setFog(color, density) {
    var scene = GH.Engine.scene;
    if (!scene) return;
    if (density !== undefined && isFinite(density)) state.fogDensityBase = Math.max(0, density);
    if (!scene.fog || !scene.fog.isFogExp2) {
      scene.fog = new THREE.FogExp2(toColor(color, DEFAULT_THEME.fog).getHex(), state.fogDensityBase);
    } else {
      if (color !== undefined && color !== null) scene.fog.color.copy(toColor(color, DEFAULT_THEME.fog));
      scene.fog.density = state.fogDensityBase;
    }
    GH.Engine.fog = scene.fog;
  }

  /* =======================================================================
     8. COMPOSER E PASSES
     Ordem: RenderPass -> UnrealBloomPass -> guitarradaGrade -> SMAA/FXAA
     ======================================================================= */

  function chooseRTType(renderer) {
    /* Meio-float mata o banding do degrade do fundo e deixa o bloom bem mais
       bonito. Em WebGL2 o RGBA16F so e renderizavel com EXT_color_buffer_float
       (ou _half_float); `extensions.has()` ja habilita a extensao. */
    try {
      var ext = renderer.extensions;
      if (ext && (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'))) {
        return THREE.HalfFloatType;
      }
    } catch (e) { /* sem extensao -> byte */ }
    return THREE.UnsignedByteType;
  }

  function buildComposer() {
    var renderer = GH.Engine.renderer;
    var scene = GH.Engine.scene;
    var camera = GH.Engine.camera;
    var tier = QUALITY_TIERS[state.quality] || QUALITY_TIERS.high;

    var pw = Math.max(2, Math.round(state.width * state.pixelRatio));
    var ph = Math.max(2, Math.round(state.height * state.pixelRatio));

    var rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: chooseRTType(renderer),
      stencilBuffer: false,
      depthBuffer: true
    };
    state.msaaSamples = (tier.msaa > 0 && renderer.capabilities && renderer.capabilities.isWebGL2 && !isCapture()) ? tier.msaa : 0;

    var rt = new THREE.WebGLRenderTarget(pw, ph, rtOpts);
    rt.texture.name = 'GH.composer.rt';
    if (state.msaaSamples > 0) { try { rt.samples = state.msaaSamples; } catch (e) { state.msaaSamples = 0; } }
    state.renderTarget = rt;

    /* passando um RT explicito, o composer trabalha com _pixelRatio = 1;
       ou seja, sempre falamos com ele em PIXELS DE DISPOSITIVO. */
    var composer = new THREE.EffectComposer(renderer, rt);
    composer.setSize(pw, ph);

    /* --- 1. cena --- */
    var renderPass = new THREE.RenderPass(scene, camera);
    renderPass.clear = true;
    composer.addPass(renderPass);

    /* --- 2. bloom seletivo --- */
    var bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(Math.round(pw * tier.bloomScale), Math.round(ph * tier.bloomScale)),
      0.62,  /* strength — o pulso soma por cima */
      0.72,  /* radius   — halo largo e macio */
      0.85   /* threshold alto: SO o que e emissivo estoura */
    );
    composer.addPass(bloomPass);

    /* --- 3. grade custom (e quem converte linear -> sRGB) --- */
    var gradePass = new THREE.ShaderPass(gradeMaterial);
    gradePass.material.depthTest = false;
    gradePass.material.depthWrite = false;
    composer.addPass(gradePass);

    /* --- 4. antialiasing (ultima passada) --- */
    var smaaPass = null, fxaaPass = null;
    try {
      smaaPass = new THREE.SMAAPass(pw, ph);
      composer.addPass(smaaPass);
    } catch (e) { warn('SMAAPass indisponivel, usando FXAA', e); }

    try {
      fxaaPass = new THREE.ShaderPass(THREE.FXAAShader);
      fxaaPass.material.transparent = false;
      fxaaPass.uniforms.resolution.value.set(1 / pw, 1 / ph);
      composer.addPass(fxaaPass);
    } catch (e) { warn('FXAAShader indisponivel', e); }

    GH.Engine.composer = composer;
    GH.Engine.renderPass = renderPass;
    GH.Engine.bloomPass = bloomPass;
    GH.Engine.grade = gradePass;
    GH.Engine.smaaPass = smaaPass;
    GH.Engine.fxaaPass = fxaaPass;
    state.composerOk = true;
    state.smaaReady = false;

    applyAAMode(tier.aa);
    applyBloomResolution(tier.bloomScale);
    updateGradeResolution();
  }

  function disposeComposer() {
    var c = GH.Engine.composer;
    if (!c) return;
    try {
      for (var i = 0; i < c.passes.length; i++) {
        var p = c.passes[i];
        /* o material do grade e nosso e reaproveitado entre reconstrucoes */
        if (p === GH.Engine.grade) continue;
        /* o Pass base tem dispose() vazio: os RTs do SMAA vao na mao */
        if (p && p.edgesRT && p.edgesRT.dispose) p.edgesRT.dispose();
        if (p && p.weightsRT && p.weightsRT.dispose) p.weightsRT.dispose();
        if (p && typeof p.dispose === 'function') p.dispose();
      }
      c.dispose();
    } catch (e) { warn('falha ao descartar composer', e); }
    GH.Engine.composer = null;
    GH.Engine.bloomPass = null;
    GH.Engine.smaaPass = null;
    GH.Engine.fxaaPass = null;
    GH.Engine.renderPass = null;
    state.renderTarget = null;
  }

  function applyAAMode(mode) {
    var smaa = GH.Engine.smaaPass, fxaa = GH.Engine.fxaaPass;
    state.aaMode = mode;
    if (mode === 'off') {
      if (smaa) smaa.enabled = false;
      if (fxaa) fxaa.enabled = false;
      return;
    }
    if (mode === 'smaa' && smaa) {
      /* as texturas do SMAA sao data-URI carregadas de forma assincrona;
         ate elas ficarem prontas usamos FXAA pra nao piscar tela quebrada */
      var ready = smaaTexturesReady(smaa);
      smaa.enabled = ready;
      if (fxaa) fxaa.enabled = !ready;
      return;
    }
    if (smaa) smaa.enabled = false;
    if (fxaa) fxaa.enabled = true;
  }

  function smaaTexturesReady(smaa) {
    if (state.smaaReady) return true;
    try {
      var a = smaa.areaTexture && smaa.areaTexture.image;
      var s = smaa.searchTexture && smaa.searchTexture.image;
      if (a && s && a.complete === true && s.complete === true && a.width > 0 && s.width > 0) {
        state.smaaReady = true;
        return true;
      }
    } catch (e) { /* ignora */ }
    return false;
  }

  function applyBloomResolution(scaleFactor) {
    var b = GH.Engine.bloomPass;
    if (!b) return;
    var pw = Math.max(4, Math.round(state.width * state.pixelRatio * scaleFactor));
    var ph = Math.max(4, Math.round(state.height * state.pixelRatio * scaleFactor));
    b.setSize(pw, ph);
  }

  function updateGradeResolution() {
    var pw = Math.max(2, Math.round(state.width * state.pixelRatio));
    var ph = Math.max(2, Math.round(state.height * state.pixelRatio));
    gradeUniforms.uResolution.value.set(pw, ph);
    gradeUniforms.uAspect.value = pw / Math.max(1, ph);
  }

  /* =======================================================================
     9. QUALIDADE
     ======================================================================= */

  function baseDevicePixelRatio() {
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    if (!isFinite(dpr) || dpr <= 0) dpr = 1;
    return Math.min(dpr, 2);
  }

  function setQuality(name, opts) {
    var key = (typeof name === 'string') ? name.toLowerCase() : state.quality;
    if (!QUALITY_TIERS[key]) key = 'high';
    var manual = !(opts && opts.auto === true);
    if (manual) {
      state.requestedQuality = key;
      state.autoDowngrades = 0;
      state.slowSeconds = 0;
      state.fastSeconds = 0;
    }
    var changed = (state.quality !== key);
    state.quality = key;
    GH.Engine.quality = key;

    var tier = QUALITY_TIERS[key];

    /* ---- espelha na tabela publica que os outros modulos leem ---- */
    var qs = GH.Engine.qualityScale;
    qs.name = key;
    qs.particles = tier.particles;
    qs.crowd = tier.crowd;
    qs.shadows = tier.shadows;
    qs.shadowMapSize = tier.shadowMapSize;
    qs.bloomScale = tier.bloomScale;
    qs.aa = tier.aa;
    qs.detail = tier.detail;
    qs.reflections = tier.reflections;
    qs.texScale = tier.texScale;
    qs.maxLights = tier.maxLights;
    qs.anisotropy = tier.anisotropy;
    qs.renderScale = tier.renderScale;
    qs.index = QUALITY_ORDER.indexOf(key);

    if (!state.inited) return key;

    var renderer = GH.Engine.renderer;

    /* ---- pixel ratio ---- */
    var pr = clamp(baseDevicePixelRatio() * tier.renderScale, 0.5, 2);
    if (isCapture()) pr = 1; /* headless: 1:1 sempre, print deterministico */
    if (Math.abs(pr - state.pixelRatio) > 0.001) {
      state.pixelRatio = pr;
      renderer.setPixelRatio(pr);
      applySizeToTargets();
    }
    qs.pixelRatio = state.pixelRatio;

    /* ---- sombras ---- */
    renderer.shadowMap.enabled = tier.shadows;
    var L = GH.Engine.lights;
    if (L && L.key) {
      L.key.castShadow = tier.shadows;
      if (L.key.shadow.mapSize.x !== tier.shadowMapSize) {
        L.key.shadow.mapSize.set(tier.shadowMapSize, tier.shadowMapSize);
        if (L.key.shadow.map) { L.key.shadow.map.dispose(); L.key.shadow.map = null; }
      }
    }
    renderer.shadowMap.needsUpdate = true;

    /* ---- bloom / shader / AA ---- */
    applyBloomResolution(tier.bloomScale);
    gradeUniforms.uDetail.value = tier.detail;
    gradeUniforms.uHalo.value = tier.detail > 0.5 ? 0.10 : 0.0;
    gradeUniforms.uGrain.value = tier.detail > 0.5 ? 0.030 : 0.020;
    applyAAMode(tier.aa);

    /* ---- MSAA muda o render target: precisa reconstruir a cadeia ---- */
    var wantMsaa = (tier.msaa > 0 && renderer.capabilities && renderer.capabilities.isWebGL2 && !isCapture()) ? tier.msaa : 0;
    if (wantMsaa !== state.msaaSamples) {
      disposeComposer();
      buildComposer();
    }

    if (changed) dispatch('quality', key);
    return key;
  }

  function stepQuality(delta) {
    var i = QUALITY_ORDER.indexOf(state.quality);
    var j = clamp(i + delta, 0, QUALITY_ORDER.length - 1);
    if (j === i) return false;
    setQuality(QUALITY_ORDER[j], { auto: true });
    return true;
  }

  /* auto-degradacao: nunca em modo captura (contrato, secao 7) */
  function updateAutoQuality(dt) {
    if (!state.autoQuality || isCapture()) return;
    state.qualityCooldown = Math.max(0, state.qualityCooldown - dt);
    if (state.qualityCooldown > 0) return;
    if (state.frame < 90) return; /* ignora o aquecimento de shaders */

    /* decide pelo pior entre a media exponencial e a media das amostras de
       1s: descer de qualidade e barato, subir de novo e que e caro. */
    var f = (state.fpsSamples.length >= 2) ? Math.min(state.fps, state.fpsAvg) : state.fps;
    if (f < 46) {
      state.slowSeconds += dt;
      state.fastSeconds = 0;
    } else if (f > 57.5) {
      state.fastSeconds += dt;
      state.slowSeconds = 0;
    } else {
      state.slowSeconds = Math.max(0, state.slowSeconds - dt * 0.5);
      state.fastSeconds = Math.max(0, state.fastSeconds - dt * 0.5);
    }

    if (state.slowSeconds > 2.2 && QUALITY_ORDER.indexOf(state.quality) > 0) {
      if (stepQuality(-1)) {
        state.autoDowngrades++;
        state.qualityCooldown = 4.0;
        state.slowSeconds = 0;
        warn('fps baixo (' + f.toFixed(1) + ') -> qualidade ' + state.quality);
      }
    } else if (state.autoDowngrades > 0 && state.fastSeconds > 14 &&
               QUALITY_ORDER.indexOf(state.quality) < QUALITY_ORDER.indexOf(state.requestedQuality)) {
      if (stepQuality(1)) {
        state.autoDowngrades--;
        state.qualityCooldown = 8.0;
        state.fastSeconds = 0;
      }
    }
  }

  /* =======================================================================
     10. TAMANHO / RESIZE
     ======================================================================= */

  function isCapture() {
    return !!(typeof window !== 'undefined' && window.__GH_CAP);
  }

  function captureSize() {
    var cap = window.__GH_CAP;
    if (cap && typeof cap === 'object') {
      var w = +(cap.w || cap.width || 0);
      var h = +(cap.h || cap.height || 0);
      if (w > 16 && h > 16) return { w: Math.round(w), h: Math.round(h) };
    }
    return null;
  }

  function measure() {
    if (state.forcedSize) return { w: state.forcedSize.w, h: state.forcedSize.h };
    var cs = captureSize();
    if (cs) return cs;
    var el = state.canvas;
    var w = 0, h = 0;
    if (el) {
      var p = el.parentNode;
      w = el.clientWidth || (p && p.clientWidth) || 0;
      h = el.clientHeight || (p && p.clientHeight) || 0;
    }
    if (!w || !h) {
      w = window.innerWidth || document.documentElement.clientWidth || 1280;
      h = window.innerHeight || document.documentElement.clientHeight || 720;
    }
    return { w: Math.max(16, Math.round(w)), h: Math.max(16, Math.round(h)) };
  }

  function applySizeToTargets() {
    var pw = Math.max(2, Math.round(state.width * state.pixelRatio));
    var ph = Math.max(2, Math.round(state.height * state.pixelRatio));
    var tier = QUALITY_TIERS[state.quality] || QUALITY_TIERS.high;

    if (GH.Engine.composer) {
      GH.Engine.composer.setSize(pw, ph);          /* RTs + todos os passes */
      applyBloomResolution(tier.bloomScale);       /* bloom em resolucao propria */
      if (GH.Engine.smaaPass) GH.Engine.smaaPass.setSize(pw, ph);
      if (GH.Engine.fxaaPass) GH.Engine.fxaaPass.uniforms.resolution.value.set(1 / pw, 1 / ph);
    }
    updateGradeResolution();
  }

  function resize() {
    if (!state.inited) return;
    var m = measure();
    var cam = GH.Engine.camera;
    var renderer = GH.Engine.renderer;

    state.width = m.w;
    state.height = m.h;

    var pr = clamp(baseDevicePixelRatio() * (QUALITY_TIERS[state.quality] || QUALITY_TIERS.high).renderScale, 0.5, 2);
    if (isCapture()) pr = 1;
    state.pixelRatio = pr;
    GH.Engine.qualityScale.pixelRatio = pr;

    renderer.setPixelRatio(pr);
    renderer.setSize(m.w, m.h, !!state.forcedSize || !!captureSize());

    cam.aspect = m.w / Math.max(1, m.h);
    cam.updateProjectionMatrix();

    applySizeToTargets();
    dispatch('resize', m);
  }

  function setSize(w, h, force) {
    if (force) state.forcedSize = { w: Math.max(16, Math.round(w)), h: Math.max(16, Math.round(h)) };
    else state.forcedSize = null;
    resize();
  }

  /* =======================================================================
     11. UPDATERS (com remocao segura durante a iteracao)
     ======================================================================= */

  function addUpdater(fn) {
    if (typeof fn !== 'function') return fn;
    if (state.updaterLock > 0) { state.pendingAdd.push(fn); return fn; }
    if (state.updaters.indexOf(fn) < 0) state.updaters.push(fn);
    return fn;
  }

  function removeUpdater(fn) {
    if (typeof fn !== 'function') return fn;
    if (state.updaterLock > 0) { state.pendingRemove.push(fn); return fn; }
    var i = state.updaters.indexOf(fn);
    if (i >= 0) state.updaters.splice(i, 1);
    var j = state.lateUpdaters.indexOf(fn);
    if (j >= 0) state.lateUpdaters.splice(j, 1);
    return fn;
  }

  /* updaters "tardios": rodam DEPOIS do rig de camera do frame.
     E o gancho certo pra billboard, lens flare e qualquer coisa que precise
     da camera ja no lugar definitivo deste frame. */
  function addLateUpdater(fn) {
    if (typeof fn !== 'function') return fn;
    if (state.updaterLock > 0) { state.pendingAddLate.push(fn); return fn; }
    if (state.lateUpdaters.indexOf(fn) < 0) state.lateUpdaters.push(fn);
    return fn;
  }

  function flushUpdaterQueue() {
    var i, k;
    if (state.pendingRemove.length) {
      for (i = 0; i < state.pendingRemove.length; i++) {
        k = state.updaters.indexOf(state.pendingRemove[i]);
        if (k >= 0) state.updaters.splice(k, 1);
        k = state.lateUpdaters.indexOf(state.pendingRemove[i]);
        if (k >= 0) state.lateUpdaters.splice(k, 1);
      }
      state.pendingRemove.length = 0;
    }
    if (state.pendingAdd.length) {
      for (i = 0; i < state.pendingAdd.length; i++) {
        if (state.updaters.indexOf(state.pendingAdd[i]) < 0) state.updaters.push(state.pendingAdd[i]);
      }
      state.pendingAdd.length = 0;
    }
    if (state.pendingAddLate.length) {
      for (i = 0; i < state.pendingAddLate.length; i++) {
        if (state.lateUpdaters.indexOf(state.pendingAddLate[i]) < 0) state.lateUpdaters.push(state.pendingAddLate[i]);
      }
      state.pendingAddLate.length = 0;
    }
  }

  function runList(list, dt, elapsed, label) {
    state.updaterLock++;
    for (var i = 0; i < list.length; i++) {
      var fn = list[i];
      if (!fn) continue;
      try {
        fn(dt, elapsed);
        if (state.updaterErrors && state.updaterErrors.has(fn)) state.updaterErrors.delete(fn);
      } catch (err) {
        if (!state.updaterErrors) state.updaterErrors = new Map();
        var n = (state.updaterErrors.get(fn) || 0) + 1;
        state.updaterErrors.set(fn, n);
        if (n === 1 || n === 8) warn(label + ' lancou excecao (' + n + 'x)', err);
        /* um modulo quebrado nao pode derrubar o jogo inteiro */
        if (n >= 8) { state.pendingRemove.push(fn); warn(label + ' removido apos 8 falhas seguidas'); }
      }
    }
    state.updaterLock--;
    if (state.updaterLock === 0) flushUpdaterQueue();
  }

  function runUpdaters(dt, elapsed) { runList(state.updaters, dt, elapsed, 'updater'); }
  function runLateUpdaters(dt, elapsed) { runList(state.lateUpdaters, dt, elapsed, 'lateUpdater'); }

  /* =======================================================================
     12. EVENTOS SIMPLES (resize / quality / contextlost)
     ======================================================================= */

  var listeners = {};
  function on(name, fn) {
    if (typeof fn !== 'function') return fn;
    (listeners[name] = listeners[name] || []).push(fn);
    return fn;
  }
  function off(name, fn) {
    var l = listeners[name];
    if (!l) return;
    var i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  function dispatch(name, payload) {
    var l = listeners[name];
    if (!l) return;
    for (var i = 0; i < l.length; i++) {
      try { l[i](payload); } catch (e) { warn('listener "' + name + '" falhou', e); }
    }
  }

  /* =======================================================================
     13. EFEITOS DE TELA (flash, bloom pulse, intensidade)
     ======================================================================= */

  function flash(color, intensity, durationSec) {
    var c = toColor(color, 0xffffff);
    var amt = clamp((intensity === undefined) ? 0.5 : intensity, 0, 1.6);
    var dur = Math.max(0.02, (durationSec === undefined) ? 0.16 : durationSec);
    if (amt >= state.flashAmount * 0.85) state.flashColor.copy(c);
    else state.flashColor.lerp(c, 0.35);
    state.flashAmount = Math.max(state.flashAmount, amt);
    state.flashDecay = 1 / dur;
  }

  function bloomPulse(amount, decay) {
    state.bloomPulse += (amount === undefined ? 0.35 : amount);
    state.bloomPulse = Math.min(state.bloomPulse, 2.2);
    if (decay !== undefined && decay > 0) state.bloomPulseDecay = decay;
  }

  function shake(intensity, durationSec) {
    var rig = state.rig;
    if (!rig) return;
    var amt = clamp((intensity === undefined) ? 0.4 : intensity, 0, 1.5);
    var dur = Math.max(0.05, (durationSec === undefined) ? 0.35 : durationSec);
    rig.trauma = Math.min(1.25, rig.trauma + amt);
    rig.traumaDecay = 1 / dur;
    /* impulso imediato na mola: o primeiro solavanco e o que se sente */
    rig.shakeVel.x += (fbm1(state.elapsed * 91.3) * amt) * 6.0;
    rig.shakeVel.y += (fbm1(state.elapsed * 71.7 + 13.1) * amt) * 5.0;
    rig.shakeRotVel.z += (fbm1(state.elapsed * 53.9 + 27.3) * amt) * 4.0;
  }

  /* kick do beat: a camera "recua" um tico e volta por mola.
     amount 0.02 = batida fraca, 0.05 = batida forte, 0.12 = virada. */
  function kick(amount) {
    var rig = state.rig;
    if (!rig) return;
    var a = clamp((amount === undefined) ? 0.05 : amount, 0, 0.6);
    rig.kickVel -= a * 13.0;
  }

  /* punch do acerto: empurrao curto, com direcao lateral da raia */
  function punch(amount, dirX) {
    var rig = state.rig;
    if (!rig) return;
    var a = clamp((amount === undefined) ? 0.05 : amount, 0, 0.6);
    var dx = (dirX === undefined) ? 0 : clamp(dirX, -1, 1);
    rig.punchVel.x += dx * a * 16.0;
    rig.punchVel.y += a * 9.0;
    rig.punchVel.z += a * 13.0;
  }

  /* atalho pro gameplay: punch a partir da raia acertada */
  function punchLane(laneIdx, amount) {
    var dx = 0;
    try {
      if (GH.Layout && typeof GH.Layout.laneX === 'function' && typeof laneIdx === 'number') {
        dx = clamp(GH.Layout.laneX(laneIdx) / Math.max(0.001, GH.Layout.HALF_W || 1.8), -1, 1);
      }
    } catch (e) { dx = 0; }
    punch(amount === undefined ? 0.05 : amount, dx);
  }

  function setIntensity(v) { state.intensityTarget = clamp(v || 0, 0, 1); }
  function setStarPower(on) {
    state.starPowerTarget = on ? 1 : 0;
    var rig = state.rig;
    if (rig) rig.fovOffsetTarget = on ? 1.6 : 0;
  }
  function setExposure(v) {
    /* vira a nova referencia: sobrevive a troca de tema (o mood multiplica) */
    state.exposureRef = clamp(v, 0.2, 3);
    state.exposureBase = state.exposureRef;
    if (GH.Engine.renderer) GH.Engine.renderer.toneMappingExposure = state.exposureBase;
  }
  function setFade(v) { gradeUniforms.uFade.value = clamp(v, 0, 1); }

  function updateScreenFx(dt) {
    /* flash: decai rapido no comeco e some de vez (nada de residuo) */
    if (state.flashAmount > 0) {
      state.flashAmount *= Math.exp(-dt * state.flashDecay * 2.4);
      state.flashAmount -= dt * state.flashDecay * 0.16;
      if (state.flashAmount < 0.0006) state.flashAmount = 0;
    }
    gradeUniforms.uFlashAmount.value = state.flashAmount;
    gradeUniforms.uFlashColor.value.set(state.flashColor.r, state.flashColor.g, state.flashColor.b);

    /* bloom pulse */
    if (state.bloomPulse > 0) {
      state.bloomPulse *= Math.exp(-dt * state.bloomPulseDecay);
      if (state.bloomPulse < 0.0008) state.bloomPulse = 0;
    }

    state.intensity = damp(state.intensity, state.intensityTarget, 3.2, dt);
    state.starPower = damp(state.starPower, state.starPowerTarget, 4.5, dt);

    gradeUniforms.uTime.value = state.elapsed;
    gradeUniforms.uIntensity.value = state.intensity;
    gradeUniforms.uStarPower.value = state.starPower;

    var b = GH.Engine.bloomPass;
    if (b) {
      b.strength = state.bloomBase + state.intensity * 0.10 + state.starPower * 0.26 + state.bloomPulse * 0.55;
      b.radius = 0.72 + state.starPower * 0.10 + state.bloomPulse * 0.08;
      b.threshold = 0.85 - state.starPower * 0.10;
    }

    var r = GH.Engine.renderer;
    if (r) r.toneMappingExposure = state.exposureBase * (1 + state.bloomPulse * 0.045 + state.starPower * 0.04);
  }

  /* Engates preguicosos em modulos que carregam DEPOIS do engine
     (conductor.js e quem cria GH.Settings; ambos vem depois na ordem).
       - GH.Conductor.onBeat  -> kick de camera + pulso de bloom no beat
       - GH.Settings.onChange -> respeita a qualidade escolhida no menu     */
  function tryLateHooks() {
    if (state.beatHooked && state.settingsHooked) return;
    /* so tenta a cada 20 frames — custo desprezivel */
    if ((state.hookTry++ % 20) !== 0) return;

    if (!state.beatHooked) {
      try {
        if (GH.Conductor && typeof GH.Conductor.onBeat === 'function') {
          GH.Conductor.onBeat(function (beatIndex) {
            if (!GH.Engine.autoBeatKick) return;
            var strong = ((beatIndex | 0) % 4 === 0);
            kick(strong ? 0.052 : 0.024);
            bloomPulse(strong ? 0.16 : 0.07, 4.2);
          });
          state.beatHooked = true;
        }
      } catch (e) {
        state.beatHooked = true; /* nao insiste */
        warn('nao consegui engatar no Conductor', e);
      }
    }

    if (!state.settingsHooked) {
      try {
        if (GH.Settings && typeof GH.Settings.onChange === 'function') {
          if (GH.Settings.quality && QUALITY_TIERS[GH.Settings.quality] && GH.Settings.quality !== state.requestedQuality) {
            setQuality(GH.Settings.quality);
          }
          GH.Settings.onChange(function (s, key) {
            if (key && key !== 'quality') return;
            if (s && s.quality && QUALITY_TIERS[s.quality] && s.quality !== state.requestedQuality) setQuality(s.quality);
          });
          state.settingsHooked = true;
        }
      } catch (e) {
        state.settingsHooked = true;
        warn('nao consegui engatar em GH.Settings', e);
      }
    }
  }

  /* =======================================================================
     14. SIMULACAO E RENDER
     ======================================================================= */

  function simulate(dt) {
    state.elapsed += dt;
    GH.Engine.elapsed = state.elapsed;
    GH.Engine.dt = dt;

    tryLateHooks();
    runUpdaters(dt, state.elapsed);
    updateScreenFx(dt);
    updateLights(dt);
    updateCameraRig(dt);
    /* depois do rig: quem precisa da camera ja no lugar final deste frame */
    if (state.lateUpdaters.length) runLateUpdaters(dt, state.elapsed);
  }

  function renderFrame(dt) {
    var renderer = GH.Engine.renderer;
    if (!renderer || state.contextLost) return;

    /* o SMAA pode ter ficado pronto entre frames */
    var tier = QUALITY_TIERS[state.quality] || QUALITY_TIERS.high;
    if (tier.aa === 'smaa' && GH.Engine.smaaPass && !GH.Engine.smaaPass.enabled && !state.smaaReady) {
      applyAAMode('smaa');
    }

    if (state.composerOk && GH.Engine.composer) {
      try {
        GH.Engine.composer.render(dt);
      } catch (e) {
        state.composerOk = false;
        warn('composer falhou; caindo pro render direto', e);
        try { renderer.setRenderTarget(null); renderer.render(GH.Engine.scene, GH.Engine.camera); } catch (e2) { warn('render direto tambem falhou', e2); }
      }
    } else {
      try { renderer.setRenderTarget(null); renderer.render(GH.Engine.scene, GH.Engine.camera); } catch (e3) { warn('render direto falhou', e3); }
    }

    state.frame++;
    GH.Engine.frame = state.frame;
  }

  function updateFps(rawDt) {
    if (rawDt <= 0) return;
    var inst = 1 / rawDt;
    state.fpsInstant = inst;
    /* media movel exponencial + amostra por segundo (mais estavel) */
    state.fps = state.fps * 0.92 + inst * 0.08;
    state.fpsAccum += rawDt;
    state.fpsFrames++;
    if (state.fpsAccum >= 1.0) {
      /* amostra fechada de 1 segundo: imune a um unico frame perdido */
      var s = state.fpsFrames / state.fpsAccum;
      state.fpsSamples.push(s);
      if (state.fpsSamples.length > 8) state.fpsSamples.shift();
      var sum = 0;
      for (var i = 0; i < state.fpsSamples.length; i++) sum += state.fpsSamples[i];
      state.fpsAvg = sum / state.fpsSamples.length;
      state.fpsAccum = 0;
      state.fpsFrames = 0;
    }
    GH.Engine.fps = state.fps;
    GH.Engine.fpsAvg = state.fpsAvg;
    GH.Engine.fpsInstant = inst;
  }

  function tick(now) {
    if (!state.running) return;
    state.rafId = requestAnimationFrame(tick);

    var raw = (now - state.lastTime) / 1000;
    state.lastTime = now;
    if (!isFinite(raw) || raw <= 0) raw = 1 / 60;
    if (raw > 1) raw = 1 / 60;          /* voltou de aba escondida */
    state.wallElapsed += raw;

    var dt = Math.min(raw, 1 / 20);      /* contrato: dt limitado a 1/20 */

    updateFps(raw);
    simulate(dt);
    renderFrame(dt);
    updateAutoQuality(raw);
  }

  function start() {
    if (!state.inited || state.running || state.frozen) return;
    state.running = true;
    state.lastTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (GH.Engine.clock && !GH.Engine.clock.running) GH.Engine.clock.start();
    state.rafId = requestAnimationFrame(tick);
  }

  function stop() {
    state.running = false;
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = 0; }
    if (GH.Engine.clock && GH.Engine.clock.running) GH.Engine.clock.stop();
  }

  /* modo captura: congela o rAF de vez */
  function freeze() {
    stop();
    state.frozen = true;
    GH.Engine.frozen = true;
  }
  function unfreeze() {
    state.frozen = false;
    GH.Engine.frozen = false;
  }

  /* um passo deterministico de simulacao + render (modo captura) */
  function stepFixed(dt) {
    if (!state.inited) return state.frame;
    var d = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? Math.min(dt, 1 / 20) : (1 / 60);
    simulate(d);
    renderFrame(d);
    return state.frame;
  }

  /* so simula (sem render) — util pra "esquentar" o estado antes do print */
  function simulateOnly(dt) {
    if (!state.inited) return;
    var d = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? Math.min(dt, 1 / 20) : (1 / 60);
    simulate(d);
  }

  /* =======================================================================
     15. PERDA DE CONTEXTO WEBGL
     ======================================================================= */

  function hookContextEvents(canvas) {
    canvas.addEventListener('webglcontextlost', function (ev) {
      ev.preventDefault();                    /* obrigatorio pra poder restaurar */
      state.contextLost = true;
      GH.Engine.contextLost = true;
      state.wasRunningBeforeLoss = state.running;
      stop();
      warn('contexto WebGL perdido — aguardando restauracao');
      dispatch('contextlost', null);
    }, false);

    canvas.addEventListener('webglcontextrestored', function () {
      warn('contexto WebGL restaurado — reconstruindo cadeia de pos-processamento');
      state.contextLost = false;
      GH.Engine.contextLost = false;
      state.smaaReady = false;
      try {
        var r = GH.Engine.renderer;
        if (r) {
          r.setPixelRatio(state.pixelRatio);
          r.setSize(state.width, state.height, !!state.forcedSize);
          r.shadowMap.needsUpdate = true;
        }
        disposeComposer();
        buildComposer();
        setQuality(state.quality, { auto: true });
        resize();
      } catch (e) {
        warn('falha ao reconstruir apos restauracao', e);
        state.composerOk = false;
      }
      dispatch('contextrestored', null);
      if (state.wasRunningBeforeLoss && !state.frozen) start();
    }, false);
  }

  /* =======================================================================
     16. INIT
     ======================================================================= */

  function init(canvasEl, options) {
    if (state.inited) return GH.Engine;
    var opts = options || {};

    var canvas = canvasEl;
    if (typeof canvas === 'string') canvas = document.getElementById(canvas.replace('#', ''));
    if (!canvas) canvas = document.getElementById('gh-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'gh-canvas';
      document.body.appendChild(canvas);
    }
    state.canvas = canvas;

    /* --- gerenciamento de cor ---
       A flag e ligada em index.html, LOGO APOS vendor/three.min.js e antes de
       qualquer src/*.js — que e o unico ponto em que ela pega a paleta inteira
       (palette.js constroi seus THREE.Color na hora do load). Daqui de dentro
       seria tarde demais: metade da cena ficaria convertida e a outra nao.
       Aqui apenas LEMOS o estado real e publicamos para os outros modulos;
       o engine funciona nos dois modos, so muda o quanto a imagem e saturada.
       O grade (uGamma/uBlack/uContrast) foi reconferido com a flag ligada. */
    GH.Engine.colorManagement = !!(THREE.ColorManagement && THREE.ColorManagement.legacyMode === false);

    /* --- renderer --- */
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        powerPreference: 'high-performance',
        stencil: true,
        alpha: false,
        depth: true,
        logarithmicDepthBuffer: false,
        preserveDrawingBuffer: isCapture(),  /* o screenshot headless agradece */
        failIfMajorPerformanceCaveat: false
      });
    } catch (e) {
      warn('WebGLRenderer falhou', e);
      if (window.__GH_fatal) window.__GH_fatal('WebGL indisponivel: ' + (e && e.message));
      throw e;
    }

    renderer.setPixelRatio(clamp(baseDevicePixelRatio(), 0.5, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    /* exposicao de referencia; o `mood` do tema multiplica em cima dela */
    state.exposureRef = (opts.exposure === undefined) ? 1.05 : opts.exposure;
    state.exposureBase = state.exposureRef;
    renderer.toneMappingExposure = state.exposureBase;
    renderer.physicallyCorrectLights = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = true;
    renderer.sortObjects = true;
    renderer.setClearColor(DEFAULT_THEME.bg, 1);
    renderer.info.autoReset = true;
    /* deixamos a validacao de shader ligada: erro de GLSL vira log, nunca
       tela preta silenciosa (contrato, secao 10) */
    renderer.debug.checkShaderErrors = true;

    GH.Engine.renderer = renderer;
    GH.Engine.capabilities = renderer.capabilities;
    GH.Engine.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    /* --- cena + neblina --- */
    var scene = new THREE.Scene();
    scene.name = 'GH_Scene';
    scene.background = toColor(DEFAULT_THEME.bg, DEFAULT_THEME.bg);
    scene.fog = new THREE.FogExp2(DEFAULT_THEME.fog, state.fogDensityBase);
    GH.Engine.scene = scene;
    GH.Engine.fog = scene.fog;

    /* --- camera --- */
    var m = measure();
    state.width = m.w; state.height = m.h;
    var camera = new THREE.PerspectiveCamera(46, m.w / Math.max(1, m.h), 0.1, 300);
    camera.name = 'GH_Camera';
    camera.position.set(0, 3.05, 6.35);
    camera.lookAt(0, 0.35, -6.0);
    GH.Engine.camera = camera;

    /* --- rig --- */
    state.rig = makeRig();
    GH.Engine.cam = state.rig;
    /* semente do sway: se o RNG deterministico existir, usa ele (captura) */
    try {
      if (GH.Util && typeof GH.Util.RNG === 'function') {
        var rng = new GH.Util.RNG(isCapture() ? 7 : 1337);
        var r = (typeof rng.next === 'function') ? rng.next() : (typeof rng === 'function' ? rng() : 0.5);
        if (isFinite(r)) state.rig.seed = 100 + r * 900;
      }
    } catch (e) { /* mantem a semente padrao */ }
    if (isCapture()) state.rig.seed = 137.77; /* print sempre igual */
    camPreset(opts.preset || 'gameplay', 0);

    /* --- luzes --- */
    GH.Engine.lights = buildLights(scene);

    /* --- relogio --- */
    GH.Engine.clock = new THREE.Clock(false);

    state.inited = true;
    GH.Engine.inited = true;

    /* --- adocao explicita do GH.Materials ---
       O materials.js tem auto-adocao defensiva, mas ela so dispara no primeiro
       pedido de textura — o que joga o envMap e a anisotropia 16x para o
       SEGUNDO frame. Chamando aqui, a cena ja nasce com scene.environment
       pendurado e as texturas do primeiro frame ja saem com filtragem cheia.
       Idempotente do lado do materials: chamar de novo nao recria nada. */
    try {
      if (GH.Materials && typeof GH.Materials.init === 'function') {
        GH.Materials.init(renderer, scene);
      }
    } catch (e) { warn('GH.Materials.init falhou; sigo com o fallback dele', e); }

    /* --- pos-processamento --- */
    /* Qualidade inicial, por ordem de prioridade:
         1) o que o chamador pediu em opts;
         2) o que o JOGADOR salvou em GH.Settings (fora do modo captura);
         3) o palpite pelo tamanho de tela / dispositivo.
       O passo (2) e o que faz a preferencia salva valer JA no primeiro frame,
       sem depender de alguem lembrar de chamar GH.Settings.apply() no boot.
       Em modo captura ignoramos o localStorage de proposito: o print tem que
       sair igual em qualquer maquina. */
    var savedQuality = null;
    try {
      if (!isCapture() && GH.Settings && QUALITY_TIERS[GH.Settings.quality]) savedQuality = GH.Settings.quality;
    } catch (e) { savedQuality = null; }
    state.quality = state.requestedQuality =
      (opts.quality && QUALITY_TIERS[opts.quality]) ? opts.quality
      : (savedQuality || pickInitialQuality());
    state.pixelRatio = isCapture() ? 1 : clamp(baseDevicePixelRatio() * QUALITY_TIERS[state.quality].renderScale, 0.5, 2);
    renderer.setPixelRatio(state.pixelRatio);
    renderer.setSize(state.width, state.height, !!captureSize());

    try {
      buildComposer();
    } catch (e) {
      state.composerOk = false;
      warn('nao consegui montar o EffectComposer; render direto', e);
    }

    setQuality(state.quality, { auto: true });

    /* tema: segue GH.Palette automaticamente (ela carrega antes do engine) */
    try {
      if (GH.Palette) {
        if (GH.Palette.themeName) state.themeName = GH.Palette.themeName;
        if (typeof GH.Palette.onChange === 'function') {
          GH.Palette.onChange(function (t) { try { applyTheme(t); } catch (e) { warn('applyTheme falhou', e); } });
        }
      }
    } catch (e) { warn('nao consegui seguir GH.Palette', e); }
    applyTheme(state.themeName);
    resize();

    /* --- eventos --- */
    hookContextEvents(canvas);
    if (!isCapture()) {
      window.addEventListener('resize', onWindowResize, false);
      window.addEventListener('orientationchange', onWindowResize, false);
    }

    /* renderiza um primeiro frame ja: nada de tela preta esperando o rAF */
    try { renderFrame(1 / 60); } catch (e) { warn('primeiro frame falhou', e); }

    return GH.Engine;
  }

  var resizeTimer = 0;
  function onWindowResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resizeTimer = 0; try { resize(); } catch (e) { warn('resize falhou', e); } }, 80);
  }

  /* chute inicial de qualidade: telas grandes/densas comecam mais modestas */
  function pickInitialQuality() {
    if (isCapture()) return 'high';
    try {
      var dpr = baseDevicePixelRatio();
      var px = (window.innerWidth || 1280) * (window.innerHeight || 720) * dpr * dpr;
      var mob = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
      if (mob) return 'med';
      if (px > 4200000) return 'med';   /* 4K+ */
      return 'high';
    } catch (e) { return 'high'; }
  }

  /* =======================================================================
     17. DISPOSE
     ======================================================================= */

  function dispose() {
    stop();
    disposeComposer();
    try { if (GH.Engine.renderer) GH.Engine.renderer.dispose(); } catch (e) { /* ok */ }
    if (!isCapture()) {
      window.removeEventListener('resize', onWindowResize, false);
      window.removeEventListener('orientationchange', onWindowResize, false);
    }
    state.inited = false;
    GH.Engine.inited = false;
  }

  /* =======================================================================
     18. API PUBLICA
     ======================================================================= */

  GH.Engine = {

    /* ---- ciclo de vida ---- */
    init: init,
    dispose: dispose,
    start: start,
    stop: stop,
    freeze: freeze,
    unfreeze: unfreeze,
    stepFixed: stepFixed,
    simulateOnly: simulateOnly,
    resize: resize,
    setSize: setSize,

    /* ---- objetos three ---- */
    renderer: null,
    scene: null,
    camera: null,
    composer: null,
    clock: null,
    fog: null,
    lights: null,
    renderPass: null,
    bloomPass: null,
    smaaPass: null,
    fxaaPass: null,
    /* placeholder trocado pelo ShaderPass no init — a identidade do objeto
       de uniforms NAO muda, entao guardar GH.Engine.grade.uniforms e seguro */
    grade: { uniforms: gradeUniforms, isPlaceholder: true },
    gradeShader: GuitarradaGradeShader,

    /* ---- loop ---- */
    addUpdater: addUpdater,
    addLateUpdater: addLateUpdater,
    removeUpdater: removeUpdater,
    on: on,
    off: off,
    frame: 0,
    elapsed: 0,
    dt: 1 / 60,
    fps: 60,
    fpsAvg: 60,
    fpsInstant: 60,
    running: false,
    frozen: false,
    inited: false,
    contextLost: false,

    /* ---- camera ---- */
    camPreset: camPreset,
    camPresets: CAM_PRESETS,
    camAliases: CAM_ALIASES,
    cam: null,
    defineCamPreset: function (name, def) {
      if (!name || !def) return;
      CAM_PRESETS[name] = {
        pos: def.pos || [0, 3.05, 6.35],
        look: def.look || [0, 0.35, -6],
        fov: def.fov || 46,
        sway: (def.sway === undefined) ? 1 : def.sway,
        shake: (def.shake === undefined) ? 1 : def.shake,
        roll: def.roll || 0
      };
    },
    kick: kick,
    punch: punch,
    punchLane: punchLane,
    shake: shake,
    autoBeatKick: true,

    /* ---- efeitos de tela ---- */
    flash: flash,
    bloomPulse: bloomPulse,
    setIntensity: setIntensity,
    setStarPower: setStarPower,
    setExposure: setExposure,
    setFade: setFade,

    /* ---- tema / neblina ---- */
    setTheme: applyTheme,
    setFog: setFog,
    themeColors: null,

    /* ---- qualidade ---- */
    setQuality: setQuality,
    quality: 'high',
    autoQuality: true,
    qualityTiers: QUALITY_TIERS,
    /* tabela lida pelos outros modulos (particulas, publico, texturas...) */
    qualityScale: {
      name: 'high', pixelRatio: 1, particles: 1.0, crowd: 1.0, shadows: true,
      shadowMapSize: 2048, bloomScale: 0.6, aa: 'smaa', detail: 1.0,
      reflections: true, texScale: 1.0, maxLights: 8, anisotropy: 8,
      renderScale: 1.0, index: 2
    },

    /* ---- diagnostico ---- */
    log: state.log,
    stats: function () {
      var r = GH.Engine.renderer;
      return {
        fps: Math.round(state.fps * 10) / 10,
        frame: state.frame,
        quality: state.quality,
        pixelRatio: state.pixelRatio,
        size: state.width + 'x' + state.height,
        calls: r ? r.info.render.calls : 0,
        triangles: r ? r.info.render.triangles : 0,
        programs: (r && r.info.programs) ? r.info.programs.length : 0,
        composer: state.composerOk,
        aa: state.aaMode
      };
    }
  };

  /* mantem os espelhos publicos sincronizados com o estado interno */
  Object.defineProperty(GH.Engine, 'running', {
    get: function () { return state.running; },
    set: function (v) { if (v) start(); else stop(); },
    enumerable: true, configurable: true
  });
  Object.defineProperty(GH.Engine, 'autoQuality', {
    get: function () { return state.autoQuality; },
    set: function (v) { state.autoQuality = !!v; },
    enumerable: true, configurable: true
  });
  Object.defineProperty(GH.Engine, 'intensity', {
    get: function () { return state.intensity; },
    enumerable: true, configurable: true
  });
  Object.defineProperty(GH.Engine, 'starPowerLevel', {
    get: function () { return state.starPower; },
    enumerable: true, configurable: true
  });

})(window.GH = window.GH || {});

/* ===========================================================================
   GUITARRADA HERO — src/visual/notes.js
   ---------------------------------------------------------------------------
   AS GEMS. O jogador olha para elas 100% do tempo: precisam ser bonitas E
   perfeitamente legiveis a 200ms de distancia.

   CONTRATO (ARCHITECTURE.md secao 6):
     GH.Notes = { init(scene), update(dt, songTime), group,
                  onHit(noteIdx, quality), onMiss(noteIdx),
                  setStarPower(bool), reset() }

   ARQUITETURA DE DESENHO
   ----------------------
   Tudo e InstancedMesh. NADA e criado ou destruido por frame — nem Mesh, nem
   Material, nem Geometry, nem objeto JS. Sao 9 camadas instanciadas:

     1. gemLayer     corpo biselado da gem      (MeshPhysicalMaterial, opaco)
     2. rimLayer     aro cromado ao redor       (MeshStandardMaterial, opaco)
     3. openLayer    barra da nota aberta       (MeshPhysicalMaterial, opaco)
     4. shadowLayer  sombra de contato na pista (normal, escurece)
     5. trailLayer   rastro de luz atras        (aditivo)
     6. ribbonLayer  sustains + conectores de acorde + energia da aberta
                                                (ShaderMaterial aditivo)
     7. coreLayer    nucleo emissivo no topo    (aditivo)
     8. starLayer    estrela do Star Power      (aditivo, billboard)
     9. haloLayer    halo/flare volumetrico     (aditivo, billboard)
    10. sparkLayer   fagulhas do sustain queimando na linha de acerto

   Cor por instancia SEM instanceColor: `instanceColor` do three so chega ao
   fragmento quando `vertexColors` esta ligado, e ligar vertexColors numa
   geometria sem atributo `color` deixa tudo preto. Entao injetamos atributos
   proprios (iTint/iEmis/iSurf/iAlpha) via onBeforeCompile. Isso tambem nos da
   metalness e roughness POR INSTANCIA — e o que permite a mesma malha
   desenhar resina colorida (metalness 0) e cromo de Star Power (metalness 1)
   numa unica chamada de desenho.

   O atributo de geometria `aUp` (altura normalizada 0..1) da o gradiente
   interno: a gem e mais clara e mais emissiva em cima, escura embaixo. E o
   que impede o "cilindro chapado de uma cor so".

   LEITURA (a regra que manda em tudo)
   -----------------------------------
   Forma diz o TIPO, cor diz a RAIA, brilho diz a DISTANCIA:
     normal = disco biselado          | HOPO = menor e mais alto, aro branco
     tap    = achatado, escuro, vidro | SP   = cromado com estrela
     aberta = barra atravessando tudo | acorde = conector luminoso ligando

   Nao depende de GH.Highway, GH.FX, GH.HUD nem de GH.Art. Se GH.Materials ou
   GH.Palette faltarem, cai em fallback e continua desenhando.
   =========================================================================== */
(function (GH) {
  'use strict';

  /* =========================================================================
     0. CONSTANTES DE ARTE
     ========================================================================= */

  /* Geometria da gem (unidades de mundo). O raio nasce do LANE_W: a gem tem
     que caber dentro do aro de fret sem encostar. */
  var GEM_R      = 0.272;   // raio maximo do corpo (raia tem 0.72 de largura)
  var GEM_H      = 0.176;   // altura do corpo — gem parruda, nao moeda
  var RIM_R      = 0.2925;  // raio maior do aro — passa por FORA da silhueta
  var RIM_TUBE   = 0.0365;  // espessura do aro (contorno escuro da gem)

  /* Escalas por FORMA (a cor e independente — ver secao de LOOK). */
  var SHAPE_NORMAL = [1.00, 1.00];   // [xz, y]
  var SHAPE_HOPO   = [0.795, 1.36];  // menor e mais alta
  var SHAPE_TAP    = [1.035, 0.585]; // achatada como um botao de vidro

  /* Aproximacao: a nota cresce e ganha intensidade conforme chega. */
  var APPROACH_FAR   = 0.815;  // escala la no fundo
  var APPROACH_NEAR  = 1.075;  // escala na linha de acerto
  /* Ganho emissivo. Calibrado para cair na FAIXA MEDIA do ACES: acima de ~1.2
     o tone mapping empurra o pixel para o branco e as cinco raias viram o
     mesmo pastel — legibilidade antes de espetaculo. */
  var GLOW_FAR       = 0.30;
  var GLOW_NEAR      = 0.68;

  /* ORCAMENTO DE ADITIVO — a regra mais importante deste arquivo.
     Ha ate 45 gems na tela ao mesmo tempo e todas convergem para o ponto de
     fuga. Se cada uma somar um halo constante, o somatorio estoura o bloom e
     a pista inteira vira um borrao branco (foi exatamente o que aconteceu na
     primeira captura). Entao TODO aditivo e ponderado por `depthT^ADD_FALLOFF`:
     nota longe quase nao brilha, nota perto brilha muito. Isso conserta o
     estouro E reforca a leitura de aproximacao. */
  var ADD_FALLOFF = 1.55;

  /* Teto de cada aditivo, medido no pior caso (nota na linha de acerto).
     Numeros pequenos de proposito: quem entrega HDR para o bloom e o
     EMISSIVO do corpo da gem (fisicamente motivado, e uma superficie pequena);
     estes aqui so DESENHAM o brilho. Medido em captura: com halo em 0.18 e
     ~45 notas na tela o somatorio lavava a pista inteira de branco. */
  var A_HALO  = 0.075;
  var A_CORE  = 0.105;
  var A_TRAIL = 0.100;
  var A_STAR  = 0.900;
  var A_SPARK = 0.340;
  var HALO_SIZE = 0.74;   // diametro do halo em unidades de mundo (gem = 0.50)

  /* Nascimento: rampa curta para nada aparecer com "pop". */
  var BIRTH_T        = 0.085;  // fracao do trajeto usada para nascer

  /* Morte. */
  var HIT_DUR   = 0.230;
  var MISS_DUR  = 0.620;

  /* Sustain. */
  var SUS_W        = 0.300;   // largura do trilho
  var SUS_H        = 0.110;   // altura do trilho
  var SUS_Y        = 0.088;   // base do trilho acima da pista
  /* Fagulhas por segundo POR SUSTAIN. Baixo de proposito: elas nascem todas no
     mesmo ponto (o traste) e aditivo empilhado no mesmo pixel estoura o bloom
     — com 46/s e cinco sustains o jogo virou um clarao branco. */
  var SUS_SPARK_RATE = 13;
  var SPARK_LIVE_MAX = 84;    // teto de fagulhas simultaneas

  /* Nota aberta. */
  var OPEN_W  = 3.94;
  var OPEN_H  = 0.148;
  var OPEN_D  = 0.395;
  var OPEN_Y  = 0.056;        // base da barra acima da pista

  /* Conector de acorde. */
  var CONN_Y = 0.112;
  var CONN_W = 0.130;         // profundidade da barra conectora
  var CONN_H = 0.055;         // altura da barra conectora

  /* Capacidades dos pools (nunca realocadas em runtime). */
  var CAP_GEM    = 224;
  var CAP_RIM    = 224;
  var CAP_OPEN   = 14;
  var CAP_SHADOW = 248;
  var CAP_TRAIL  = 224;
  var CAP_RIBBON = 280;
  var CAP_CORE   = 224;
  var CAP_STAR   = 128;
  var CAP_HALO   = 256;
  var CAP_SPARK  = 224;
  var CAP_DYING  = 96;

  /* Estados de nota do GH.Chart (espelhados; o chart e a fonte da verdade). */
  var ST_PENDING = 0, ST_HIT = 1, ST_MISSED = 2, ST_HELD = 3, ST_DONE = 4;

  /* Animacao de morte local. */
  var AN_NONE = 0, AN_HIT = 1, AN_MISS = 2;

  /* =========================================================================
     1. ATALHOS DEFENSIVOS
     ========================================================================= */

  var U = null;            // GH.Util (resolvido no init)
  var LAY = null;          // GH.Layout

  function util() {
    if (!U) U = GH.Util || null;
    return U;
  }
  function layout() {
    if (!LAY) {
      LAY = GH.Layout || {
        LANES: 5, LANE_W: 0.72, HALF_W: 1.80, SPAWN_Z: -46, DESPAWN_Z: 6,
        STRIKE_Z: 0, SURFACE_Y: 0, GEM_Y: 0.16,
        laneX: function (i) { return (i - 2) * 0.72; }
      };
    }
    return LAY;
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep01(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function easeOutCubic(t) { t = clamp01(t); var u = 1 - t; return 1 - u * u * u; }
  function easeOutBack(t) { t = clamp01(t); var u = t - 1; return 1 + 2.70158 * u * u * u + 1.70158 * u * u; }

  /* =========================================================================
     2. ESTADO DO MODULO
     ========================================================================= */

  var inited = false;
  var scene = null;
  var group = null;
  var camera = null;

  var time = 0;                 // relogio visual proprio (segundos)
  var spActive = false;         // Star Power LIGADO agora?
  var spBlend = 0;              // transicao suave 0..1 do SP

  var rng = null;               // gerador deterministico proprio

  /* Estado visual por nota (arrays paralelos ao GH.Chart.notes). */
  var vAnim = null;             // Uint8Array  — AN_NONE / AN_HIT / AN_MISS
  var vAnimT = null;            // Float32Array— segundos dentro da animacao
  var vQual = null;             // Float32Array— 1 = perfeito, 0.55 = bom
  var vDeathZ = null;           // Float32Array— z congelado no acerto
  var vSpark = null;            // Float32Array— acumulador de fagulhas
  var vSusDead = null;          // Float32Array— instante em que o sustain caiu
  var vPrevState = null;        // Uint8Array  — estado do chart no frame passado
  var vLen = 0;
  var chartStamp = '';

  /* Lista compacta de notas em animacao de morte. */
  var dying = new Int32Array(CAP_DYING);
  var dyingN = 0;

  /* Fagulhas do sustain (pool puro, sem alocacao). */
  var spX = null, spY = null, spZ = null;
  var spVX = null, spVY = null, spVZ = null;
  var spLife = null, spMax = null, spSize = null;
  var spR = null, spG = null, spB = null;
  var spCount = 0;

  /* Diagnostico (o integrador le isto). */
  var stat = {
    gems: 0, sustains: 0, opens: 0, connectors: 0, halos: 0, sparks: 0,
    visible: 0, dying: 0, overflow: 0
  };

  /* Scratch — reaproveitado em TODO o loop quente. Zero alocacao por frame. */
  var _p = null, _s = null, _m = null, _q = null, _qId = null, _qX = null;
  var _camQ = null, _camPos = null;
  /* cores de trabalho: look resolvido da gem + um descartavel para os pushes */
  var _cTint = null, _cEmis = null, _cRim = null, _cTmp = null, _cTmp2 = null;

  /* =========================================================================
     3. PALETA RESOLVIDA (tabelas de look, recalculadas ao trocar de tema)
     ========================================================================= */

  var LOOK = [];     // LOOK[lane] = { tint, emis, rim, core, halo, ... }
  var SPLOOK = null; // look cromado do Star Power
  var OPENLOOK = null;
  var shadowColor = null;

  function pal() { return GH.Palette || null; }

  function colorOf(c, fallbackHex) {
    if (c && c.isColor) return c;
    var out = new THREE.Color(fallbackHex === undefined ? 0xffffff : fallbackHex);
    return out;
  }

  /* Constroi as tabelas de cor. Chamado no init e a cada troca de tema.
     Nenhuma dessas cores e inventada: todas saem de GH.Palette. */
  function buildLooks() {
    var P = pal();
    var i;
    LOOK.length = 0;

    for (i = 0; i < 5; i++) {
      var laneC = (P && P.lanes && P.lanes[i]) ? P.lanes[i] : null;
      var base = colorOf(laneC, 0x888888);
      var emis = colorOf(laneC ? laneC.emissive : null, 0xcccccc);
      var rimC = colorOf(laneC ? laneC.rim : null, 0xdddddd);
      var glow = colorOf(laneC ? laneC.glow : null, 0xffffff);
      var dark = colorOf(laneC ? laneC.dark : null, 0x101010);

      var L = {};
      /* corpo normal: cor pura da raia (a saturacao E a informacao de jogo) */
      L.tint = base.clone();
      L.emis = emis.clone();
      /* Aro: METAL ESCURO (gunmetal anodizado na cor da raia), nao espelho de
         cromo claro. Duas razoes medidas em captura:
           1. um anel prateado a 25px de diametro estoura e o bloom sangra por
              cima da gem inteira — as cinco raias viram o mesmo pastel;
           2. um anel ESCURO em volta e um CONTORNO: e o que faz a gem
              sobreviver quando a pista atras dela esta clara e o bloom da
              linha de acerto invade. Continua sendo metal (metalness 1), so
              que reflete o mundo em vez de devolver o refletor inteiro.
         O aro BRANCO fica reservado ao HOPO — vira sinal de leitura, nao
         decoracao repetida em toda nota. */
      L.rim = new THREE.Color(0x1b2130).lerp(base, 0.30);
      L.core = emis.clone();
      /* halo puxado para o emissivo: o `glow` da paleta e claro demais e
         empurra a nota para o branco quando somado. */
      L.halo = glow.clone().lerp(emis, 0.55);

      /* HOPO: corpo um pouco mais claro, aro BRANCO (o sinal de leitura) */
      L.hopoTint = base.clone().lerp(new THREE.Color(0xffffff), 0.16);
      L.hopoRim = new THREE.Color(0xe8eef8).lerp(base, 0.12);
      L.hopoEmis = emis.clone().lerp(new THREE.Color(0xffffff), 0.18);

      /* TAP: vidro escuro com nucleo aceso e aro fino da cor da raia */
      L.tapTint = dark.clone().lerp(base, 0.16);
      L.tapEmis = emis.clone();
      L.tapRim = emis.clone().lerp(rimC, 0.28).multiplyScalar(0.85);

      /* Cor de morte: a gem escurece para o tom de sombra da propria raia */
      L.dead = dark.clone();

      LOOK.push(L);
    }

    var sp = (P && P.sp) ? P.sp : null;
    /* CROMO DE VERDADE: metal puro so fica com cara de metal quando o que ele
       reflete tem contraste. O envMap do palco e um softbox claro, entao um
       tint quase branco devolve uma bolacha branca chapada (medido). Com o
       tint em ~45% o reflexo cai para a faixa do aco escovado, o bisel volta
       a aparecer e — o mais importante — a ESTRELA branca por cima finalmente
       tem contra o que brilhar. */
    SPLOOK = {
      /* 0,46 era compensacao para um BUG, nao para a luz: com o map das
         camadas aditivas perdido (ver texOf), a estrela e o halo pintavam
         quadrados brancos opacos por cima da gem, e a unica saida parecia ser
         apagar o corpo. Com os sprites corretos o cromo pode voltar a ter
         valor de aco escovado — sem ele a nota de star power some no conves. */
      tint: colorOf(sp ? sp.tint : null, 0xb9e6ff).clone()
              .lerp(new THREE.Color(0xffffff), 0.30).multiplyScalar(0.80),
      /* Emissivo BAIXO. Com 0.62 a gem cromada saturava em branco puro e a
         estrela branca por cima ficava invisivel — no print de star power as
         notas viravam quadradinhos de papel. Em 0.28 o corpo assenta na faixa
         do aco azulado e a estrela volta a ser o simbolo que identifica a
         nota de star power a 200 ms de distancia. */
      emis: colorOf(sp ? sp.glow : null, 0x8fd8ff).clone().multiplyScalar(0.46),
      rim:  colorOf(sp ? sp.rim : null, 0xffffff).clone().multiplyScalar(0.72),
      core: colorOf(sp ? sp.core : null, 0xf2fbff).clone(),
      halo: colorOf(sp ? sp.glow : null, 0x8fd8ff).clone(),
      deep: colorOf(sp ? sp.deep : null, 0x0b2a4a).clone()
    };

    var theme = (P && P.current) ? P.current : null;
    OPENLOOK = {
      tint: new THREE.Color(0xffffff),
      emis: new THREE.Color(0xffffff),
      rim:  colorOf(theme ? theme.metal : null, 0xd9b98c).clone(),
      halo: colorOf(theme ? theme.highwayEdge : null, 0xff3d8a).clone()
    };

    shadowColor = colorOf(theme ? theme.shadow : null, 0x05030a).clone();
  }

  /* =========================================================================
     4. GEOMETRIAS PROCEDURAIS
     ========================================================================= */

  /* Perfil do corpo da gem, de baixo para cima: base larga, barriga reta,
     chanfro generoso e calota levemente abaulada no topo. E o chanfro que
     captura o realce do refletor e da volume — cilindro reto nao da. */
  var GEM_PROFILE_N = [
    [0.000, 0.000],
    [0.470, 0.000],
    [0.720, 0.038],
    [0.857, 0.128],
    [0.960, 0.275],
    [1.000, 0.455],
    [0.978, 0.610],
    [0.905, 0.735],
    [0.790, 0.835],
    [0.640, 0.905],
    [0.460, 0.958],
    [0.250, 0.990],
    [0.000, 1.000]
  ];

  /* Adiciona `aUp` (altura normalizada) a partir de position.y. E o atributo
     que faz o gradiente interno da gem (clara em cima, escura embaixo). */
  function addUpAttribute(geo, minY, maxY) {
    var pos = geo.attributes.position;
    var n = pos.count;
    var arr = new Float32Array(n);
    var span = (maxY - minY) || 1;
    for (var i = 0; i < n; i++) {
      arr[i] = clamp01((pos.getY(i) - minY) / span);
    }
    geo.setAttribute('aUp', new THREE.BufferAttribute(arr, 1));
    return geo;
  }

  function buildGemGeometry(segments) {
    var pts = [], i;
    for (i = 0; i < GEM_PROFILE_N.length; i++) {
      pts.push(new THREE.Vector2(GEM_PROFILE_N[i][0] * GEM_R,
                                 GEM_PROFILE_N[i][1] * GEM_H));
    }
    var geo = new THREE.LatheGeometry(pts, segments || 22, 0, Math.PI * 2);
    addUpAttribute(geo, 0, GEM_H);
    geo.translate(0, -GEM_H * 0.5, 0);   // centro geometrico na origem
    geo.computeBoundingSphere();
    return geo;
  }

  /* Aro cromado: toroide achatado deitado no plano XZ, na barriga da gem. */
  function buildRimGeometry() {
    var geo = new THREE.TorusGeometry(RIM_R, RIM_TUBE, 8, 24);
    geo.rotateX(-Math.PI / 2);
    geo.scale(1, 0.86, 1);               // levemente achatado: aro, nao rosquinha
    geo.translate(0, GEM_H * 0.44 - GEM_H * 0.5, 0);
    addUpAttribute(geo, -RIM_TUBE, RIM_TUBE);
    geo.computeBoundingSphere();
    return geo;
  }

  /* Disco deitado (nucleo emissivo no topo da gem, sombra de contato). */
  function buildDiscGeometry(seg) {
    var geo = new THREE.CircleGeometry(0.5, seg || 20);
    geo.rotateX(-Math.PI / 2);
    geo.computeBoundingSphere();
    return geo;
  }

  /* Quad para billboard (halo, estrela, fagulha). */
  function buildQuadGeometry() {
    var geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    geo.computeBoundingSphere();
    return geo;
  }

  /* Quad deitado na pista, com a ponta luminosa na cabeca (rastro).
     A textura `streak` tem o eixo longo em U e a secao em V, entao trocamos
     as componentes de uv: sem isso o rastro sairia atravessado. */
  function buildTrailGeometry() {
    var geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -0.5);           // nasce na gem e se estende para -Z
    var uv = geo.attributes.uv;
    for (var i = 0; i < uv.count; i++) {
      var a = uv.getX(i), b = uv.getY(i);
      uv.setXY(i, b, a);
    }
    uv.needsUpdate = true;
    geo.computeBoundingSphere();
    return geo;
  }

  /* -------------------------------------------------------------------------
     buildRibbon(profile, capped)
     Extruda um perfil 2D (x = travessia em [-0.5, 0.5], y = altura em [0, 1])
     ao longo de -Z, de z = 0 (cabeca) ate z = -1 (cauda).
       uv.x = travessia normalizada por comprimento de arco
       uv.y = 0 na cabeca, 1 na cauda
     `capped` fecha as duas pontas (necessario na barra da nota aberta, cujas
     pontas ficam visiveis; desnecessario no sustain, que morre em neblina).
     ------------------------------------------------------------------------- */
  function buildRibbon(profile, capped) {
    var n = profile.length;
    var i;

    /* comprimento de arco acumulado -> uv.x honesto (sem esticar o chanfro) */
    var arc = new Float32Array(n);
    var total = 0;
    for (i = 1; i < n; i++) {
      var dx = profile[i][0] - profile[i - 1][0];
      var dy = profile[i][1] - profile[i - 1][1];
      total += Math.sqrt(dx * dx + dy * dy);
      arc[i] = total;
    }
    if (total <= 0) total = 1;
    for (i = 0; i < n; i++) arc[i] /= total;

    var vertsPerRow = n;
    var rows = 2;
    var capVerts = capped ? (n + 1) * 2 : 0;
    var vcount = vertsPerRow * rows + capVerts;

    var pos = new Float32Array(vcount * 3);
    var uv = new Float32Array(vcount * 2);
    var up = new Float32Array(vcount);
    var idx = [];

    var w = 0;
    for (var r = 0; r < rows; r++) {
      var z = -r;                         // z = 0 e z = -1
      for (i = 0; i < n; i++) {
        pos[w * 3] = profile[i][0];
        pos[w * 3 + 1] = profile[i][1];
        pos[w * 3 + 2] = z;
        uv[w * 2] = arc[i];
        uv[w * 2 + 1] = r;
        up[w] = profile[i][1];
        w++;
      }
    }
    /* Ordem CCW vista de FORA. Errar aqui deixa a fita virada para dentro e o
       backface culling apaga todos os sustains — foi exatamente o que
       aconteceu quando o material passou de DoubleSide para FrontSide. */
    for (i = 0; i < n - 1; i++) {
      var a = i, b = i + 1, c = n + i, d = n + i + 1;
      idx.push(a, b, c, b, d, c);
    }

    if (capped) {
      /* tampa: leque a partir do centroide do perfil (fechando pela base) */
      for (var side = 0; side < 2; side++) {
        var zz = -side;
        var base0 = w;
        var cx = 0, cy = 0;
        for (i = 0; i < n; i++) { cx += profile[i][0]; cy += profile[i][1]; }
        cx /= n; cy /= n;
        pos[w * 3] = cx; pos[w * 3 + 1] = cy; pos[w * 3 + 2] = zz;
        uv[w * 2] = 0.5; uv[w * 2 + 1] = side;
        up[w] = cy;
        w++;
        for (i = 0; i < n; i++) {
          pos[w * 3] = profile[i][0];
          pos[w * 3 + 1] = profile[i][1];
          pos[w * 3 + 2] = zz;
          uv[w * 2] = arc[i];
          uv[w * 2 + 1] = side;
          up[w] = profile[i][1];
          w++;
        }
        for (i = 0; i < n - 1; i++) {
          if (side === 0) idx.push(base0, base0 + 1 + i, base0 + 2 + i);
          else idx.push(base0, base0 + 2 + i, base0 + 1 + i);
        }
        /* fecha a base do perfil (ultimo ponto de volta para o primeiro) */
        if (side === 0) idx.push(base0, base0 + n, base0 + 1);
        else idx.push(base0, base0 + 1, base0 + n);
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    /* aUp normalizado pela altura do perfil */
    var maxY = 0;
    for (i = 0; i < n; i++) if (profile[i][1] > maxY) maxY = profile[i][1];
    if (maxY <= 0) maxY = 1;
    var upArr = new Float32Array(vcount);
    for (i = 0; i < vcount; i++) upArr[i] = clamp01(up[i] / maxY);
    geo.setAttribute('aUp', new THREE.BufferAttribute(upArr, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  /* Perfil do trilho de sustain: capsula achatada, com aresta viva na base
     (a linha escura embaixo separa o trilho da pista). */
  var SUSTAIN_PROFILE = [
    [-0.500, 0.000],
    [-0.400, 0.640],
    [ 0.000, 1.000],
    [ 0.400, 0.640],
    [ 0.500, 0.000]
  ];

  /* Perfil da barra aberta: mais quadrada, com chanfro curto — barra macica. */
  var OPEN_PROFILE = [
    [-0.500, 0.000],
    [-0.492, 0.300],
    [-0.455, 0.620],
    [-0.360, 0.870],
    [-0.190, 1.000],
    [ 0.190, 1.000],
    [ 0.360, 0.870],
    [ 0.455, 0.620],
    [ 0.492, 0.300],
    [ 0.500, 0.000]
  ];

  function buildOpenGeometry() {
    var geo = buildRibbon(OPEN_PROFILE, true);
    /* o perfil vira a PROFUNDIDADE e a extrusao vira a LARGURA */
    geo.rotateY(-Math.PI / 2);           // -Z local -> +X mundo
    geo.translate(-0.5, 0, 0);           // centraliza a barra em x = 0
    geo.scale(OPEN_W, OPEN_H, OPEN_D);
    /* Depois da rotacao o eixo LONGO da barra e o `v` do uv, mas a rampa das
       5 raias varia em `u`. Trocamos as componentes aqui para o arco-iris
       correr ao LONGO da barra (a rampa e compartilhada com o shader da fita,
       que usa a geometria propria dele e nao e afetado). */
    var uv = geo.attributes.uv;
    for (var i = 0; i < uv.count; i++) {
      var a = uv.getX(i), b = uv.getY(i);
      uv.setXY(i, b, a);
    }
    uv.needsUpdate = true;
    geo.computeBoundingSphere();
    return geo;
  }

  /* =========================================================================
     5. INJECAO DE ATRIBUTOS POR INSTANCIA
     ========================================================================= */

  /* Materiais PBR: cor difusa, emissivo, metalness e roughness por instancia,
     mais o gradiente vertical vindo de `aUp`.
       opts.emissive : 'set' (ignora emissiveMap) | 'mul' (preserva o mapa)
       opts.rough    : 'set' (ignora roughnessMap) | 'mul' (preserva o mapa) */
  function injectLit(mat, opts) {
    opts = opts || {};
    var emisMode = opts.emissive || 'set';
    var roughMode = opts.rough || 'set';
    var key = 'ghNotesLit:' + emisMode + ':' + roughMode;
    var emisLine = (emisMode === 'mul')
      ? 'totalEmissiveRadiance *= vEmisI * vSurfI.z * (0.30 + 1.00 * vUpI * vUpI);'
      : 'totalEmissiveRadiance = vEmisI * vSurfI.z * (0.14 + 0.94 * vUpI * vUpI);';
    var roughLine = (roughMode === 'mul')
      ? 'roughnessFactor = clamp(roughnessFactor * vSurfI.y * 2.4, 0.025, 1.0);'
      : 'roughnessFactor = vSurfI.y;';

    mat.onBeforeCompile = function (shader) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', [
          '#include <common>',
          'attribute vec3 iTint;',
          'attribute vec3 iEmis;',
          'attribute vec3 iSurf;',
          'attribute float aUp;',
          'varying vec3 vTintI;',
          'varying vec3 vEmisI;',
          'varying vec3 vSurfI;',
          'varying float vUpI;'
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          'vTintI = iTint; vEmisI = iEmis; vSurfI = iSurf; vUpI = aUp;'
        ].join('\n'));

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'varying vec3 vTintI;',
          'varying vec3 vEmisI;',
          'varying vec3 vSurfI;',
          'varying float vUpI;'
        ].join('\n'))
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          'diffuseColor.rgb *= vTintI * (0.52 + 0.56 * vUpI);'
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          roughLine
        ].join('\n'))
        .replace('#include <metalnessmap_fragment>', [
          '#include <metalnessmap_fragment>',
          'metalnessFactor = vSurfI.x;'
        ].join('\n'))
        .replace('#include <emissivemap_fragment>', [
          '#include <emissivemap_fragment>',
          emisLine
        ].join('\n'));
    };
    mat.customProgramCacheKey = function () { return key; };
    mat.needsUpdate = true;
    return mat;
  }

  /* Materiais nao iluminados (aditivos e sombra): tint + alpha por instancia. */
  function injectUnlit(mat) {
    mat.onBeforeCompile = function (shader) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', [
          '#include <common>',
          'attribute vec3 iTint;',
          'attribute float iAlpha;',
          'varying vec3 vTintI;',
          'varying float vAlphaI;'
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          'vTintI = iTint; vAlphaI = iAlpha;'
        ].join('\n'));
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'varying vec3 vTintI;',
          'varying float vAlphaI;'
        ].join('\n'))
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          'diffuseColor.rgb *= vTintI;',
          'diffuseColor.a *= vAlphaI;'
        ].join('\n'));
    };
    mat.customProgramCacheKey = function () { return 'ghNotesUnlit'; };
    mat.needsUpdate = true;
    return mat;
  }

  /* =========================================================================
     6. CAMADAS INSTANCIADAS
     ========================================================================= */

  function Layer(name, geo, mat, cap, kind, renderOrder) {
    this.name = name;
    this.cap = cap;
    this.n = 0;
    this.kind = kind;                     // 'lit' | 'unlit' | 'ribbon'
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.name = 'GH_Notes_' + name;
    this.mesh.frustumCulled = false;      // o pool cobre a pista inteira
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = renderOrder || 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;

    if (kind === 'lit') {
      this.tint = new Float32Array(cap * 3);
      this.emis = new Float32Array(cap * 3);
      this.surf = new Float32Array(cap * 3);
      this.aTint = new THREE.InstancedBufferAttribute(this.tint, 3);
      this.aEmis = new THREE.InstancedBufferAttribute(this.emis, 3);
      this.aSurf = new THREE.InstancedBufferAttribute(this.surf, 3);
      this.aTint.setUsage(THREE.DynamicDrawUsage);
      this.aEmis.setUsage(THREE.DynamicDrawUsage);
      this.aSurf.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iTint', this.aTint);
      geo.setAttribute('iEmis', this.aEmis);
      geo.setAttribute('iSurf', this.aSurf);
    } else if (kind === 'unlit') {
      this.tint = new Float32Array(cap * 3);
      this.alpha = new Float32Array(cap);
      this.aTint = new THREE.InstancedBufferAttribute(this.tint, 3);
      this.aAlpha = new THREE.InstancedBufferAttribute(this.alpha, 1);
      this.aTint.setUsage(THREE.DynamicDrawUsage);
      this.aAlpha.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iTint', this.aTint);
      geo.setAttribute('iAlpha', this.aAlpha);
    } else {                              // ribbon (ShaderMaterial proprio)
      this.tint = new Float32Array(cap * 3);
      this.params = new Float32Array(cap * 4);
      this.aTint = new THREE.InstancedBufferAttribute(this.tint, 3);
      this.aParams = new THREE.InstancedBufferAttribute(this.params, 4);
      this.aTint.setUsage(THREE.DynamicDrawUsage);
      this.aParams.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iColor', this.aTint);
      geo.setAttribute('iParams', this.aParams);
    }
  }

  Layer.prototype.reset = function () { this.n = 0; };

  Layer.prototype.flush = function () {
    var m = this.mesh;
    m.count = this.n;
    m.visible = this.n > 0;
    if (this.n === 0) return;
    m.instanceMatrix.needsUpdate = true;
    if (this.aTint) this.aTint.needsUpdate = true;
    if (this.aEmis) this.aEmis.needsUpdate = true;
    if (this.aSurf) this.aSurf.needsUpdate = true;
    if (this.aAlpha) this.aAlpha.needsUpdate = true;
    if (this.aParams) this.aParams.needsUpdate = true;
  };

  Layer.prototype.dispose = function () {
    try { this.mesh.geometry.dispose(); } catch (e) {}
    try { this.mesh.material.dispose(); } catch (e) {}
  };

  var Lgem = null, Lrim = null, Lopen = null, Lshadow = null, Ltrail = null;
  var Lribbon = null, Lcore = null, Lstar = null, Lhalo = null, Lspark = null;
  var ribbonMat = null;

  /* --- escrita de instancia (sem alocacao) -------------------------------- */

  function pushLit(L, x, y, z, sx, sy, sz, quat, tintC, emisC, metal, rough, gain) {
    var i = L.n;
    if (i >= L.cap) { stat.overflow++; return; }
    _p.set(x, y, z); _s.set(sx, sy, sz);
    _m.compose(_p, quat || _qId, _s);
    L.mesh.setMatrixAt(i, _m);
    var k = i * 3;
    L.tint[k] = tintC.r; L.tint[k + 1] = tintC.g; L.tint[k + 2] = tintC.b;
    L.emis[k] = emisC.r; L.emis[k + 1] = emisC.g; L.emis[k + 2] = emisC.b;
    L.surf[k] = metal; L.surf[k + 1] = rough; L.surf[k + 2] = gain;
    L.n = i + 1;
  }

  function pushUnlit(L, x, y, z, sx, sy, sz, quat, tintC, alpha) {
    var i = L.n;
    if (i >= L.cap) { stat.overflow++; return; }
    _p.set(x, y, z); _s.set(sx, sy, sz);
    _m.compose(_p, quat || _qId, _s);
    L.mesh.setMatrixAt(i, _m);
    var k = i * 3;
    L.tint[k] = tintC.r; L.tint[k + 1] = tintC.g; L.tint[k + 2] = tintC.b;
    L.alpha[i] = alpha;
    L.n = i + 1;
  }

  function pushRibbon(L, x, y, z, sx, sy, sz, quat, tintC, worldLen, alpha, hot, rampMix) {
    var i = L.n;
    if (i >= L.cap) { stat.overflow++; return; }
    _p.set(x, y, z); _s.set(sx, sy, sz);
    _m.compose(_p, quat || _qId, _s);
    L.mesh.setMatrixAt(i, _m);
    var k3 = i * 3, k4 = i * 4;
    L.tint[k3] = tintC.r; L.tint[k3 + 1] = tintC.g; L.tint[k3 + 2] = tintC.b;
    L.params[k4] = worldLen;
    L.params[k4 + 1] = alpha;
    L.params[k4 + 2] = hot;
    L.params[k4 + 3] = rampMix;
    L.n = i + 1;
  }

  /* =========================================================================
     7. MATERIAIS
     ========================================================================= */

  function mat() { return GH.Materials || null; }

  /* Copia independente de um material da fabrica. clone() NAO fica preso ao
     hook de paleta do GH.Materials — que e exatamente o que queremos, porque
     a cor aqui vem por instancia. */
  function factoryClone(name, a, b, fallback) {
    var M = mat();
    try {
      if (M && M.make && typeof M.make[name] === 'function') {
        var base = M.make[name](a, b);
        if (base) return base.clone();
      }
    } catch (e) { /* cai no fallback */ }
    return fallback();
  }

  /* BUG HISTORICO (custou as gems): em materials.js os nomes de textura sao
     GETTERS (Object.defineProperty), nao funcoes. O teste antigo
     `typeof M.tex[name] === 'function'` dava FALSO para TODAS elas, entao todo
     unlitAdditive() daqui saia com map=null — e um MeshBasicMaterial aditivo
     sem mapa pinta o QUAD INTEIRO. Era essa a origem do "azulejo branco" da
     nota de star power, do retangulo pálido atras das gems e do rastro
     retangular. Agora tentamos, em ordem: tex.get(), getter e funcao. */
  function texOf(name) {
    var M = mat();
    try {
      if (!M || !M.tex) return null;
      if (typeof M.tex.get === 'function') {
        var t = M.tex.get(name);
        if (t) return t;
      }
      var v = M.tex[name];
      if (typeof v === 'function') return v();
      return v || null;
    } catch (e) {}
    return null;
  }

  function buildGemMaterial() {
    var m = factoryClone('gemBody', 0, 'normal', function () {
      return new THREE.MeshPhysicalMaterial({
        metalness: 0, roughness: 0.26, clearcoat: 1.0, clearcoatRoughness: 0.05
      });
    });
    /* neutraliza a cor da fabrica: quem manda agora sao os atributos */
    m.color.setRGB(1, 1, 1);
    if (m.emissive) m.emissive.setRGB(1, 1, 1);
    m.emissiveIntensity = 1;
    m.transparent = false;
    m.opacity = 1;
    m.metalness = 0;
    m.roughness = 0.30;
    /* O verniz e a parte mais delicada da gem. A tampa e um espelho VIRADO
       PARA CIMA embaixo do softbox do envMap: com clearcoat 1.0 e rugosidade
       baixa a calota inteira devolve o refletor e as cinco raias viram o mesmo
       branco (medido em captura). Verniz parcial + reflexo espalhado + IBL
       contido preservam a cor da raia e ainda dao o brilho molhado. */
    m.clearcoat = 0.55;
    m.clearcoatRoughness = 0.30;
    m.envMapIntensity = 0.42;
    m.dithering = true;
    m.name = 'GH_GemBody';
    return injectLit(m, { emissive: 'set', rough: 'set' });
  }

  function buildRimMaterial() {
    var m = factoryClone('gemRim', 0, 'normal', function () {
      return new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.4 });
    });
    m.color.setRGB(1, 1, 1);
    if (m.emissive) m.emissive.setRGB(1, 1, 1);
    m.emissiveIntensity = 1;
    m.metalness = 1;
    m.roughness = 1.0;                    // modulado pelo roughnessMap escovado
    m.envMapIntensity = 0.95;
    m.name = 'GH_GemRim';
    /* 'mul' preserva a anisotropia do niquel escovado do GH.Materials: sem
       ela o aro vira cromo de plastico, perfeito demais para ser metal. */
    return injectLit(m, { emissive: 'set', rough: 'mul' });
  }

  function buildOpenMaterial() {
    var ramp = laneRampTexture();
    var m = new THREE.MeshPhysicalMaterial({
      map: ramp,
      emissiveMap: ramp,
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 1,
      metalness: 0.0,
      roughness: 0.22,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.35,
      dithering: true
    });
    m.name = 'GH_OpenBar';
    return injectLit(m, { emissive: 'mul', rough: 'set' });
  }

  /* Aditivo puro. As texturas de FX do GH.Materials sao brancas com a forma na
     ALPHA — `map` sozinho ja resolve (o <map_fragment> multiplica o vec4
     inteiro, alpha inclusa) e evita o alphaMap ler o canal G por engano. */
  function unlitAdditive(texName, opts) {
    opts = opts || {};
    var t = texOf(texName);
    var m = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: t || null,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: opts.depthTest === false ? false : true,
      side: opts.side || THREE.FrontSide,
      /* toneMapped false mantem o pixel acima de 1.0 no alvo half-float — e
         assim que o UnrealBloomPass encontra o que morder. So vale para os
         nucleos PEQUENOS (core/estrela/faisca); as manchas grandes (halo,
         rastro) passam pelo ACES, senao o somatorio delas lava a pista. */
      toneMapped: opts.toneMapped === true,
      fog: false
    });
    m.name = 'GH_Add_' + texName;
    return injectUnlit(m);
  }

  function buildShadowMaterial() {
    var t = texOf('softGlow');
    var m = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: t || null,
      transparent: true,
      opacity: 1,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      fog: false
    });
    m.name = 'GH_GemShadow';
    return injectUnlit(m);
  }

  /* Rampa com as 5 cores de raia — usada na barra da nota aberta e na
     energia que corre por dentro dela. Uma unica textura, gerada uma vez. */
  var _laneRamp = null;
  function laneRampTexture() {
    if (_laneRamp) return _laneRamp;
    var M = mat();
    var P = pal();
    var cols = [];
    if (P && P.laneEmissive && P.laneEmissive.length === 5) {
      cols.push(P.laneEmissive[0]);
      for (var i = 0; i < 5; i++) cols.push(P.laneEmissive[i]);
      cols.push(P.laneEmissive[4]);
    } else {
      cols = [0x2bff86, 0xff2e45, 0xffdc3a, 0x3b87ff, 0xff7f1e];
    }
    try {
      if (M && typeof M.gradientRamp === 'function') {
        _laneRamp = M.gradientRamp(cols, { size: 256, srgb: true, vertical: false });
      }
    } catch (e) { _laneRamp = null; }
    return _laneRamp;
  }

  /* -------------------------------------------------------------------------
     Shader da FITA (sustain, conector de acorde e energia da nota aberta).
     Um unico material desenha os tres: o que muda e o atributo iParams.
       iParams.x = comprimento em unidades de mundo (escala do scroll)
       iParams.y = alpha geral
       iParams.z = "calor" (0 = so a cor da raia, 1 = nucleo branco)
       iParams.w = mistura da rampa de raias (0 = solido, 1 = arco-iris)
     ------------------------------------------------------------------------- */
  var RIBBON_VS = [
    'attribute vec3 iColor;',
    'attribute vec4 iParams;',
    'varying vec3 vCol;',
    'varying vec4 vPar;',
    'varying vec2 vRuv;',
    'varying float vDepth;',
    'void main() {',
    '  vCol = iColor;',
    '  vPar = iParams;',
    '  vRuv = uv;',
    '  vec4 mv = vec4(position, 1.0);',
    '  #ifdef USE_INSTANCING',
    '    mv = instanceMatrix * mv;',
    '  #endif',
    '  vec4 mvp = modelViewMatrix * mv;',
    '  vDepth = -mvp.z;',
    '  gl_Position = projectionMatrix * mvp;',
    '}'
  ].join('\n');

  var RIBBON_FS = [
    'uniform sampler2D uEnergy;',
    'uniform sampler2D uRamp;',
    'uniform float uTime;',
    'uniform float uFog;',
    'varying vec3 vCol;',
    'varying vec4 vPar;',
    'varying vec2 vRuv;',
    'varying float vDepth;',
    'void main() {',
    '  float across = vRuv.x;',
    '  float along  = vRuv.y;',
    /* perfil transversal: nucleo cheio + duas bordas vivas (leitura de tubo) */
    '  float e = abs(across * 2.0 - 1.0);',
    '  float core = smoothstep(0.95, 0.05, e);',
    '  float edge = smoothstep(0.50, 0.99, e);',
    /* energia correndo por dentro, em unidades de MUNDO (velocidade constante
       qualquer que seja o comprimento do sustain) */
    '  float scroll = along * vPar.x * 0.235 - uTime * 1.22;',
    '  float n1 = texture2D(uEnergy, vec2(across * 0.55 + 0.20, scroll)).r;',
    '  float n2 = texture2D(uEnergy, vec2(across * 0.29 + 0.61, scroll * 0.56 + 0.33)).g;',
    '  float energy = n1 * 0.78 + n2 * 0.55;',
    '  float head = smoothstep(0.34, 0.0, along);',
    '  float tail = smoothstep(1.0, 0.80, along);',
    '  float a = core * (0.34 + 0.62 * energy) + edge * (0.50 + 0.40 * energy);',
    '  a *= tail * (0.72 + 0.72 * head);',
    '  a = min(a, 1.25);',
    '  vec3 ramp = mix(vec3(1.0), texture2D(uRamp, vec2(along, 0.5)).rgb, vPar.w);',
    '  vec3 col = vCol * ramp;',
    '  col = mix(col, vec3(1.0, 0.985, 0.955), min(0.94, core * vPar.z));',
    /* Fade de profundidade EM ESPACO DE VISTA — sem isto um sustain de 40
       unidades visto quase de topo empilha centenas de fragmentos aditivos
       por pixel perto do ponto de fuga e a pista inteira vira um clarao. */
    '  float fd = uFog * vDepth;',
    '  float fade = exp(-fd * fd);',
    '  float o = a * vPar.y * fade;',
    '  gl_FragColor = vec4(col * o, o);',
    '}'
  ].join('\n');

  function buildRibbonMaterial() {
    var energy = texOf('noiseFine') || texOf('noise');
    var ramp = laneRampTexture();
    var m = new THREE.ShaderMaterial({
      uniforms: {
        uEnergy: { value: energy },
        uRamp: { value: ramp },
        uTime: { value: 0 },
        uFog: { value: 0.0295 }
      },
      vertexShader: RIBBON_VS,
      fragmentShader: RIBBON_FS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      /* FrontSide, nao DoubleSide: com aditivo o dorso do tubo dobraria a
         energia somada em cada pixel — custo em dobro por nada. */
      side: THREE.FrontSide,
      fog: false,
      toneMapped: true
    });
    m.name = 'GH_Ribbon';
    return m;
  }

  /* =========================================================================
     8. INIT
     ========================================================================= */

  function allocScratch() {
    _p = new THREE.Vector3();
    _s = new THREE.Vector3();
    _m = new THREE.Matrix4();
    _q = new THREE.Quaternion();
    _qId = new THREE.Quaternion();
    _qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    _camQ = new THREE.Quaternion();
    _camPos = new THREE.Vector3();
    _cTint = new THREE.Color();
    _cEmis = new THREE.Color();
    _cRim = new THREE.Color();
    _cTmp = new THREE.Color();
    _cTmp2 = new THREE.Color();
  }

  function allocSparks() {
    spX = new Float32Array(CAP_SPARK); spY = new Float32Array(CAP_SPARK); spZ = new Float32Array(CAP_SPARK);
    spVX = new Float32Array(CAP_SPARK); spVY = new Float32Array(CAP_SPARK); spVZ = new Float32Array(CAP_SPARK);
    spLife = new Float32Array(CAP_SPARK); spMax = new Float32Array(CAP_SPARK); spSize = new Float32Array(CAP_SPARK);
    spR = new Float32Array(CAP_SPARK); spG = new Float32Array(CAP_SPARK); spB = new Float32Array(CAP_SPARK);
    spCount = 0;
  }

  function init(sceneIn) {
    if (inited) return API;
    if (typeof THREE === 'undefined') return API;

    scene = sceneIn || (GH.Engine ? GH.Engine.scene : null);
    camera = GH.Engine ? GH.Engine.camera : null;

    util(); layout();
    allocScratch();
    allocSparks();

    try {
      rng = (GH.Util && GH.Util.RNG) ? GH.Util.RNG(0x6E07E5) : null;
    } catch (e) { rng = null; }
    if (!rng) { rng = function () { return Math.random(); }; }

    buildLooks();

    group = new THREE.Group();
    group.name = 'GH_Notes';
    group.matrixAutoUpdate = false;      // fica parado na origem para sempre

    /* --- geometrias (criadas UMA vez) --- */
    var gemGeo = buildGemGeometry(22);
    var rimGeo = buildRimGeometry();
    var openGeo = buildOpenGeometry();
    var discGeo = buildDiscGeometry(20);
    var shadowGeo = buildDiscGeometry(16);
    var quadGeo = buildQuadGeometry();
    var starGeo = buildQuadGeometry();
    var sparkGeo = buildQuadGeometry();
    var trailGeo = buildTrailGeometry();
    var ribbonGeo = buildRibbon(SUSTAIN_PROFILE, false);

    ribbonMat = buildRibbonMaterial();

    /* --- camadas --- */
    Lgem = new Layer('gem', gemGeo, buildGemMaterial(), CAP_GEM, 'lit', 0);
    Lrim = new Layer('rim', rimGeo, buildRimMaterial(), CAP_RIM, 'lit', 0);
    Lopen = new Layer('open', openGeo, buildOpenMaterial(), CAP_OPEN, 'lit', 0);

    Lshadow = new Layer('shadow', shadowGeo, buildShadowMaterial(), CAP_SHADOW, 'unlit', 1);
    Ltrail = new Layer('trail', trailGeo, unlitAdditive('streak', { toneMapped: true }), CAP_TRAIL, 'unlit', 2);
    Lribbon = new Layer('ribbon', ribbonGeo, ribbonMat, CAP_RIBBON, 'ribbon', 3);
    /* O nucleo passa pelo ACES: quem alimenta o bloom com HDR e o EMISSIVO do
       corpo (fisicamente motivado). O aditivo aqui e so o desenho do brilho. */
    Lcore = new Layer('core', discGeo, unlitAdditive('softGlow', { toneMapped: true }), CAP_CORE, 'unlit', 5);
    Lstar = new Layer('star', starGeo, unlitAdditive('star'), CAP_STAR, 'unlit', 6);
    /* halo com softGlow (queda radial limpa), NAO com flare: o flare tem risco
       anamorfico e espinhos, e 40 deles empilhados viram nevoeiro branco. */
    Lhalo = new Layer('halo', quadGeo, unlitAdditive('softGlow', { toneMapped: true }), CAP_HALO, 'unlit', 7);
    Lspark = new Layer('spark', sparkGeo, unlitAdditive('sparkle', { toneMapped: true }), CAP_SPARK, 'unlit', 8);

    group.add(Lgem.mesh, Lrim.mesh, Lopen.mesh, Lshadow.mesh, Ltrail.mesh,
              Lribbon.mesh, Lcore.mesh, Lstar.mesh, Lhalo.mesh, Lspark.mesh);

    if (scene) scene.add(group);
    API.group = group;

    /* Repinta as tabelas quando o tema muda (o material nao muda: a cor esta
       nos atributos, entao basta reconstruir o LOOK). */
    try {
      if (GH.Palette && typeof GH.Palette.onChange === 'function') {
        GH.Palette.onChange(function () { buildLooks(); });
      }
    } catch (e) {}

    ensureNoteArrays();
    inited = true;
    return API;
  }

  /* =========================================================================
     9. ESTADO POR NOTA
     ========================================================================= */

  function chartOf() { return GH.Chart || null; }

  function currentStamp() {
    var C = chartOf();
    if (!C || !C.notes) return '';
    return (C.notes.length | 0) + '|' + (C.difficulty || '') + '|' +
           ((C.song && C.song.id) ? C.song.id : '');
  }

  /* Realoca os arrays paralelos quando o chart muda. Fora disso, nunca aloca. */
  function ensureNoteArrays() {
    var C = chartOf();
    var n = (C && C.notes) ? C.notes.length : 0;
    var stamp = currentStamp();
    if (stamp === chartStamp && vLen >= n && vAnim) return;

    chartStamp = stamp;
    var cap = Math.max(n, 16);
    if (!vAnim || vAnim.length < cap) {
      vAnim = new Uint8Array(cap);
      vAnimT = new Float32Array(cap);
      vQual = new Float32Array(cap);
      vDeathZ = new Float32Array(cap);
      vSpark = new Float32Array(cap);
      vSusDead = new Float32Array(cap);
      vPrevState = new Uint8Array(cap);
    }
    clearNoteState(n);
    vLen = n;
  }

  function clearNoteState(n) {
    var i, m = Math.max(n | 0, vAnim ? vAnim.length : 0);
    if (!vAnim) return;
    for (i = 0; i < m && i < vAnim.length; i++) {
      vAnim[i] = AN_NONE;
      vAnimT[i] = 0;
      vQual[i] = 1;
      vDeathZ[i] = 0;
      vSpark[i] = 0;
      vSusDead[i] = -1;
      vPrevState[i] = ST_PENDING;
    }
    dyingN = 0;
  }

  function addDying(idx) {
    if (dyingN >= CAP_DYING) {
      /* mata o mais antigo: melhor perder uma animacao do que estourar */
      for (var i = 1; i < dyingN; i++) dying[i - 1] = dying[i];
      dyingN--;
    }
    for (var j = 0; j < dyingN; j++) if (dying[j] === idx) return;
    dying[dyingN++] = idx;
  }

  /* =========================================================================
     10. EVENTOS PUBLICOS
     ========================================================================= */

  function onHit(noteIdx, quality) {
    if (!inited) return;
    ensureNoteArrays();
    var i = noteIdx | 0;
    if (i < 0 || i >= vLen) return;
    var C = chartOf();
    var nt = (C && C.notes) ? C.notes[i] : null;
    vAnim[i] = AN_HIT;
    vAnimT[i] = 0;
    vQual[i] = (quality === 'perfect' || quality === 1 || quality === true) ? 1 : 0.6;
    var t = songTimeNow();
    vDeathZ[i] = nt ? clamp(C.zAt(t, nt.t), -0.9, 1.6) : 0;
    addDying(i);
  }

  function onMiss(noteIdx) {
    if (!inited) return;
    ensureNoteArrays();
    var i = noteIdx | 0;
    if (i < 0 || i >= vLen) return;
    vAnim[i] = AN_MISS;
    vAnimT[i] = 0;
    vQual[i] = 0;
    addDying(i);
  }

  function setStarPower(on) {
    spActive = !!on;
  }

  function reset() {
    ensureNoteArrays();
    clearNoteState(vLen);
    spCount = 0;
    spActive = false;
    spBlend = 0;
    time = 0;
    if (inited) {
      Lgem.reset(); Lrim.reset(); Lopen.reset(); Lshadow.reset(); Ltrail.reset();
      Lribbon.reset(); Lcore.reset(); Lstar.reset(); Lhalo.reset(); Lspark.reset();
      flushAll();
    }
  }

  var _lastSongTime = 0;
  function songTimeNow() { return _lastSongTime; }

  /* =========================================================================
     11. FAGULHAS DO SUSTAIN
     ========================================================================= */

  function rnd() {
    if (typeof rng === 'function') return rng();
    return Math.random();
  }

  function emitSpark(x, y, z, cr, cg, cb, power) {
    if (spCount >= CAP_SPARK || spCount >= SPARK_LIVE_MAX) return;
    var i = spCount++;
    var a = rnd() * Math.PI * 2;
    var sp = 0.9 + rnd() * 2.3;
    /* espalha desde o nascimento: fagulha que nasce toda no mesmo pixel vira
       um borrao branco em vez de faisca */
    spX[i] = x + (rnd() - 0.5) * 0.34;
    spY[i] = y + (rnd() - 0.5) * 0.09;
    spZ[i] = z + (rnd() - 0.5) * 0.22;
    spVX[i] = Math.cos(a) * sp * 0.52;
    spVY[i] = 1.1 + rnd() * 2.6 * power;
    spVZ[i] = Math.sin(a) * sp * 0.34 + 0.8 + rnd() * 1.5;   // sai na direcao do jogador
    spMax[i] = 0.26 + rnd() * 0.30;
    spLife[i] = spMax[i];
    spSize[i] = 0.022 + rnd() * 0.036;
    spR[i] = cr; spG[i] = cg; spB[i] = cb;
  }

  function updateSparks(dt) {
    var i = 0;
    while (i < spCount) {
      spLife[i] -= dt;
      if (spLife[i] <= 0) {
        var last = spCount - 1;
        if (i !== last) {
          spX[i] = spX[last]; spY[i] = spY[last]; spZ[i] = spZ[last];
          spVX[i] = spVX[last]; spVY[i] = spVY[last]; spVZ[i] = spVZ[last];
          spLife[i] = spLife[last]; spMax[i] = spMax[last]; spSize[i] = spSize[last];
          spR[i] = spR[last]; spG[i] = spG[last]; spB[i] = spB[last];
        }
        spCount--;
        continue;
      }
      spVY[i] -= 7.4 * dt;                 // gravidade
      var drag = 1 - 2.1 * dt;
      if (drag < 0) drag = 0;
      spVX[i] *= drag; spVZ[i] *= drag;
      spX[i] += spVX[i] * dt;
      spY[i] += spVY[i] * dt;
      spZ[i] += spVZ[i] * dt;
      if (spY[i] < 0.02) {                 // quica raso na pista
        spY[i] = 0.02;
        spVY[i] = -spVY[i] * 0.30;
      }
      i++;
    }
  }

  function drawSparks() {
    for (var i = 0; i < spCount; i++) {
      var u = spLife[i] / (spMax[i] || 1);
      var k = u * u;
      var s = spSize[i] * (0.45 + 0.85 * u);
      _cTmp.setRGB(spR[i] * 0.75 + (1 - u) * 0.22, spG[i] * (0.45 + 0.42 * u), spB[i] * (0.30 + 0.55 * u));
      pushUnlit(Lspark, spX[i], spY[i], spZ[i], s, s, s, _camQ, _cTmp, k * A_SPARK);
    }
    stat.sparks = spCount;
  }

  /* =========================================================================
     12. NEBLINA (a mesma do engine, avaliada na CPU para os aditivos)
     ========================================================================= */

  var fogDensity = 0.0225;
  function refreshFog() {
    try {
      var f = (GH.Engine && GH.Engine.fog) ? GH.Engine.fog : (scene ? scene.fog : null);
      if (f && typeof f.density === 'number') fogDensity = f.density;
    } catch (e) {}
  }

  /* Visibilidade 0..1 de um ponto (1 = perto, 0 = engolido pela neblina).
     Aditivo com fog do three ADICIONA a cor da neblina em vez de somer, entao
     fazemos a conta aqui e apagamos os aditivos na mao. */
  function visAt(x, y, z) {
    _p.set(x, y, z);
    var d = _camPos.distanceTo(_p);
    var t = fogDensity * d;
    var v = Math.exp(-t * t);
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  /* =========================================================================
     13. DESENHO DE UMA GEM
     ========================================================================= */

  /* eixo de tombo do erro: a gem cai para a frente, na direcao do jogador */
  var TILT_AXIS = null;

  /* Resultado da resolucao de aparencia. Forma vem do TIPO, cor vem da RAIA
     (ou do cromo do Star Power). Preenche _cTint / _cEmis / _cRim. */
  var _look = {
    metal: 0, rough: 0.26, sx: 1, sy: 1,
    coreScale: 1, rimScale: 1, rimGain: 0.11, sp: 0, lane: 0
  };

  function resolveLook(nt, spVis, pulse) {
    var lane = nt.lane | 0;
    if (lane < 0) lane = 0;
    if (lane > 4) lane = 4;
    var L = LOOK[lane] || LOOK[0];
    var isTap = !!nt.tap;
    var isHopo = !!nt.hopo && !isTap;

    _look.lane = lane;
    _look.sp = spVis ? 1 : 0;

    /* --- FORMA: e o que o jogador le antes da cor --- */
    if (isHopo) { _look.sx = SHAPE_HOPO[0]; _look.sy = SHAPE_HOPO[1]; }
    else if (isTap) { _look.sx = SHAPE_TAP[0]; _look.sy = SHAPE_TAP[1]; }
    else { _look.sx = SHAPE_NORMAL[0]; _look.sy = SHAPE_NORMAL[1]; }

    _look.rimScale = isTap ? 0.985 : (isHopo ? 0.845 : 1.0);
    _look.coreScale = isHopo ? 0.78 : (isTap ? 1.14 : 1.0);

    /* --- COR --- */
    if (spVis) {
      /* Star Power: cromo espelhado com um sopro da raia. A forma continua
         dizendo o tipo, a cor grita "isto vale dobrado". */
      _cTint.copy(SPLOOK.tint).lerp(L.tint, isTap ? 0.18 : 0.10);
      _cEmis.copy(SPLOOK.emis);
      _cRim.copy(SPLOOK.rim);
      _look.metal = 1.0;
      _look.rough = isTap ? 0.20 : 0.115;
      _look.rimGain = 0.34;
      if (isTap) {
        _cTint.multiplyScalar(0.34);
        _cEmis.multiplyScalar(0.85 + pulse * 0.65);
      }
      return L;
    }
    if (isTap) {
      /* tap: vidro preto com nucleo aceso pulsando e aro fino da raia */
      _cTint.copy(L.tapTint);
      _cEmis.copy(L.tapEmis).multiplyScalar(0.70 + pulse * 0.90);
      _cRim.copy(L.tapRim);
      _look.metal = 0.0;
      _look.rough = 0.075;
      _look.rimGain = 0.42;
      return L;
    }
    if (isHopo) {
      /* HOPO: menor, mais alta, aro BRANCO — o sinal de "nao precisa palhetar" */
      _cTint.copy(L.hopoTint);
      _cEmis.copy(L.hopoEmis);
      _cRim.copy(L.hopoRim);
      _look.metal = 0.0;
      _look.rough = 0.195;
      _look.rimGain = 0.30;
      return L;
    }
    _cTint.copy(L.tint);
    _cEmis.copy(L.emis);
    _cRim.copy(L.rim);
    _look.metal = 0.0;
    _look.rough = 0.30;
    _look.rimGain = 0.12;
    return L;
  }

  /* Uma gem completa: sombra de contato, rastro, corpo, aro, nucleo,
     estrela de SP e halo. Uma unica passagem, sem alocar nada. */
  function drawGem(nt, idx, x, z, depthT, anim, animU) {
    var LY = layout();
    var lane = nt.lane | 0;
    if (lane < 0) lane = 0;
    if (lane > 4) lane = 4;
    var spVis = (!!nt.sp) || spActive;
    var L = LOOK[lane] || LOOK[0];

    /* respiracao interna (tap pisca, SP cintila) */
    var pulse = 0.5 + 0.5 * Math.sin(time * 7.4 + lane * 1.31 + nt.t * 2.1);
    resolveLook(nt, spVis, pulse);

    /* --- aproximacao: cresce e ganha intensidade; nasce sem "pop" --- */
    var birth = smoothstep01(depthT / BIRTH_T);
    var grow = lerp(APPROACH_FAR, APPROACH_NEAR, smoothstep01(depthT * 1.02));
    var scale = grow * lerp(0.30, 1.0, birth);

    var strikeK = Math.exp(-(z / 1.35) * (z / 1.35));
    var gain = lerp(GLOW_FAR, GLOW_NEAR, Math.pow(clamp01(depthT), 1.25)) * birth;
    gain += strikeK * 0.18;
    /* A gem de star power NAO precisa de mais ganho: ela ja e cromo sob a luz
       azul do SP e o banho da pista. Com o ganho antigo (1.15+) o corpo
       saturava em branco puro, a estrela branca por cima sumia e as notas
       viravam quadradinhos de papel. Escurecendo o corpo, a ESTRELA aparece —
       e e ela, nao o brilho, que identifica a nota. */
    if (spVis) gain *= 1.00 + spBlend * 0.06;
    /* peso do aditivo desta nota (ver ADD_FALLOFF no topo) */
    var addW = Math.pow(clamp01(depthT), ADD_FALLOFF);

    var y = LY.GEM_Y;
    var tilt = 0;
    var alphaK = 1;
    var deadMix = 0;

    /* --- MORTE --- */
    if (anim === AN_HIT) {
      /* estoura: cresce, clareia, colapsa. A particula e do GH.FX. */
      var pop = easeOutCubic(animU);
      scale *= (1 + 1.15 * pop) * (1 - animU * animU * animU);
      gain *= 1 + 7.5 * (1 - animU) * (1 - animU) * (0.5 + vQual[idx] * 0.5);
      _cEmis.lerp(SPLOOK.core, 0.55 * (1 - animU));
      _cTint.lerp(SPLOOK.core, 0.30 * (1 - animU));
    } else if (anim === AN_MISS) {
      /* cai, escurece, atravessa a pista e apaga — o erro tem que doer */
      deadMix = clamp01(animU * 2.1);
      y -= animU * animU * 0.66;
      tilt = animU * 0.95;
      scale *= (1 - 0.34 * animU);
      gain *= (1 - animU) * (1 - animU) * 0.5;
      _cTint.lerp(L.dead, deadMix);
      _cEmis.multiplyScalar(clamp01(1 - animU * 2.4));
      _cRim.lerp(L.dead, clamp01(animU * 1.6));
      alphaK = clamp01(1 - animU * 1.25);
      _look.metal = 0;
      _look.rough = clamp(_look.rough + animU * 0.5, 0, 1);
      _look.rimGain *= clamp01(1 - animU * 2);
    }

    /* SAIDA DE QUADRO. A nota vive ate DESPAWN_Z = 6 (contrato), mas entre a
     * linha de acerto e a lente ela fica GIGANTE e ocupa o rodape da tela —
     * duas gems brancas de 150 px cortadas na borda de baixo, medido no
     * print de gameplay_miss. O corpo da gem e OPACO (instancia iluminada),
     * entao baixar o alfa nao a esconde: ela precisa COLAPSAR. Encolher
     * tambem le melhor que sumir — parece que a nota passou por baixo do
     * jogador, que e o que acontece no Guitar Hero. */
    if (z > 0.30) {
      var outU = clamp01((z - 0.30) / 1.35);
      if (outU >= 0.999) return;
      var outK = (1 - outU) * (1 - outU);
      scale *= outK;
      alphaK *= outK;
      gain *= outK;
    }

    var vis = visAt(x, y, z) * alphaK;
    var sxz = scale * _look.sx;
    var sy = scale * _look.sy;

    var quat = null;
    if (tilt > 0.0001 && TILT_AXIS) {
      _q.setFromAxisAngle(TILT_AXIS, tilt * 1.25);
      quat = _q;
    }

    /* --- 1. sombra de contato: e o que gruda a gem na pista --- */
    if (alphaK > 0.04) {
      var shW = 0.98 * sxz;
      pushUnlit(Lshadow, x, LY.SURFACE_Y + 0.014, z + 0.025,
                shW, 1, shW * 0.78, null, shadowColor,
                0.74 * alphaK * vis * lerp(0.30, 1, birth));
    }

    /* --- 2. rastro de luz (so sem sustain e so perto: senao vira borrao) --- */
    if (nt.dur <= 0 && anim === AN_NONE && depthT > 0.34) {
      _cTmp.copy(spVis ? SPLOOK.halo : L.halo);
      pushUnlit(Ltrail, x, LY.SURFACE_Y + 0.022, z,
                0.46 * sxz, 1, lerp(0.50, 1.05, clamp01(depthT)), null,
                _cTmp, A_TRAIL * vis * addW);
    }

    /* --- 3. corpo biselado --- */
    pushLit(Lgem, x, y, z, sxz, sy, sxz, quat, _cTint, _cEmis,
            _look.metal, _look.rough, gain);

    /* --- 4. aro cromado --- */
    _cTmp.copy(_cRim).multiplyScalar(_look.rimGain * (0.55 + gain * 0.55));
    var rs = sxz * _look.rimScale;
    pushLit(Lrim, x, y, z, rs, sy * 0.92 + scale * 0.08, rs, quat,
            _cRim, _cTmp, 1.0, spVis ? 0.20 : (nt.hopo ? 0.30 : 0.42), 1.0);

    /* --- 5. nucleo emissivo deitado na tampa da gem --- */
    var coreY = y + GEM_H * 0.5 * sy * 0.99 + 0.004;
    var coreR = 0.54 * GEM_R * 2.0 * sxz * _look.coreScale;
    var coreA = clamp01(A_CORE * (0.42 + gain * 0.58) * vis * alphaK * birth * lerp(0.28, 1.0, addW));
    if (nt.tap) coreA *= 1.45;
    /* No Star Power a gem inteira ja e cromada e ainda leva o banho azul da
       pista: com o nucleo em cheio ela virava um quadrado branco liso e a
       ESTRELA — que e o que identifica a nota de star power a 200 ms — sumia
       dentro dele. Baixando o nucleo, o bisel e a estrela voltam a aparecer. */
    if (spVis) coreA *= 0.80;
    if (anim === AN_HIT) coreA = clamp01(coreA * (1 + 3.0 * (1 - animU)));
    _cTmp.copy(spVis ? SPLOOK.core : (nt.tap ? L.tapEmis : L.core));
    if (deadMix > 0) _cTmp.lerp(L.dead, deadMix);
    pushUnlit(Lcore, x, coreY, z, coreR, 1, coreR, null, _cTmp, coreA);

    /* --- 6. estrela do Star Power: inconfundivel a 200ms --- */
    if (spVis && alphaK > 0.05) {
      var starS = 0.66 * sxz * (1 + 0.06 * Math.sin(time * 5.2 + lane));
      _cTmp.copy(SPLOOK.core);
      pushUnlit(Lstar, x, y + 0.052 * sy, z + 0.035, starS, starS, starS,
                _camQ, _cTmp,
                clamp01(A_STAR * (0.60 + gain * 0.45) * vis * alphaK * birth * lerp(0.45, 1.0, addW)));
    }

    /* --- 7. halo volumetrico (ponderado pela profundidade) --- */
    var haloS = HALO_SIZE * (spVis ? 1.20 : 1.0) * sxz * (0.86 + gain * 0.26);
    var haloA = clamp01(A_HALO * (0.35 + gain * 0.72) * vis * alphaK * birth * addW);
    if (anim === AN_HIT) {
      haloS *= 1 + 3.4 * easeOutCubic(animU);
      haloA = clamp01(0.42 * (1 - animU) * (1 - animU) * vis);
      _cTmp.copy(SPLOOK.core).lerp(spVis ? SPLOOK.halo : L.halo, 0.45);
    } else if (anim === AN_MISS) {
      haloA *= clamp01(1 - animU * 2.6);
      _cTmp.copy(L.dead).lerp(L.halo, 0.5);
    } else {
      _cTmp.copy(spVis ? SPLOOK.halo : L.halo);
    }
    if (haloA > 0.004) {
      pushUnlit(Lhalo, x, y + 0.02, z, haloS, haloS, haloS, _camQ, _cTmp, haloA);
    }

    stat.gems++;
  }

  /* =========================================================================
     14. DESENHO DA NOTA ABERTA
     ========================================================================= */

  /* Barra larga atravessando as 5 raias, com energia correndo por dentro.
     O arco-iris das 5 cores de raia vem de uma rampa procedural do
     GH.Materials — e o mesmo mapa que alimenta a fita de energia. */
  function drawOpen(nt, idx, z, depthT, anim, animU) {
    var LY = layout();
    var spVis = (!!nt.sp) || spActive;
    var birth = smoothstep01(depthT / BIRTH_T);
    var grow = lerp(0.90, 1.045, smoothstep01(depthT)) * lerp(0.45, 1, birth);
    var strikeK = Math.exp(-(z / 1.35) * (z / 1.35));
    var gain = lerp(0.55, 1.55, Math.pow(clamp01(depthT), 1.2)) * birth + strikeK * 0.65;
    var y = OPEN_Y;
    var alphaK = 1;
    var quat = null;

    if (anim === AN_HIT) {
      var pop = easeOutCubic(animU);
      grow *= (1 + 0.32 * pop) * (1 - animU * animU * animU);
      gain *= 1 + 6.5 * (1 - animU) * (1 - animU);
      alphaK = 1 - animU * 0.2;
    } else if (anim === AN_MISS) {
      y -= animU * animU * 0.60;
      grow *= (1 - 0.20 * animU);
      gain *= (1 - animU) * (1 - animU) * 0.4;
      alphaK = clamp01(1 - animU * 1.25);
      if (TILT_AXIS) { _q.setFromAxisAngle(TILT_AXIS, animU * 0.55); quat = _q; }
    }

    /* mesma saida de quadro da gem (ver drawGem): a barra aberta colapsa
       logo depois de passar pela linha em vez de virar um paredao no rodape */
    if (z > 0.30) {
      var outU = clamp01((z - 0.30) / 1.35);
      if (outU >= 0.999) return;
      var outK = (1 - outU) * (1 - outU);
      grow *= outK; gain *= outK; alphaK *= outK;
    }

    var vis = visAt(0, y + OPEN_H * 0.5, z);
    var addW = Math.pow(clamp01(depthT), ADD_FALLOFF);

    /* --- sombra larga: a barra tem que pesar na pista --- */
    pushUnlit(Lshadow, 0, LY.SURFACE_Y + 0.013, z + 0.04,
              OPEN_W * 0.99 * grow, 1, 0.95, null, shadowColor,
              0.55 * alphaK * vis * birth);

    /* --- corpo da barra --- */
    if (spVis) {
      _cTint.copy(SPLOOK.tint);
      _cEmis.copy(SPLOOK.emis).multiplyScalar(0.85);
      _look.metal = 1.0; _look.rough = 0.13;
    } else {
      _cTint.copy(OPENLOOK.tint);
      _cEmis.copy(OPENLOOK.emis).multiplyScalar(0.60);
      _look.metal = 0.0; _look.rough = 0.20;
    }
    if (anim === AN_MISS) {
      _cTint.multiplyScalar(clamp01(1 - animU * 1.4) * 0.75 + 0.12);
      _cEmis.multiplyScalar(clamp01(1 - animU * 2.2));
      _look.rough = clamp(_look.rough + animU * 0.5, 0, 1);
      _look.metal = 0;
    }
    pushLit(Lopen, 0, y, z, grow, grow, 1, quat, _cTint, _cEmis,
            _look.metal, _look.rough, gain);

    /* --- energia correndo por dentro (mesma fita do sustain) --- */
    _cTmp.setRGB(1, 1, 1);
    if (spVis) _cTmp.copy(SPLOOK.core);
    pushRibbon(Lribbon, -OPEN_W * 0.5 * grow, y + OPEN_H * 0.58, z,
               0.26, 0.105, OPEN_W * grow, _qX, _cTmp,
               OPEN_W,
               clamp01((0.30 + gain * 0.26) * vis * alphaK * birth * lerp(0.45, 1, addW)),
               spVis ? 0.85 : 0.20, spVis ? 0.0 : 1.0);

    /* --- halos: um por raia (a barra pertence as cinco) --- */
    for (var i = 0; i < 5; i++) {
      var hs = HALO_SIZE * 1.05 * grow;
      var ha = clamp01(A_HALO * (0.45 + gain * 0.65) * vis * alphaK * birth * addW);
      if (anim === AN_HIT) {
        hs *= 1 + 2.4 * easeOutCubic(animU);
        ha = clamp01(0.40 * (1 - animU) * (1 - animU) * vis);
        _cTmp.copy(SPLOOK.core).lerp(spVis ? SPLOOK.halo : LOOK[i].halo, 0.5);
      } else {
        _cTmp.copy(spVis ? SPLOOK.halo : LOOK[i].halo);
      }
      pushUnlit(Lhalo, LY.laneX(i), y + OPEN_H * 0.6, z, hs, hs, hs,
                _camQ, _cTmp, ha);
    }
    stat.opens++;
  }

  /* =========================================================================
     15. SUSTAIN + CONECTOR DE ACORDE
     ========================================================================= */

  /* Trilho luminoso saindo da gem. Enquanto e segurado ele fica preso na
     linha de acerto e ENCURTA: literalmente queima, soltando fagulhas.
     Solto antes do fim, apaga em 0.42s. */
  function drawSustain(nt, idx, songTime, state, dt) {
    var C = chartOf();
    var LY = layout();
    var lane = nt.lane | 0;
    if (lane < 0) lane = 0;
    if (lane > 4) lane = 4;
    var spVis = (!!nt.sp) || spActive;
    var L = LOOK[lane] || LOOK[0];

    var headZ = C.zAt(songTime, nt.t);
    var tailZ = C.zAt(songTime, nt.end);
    var held = (state === ST_HELD);
    var dead = false;

    if (held) {
      headZ = LY.STRIKE_Z;                       // preso no traste: queimando
    } else if (state === ST_DONE || state === ST_HIT) {
      if (songTime < nt.end - 0.02) {
        if (vSusDead[idx] < 0) vSusDead[idx] = songTime;
        headZ = LY.STRIKE_Z;
        dead = true;
      } else {
        return;                                   // completou: nada a desenhar
      }
    } else if (state === ST_MISSED) {
      dead = true;
      if (headZ > 1.2) headZ = 1.2;
    } else if (headZ > 1.6) {
      headZ = 1.6;
    }

    /* Corta a cauda bem antes do fim da pista: alem disto a neblina ja comeu
       tudo e so restaria overdraw aditivo. */
    var tailLimit = LY.SPAWN_Z * 0.62;
    if (tailZ < tailLimit) tailZ = tailLimit;
    var len = headZ - tailZ;
    if (len <= 0.02) return;

    var deadK = 1;
    if (dead) {
      var since = (vSusDead[idx] >= 0) ? (songTime - vSusDead[idx]) : 0;
      deadK = (state === ST_MISSED) ? 0.30 : clamp01(1 - since / 0.42);
      if (deadK <= 0.01) return;
    }

    var midZ = (headZ + tailZ) * 0.5;
    var xx = LY.laneX(lane);
    var vis = visAt(xx, SUS_Y, midZ);
    var birth = smoothstep01(clamp01((headZ - LY.SPAWN_Z) / 5.0));

    if (spVis) _cTmp.copy(SPLOOK.emis);
    else _cTmp.copy(L.core);
    if (dead) _cTmp.lerp(L.dead, 0.74);

    /* peso de profundidade: a cauda longe quase nao soma (a fita ja tem o
       `tail` no shader, isto cuida do sustain inteiro que ainda esta longe) */
    var headT = clamp01((headZ - LY.SPAWN_Z) / (LY.STRIKE_Z - LY.SPAWN_Z));
    var alpha = (held ? 1.15 : 0.86) * vis * birth * deadK * lerp(0.55, 1.0, headT);
    var hot = held ? 1.0 : (spVis ? 0.45 : 0.16);
    var w = SUS_W * (held ? 1.16 : 1.0) * (nt.tap ? 0.86 : 1.0);
    var h = SUS_H * (held ? 1.24 : 1.0);

    pushRibbon(Lribbon, xx, SUS_Y, headZ, w, h, len, null,
               _cTmp, len, alpha, hot, 0.0);
    stat.sustains++;

    /* fagulhas na linha de acerto enquanto queima */
    if (held && dt > 0) {
      vSpark[idx] += dt * SUS_SPARK_RATE * (spVis ? 1.35 : 1.0);
      var burst = vSpark[idx] | 0;
      if (burst > 6) burst = 6;
      vSpark[idx] -= burst;
      var cc = spVis ? SPLOOK.core : L.halo;
      for (var k = 0; k < burst; k++) {
        emitSpark(xx, SUS_Y + 0.06, LY.STRIKE_Z, cc.r, cc.g, cc.b, 1.0);
      }
    }
  }

  /* Conector luminoso do acorde: barra fina ligando raias vizinhas do mesmo
     ataque. E o que faz o olho ler "isto e UM acorde", nao tres notas soltas. */
  function drawChordConnector(nt, z, depthT) {
    var C = chartOf();
    var g = (C && C.groupAt) ? C.groupAt(nt.group) : null;
    if (!g || !g.lanes || g.lanes.length < 2 || g.open) return;
    var LY = layout();
    var spVis = g.sp || spActive;
    var birth = smoothstep01(depthT / BIRTH_T);
    var vis = visAt(0, CONN_Y, z);
    var alpha = (0.16 + 0.34 * clamp01(depthT)) * vis * birth *
                lerp(0.30, 1.0, Math.pow(clamp01(depthT), ADD_FALLOFF));
    if (alpha <= 0.012) return;

    /* as raias do grupo ja vem em ordem crescente do GH.Chart */
    for (var i = 0; i < g.lanes.length - 1; i++) {
      var a = g.lanes[i] | 0, b = g.lanes[i + 1] | 0;
      var xa = LY.laneX(a), xb = LY.laneX(b);
      var len = xb - xa;
      if (len <= 0.001) continue;
      if (spVis) _cTmp.copy(SPLOOK.halo);
      else { _cTmp.copy(LOOK[a].core); _cTmp.lerp(LOOK[b].core, 0.5); }
      pushRibbon(Lribbon, xa, CONN_Y, z, CONN_W, CONN_H, len, _qX,
                 _cTmp, len, alpha, spVis ? 0.55 : 0.22, 0.0);
      stat.connectors++;
    }
  }
  /* =========================================================================
     16. UPDATE
     ========================================================================= */

  function flushAll() {
    Lgem.flush(); Lrim.flush(); Lopen.flush(); Lshadow.flush(); Ltrail.flush();
    Lribbon.flush(); Lcore.flush(); Lstar.flush(); Lhalo.flush(); Lspark.flush();
  }

  function resetAll() {
    Lgem.reset(); Lrim.reset(); Lopen.reset(); Lshadow.reset(); Ltrail.reset();
    Lribbon.reset(); Lcore.reset(); Lstar.reset(); Lhalo.reset(); Lspark.reset();
    stat.gems = 0; stat.sustains = 0; stat.opens = 0; stat.connectors = 0;
    stat.halos = 0; stat.visible = 0; stat.dying = 0; stat.overflow = 0;
  }

  function syncCamera() {
    var cam = camera || (GH.Engine ? GH.Engine.camera : null);
    if (!cam) return false;
    camera = cam;
    cam.getWorldQuaternion(_camQ);
    cam.getWorldPosition(_camPos);
    return true;
  }

  function update(dt, songTime) {
    if (!inited) return;
    if (!isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    time += dt;
    _lastSongTime = songTime || 0;

    var C = chartOf();
    resetAll();

    if (!C || !C.notes || !C.notes.length || !C.loaded) {
      updateSparks(dt);
      drawSparks();
      flushAll();
      return;
    }

    ensureNoteArrays();
    refreshFog();
    if (!syncCamera()) { flushAll(); return; }

    /* transicao suave do estado de Star Power (a cor nao pula de um frame
       para o outro — o brilho geral acompanha) */
    var U2 = util();
    spBlend = U2 ? U2.damp(spBlend, spActive ? 1 : 0, 8, dt)
                 : (spActive ? 1 : 0);

    if (ribbonMat) ribbonMat.uniforms.uTime.value = time;

    var notes = C.notes;
    var LY = layout();
    var i, nt, st;

    /* ---- 1. notas vivas dentro do alcance visivel ---- */
    var range = C.visibleRange(songTime);
    var i0 = range[0], i1 = range[1];
    stat.visible = i1 - i0 + 1;

    for (i = i0; i <= i1; i++) {
      nt = notes[i];
      if (!nt) continue;
      st = nt.state | 0;

      /* Detecta transicoes de estado que o Game pode nao ter roteado
         (historico silencioso do modo captura, autoplay, etc.). */
      var prev = vPrevState[i];
      if (prev !== st) {
        if (st === ST_DONE && prev === ST_HELD && songTime < nt.end - 0.02) {
          if (vSusDead[i] < 0) vSusDead[i] = songTime;
        }
        if (st === ST_PENDING) { vSusDead[i] = -1; vSpark[i] = 0; }
        vPrevState[i] = st;
      }

      /* sustain e desenhado independentemente do estado da cabeca */
      if (nt.dur > 0) drawSustain(nt, i, songTime, st, dt);

      /* a cabeca so existe enquanto a nota nao foi resolvida */
      if (st !== ST_PENDING) continue;
      if (vAnim[i] !== AN_NONE) continue;      /* ja esta na lista de morte */

      var z = C.zAt(songTime, nt.t);
      if (z > LY.DESPAWN_Z || z < LY.SPAWN_Z - 1) continue;
      var depthT = clamp01((z - LY.SPAWN_Z) / (LY.STRIKE_Z - LY.SPAWN_Z));

      if (nt.open) {
        drawOpen(nt, i, z, depthT, AN_NONE, 0);
      } else {
        if (nt.chord && nt.root) drawChordConnector(nt, z, depthT);
        drawGem(nt, i, LY.laneX(nt.lane), z, depthT, AN_NONE, 0);
      }
    }

    /* ---- 2. notas em animacao de morte (podem estar fora do alcance) ---- */
    var w = 0;
    for (var d = 0; d < dyingN; d++) {
      var idx = dying[d];
      if (idx < 0 || idx >= notes.length) continue;
      nt = notes[idx];
      if (!nt) continue;
      var an = vAnim[idx];
      if (an === AN_NONE) continue;

      vAnimT[idx] += dt;
      var dur = (an === AN_HIT) ? HIT_DUR : MISS_DUR;
      var u = vAnimT[idx] / dur;
      if (u >= 1) {
        vAnim[idx] = AN_NONE;
        vAnimT[idx] = 0;
        continue;
      }

      var zz = (an === AN_HIT) ? vDeathZ[idx] : C.zAt(songTime, nt.t);
      if (zz > LY.DESPAWN_Z + 3) { vAnim[idx] = AN_NONE; continue; }
      var dT = clamp01((zz - LY.SPAWN_Z) / (LY.STRIKE_Z - LY.SPAWN_Z));

      if (nt.open) drawOpen(nt, idx, zz, dT, an, u);
      else drawGem(nt, idx, LY.laneX(nt.lane), zz, dT, an, u);

      dying[w++] = idx;
    }
    dyingN = w;
    stat.dying = dyingN;

    /* ---- 3. fagulhas ---- */
    updateSparks(dt);
    drawSparks();

    flushAll();
  }

  /* =========================================================================
     17. CICLO DE VIDA
     ========================================================================= */

  function dispose() {
    if (!inited) return;
    try { if (scene && group) scene.remove(group); } catch (e) {}
    var all = [Lgem, Lrim, Lopen, Lshadow, Ltrail, Lribbon, Lcore, Lstar, Lhalo, Lspark];
    for (var i = 0; i < all.length; i++) { if (all[i]) all[i].dispose(); }
    Lgem = Lrim = Lopen = Lshadow = Ltrail = Lribbon = Lcore = Lstar = Lhalo = Lspark = null;
    group = null;
    inited = false;
    API.group = null;
  }

  function setTheme() {
    buildLooks();

    return API;
  }

  /* =========================================================================
     18. API PUBLICA
     ========================================================================= */

  var API = {
    init: init,
    update: update,
    group: null,
    onHit: onHit,
    onMiss: onMiss,
    setStarPower: setStarPower,
    reset: reset,

    /* extras uteis (nao fazem parte do contrato, mas nao atrapalham) */
    setTheme: setTheme,
    dispose: dispose,
    stats: function () { return stat; },
    get starPower() { return spActive; },
    get ready() { return inited; }
  };

  /* eixo de tombo do erro: a gem cai para a frente, na direcao do jogador */
  try { TILT_AXIS = new THREE.Vector3(1, 0, 0); } catch (e) { TILT_AXIS = null; }

  GH.Notes = API;

})(window.GH = window.GH || {});

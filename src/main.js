/* ===========================================================================
   GUITARRADA HERO — src/main.js
   Bootstrap do jogo + MODO CAPTURA (secao 7 do ARCHITECTURE.md).

   Dois caminhos, um arquivo:

   A) MODO NORMAL (index.html sem ?cap=)
      1. Tela de carregamento em HTML (nitida, animada) com barra de progresso.
      2. Geracao das texturas procedurais em FATIAS com requestAnimationFrame —
         a aba nunca congela e a barra anda de verdade.
      3. Inicializacao dos modulos visuais, do GH.Game e ida para o titulo.
      4. O AudioContext so nasce no primeiro gesto do usuario (regra do
         navegador). Ate la o jogo roda mudo, sem erro.

   B) MODO CAPTURA (index.html?cap=<cena>&t=<seg>&seed=<int>&w=&h=)
      1. window.__GH_CAP e definido ANTES de qualquer init — engine, audio e
         conductor leem essa flag e entram no modo deterministico/mudo.
      2. GH.Util e semeado com `seed`.
      3. GH.Game.forceState monta a cena pedida.
      4. Simulamos de t-3,0 s ate t em passos FIXOS de 1/60 chamando todos os
         updaters (particulas, chamas, publico e combo ganham historia real).
      5. Renderiza o frame final, congela o rAF, seta __GH_READY e o titulo.

   NADA aqui pode falhar em silencio: todo caminho passa por try/catch e
   termina em window.__GH_fatal() com a tela vermelha grande.
   =========================================================================== */

(function (GH) {
  'use strict';

  /* =========================================================================
     0. PARAMETROS DA URL — tem que rodar ANTES de qualquer init
     ========================================================================= */

  function parseQuery() {
    var out = {};
    try {
      var s = (window.location && window.location.search) || '';
      if (s.charAt(0) === '?') s = s.slice(1);
      if (!s) return out;
      var parts = s.split('&');
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var kv = parts[i].split('=');
        out[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
      }
    } catch (e) { /* file:// paranoico */ }
    return out;
  }

  var Q = parseQuery();
  var CAP_NAME = (Q.cap || '').trim();
  var IS_CAP = CAP_NAME.length > 0;

  var CAP_T = parseFloat(Q.t);
  if (!isFinite(CAP_T)) CAP_T = 32;
  var CAP_SEED = parseInt(Q.seed, 10);
  if (!isFinite(CAP_SEED)) CAP_SEED = 7;
  var CAP_W = parseInt(Q.w, 10);
  var CAP_H = parseInt(Q.h, 10);
  if (!isFinite(CAP_W) || CAP_W < 16) CAP_W = 1600;
  if (!isFinite(CAP_H) || CAP_H < 16) CAP_H = 900;
  var CAP_PREROLL = parseFloat(Q.preroll);
  if (!isFinite(CAP_PREROLL) || CAP_PREROLL < 0) CAP_PREROLL = 3.0;

  /* A FLAG, antes de tudo. O engine le isto no init (pixelRatio 1:1,
     preserveDrawingBuffer, sem auto-qualidade, seed do sway fixa); o audio e o
     conductor leem para nao criar AudioContext nenhum. */
  if (IS_CAP) {
    window.__GH_CAP = { cap: CAP_NAME, t: CAP_T, seed: CAP_SEED, w: CAP_W, h: CAP_H };
  }
  window.__GH_READY = false;

  /* =========================================================================
     1. FERRAMENTAS
     ========================================================================= */

  var boot = {
    step: '',
    errors: [],
    startedAt: (window.performance && performance.now) ? performance.now() : Date.now()
  };

  function fatal(msg, e) {
    var full = String(msg);
    if (e && e.message) full += ' :: ' + e.message;
    if (e && e.stack) full += '\n' + String(e.stack).split('\n').slice(0, 6).join('\n');
    boot.errors.push(full);
    try { if (window.__GH_fatal) window.__GH_fatal(full); } catch (err) { /* ok */ }
    try { document.title = 'GH_ERROR: ' + full.slice(0, 160); } catch (err2) { /* ok */ }
    try { if (console && console.error) console.error('GH_ERROR: ' + full); } catch (err3) { /* ok */ }
    drawFatalOverlay(full);
  }

  /* Erro DESENHADO por cima de tudo, grande e vermelho. O contrato exige que a
     falha seja visivel no print, nunca uma tela preta muda. */
  function drawFatalOverlay(msg) {
    try {
      var ui = document.getElementById('gh-ui') || document.body;
      var el = document.getElementById('gh-boot-fatal');
      if (!el) {
        el = document.createElement('div');
        el.id = 'gh-boot-fatal';
        el.style.cssText = [
          'position:absolute', 'inset:0', 'z-index:99999', 'pointer-events:none',
          'display:flex', 'flex-direction:column', 'justify-content:center',
          'padding:5vh 6vw', 'box-sizing:border-box',
          'background:rgba(24,0,4,.92)',
          'font:700 clamp(16px,2.1vw,30px)/1.35 "Cascadia Mono",Consolas,monospace',
          'color:#ff6b6b', 'white-space:pre-wrap', 'overflow:hidden'
        ].join(';');
        ui.appendChild(el);
      }
      el.textContent = 'GH_ERROR\n\n' + msg;
      el.style.display = 'flex';
    } catch (e) { /* se nem isso der, o #gh-fatal do index.html ja cobre */ }
  }

  function guard(label, fn) {
    boot.step = label;
    try { return fn(); }
    catch (e) { fatal('falha em "' + label + '"', e); return undefined; }
  }

  /* Chamada opcional a outro modulo: nunca derruba o boot. */
  function opt(modName, fnName, a, b, c) {
    var m = GH[modName];
    if (!m || typeof m[fnName] !== 'function') return undefined;
    try { return m[fnName](a, b, c); }
    catch (e) {
      boot.errors.push(modName + '.' + fnName + ': ' + (e && e.message));
      try { if (console && console.warn) console.warn('GH.main: ' + modName + '.' + fnName, e); } catch (e2) { /* ok */ }
      return undefined;
    }
  }

  function el(id) { return document.getElementById(id); }

  /* =========================================================================
     2. SCAFFOLD — rede de seguranca visual
     Enquanto os modulos de HIGHWAY / STAGE nao existirem, montamos um cenario
     minimo para que NENHUMA captura saia preta. Cada peca so e construida se o
     modulo dono estiver ausente; assim que o modulo real chegar, o scaffold
     simplesmente nao nasce. Isto NAO substitui o trabalho daqueles agentes.
     ========================================================================= */

  var scaffold = { group: null, built: [] };

  function L() {
    return GH.Layout || {
      LANES: 5, LANE_W: 0.72, HALF_W: 1.80, SPAWN_Z: -46, DESPAWN_Z: 6,
      STRIKE_Z: 0, SURFACE_Y: 0, GEM_Y: 0.16,
      laneX: function (i) { return (i - 2) * 0.72; }
    };
  }

  function themeColor(key, fallback) {
    try {
      var t = GH.Palette && GH.Palette.current;
      if (t && t[key] && t[key].isColor) return t[key].clone();
      if (t && t.hex && t.hex[key]) return new THREE.Color(t.hex[key]);
    } catch (e) { /* fallback */ }
    return new THREE.Color(fallback);
  }

  function buildScaffold(scene) {
    if (!scene || !window.THREE) return;
    var needHighway = !GH.Highway;
    var needStage = !GH.Stage;
    if (!needHighway && !needStage) return;

    var lay = L();
    var g = new THREE.Group();
    g.name = 'GH_Scaffold';
    scaffold.group = g;

    var M = GH.Materials;
    var mk = (M && M.make) ? M.make : null;

    /* ---------- PALCO PROVISORIO ----------
       Objetivo: dar HORIZONTE, PROFUNDIDADE e uma massa escura de publico para
       que a pista nao flutue no vazio e nenhuma captura saia preta. A base do
       ceu usa a MESMA cor da neblina do engine, entao a linha do horizonte
       nasce sem emenda em vez de virar um corte duro. */
    var fogC = themeColor('fog', 0x301246);
    if (needStage) {
      scaffold.built.push('stage');

      var skyMat;
      try {
        /* A primeira parada da rampa cai no TOPO do plano (a textura nasce com
           flipY ligado). Calibrado para a camera de gameplay: a emenda com a
           neblina cai exatamente na linha do chao (parada 0.586), a brasa do
           sol logo acima, e dali para cima laranja -> magenta -> violeta ->
           indigo. Assim o horizonte nao vira um corte duro. */
        var hz = themeColor('horizon', 0xff6a1e);
        var skC = themeColor('sky', 0x1e0b3a);
        var ramp = (M && M.tex && M.tex.gradientRamp)
          ? M.tex.gradientRamp([
              skC.clone().multiplyScalar(0.26),
              skC.clone().multiplyScalar(0.48),
              skC.clone().multiplyScalar(1.55),
              themeColor('highwayEdge', 0xff3d8a).clone().multiplyScalar(0.50),
              hz.clone(),
              hz.clone().multiplyScalar(1.40),
              fogC.clone(),
              fogC.clone()
            ], { vertical: true, size: 512,
                 stops: [0, 0.14, 0.30, 0.43, 0.515, 0.560, 0.588, 1] })
          : null;
        skyMat = new THREE.MeshBasicMaterial({
          map: ramp, color: ramp ? 0xffffff : 0x2a1040, fog: false, depthWrite: false
        });
      } catch (e) {
        skyMat = new THREE.MeshBasicMaterial({ color: 0x2a1040, fog: false, depthWrite: false });
      }
      /* fundo neutro atras do ceu: garante que NENHUMA camera (nem a
         cinematografica) enxergue a borda do plano do por do sol */
      var backMat = new THREE.MeshBasicMaterial({
        color: themeColor('sky', 0x1e0b3a).multiplyScalar(0.26), fog: false, depthWrite: false
      });
      var back = new THREE.Mesh(new THREE.PlaneGeometry(1400, 460), backMat);
      back.position.set(0, 40, -132);
      back.renderOrder = -30;
      back.frustumCulled = false;
      g.add(back);

      var sky = new THREE.Mesh(new THREE.PlaneGeometry(900, 62), skyMat);
      sky.position.set(0, 5, -118);
      sky.renderOrder = -20;
      sky.frustumCulled = false;
      g.add(sky);

      /* chao do palco: bem escuro, para o refletor magenta do engine nao
         lavar o fundo inteiro. A neblina fecha o resto. */
      var floorMat = new THREE.MeshStandardMaterial({
        color: themeColor('highway', 0x150a20).multiplyScalar(0.55),
        roughness: 0.94, metalness: 0.0
      });
      var floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 260), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(0, -0.36, -60);
      floor.receiveShadow = true;
      g.add(floor);

      /* praticavel escuro no fim da pista: fecha a fuga e da uma base para o
         palco (o agente de PALCO troca isto por banda, publico e cenario) */
      var riserMat = new THREE.MeshStandardMaterial({
        color: fogC.clone().multiplyScalar(0.30), roughness: 0.9, metalness: 0.0
      });
      var riser = new THREE.Mesh(new THREE.BoxGeometry(30, 1.15, 4.0), riserMat);
      riser.position.set(0, 0.22, -52);
      riser.receiveShadow = true;
      g.add(riser);

      /* rig de luz atras: feixes verticais alternando os neons do tema */
      var neon = themeColor('neon', 0x25e8ce);
      var edge = themeColor('highwayEdge', 0xff3d8a);
      var beamGeo = new THREE.BoxGeometry(0.10, 9.0, 0.10);
      for (var b = 0; b < 11; b++) {
        var c = (b % 2) ? neon : edge;
        var barMat = mk && mk.emissiveUnlit
          ? mk.emissiveUnlit(c, 1.35)
          : new THREE.MeshBasicMaterial({ color: c });
        var bar = new THREE.Mesh(beamGeo, barMat);
        bar.position.set(-30 + b * 6.0, 6.4 + (b % 3) * 0.8, -80 - (b % 3) * 6);
        g.add(bar);
      }
      /* travessa horizontal — leitura de "estrutura de palco" */
      var trussMat = new THREE.MeshStandardMaterial({
        color: 0x10121a, roughness: 0.65, metalness: 0.85
      });
      var truss = new THREE.Mesh(new THREE.BoxGeometry(70, 0.36, 0.36), trussMat);
      truss.position.set(0, 11.4, -80);
      g.add(truss);
    }

    /* ---------- PISTA PROVISORIA ---------- */
    if (needHighway) {
      scaffold.built.push('highway');

      var len = lay.DESPAWN_Z - lay.SPAWN_Z;
      var wid = lay.HALF_W * 2;

      /* copia PRIVADA do material da pista (fresh) — o verniz alto do material
         compartilhado estoura em angulo rasante sob o refletor magenta do
         engine. Nunca mutamos o material cacheado: ele e do agente de HIGHWAY. */
      var surfMat = null;
      if (M && typeof M.fresh === 'function') {
        surfMat = M.fresh('highwaySurface', { repeatX: 2, repeatY: 22 });
        if (surfMat) {
          surfMat.clearcoat = 0.16;
          surfMat.clearcoatRoughness = 0.55;
          surfMat.envMapIntensity = 0.22;
          surfMat.needsUpdate = true;
        }
      }
      if (!surfMat && mk && mk.highwaySurface) surfMat = mk.highwaySurface({ repeatX: 2, repeatY: 22 });
      if (!surfMat) surfMat = new THREE.MeshStandardMaterial({ color: 0x191228, roughness: 0.85, metalness: 0.0 });
      var surf = new THREE.Mesh(new THREE.PlaneGeometry(wid, len, 1, 32), surfMat);
      surf.rotation.x = -Math.PI / 2;
      surf.position.set(0, lay.SURFACE_Y, (lay.SPAWN_Z + lay.DESPAWN_Z) * 0.5);
      surf.receiveShadow = true;
      g.add(surf);

      /* divisorias das raias */
      var divGeo = new THREE.PlaneGeometry(0.018, len);
      for (var d = 0; d <= lay.LANES; d++) {
        var x = (d - 2.5) * lay.LANE_W;
        var isEdge = (d === 0 || d === lay.LANES);
        var dm = new THREE.MeshBasicMaterial({
          color: isEdge ? themeColor('highwayEdge', 0xff3d8a) : new THREE.Color(0x8ea0c8),
          transparent: true, opacity: isEdge ? 0.95 : 0.30, depthWrite: false, fog: true
        });
        var dv = new THREE.Mesh(divGeo, dm);
        dv.rotation.x = -Math.PI / 2;
        dv.position.set(x, lay.SURFACE_Y + 0.004, (lay.SPAWN_Z + lay.DESPAWN_Z) * 0.5);
        g.add(dv);
      }

      /* trilhos laterais de neon */
      for (var s = -1; s <= 1; s += 2) {
        var railMat = mk && mk.neonTube
          ? mk.neonTube(themeColor('highwayEdge', 0xff3d8a))
          : new THREE.MeshBasicMaterial({ color: 0xff3d8a });
        var rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, len), railMat);
        rail.position.set(s * (lay.HALF_W + 0.06), 0.05, (lay.SPAWN_Z + lay.DESPAWN_Z) * 0.5);
        g.add(rail);
      }

      /* linha de acerto */
      var strikeMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false
      });
      var strike = new THREE.Mesh(new THREE.PlaneGeometry(wid + 0.24, 0.075), strikeMat);
      strike.rotation.x = -Math.PI / 2;
      strike.position.set(0, lay.SURFACE_Y + 0.012, lay.STRIKE_Z);
      g.add(strike);

      /* 5 aros de fret */
      var ringGeo = new THREE.TorusGeometry(lay.LANE_W * 0.40, lay.LANE_W * 0.070, 12, 40);
      for (var i = 0; i < lay.LANES; i++) {
        var rm = mk && mk.fretRing ? mk.fretRing(i) : new THREE.MeshStandardMaterial({
          color: (GH.Palette && GH.Palette.lanes && GH.Palette.lanes[i]) ? GH.Palette.lanes[i] : 0xffffff,
          emissive: (GH.Palette && GH.Palette.laneEmissive) ? GH.Palette.laneEmissive[i] : 0x333333,
          emissiveIntensity: 1.4, roughness: 0.35, metalness: 0.6
        });
        var ring = new THREE.Mesh(ringGeo, rm);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(lay.laneX(i), lay.SURFACE_Y + 0.045, lay.STRIKE_Z);
        ring.castShadow = true;
        g.add(ring);

        /* disco interno luminoso */
        var discMat = new THREE.MeshBasicMaterial({
          color: (GH.Palette && GH.Palette.laneGlow) ? GH.Palette.laneGlow[i] : 0x88aaff,
          transparent: true, opacity: 0.34, depthWrite: false
        });
        var disc = new THREE.Mesh(new THREE.CircleGeometry(lay.LANE_W * 0.36, 28), discMat);
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(lay.laneX(i), lay.SURFACE_Y + 0.010, lay.STRIKE_Z);
        g.add(disc);
      }
    }

    scene.add(g);
  }

  /* =========================================================================
     3. INICIALIZACAO DOS MODULOS VISUAIS (todos opcionais)
     ========================================================================= */

  var VISUAL_STEPS = [
    { label: 'pista',      fn: function (sc, cam, ui) { opt('Highway', 'init', sc); } },
    { label: 'notas',      fn: function (sc, cam, ui) { opt('Notes', 'init', sc); } },
    { label: 'efeitos',    fn: function (sc, cam, ui) { opt('FX', 'init', sc, cam); } },
    { label: 'palco',      fn: function (sc, cam, ui) { opt('Stage', 'init', sc); } },
    { label: 'interface',  fn: function (sc, cam, ui) { opt('HUD', 'init', ui); } },
    { label: 'menus',      fn: function (sc, cam, ui) { opt('Menus', 'init', ui); } }
  ];

  function initVisuals() {
    var E = GH.Engine;
    var sc = E ? E.scene : null;
    var cam = E ? E.camera : null;
    var ui = el('gh-ui') || document.body;
    for (var i = 0; i < VISUAL_STEPS.length; i++) {
      try { VISUAL_STEPS[i].fn(sc, cam, ui); }
      catch (e) { boot.errors.push('init ' + VISUAL_STEPS[i].label + ': ' + (e && e.message)); }
    }
    buildScaffold(sc);
  }

  /* =========================================================================
     4. TELA DE CARREGAMENTO (modo normal)
     HTML/CSS por cima do canvas: texto nitido de verdade, sem textura.
     ========================================================================= */

  var loader = { root: null, bar: null, pct: null, task: null, done: false };

  var LOADER_CSS = [
    '#gh-load{position:absolute;inset:0;z-index:900;display:flex;flex-direction:column;',
    'align-items:center;justify-content:center;gap:0;pointer-events:none;',
    'background:radial-gradient(115% 88% at 50% 26%,#2b1150 0%,#160a2c 42%,#07060e 100%);',
    'font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;',
    'opacity:1;transition:opacity .55s cubic-bezier(.4,0,.2,1)}',
    '#gh-load.gone{opacity:0}',
    /* ---------------- CARTELA DO ESTUDIO (Mega Brain Games BR) -------------
       "UM JOGO MEGA BRAIN GAMES BR" — a cartela de publisher que abre o jogo.
       O logotipo vem de GH.Brand (definido em src/ui/menus.js, que carrega
       antes deste arquivo); se por qualquer motivo ele nao existir, cai num
       lockup de texto puro e a tela continua correta.
       A entrada e por TRANSITION de CSS, disparada pela classe .on: aqui nao
       ha o tween em JS dos menus, e esta tela nunca aparece numa captura de
       gameplay — a captura dela usa a classe .still, que congela tudo no
       estado final. */
    '#gh-load .pres{margin:0 0 calc(3.4vmin + 8px);text-align:center;',
    'opacity:0;transform:translateY(14px) scale(.965);',
    'transition:opacity .95s cubic-bezier(.22,1,.36,1),transform .95s cubic-bezier(.22,1,.36,1)}',
    '#gh-load.on .pres{opacity:1;transform:none}',
    '#gh-load .pres .ghb{font-size:clamp(15px,1.92vw,27px)}',
    '#gh-load .pres .ghb-mark{transform:scale(.72) rotate(-14deg);opacity:0;',
    'transition:transform 1.05s .16s cubic-bezier(.2,1.5,.35,1),opacity .7s .16s ease}',
    '#gh-load.on .pres .ghb-mark{transform:none;opacity:1}',
    '#gh-load .pres .ghb-eye{opacity:0;transform:translateY(6px);',
    'transition:opacity .7s .34s ease,transform .7s .34s cubic-bezier(.22,1,.36,1)}',
    '#gh-load.on .pres .ghb-eye{opacity:1;transform:none}',
    '#gh-load .pres .ghb-w2::before,#gh-load .pres .ghb-w2::after{transform:scaleX(0);',
    'transition:transform .85s .46s cubic-bezier(.22,1,.36,1)}',
    '#gh-load.on .pres .ghb-w2::before,#gh-load.on .pres .ghb-w2::after{transform:scaleX(1)}',
    /* modo captura: nada de animacao, tudo ja no estado final */
    '#gh-load.still *{transition:none !important;animation:none !important}',

    '#gh-load .glowline{position:absolute;left:0;right:0;top:0;height:2px;',
    'background:linear-gradient(90deg,transparent,var(--gh-neon,#25e8ce),var(--gh-highway-edge,#ff3d8a),transparent);',
    'opacity:.75;filter:blur(.4px)}',
    '#gh-load .kick{font-size:clamp(8px,.98vw,13px);letter-spacing:.58em;text-transform:uppercase;',
    'color:var(--gh-neon,#25e8ce);font-weight:700;margin:0 0 16px 4px;opacity:.88;',
    'display:flex;align-items:center;gap:16px}',
    '#gh-load .kick::before,#gh-load .kick::after{content:"";display:block;width:clamp(22px,4vw,64px);',
    'height:1px;background:linear-gradient(90deg,transparent,var(--gh-neon,#25e8ce));opacity:.55}',
    '#gh-load .kick::after{background:linear-gradient(90deg,var(--gh-neon,#25e8ce),transparent)}',
    '#gh-load .wm{font-family:"Arial Black","Segoe UI Black",Impact,"Segoe UI",sans-serif;',
    'font-weight:900;font-size:clamp(34px,7.6vw,108px);line-height:.92;letter-spacing:-.022em;',
    'text-transform:uppercase;margin:0;text-align:center;',
    'background:linear-gradient(178deg,#fff4d8 4%,#ffcf4a 38%,#ff6a1e 72%,#ff2e9a 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 5px 0 rgba(0,0,0,.55)) drop-shadow(0 0 34px rgba(255,106,30,.42))}',
    '#gh-load .wm i{display:block;font-style:normal;font-size:.63em;letter-spacing:.13em;',
    'margin-top:.06em;background:linear-gradient(178deg,#eafcff 0%,#8fd8ff 55%,#25e8ce 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent}',
    '#gh-load .slogan{margin:24px 0 0;max-width:min(760px,84vw);text-align:center;',
    'font-size:clamp(12px,1.42vw,20px);line-height:1.5;font-weight:600;letter-spacing:.012em;',
    'color:#e8eeff;text-shadow:0 2px 14px rgba(0,0,0,.75)}',
    '#gh-load .slogan b{color:var(--gh-gold,#ffcf4a);font-weight:800}',
    '#gh-load .track{margin-top:34px;width:min(460px,62vw);height:4px;border-radius:99px;',
    'background:rgba(255,255,255,.08);overflow:hidden;position:relative;',
    'box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}',
    '#gh-load .fill{position:absolute;left:0;top:0;bottom:0;width:0%;border-radius:99px;',
    'background:linear-gradient(90deg,#25e8ce,#8fd8ff 32%,#ffcf4a 68%,#ff6a1e);',
    'box-shadow:0 0 14px rgba(143,216,255,.8),0 0 38px rgba(255,106,30,.4);',
    'transition:width .18s cubic-bezier(.22,1,.36,1)}',
    '#gh-load .meta{margin-top:13px;display:flex;gap:13px;align-items:baseline;',
    'font-size:clamp(9px,.95vw,12px);letter-spacing:.19em;text-transform:uppercase;',
    'color:#7f8aa8;font-weight:600}',
    '#gh-load .meta b{color:#f2f5ff;font-variant-numeric:tabular-nums;font-weight:800;letter-spacing:.05em}',
    '#gh-load .notice{position:absolute;left:0;right:0;bottom:22px;text-align:center;',
    'font-size:clamp(9px,.92vw,12px);line-height:1.65;color:#5a6485;letter-spacing:.045em;',
    'padding:0 8vw;font-weight:500}',
    /* O convite para ligar o som e so um registro: letra miuda no canto
       superior direito, logo abaixo do selo "Projeto didatico" do titulo
       (mesma margem direita: 2,2u, com u = min(1vw, 1,7778vh) como no menu).
       Sai sozinho no primeiro clique ou tecla. */
    '#gh-hint{position:absolute;right:calc(min(1vw,1.7778vh)*2.4);top:calc(min(1vw,1.7778vh)*4.6);',
    'z-index:880;font-family:"Segoe UI",system-ui,sans-serif;font-weight:600;line-height:1;',
    'font-size:max(7px,calc(min(1vw,1.7778vh)*.52));letter-spacing:.2em;text-transform:uppercase;',
    'color:rgba(149,160,192,.6);text-shadow:0 1px 2px rgba(0,0,0,.9);',
    'pointer-events:none;white-space:nowrap;opacity:0;transition:opacity .5s ease}',
    '#gh-hint.on{opacity:1}'
  ].join('');

  /* Logotipo do estudio. Preferimos o de GH.Brand (mesma marca dos menus e dos
     creditos); o fallback existe para o caso improvavel de menus.js nao ter
     carregado — a tela nunca pode ficar sem a cartela obrigatoria. */
  function studioLockup() {
    try {
      if (GH.Brand && typeof GH.Brand.lockup === 'function') {
        GH.Brand.injectCss();
        return GH.Brand.lockup({ eyebrow: 'Um jogo', ring: true });
      }
    } catch (e) { /* fallback abaixo */ }
    return '<span style="font:900 1em/1 \'Arial Black\',Impact,sans-serif;' +
           'letter-spacing:.08em;color:#ffcf4a">UM JOGO MEGA BRAIN GAMES BR</span>';
  }

  function buildLoader(opts) {
    opts = opts || {};
    var ui = el('gh-ui') || document.body;
    if (!document.getElementById('gh-load-css')) {
      var style = document.createElement('style');
      style.id = 'gh-load-css';
      style.textContent = LOADER_CSS;
      document.head.appendChild(style);
    }

    var root = document.createElement('div');
    root.id = 'gh-load';
    root.innerHTML =
      '<div class="glowline"></div>' +
      '<div class="pres">' + studioLockup() + '</div>' +
      '<p class="kick">Homenagem &agrave; guitarrada paraense</p>' +
      '<h1 class="wm">Guitarrada<i>Hero</i></h1>' +
      '<p class="slogan">&ldquo;Queremos ver se o Brasil j&aacute; est&aacute; pronto<br>' +
      'pra tocar as m&uacute;sicas do <b>Ximbinha</b>&rdquo;</p>' +
      '<div class="track"><div class="fill"></div></div>' +
      '<div class="meta"><span id="gh-load-task">iniciando</span><b id="gh-load-pct">0%</b></div>' +
      '<p class="notice">Projeto did&aacute;tico, sem fins comerciais. M&uacute;sicas originais geradas ' +
      'proceduralmente.<br>Homenagem &mdash; n&atilde;o afiliado a nenhum artista ou gravadora.</p>';
    ui.appendChild(root);

    loader.root = root;
    loader.bar = root.querySelector('.fill');
    loader.pct = root.querySelector('#gh-load-pct');
    loader.task = root.querySelector('#gh-load-task');

    /* A classe .on dispara a entrada da cartela do estudio. Precisa cair num
       frame DEPOIS da insercao, senao o navegador colapsa o estado inicial e o
       final numa coisa so e nao ha transicao nenhuma. */
    if (opts.instant) {
      root.className = 'still on';
    } else {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          try { root.classList.add('on'); } catch (e) { root.className = 'on'; }
        });
      });
    }
  }

  function setProgress(p, taskName) {
    if (!loader.root) return;
    var v = Math.round(Math.max(0, Math.min(1, p)) * 100);
    if (loader.bar) loader.bar.style.width = v + '%';
    if (loader.pct) loader.pct.textContent = v + '%';
    if (loader.task && taskName) loader.task.textContent = taskName;
  }

  function hideLoader() {
    if (!loader.root || loader.done) return;
    loader.done = true;
    /* classList.add e nao className= : trocar a string inteira apagaria a
       classe .on e a cartela do estudio "voltaria" no meio do fade */
    try { loader.root.classList.add('gone'); }
    catch (e) { loader.root.className = 'gone'; }
    var r = loader.root;
    setTimeout(function () { try { if (r.parentNode) r.parentNode.removeChild(r); } catch (e) { /* ok */ } }, 700);
  }

  /* =========================================================================
     5. AUDIO — destravado no primeiro gesto
     ========================================================================= */

  /* POR QUE ISTO E MAIS COMPLICADO DO QUE "resume() no primeiro clique"
     -------------------------------------------------------------------
     `AudioContext.resume()` devolve uma PROMESSA. Logo depois do primeiro
     gesto o `ctx.state` costuma continuar 'suspended' por alguns milissegundos
     — e pode nem chegar a 'running' (politica de autoplay mais dura, maquina
     sem saida de audio, fone plugado so depois). A versao anterior entregava
     o contexto ao GH.Conductor sem conferir NADA e ja removia os listeners de
     gesto: se o resume nao pegasse de primeira, o jogo ficava mudo para
     sempre, e o jogador nao tinha um segundo clique para tentar de novo.

     Agora: os listeners so saem quando o contexto esta comprovadamente
     'running', e um vigia de baixa frequencia continua olhando o estado —
     se o audio cair no meio da sessao, os ganchos de gesto voltam sozinhos e
     o HUD acende o aviso "som indisponivel" (GH.Conductor.audioStalled). */

  var audioReady = false;      // contexto CONFIRMADO em 'running'
  var audioWired = false;      // modulos ja ligados a este contexto uma vez
  var audioWatch = 0;          // id do vigia (setInterval)
  var unlockAttached = false;
  var AUDIO_WATCH_MS = 400;

  function audioContext() {
    try { return (GH.Audio && GH.Audio.ctx) ? GH.Audio.ctx : null; }
    catch (e) { return null; }
  }

  /* Idempotente: o vigia chama isto varias vezes por segundo enquanto o audio
     estiver parado e nao pode ficar recriando no nem reagendando timer. */
  function showAudioHint(msg) {
    try {
      var text = msg || 'clique para ligar o som';
      var h = el('gh-hint');
      if (h && h.className === 'on' && h.textContent === text) return;
      if (!h) {
        var ui = el('gh-ui') || document.body;
        h = document.createElement('div');
        h.id = 'gh-hint';
        ui.appendChild(h);
      }
      h.textContent = text;
      var node = h;
      setTimeout(function () { if (node.parentNode) node.className = 'on'; }, 60);
    } catch (e) { /* ok */ }
  }

  function hideAudioHint() {
    var h = el('gh-hint');
    if (!h) return;
    h.className = '';
    setTimeout(function () { try { if (h.parentNode) h.parentNode.removeChild(h); } catch (e) { /* ok */ } }, 600);
  }

  /* Liga (ou religa) maestro e sintetizador ao contexto.
     `Conductor.init` reancorra o relogio; chamar isso COM MUSICA TOCANDO
     produziria um degrau para tras (o maestro andou pelo relogio de parede
     enquanto o audio estava morto e o `startCtxTime` ficou velho). Nesse caso
     nao tocamos no maestro: o vigia interno dele ja reancorra sozinho quando o
     relogio de audio volta a andar. */
  function wireAudio(ctx) {
    var playing = false;
    try { playing = !!(GH.Conductor && GH.Conductor.isPlaying); } catch (e) { playing = false; }
    if (!playing) opt('Conductor', 'init', ctx);
    opt('Synth', 'init', GH.Audio);
    opt('Settings', 'apply');
    audioWired = true;
  }

  /* Primeiro (e cada) gesto do usuario. */
  function unlockAudio() {
    if (audioReady) return;
    try {
      opt('Audio', 'init');
      opt('Audio', 'unlock');
    } catch (e) {
      boot.errors.push('audio: ' + (e && e.message));
    }

    var ctx = audioContext();

    /* Sem AudioContext nenhum (navegador sem WebAudio, ou grafo que nao subiu):
       nao ha nada a esperar. O jogo segue mudo, sem ficar pedindo clique. */
    if (!ctx) {
      audioReady = true;
      hideAudioHint();
      detachUnlock();
      stopAudioWatch();
      return;
    }

    if (!audioWired) wireAudio(ctx);
    audioSettled(ctx);
    /* O vigia sobe SEMPRE, tenha o resume pegado ou nao: ele cobre tanto o
       contexto que demora a acordar quanto o que morre depois. Enquanto
       `audioReady` for false os listeners de gesto continuam de pe. */
    startAudioWatch();
  }

  /* Confirma (ou nao) que o contexto esta andando. */
  function audioSettled(ctx) {
    if (!ctx || ctx.state !== 'running') return false;
    audioReady = true;
    /* O contexto so acordou agora: e AQUI que o maestro precisa adotar o
       relogio de audio de verdade. */
    wireAudio(ctx);
    /* plateia de fundo: quem cala e o volume dela (Opcoes), nao uma chave */
    try { opt('Audio', 'ambience', true, 0.5); } catch (e) { /* ambiencia e enfeite */ }
    hideAudioHint();
    detachUnlock();
    return true;
  }

  /* Vigia de baixa frequencia: 2,5 leituras por segundo, custo irrelevante.
     Cobre os dois lados — o contexto que demora a acordar e o que morre depois
     (fone desconectado, saida de audio trocada, aba suspensa pelo sistema). */
  function startAudioWatch() {
    if (audioWatch || IS_CAP) return;
    audioWatch = window.setInterval(function () {
      var ctx = audioContext();
      if (!ctx) return;
      if (ctx.state === 'running') {
        if (!audioReady) audioSettled(ctx);
        return;
      }
      /* parado: reancora os ganchos de gesto e insiste no resume */
      audioReady = false;
      attachUnlock();
      /* Aba escondida: o navegador suspende o contexto de proposito. Nao ha o
         que consertar nem quem leia o aviso — so voltamos a insistir quando a
         pagina estiver visivel de novo. */
      if (document.hidden) return;
      showAudioHint('clique para ligar o som');
      try { if (ctx.resume) ctx.resume(); } catch (e) { /* politica do navegador */ }
    }, AUDIO_WATCH_MS);
  }

  function stopAudioWatch() {
    if (!audioWatch) return;
    window.clearInterval(audioWatch);
    audioWatch = 0;
  }

  var UNLOCK_EVENTS = ['pointerdown', 'mousedown', 'touchstart', 'keydown'];
  function attachUnlock() {
    if (unlockAttached) return;
    unlockAttached = true;
    for (var i = 0; i < UNLOCK_EVENTS.length; i++) {
      window.addEventListener(UNLOCK_EVENTS[i], unlockAudio, true);
    }
  }
  function detachUnlock() {
    if (!unlockAttached) return;
    unlockAttached = false;
    for (var i = 0; i < UNLOCK_EVENTS.length; i++) {
      window.removeEventListener(UNLOCK_EVENTS[i], unlockAudio, true);
    }
  }

  /* =========================================================================
     6. BOOT NORMAL — em fatias, com barra de progresso honesta
     ========================================================================= */

  /* Orcamento de tempo por frame. Acima disso devolvemos o controle ao
     navegador: a barra anda, a aba respira e nada trava. */
  var FRAME_BUDGET_MS = 11;

  function nowMs() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  function bootNormal() {
    guard('tela de carregamento', buildLoader);
    guard('paleta em CSS', function () { opt('Palette', 'applyCssVars'); });

    /* 1. engine — precisa existir antes das texturas (anisotropia, envMap) */
    guard('engine', function () {
      var canvas = el('gh-canvas');
      if (!GH.Engine || typeof GH.Engine.init !== 'function') throw new Error('GH.Engine ausente');
      GH.Engine.init(canvas);
    });
    setProgress(0.06, 'motor grafico');

    /* 2. lista de texturas a gerar */
    var texNames = [];
    try {
      if (GH.Materials && GH.Materials.tex && typeof GH.Materials.tex.names === 'function') {
        texNames = GH.Materials.tex.names();
      }
    } catch (e) { texNames = []; }

    var ti = 0;
    var total = texNames.length + VISUAL_STEPS.length + 3;
    var doneUnits = 1;

    function progress(task) {
      setProgress(0.06 + 0.94 * (doneUnits / Math.max(1, total)), task);
    }

    function sliceTextures() {
      var t0 = nowMs();
      while (ti < texNames.length) {
        var name = texNames[ti];
        try { GH.Materials.tex.get(name); }
        catch (e) { boot.errors.push('textura ' + name + ': ' + (e && e.message)); }
        ti++; doneUnits++;
        if (nowMs() - t0 > FRAME_BUDGET_MS) break;
      }
      progress('preparando texturas · ' + ti + '/' + texNames.length);
      if (ti < texNames.length) { requestAnimationFrame(sliceTextures); return; }
      requestAnimationFrame(sliceEnv);
    }

    /* Texturas ja guardadas de uma abertura anterior (GH.Materials, 4B) sao
       lidas antes de fatiar: ai cada tex.get so decodifica em vez de desenhar.
       Se o navegador demorar, segue sem esperar — gera como sempre. */
    var texStarted = false;
    function startTextures() {
      if (texStarted) return;
      texStarted = true;
      requestAnimationFrame(sliceTextures);
    }

    function sliceEnv() {
      guard('ambiente', function () { opt('Materials', 'applyEnvironment', GH.Engine.scene); });
      doneUnits++; progress('iluminacao de ambiente');
      vi = 0;
      requestAnimationFrame(sliceVisuals);
    }

    var vi = 0;
    function sliceVisuals() {
      var t0 = nowMs();
      var E = GH.Engine;
      var sc = E ? E.scene : null;
      var cam = E ? E.camera : null;
      var uiEl = el('gh-ui') || document.body;
      while (vi < VISUAL_STEPS.length) {
        var stepDef = VISUAL_STEPS[vi];
        try { stepDef.fn(sc, cam, uiEl); }
        catch (e) { boot.errors.push('init ' + stepDef.label + ': ' + (e && e.message)); }
        vi++; doneUnits++;
        progress('montando ' + stepDef.label);
        if (nowMs() - t0 > FRAME_BUDGET_MS) break;
      }
      if (vi < VISUAL_STEPS.length) { requestAnimationFrame(sliceVisuals); return; }
      requestAnimationFrame(finishBoot);
    }

    function finishBoot() {
      guard('cenario de seguranca', function () { buildScaffold(GH.Engine.scene); });
      doneUnits++; progress('afinando a guitarra');

      guard('jogo', function () {
        if (!GH.Game || typeof GH.Game.init !== 'function') throw new Error('GH.Game ausente');
        GH.Game.init({ capture: false });
      });
      doneUnits++; setProgress(1, 'pronto');

      guard('loop', function () { opt('Engine', 'start'); });

      /* audio so no primeiro gesto — regra do navegador, nao nossa */
      attachUnlock();
      showAudioHint();

      /* guarda as texturas geradas agora para a proxima abertura — com o
         titulo ja na tela, sem disputar o carregamento */
      setTimeout(function () { opt('Materials', 'saveTextureCache'); }, 2500);

      /* um respiro curto para a barra chegar visivelmente a 100% */
      setTimeout(function () {
        hideLoader();
        guard('titulo', function () { opt('Game', 'setState', 'title'); });
        window.__GH_READY = true;
        window.__GH_BOOT = {
          mode: 'normal',
          ms: Math.round(nowMs() - boot.startedAt),
          errors: boot.errors.slice(0),
          scaffold: scaffold.built.slice(0),
          game: (GH.Game && GH.Game.debug) ? GH.Game.debug() : null
        };
        try { document.body.setAttribute('data-gh-diag', JSON.stringify(window.__GH_BOOT)); }
        catch (e) { /* diagnostico nao e critico */ }
      }, 120);
    }

    if (GH.Materials && typeof GH.Materials.prefetchTextures === 'function') {
      try { GH.Materials.prefetchTextures(startTextures); } catch (e) { startTextures(); }
      setTimeout(startTextures, 1500);
    } else {
      startTextures();
    }
  }

  /* =========================================================================
     7. MODO CAPTURA
     ========================================================================= */

  /* Captura da TELA DE CARREGAMENTO (`?cap=loading`).
     Nao passa pelo GH.Game: a tela de carregamento e do main.js e existe antes
     de qualquer estado do jogo. `t` (0..1) vira a posicao da barra, para dar
     pra fotografar o comeco, o meio ou o fim do carregamento. */
  function bootCaptureLoading() {
    guard('semente', function () { opt('Util', 'seed', CAP_SEED); });
    guard('paleta em CSS', function () { opt('Palette', 'applyCssVars'); });
    guard('tela de carregamento', function () { buildLoader({ instant: true }); });

    var p = CAP_T;
    if (!isFinite(p) || p < 0) p = 0.62;
    if (p > 1) p = p / 100;          /* aceita 62 tanto quanto 0.62 */
    if (p > 1) p = 1;
    var texN = Math.round(38 * p);
    setProgress(p, p >= 1 ? 'pronto' : ('gerando texturas · ' + texN + '/38'));

    finishCapture();
  }

  function bootCapture() {
    if (CAP_NAME === 'loading') { bootCaptureLoading(); return; }

    /* 1. determinismo total */
    guard('semente', function () {
      opt('Util', 'seed', CAP_SEED);
      try {
        if (GH.Settings) {
          GH.Settings.audioOffsetMs = 0;
          GH.Settings.videoOffsetMs = 0;
          GH.Settings.noFail = false;
          GH.Settings.scrollSpeed = 14;
        }
      } catch (e) { /* ok */ }
      opt('Chart', 'setSpeed', 14);
    });

    /* 2. engine no tamanho exato pedido pela URL */
    guard('engine', function () {
      var canvas = el('gh-canvas');
      if (!GH.Engine || typeof GH.Engine.init !== 'function') throw new Error('GH.Engine ausente');
      GH.Engine.init(canvas, { quality: 'high' });
      GH.Engine.autoQuality = false;
      GH.Engine.setSize(CAP_W, CAP_H, true);
    });

    /* 3. paleta em CSS (o HUD/menus em HTML dependem disso) */
    guard('paleta', function () { opt('Palette', 'applyCssVars'); });

    /* 4. modulos visuais + rede de seguranca */
    guard('modulos visuais', initVisuals);
    guard('ambiente', function () { opt('Materials', 'applyEnvironment', GH.Engine.scene); });

    /* 5. o jogo */
    guard('jogo', function () {
      if (!GH.Game || typeof GH.Game.init !== 'function') throw new Error('GH.Game ausente');
      GH.Game.init({ capture: true });
    });

    /* 6. a cena pedida */
    guard('cena ' + CAP_NAME, function () {
      GH.Game.forceState({
        scene: CAP_NAME,
        songTime: CAP_T,
        preroll: CAP_PREROLL,
        songId: Q.song || undefined,
        difficulty: Q.diff || undefined,
        snap: Q.snap || undefined          /* snap=none: o instante exato de ?t= */
      });
    });

    /* 7. simulacao deterministica: t-preroll -> t em passos fixos de 1/60.
          Renderizamos so os ultimos frames — o SwiftShader e lento e a imagem
          final e identica; o que importa e que TODOS os updaters rodem em
          todos os passos, para particulas, chamas, publico e combo terem
          historia de verdade no momento do print. */
    guard('simulacao', function () {
      var steps = Math.max(1, Math.round(CAP_PREROLL * 60));
      /* os 3 ultimos passos tambem RENDERIZAM: o primeiro aquece o composer e
         o SMAA, o ultimo e o frame que vira PNG. Assim gastamos 3 renders de
         SwiftShader em vez de 180, sem mudar um pixel do resultado. */
      var renderFrom = Math.max(0, steps - 3);
      for (var i = 0; i < steps; i++) {
        if (i >= renderFrom) GH.Engine.stepFixed(1 / 60);
        else GH.Engine.simulateOnly(1 / 60);
      }
    });

    /* 8. congela e avisa o capturador */
    guard('congelamento', function () {
      opt('Engine', 'freeze');
      opt('Input', 'dispose');
    });

    finishCapture();
  }

  function finishCapture() {
    var ms = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - boot.startedAt);
    /* O diagnostico e informacao, nao missao critica: na cena `loading` o
       GH.Game nem chegou a ser inicializado. */
    var gdbg = null;
    try { if (GH.Game && GH.Game.debug) gdbg = GH.Game.debug(); } catch (e0) { gdbg = null; }
    window.__GH_READY = true;
    window.__GH_BOOT = {
      cap: CAP_NAME, t: CAP_T, seed: CAP_SEED, w: CAP_W, h: CAP_H,
      ms: ms, errors: boot.errors.slice(0),
      scaffold: scaffold.built.slice(0),
      game: gdbg
    };
    /* Diagnostico legivel por MAQUINA: os outros agentes conferem o estado da
       cena sem depender de pixel. Sai no --dump-dom do Chromium headless:
         msedge --headless --dump-dom "...index.html?cap=..." | grep data-gh-diag */
    try {
      document.body.setAttribute('data-gh-diag', JSON.stringify(window.__GH_BOOT));
    } catch (e0) { /* nao e critico */ }

    if (boot.errors.length) {
      /* Erro NAO fatal (um modulo reclamou mas o frame saiu): registramos no
         titulo para o script de captura enxergar, sem apagar a imagem. */
      try { document.title = 'GH_READY (avisos: ' + boot.errors.length + ')'; } catch (e) { /* ok */ }
      try { if (console && console.warn) console.warn('GH avisos: ' + boot.errors.join(' | ')); } catch (e2) { /* ok */ }
    } else {
      try { document.title = 'GH_READY'; } catch (e3) { /* ok */ }
    }
  }

  /* =========================================================================
     8. ARRANQUE
     ========================================================================= */

  function main() {
    /* Pagina de LINT: carrega todos os scripts numa casca sem <canvas id=gh-canvas>
       so para conferir sintaxe/registro de modulo. Se bootassemos ali, o loop de
       render comecaria e o headless nunca terminaria de "carregar" a pagina. */
    if (!document.getElementById('gh-canvas')) {
      window.__GH_READY = true;
      return;
    }
    if (!window.THREE) {
      fatal('Three.js nao carregou (vendor/three.min.js). Sem WebGL nao ha jogo.');
      window.__GH_READY = true;
      return;
    }
    if (IS_CAP) {
      try { bootCapture(); }
      catch (e) {
        fatal('modo captura explodiu no passo "' + boot.step + '"', e);
        /* mesmo quebrado, tentamos deixar UMA imagem na tela */
        try { if (GH.Engine && GH.Engine.renderer) GH.Engine.stepFixed(1 / 60); } catch (e2) { /* ok */ }
        window.__GH_READY = true;
      }
    } else {
      try { bootNormal(); }
      catch (e) { fatal('boot explodiu no passo "' + boot.step + '"', e); }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, false);
  } else {
    main();
  }

  /* Diagnostico publico (ferramentas e outros agentes leem isto). */
  GH.Main = {
    capture: IS_CAP,
    params: Q,
    boot: boot,
    scaffold: scaffold,
    unlockAudio: unlockAudio,
    progress: setProgress,
    hideLoader: hideLoader
  };

})(window.GH = window.GH || {});

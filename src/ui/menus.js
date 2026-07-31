/* ===========================================================================
   GUITARRADA HERO — src/ui/menus.js
   ---------------------------------------------------------------------------
   Dono: agente MENUS. Todas as telas de interface em HTML/CSS por cima do
   canvas WebGL — titulo, selecao de musica, dificuldade, pausa, configuracao,
   resultados e creditos.

   POR QUE HTML E NAO TEXTURA
   --------------------------
   Texto em textura serrilha, borra no bloom e nao escala. Em HTML o texto sai
   com o rasterizador do sistema (subpixel/greyscale AA de verdade), fica
   nitido em qualquer resolucao e ainda aceita gradiente com background-clip.

   ANIMACAO DETERMINISTICA
   -----------------------
   As entradas NAO usam transition/animation do CSS: elas sao interpoladas em
   JavaScript por um tween proprio movido por GH.Engine.addUpdater. Motivo: o
   modo captura (secao 7 do ARCHITECTURE.md) simula 180 passos fixos de 1/60 e
   depois CONGELA o rAF. Uma animacao de CSS pode congelar no meio; o tween em
   JS anda exatamente 3 segundos e termina sempre no mesmo lugar. O CSS fica
   com o que e continuo/idle (brilho, varredura do logo) e com os estados de
   foco, que sao aplicados ANTES do elemento entrar no DOM (logo, sem transicao
   pendente na hora do print).

   DEPENDENCIAS (todas defensivas, nada obrigatorio)
   -------------------------------------------------
   GH.Palette (cor, variaveis CSS), GH.Songs (catalogo), GH.Chart/GH.Scoring
   (dados reais do resultado), GH.Settings (configuracao), GH.Input (teclas),
   GH.Audio.sfx (som de interface), GH.Engine (updater, flash, bloom),
   GH.Materials (friso marajoara ja gerado — nao duplicamos textura),
   GH.Art (se um dia existir arte externa; hoje esta vazio e tudo e procedural).

   Identificadores em ingles, comentarios em portugues.
   =========================================================================== */
(function (GH) {
  'use strict';

  /* =========================================================================
     1. UTILIDADES LOCAIS
     ========================================================================= */

  var U = GH.Util || {};
  var TAU = Math.PI * 2;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* Easings: preferimos os do core (mesma sensacao em todo o jogo) e caimos
     numa copia local se o core nao estiver la. */
  var easeOutCubic = U.easeOutCubic || function (t) { t = clamp01(t); var u = 1 - t; return 1 - u * u * u; };
  var easeOutQuint = U.easeOutQuint || function (t) { t = clamp01(t); var u = 1 - t, u2 = u * u; return 1 - u2 * u2 * u; };
  var easeOutBack = U.easeOutBack || function (t) {
    t = clamp01(t); var c1 = 1.70158, c3 = c1 + 1, u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  };
  var easeOutExpo = U.easeOutExpo || function (t) { t = clamp01(t); return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); };
  var easeInOutCubic = U.easeInOutCubic || function (t) {
    t = clamp01(t);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  /* Overshoot mais macio que o easeOutBack padrao — o "peso" que a UI pede. */
  function easeOutSoftBack(t) {
    t = clamp01(t); var c1 = 1.06, c3 = c1 + 1, u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  }

  /* Chamada segura a outro modulo: nunca derruba a interface. */
  function call(modName, fnName, a, b, c) {
    var m = GH[modName];
    if (!m || typeof m[fnName] !== 'function') return undefined;
    try { return m[fnName](a, b, c); } catch (e) { return undefined; }
  }
  function sfx(name, a) {
    var A = GH.Audio;
    if (!A || !A.sfx || typeof A.sfx[name] !== 'function') return;
    try { A.sfx[name](a); } catch (e) { /* som nunca quebra a tela */ }
  }

  var IS_CAPTURE = !!(typeof window !== 'undefined' && window.__GH_CAP);

  /* --------------------------- formatacao --------------------------------- */

  /* 1234567 -> "1.234.567" (separador de milhar brasileiro). */
  function fmtInt(n) {
    n = Math.round(n || 0);
    var neg = n < 0; if (neg) n = -n;
    var s = String(n), out = '', c = 0, i;
    for (i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if (++c % 3 === 0 && i > 0) out = '.' + out;
    }
    return (neg ? '-' : '') + out;
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtPct(v, dec) {
    var d = (dec === undefined) ? 1 : dec;
    return (clamp01(v) * 100).toFixed(d).replace('.', ',') + '%';
  }
  function fmtMs(v) {
    var s = (v >= 0 ? '+' : '') + (Math.round(v * 10) / 10).toFixed(1).replace('.', ',');
    return s + ' ms';
  }

  /* Hash estavel de string -> inteiro (semente deterministica por musica). */
  function hashStr(s) {
    var h = 0x811c9dc5, i;
    s = String(s || '');
    for (i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }
  /* mulberry32 local — as capas precisam ser identicas em toda captura. */
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hsl(h, s, l, a) {
    h = ((h % 360) + 360) % 360;
    if (a === undefined || a >= 1) return 'hsl(' + h.toFixed(1) + ',' + s.toFixed(1) + '%,' + l.toFixed(1) + '%)';
    return 'hsla(' + h.toFixed(1) + ',' + s.toFixed(1) + '%,' + l.toFixed(1) + '%,' + a.toFixed(3) + ')';
  }

  /* --------------------------- DOM enxuto --------------------------------- */

  function mk(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function txt(el, s) { el.textContent = s; return el; }
  function show(el, on) { el.style.display = on ? '' : 'none'; }
  /* Escape de HTML. Cobre tambem a aspa simples: varios trechos deste arquivo
     montam atributo de estilo/classe por concatenacao, e num contexto de aspa
     simples o &quot; sozinho nao fecharia o buraco. */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* =========================================================================
     2. FOLHA DE ESTILO
     Cada secao do arquivo empurra o proprio CSS para este array; no init tudo
     vira um unico <style>. Assim o estilo mora ao lado do codigo que o usa.
     ========================================================================= */

  var CSS = [];

  CSS.push([
    /* ------------------------------------------------------------------ *
     * RAIZ. --u e a unidade de projeto: 1u = 16px em 1600x900 e continua
     * proporcional em qualquer janela (usa a menor entre largura e altura,
     * entao nada estoura em telas estreitas ou baixas).
     * ------------------------------------------------------------------ */
    '#gh-menus{position:absolute;inset:0;z-index:600;pointer-events:none;overflow:hidden;',
    '--u:min(1vw,1.7778vh);',
    '--f-display:"Arial Black","Segoe UI Black",Impact,"Franklin Gothic Heavy",system-ui,sans-serif;',
    '--f-ui:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;',
    '--f-serif:Georgia,"Iowan Old Style","Times New Roman",serif;',
    '--f-num:"Bahnschrift","DIN Alternate","Segoe UI Semibold","Segoe UI",sans-serif;',
    '--ink:var(--gh-text,#f2f5ff);--ink-dim:var(--gh-textDim,#95a0c0);--ink-faint:var(--gh-textFaint,#5a6485);',
    '--gold:var(--gh-gold,#ffcf4a);--mag:var(--gh-edge,#ff3d8a);--cyan:var(--gh-neon,#25e8ce);',
    '--sun:var(--gh-horizon,#ff6a1e);--ice:var(--gh-sp,#8fd8ff);',
    'font-family:var(--f-ui);color:var(--ink);-webkit-font-smoothing:antialiased;',
    'text-rendering:optimizeLegibility;font-kerning:normal;letter-spacing:0;',
    'font-size:calc(var(--u)*1);line-height:1.4}',

    /* telas */
    '#gh-menus .scr{position:absolute;inset:0;display:none;}',
    '#gh-menus .scr.on{display:block}',
    '#gh-menus .pe{pointer-events:auto}',
    '#gh-menus canvas{display:block}',

    /* ------------------------------------------------------------------ *
     * PECAS COMPARTILHADAS
     * ------------------------------------------------------------------ */

    /* cortina: escurece o 3D o suficiente para o texto ganhar contraste sem
       matar o por do sol que esta atras */
    '#gh-menus .scrim{position:absolute;inset:0;pointer-events:none}',

    /* etiqueta pequena, caixa alta, muito espacada — o "kicker" editorial */
    '#gh-menus .kick{font-size:calc(var(--u)*.72);font-weight:800;letter-spacing:.52em;',
    'text-transform:uppercase;color:var(--cyan);opacity:.92;',
    'text-shadow:0 0 calc(var(--u)*1.2) rgba(37,232,206,.55),0 1px 2px rgba(0,0,0,.9)}',
    '#gh-menus .kick.gold{color:var(--gold);text-shadow:0 0 calc(var(--u)*1.2) rgba(255,207,74,.5),0 1px 2px rgba(0,0,0,.9)}',
    '#gh-menus .kick.rule{display:flex;align-items:center;gap:calc(var(--u)*.9);white-space:nowrap}',
    '#gh-menus .kick.rule::before,#gh-menus .kick.rule::after{content:"";height:1px;flex:1 1 auto;min-width:calc(var(--u)*1.5);',
    'background:linear-gradient(90deg,transparent,currentColor);opacity:.5}',
    '#gh-menus .kick.rule::after{background:linear-gradient(90deg,currentColor,transparent)}',

    /* aviso didatico — obrigatorio na tela de titulo e nos creditos */
    '#gh-menus .notice{font-size:calc(var(--u)*.68);line-height:1.75;color:var(--ink-faint);',
    'letter-spacing:.04em;font-weight:500;text-shadow:0 1px 3px rgba(0,0,0,.85)}',

    /* barra de dicas de tecla */
    '#gh-menus .hints{display:flex;gap:calc(var(--u)*1.5);align-items:center;',
    'font-size:calc(var(--u)*.68);letter-spacing:.16em;text-transform:uppercase;',
    'font-weight:700;color:var(--ink-faint)}',
    '#gh-menus .hints b{color:var(--ink-dim)}',
    '#gh-menus .key{display:inline-block;min-width:calc(var(--u)*1.5);padding:calc(var(--u)*.12) calc(var(--u)*.42);',
    'margin-right:calc(var(--u)*.34);border-radius:calc(var(--u)*.24);text-align:center;',
    'background:linear-gradient(180deg,rgba(255,255,255,.15),rgba(255,255,255,.05));',
    'border:1px solid rgba(255,255,255,.18);border-bottom-width:2px;color:var(--ink);',
    'font-size:calc(var(--u)*.62);font-weight:800;letter-spacing:.04em;',
    'box-shadow:0 1px 0 rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.14)}',

    /* friso marajoara (imagem gerada em GH.Materials, tingida por mascara) */
    '#gh-menus .frieze{height:calc(var(--u)*1.35);pointer-events:none;opacity:.62;',
    '-webkit-mask-repeat:repeat-x;mask-repeat:repeat-x;',
    '-webkit-mask-size:auto 100%;mask-size:auto 100%;',
    '-webkit-mask-position:center;mask-position:center;',
    'background:linear-gradient(90deg,transparent,var(--gold) 22%,var(--mag) 50%,var(--cyan) 78%,transparent)}',
    '#gh-menus .frieze.thin{height:calc(var(--u)*1.7);opacity:.55;',
    'background:linear-gradient(90deg,transparent,rgba(255,207,74,.85) 30%,#ffb04a 50%,rgba(255,207,74,.85) 70%,transparent)}',

    /* painel de vidro escuro reutilizavel */
    '#gh-menus .glass{background:linear-gradient(160deg,rgba(22,18,42,.80),rgba(8,7,18,.90));',
    'border:1px solid rgba(255,255,255,.085);border-radius:calc(var(--u)*.7);',
    'box-shadow:0 calc(var(--u)*1.2) calc(var(--u)*3) rgba(0,0,0,.62),inset 0 1px 0 rgba(255,255,255,.09)}',

    /* numero grande com fonte tabular */
    '#gh-menus .num{font-family:var(--f-num);font-variant-numeric:tabular-nums;font-weight:700;',
    'letter-spacing:-.01em}',

    /* estrela desenhada em clip-path (sem SVG, sem imagem) */
    '#gh-menus .starshape{clip-path:polygon(50% 0%,61.8% 34.5%,98% 34.5%,68.8% 56.2%,80% 90.5%,',
    '50% 69.1%,20% 90.5%,31.2% 56.2%,2% 34.5%,38.2% 34.5%)}'
  ].join(''));

  /* =========================================================================
     3. TWEEN — o motor de animacao proprio
     ========================================================================= */

  var tweens = [];
  var clockAccum = 0;

  /* tween({dur, delay, ease, apply(u01, raw), done()})
     `apply` recebe o progresso BRUTO (0..1); a curva fica a cargo de quem
     chama, porque quase sempre queremos curvas diferentes para posicao
     (overshoot) e opacidade (sem overshoot). */
  function tween(o) {
    o.t = -(o.delay || 0);
    o.dur = (o.dur === undefined) ? 0.42 : o.dur;
    o._alive = true;
    tweens.push(o);
    try { o.apply(0); } catch (e) { /* nunca derruba */ }
    return o;
  }
  function stepTweens(dt) {
    var i, o, u;
    for (i = tweens.length - 1; i >= 0; i--) {
      o = tweens[i];
      o.t += dt;
      if (o.t < 0) continue;
      u = (o.dur <= 0) ? 1 : clamp01(o.t / o.dur);
      try { o.apply(u); } catch (e) { u = 1; }
      if (u >= 1) {
        o._alive = false;
        tweens.splice(i, 1);
        if (o.done) { try { o.done(); } catch (e2) { /* ok */ } }
      }
    }
  }
  /* Termina TUDO agora (troca de tela, ou rede de seguranca por tempo real). */
  function settleTweens() {
    var guard = 0;
    while (tweens.length && guard++ < 64) {
      var list = tweens.slice(0);
      tweens.length = 0;
      for (var i = 0; i < list.length; i++) {
        try { list[i].apply(1); } catch (e) { /* ok */ }
        if (list[i].done) { try { list[i].done(); } catch (e2) { /* ok */ } }
      }
    }
    tweens.length = 0;
  }

  /* Entrada em cascata: cada elemento sobe, cresce um tico e aparece.
     dy em unidades de --u; o overshoot vem do easeOutSoftBack. */
  function revealList(els, opts) {
    opts = opts || {};
    var delay = (opts.delay === undefined) ? 0.06 : opts.delay;
    var step = (opts.step === undefined) ? 0.045 : opts.step;
    var dur = (opts.dur === undefined) ? 0.50 : opts.dur;
    var dy = (opts.dy === undefined) ? 22 : opts.dy;
    var dx = opts.dx || 0;
    var scale = (opts.scale === undefined) ? 0.985 : opts.scale;
    var i;
    for (i = 0; i < els.length; i++) {
      (function (el, idx) {
        if (!el) return;
        tween({
          delay: delay + idx * step, dur: dur,
          apply: function (u) {
            var p = easeOutSoftBack(u);
            var o = easeOutCubic(clamp01(u * 1.45));
            var s = lerp(scale, 1, p);
            el.style.opacity = o.toFixed(3);
            el.style.transform = 'translate3d(' + ((1 - p) * dx).toFixed(2) + 'px,' +
              ((1 - p) * dy).toFixed(2) + 'px,0) scale(' + s.toFixed(4) + ')';
          },
          done: function () { el.style.opacity = ''; el.style.transform = ''; }
        });
      })(els[i], i);
    }
  }

  /* Contador que sobe (placar, porcentagem). */
  function countUp(el, to, opts) {
    opts = opts || {};
    var from = opts.from || 0;
    var fmt = opts.fmt || fmtInt;
    tween({
      delay: opts.delay || 0, dur: (opts.dur === undefined) ? 1.15 : opts.dur,
      apply: function (u) { el.textContent = fmt(lerp(from, to, easeOutExpo(u))); },
      done: function () { el.textContent = fmt(to); }
    });
  }

  /* =========================================================================
     4. ESTADO DO MODULO
     ========================================================================= */

  var root = null;             // #gh-menus
  var styleEl = null;
  var screens = {};            // nome -> objeto de tela
  var current = null;          // tela visivel
  var chooseHandlers = [];
  var inited = false;
  var friezeMask = '';         // url(data:...) do friso marajoara
  var songList = [];
  var selectedSongIdx = 0;
  var selectedDifficulty = 'medio';
  var pendingLayout = [];      // canvases que ainda nao tinham tamanho
  var settingsReturn = 'title';
  var safetyTimer = 0;

  function emitChoose(action, payload) {
    var arg = payload;
    if (payload && typeof payload === 'object') {
      arg = payload;
      if (!arg.action) arg.action = action;
    } else if (payload !== undefined) {
      arg = { action: action, value: payload };
    } else {
      arg = action;
    }
    for (var i = 0; i < chooseHandlers.length; i++) {
      try { chooseHandlers[i](arg, payload); } catch (e) { /* ouvinte ruim nao derruba */ }
    }
  }

  /* =========================================================================
     5. CAPAS DE DISCO PROCEDURAIS
     Cada musica tem `cover:{hue,hue2,motif,subtitle}` em GH.Songs. A partir
     disso desenhamos uma capa 512x512 em canvas 2D: fundo com degrade e luz,
     um motivo geometrico proprio do genero, friso marajoara, granulacao de
     filme, vinheta e a faixa de rotulo com o titulo. Nada de retangulo
     colorido — tem que parecer arte de bolacha de vinil.
     ========================================================================= */

  var COVER_SIZE = 512;
  var coverCache = {};   // songId -> canvas 512
  var grainCanvas = null;

  function getGrain() {
    if (grainCanvas) return grainCanvas;
    var s = 128;
    var cv = document.createElement('canvas');
    cv.width = s; cv.height = s;
    var g = cv.getContext('2d');
    var img = g.createImageData(s, s);
    var rnd = makeRng(0x6a1b3c5d);
    for (var i = 0; i < img.data.length; i += 4) {
      var v = (118 + rnd() * 74) | 0;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grainCanvas = cv;
    return cv;
  }

  /* Friso marajoara ja existente em GH.Materials (branco sobre transparente).
     Reaproveitamos: nao geramos textura duplicada. */
  function marajoaraCanvas() {
    try {
      if (GH.Materials && typeof GH.Materials.canvas === 'function') {
        var c = GH.Materials.canvas('marajoaraBand');
        if (c && c.width) return c;
      }
    } catch (e) { /* segue sem o friso */ }
    return null;
  }

  /* ---------------------------------------------------------------------
     Primitivas de desenho reutilizadas pelos motivos.
     --------------------------------------------------------------------- */

  function sunRays(g, cx, cy, r, count, rot, colA, colB) {
    var i, a0, a1, step = TAU / count;
    for (i = 0; i < count; i++) {
      a0 = rot + i * step; a1 = a0 + step * 0.5;
      g.fillStyle = (i % 2) ? colA : colB;
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, r, a0, a1);
      g.closePath();
      g.fill();
    }
  }

  function slittedDisc(g, cx, cy, r, grad, cutColor) {
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.closePath();
    g.clip();
    g.fillStyle = grad; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    /* fatias horizontais crescentes na metade de baixo — o sol "listrado" */
    g.fillStyle = cutColor;
    var y = cy + r * 0.06, h = r * 0.022, gap = r * 0.10, k = 0;
    while (y < cy + r) {
      g.fillRect(cx - r, y, r * 2, h);
      y += gap + h; h *= 1.34; gap *= 1.06; k++;
      if (k > 24) break;
    }
    g.restore();
  }

  function waveBand(g, x0, x1, y, amp, len, thick, color, phase) {
    g.strokeStyle = color; g.lineWidth = thick; g.lineCap = 'round';
    g.beginPath();
    for (var x = x0; x <= x1; x += 4) {
      var yy = y + Math.sin((x / len) * TAU + phase) * amp;
      if (x === x0) g.moveTo(x, yy); else g.lineTo(x, yy);
    }
    g.stroke();
  }

  function spiralDots(g, cx, cy, turns, rMax, count, h1, h2) {
    for (var i = 0; i < count; i++) {
      var t = i / (count - 1);
      var a = t * turns * TAU;
      var r = Math.pow(t, 0.78) * rMax;
      var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.86;
      var rad = 2 + t * 13;
      g.fillStyle = hsl(lerp(h1, h2, t), 88, lerp(72, 52, t), lerp(0.95, 0.55, t));
      g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
    }
  }

  function heartPath(g, cx, cy, s) {
    g.beginPath();
    g.moveTo(cx, cy + s * 0.78);
    g.bezierCurveTo(cx - s * 1.28, cy - s * 0.10, cx - s * 0.62, cy - s * 1.02, cx, cy - s * 0.34);
    g.bezierCurveTo(cx + s * 0.62, cy - s * 1.02, cx + s * 1.28, cy - s * 0.10, cx, cy + s * 0.78);
    g.closePath();
  }

  function flameShape(g, x, y, w, h, color) {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x - w * 0.5, y);
    g.bezierCurveTo(x - w * 0.52, y - h * 0.42, x - w * 0.30, y - h * 0.62, x - w * 0.10, y - h);
    g.bezierCurveTo(x - w * 0.02, y - h * 0.60, x + w * 0.20, y - h * 0.72, x + w * 0.16, y - h * 0.34);
    g.bezierCurveTo(x + w * 0.42, y - h * 0.48, x + w * 0.54, y - h * 0.22, x + w * 0.5, y);
    g.closePath();
    g.fill();
  }

  function silhouetteGuitar(g, cx, cy, len, ang, body, rim) {
    g.save();
    g.translate(cx, cy);
    g.rotate(ang);
    var w = len * 0.085;
    /* braco */
    g.fillStyle = body;
    g.fillRect(-len * 0.5, -w * 0.5, len * 0.82, w);
    /* headstock */
    g.beginPath();
    g.moveTo(-len * 0.5, -w * 0.90);
    g.lineTo(-len * 0.5 - len * 0.13, -w * 1.15);
    g.lineTo(-len * 0.5 - len * 0.15, w * 1.05);
    g.lineTo(-len * 0.5, w * 0.90);
    g.closePath(); g.fill();
    /* corpo (dois lobos) */
    g.beginPath();
    g.ellipse(len * 0.40, 0, len * 0.155, len * 0.145, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(len * 0.185, 0, len * 0.115, len * 0.108, 0, 0, TAU);
    g.fill();
    /* trastes */
    g.strokeStyle = rim; g.lineWidth = Math.max(1, len * 0.006);
    for (var i = 1; i <= 12; i++) {
      var x = -len * 0.5 + (len * 0.62) * (i / 13);
      g.beginPath(); g.moveTo(x, -w * 0.5); g.lineTo(x, w * 0.5); g.stroke();
    }
    /* cordas com luz de contorno */
    g.strokeStyle = rim; g.globalAlpha = 0.55; g.lineWidth = Math.max(1, len * 0.0035);
    for (var s = 0; s < 6; s++) {
      var y = -w * 0.36 + (w * 0.72) * (s / 5);
      g.beginPath(); g.moveTo(-len * 0.56, y); g.lineTo(len * 0.44, y); g.stroke();
    }
    g.globalAlpha = 1;
    g.restore();
  }

  /* ---------------------------------------------------------------------
     Motivos — um por musica.
     --------------------------------------------------------------------- */

  var MOTIFS = {

    /* Guitarrada: sol da baia se pondo atras da guitarra tremolada. */
    'guitar-wave': function (g, S, h1, h2, rnd) {
      var cx = S * 0.50, cy = S * 0.44, r = S * 0.30;
      sunRays(g, cx, cy + S * 0.02, S * 0.95, 26, 0.22, hsl(h1, 90, 30, 0.30), 'rgba(0,0,0,0)');
      var grad = g.createLinearGradient(0, cy - r, 0, cy + r);
      grad.addColorStop(0, hsl(h1 + 22, 100, 78));
      grad.addColorStop(0.45, hsl(h1 + 6, 98, 60));
      grad.addColorStop(1, hsl(h1 - 14, 92, 44));
      slittedDisc(g, cx, cy, r, grad, hsl(h1 - 30, 70, 8, 0.85));
      /* halo */
      var hg = g.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 2.1);
      hg.addColorStop(0, hsl(h1 + 10, 100, 62, 0.36));
      hg.addColorStop(1, hsl(h1, 100, 50, 0));
      g.fillStyle = hg; g.fillRect(0, 0, S, S);
      /* mar */
      g.save();
      g.globalCompositeOperation = 'screen';
      for (var i = 0; i < 7; i++) {
        var y = S * 0.70 + i * S * 0.036;
        waveBand(g, -10, S + 10, y, S * (0.008 + i * 0.0025), S * (0.34 - i * 0.02),
          Math.max(1.2, S * 0.0055), hsl(h2, 85, lerp(64, 40, i / 6), lerp(0.75, 0.22, i / 6)), i * 1.7);
      }
      g.restore();
      /* guitarra em silhueta com contorno turquesa */
      silhouetteGuitar(g, S * 0.50, S * 0.60, S * 0.86, -0.42,
        hsl(h1 - 24, 60, 6, 0.94), hsl(h2, 92, 66, 0.9));
    },

    /* Carimbo: lua cheia sobre o rio, tambor de tronco e mata. */
    'moon-river': function (g, S, h1, h2, rnd) {
      var mx = S * 0.66, my = S * 0.30, mr = S * 0.155;
      var sky = g.createRadialGradient(mx, my, mr * 0.5, mx, my, S * 0.85);
      sky.addColorStop(0, hsl(h2, 78, 44, 0.55));
      sky.addColorStop(0.35, hsl(h1, 72, 22, 0.42));
      sky.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sky; g.fillRect(0, 0, S, S);
      /* aneis de halo */
      for (var k = 4; k >= 1; k--) {
        g.strokeStyle = hsl(h2, 90, 70, 0.055 * k);
        g.lineWidth = S * 0.012 * k;
        g.beginPath(); g.arc(mx, my, mr * (1 + k * 0.42), 0, TAU); g.stroke();
      }
      /* lua */
      var mg = g.createRadialGradient(mx - mr * 0.3, my - mr * 0.3, mr * 0.1, mx, my, mr);
      mg.addColorStop(0, hsl(h2 + 18, 60, 96));
      mg.addColorStop(0.7, hsl(h2 + 8, 46, 82));
      mg.addColorStop(1, hsl(h2, 40, 64));
      g.fillStyle = mg;
      g.beginPath(); g.arc(mx, my, mr, 0, TAU); g.fill();
      g.fillStyle = hsl(h2, 30, 58, 0.35);
      for (var c = 0; c < 7; c++) {
        var a = rnd() * TAU, d = rnd() * mr * 0.72;
        g.beginPath(); g.arc(mx + Math.cos(a) * d, my + Math.sin(a) * d, mr * (0.06 + rnd() * 0.12), 0, TAU); g.fill();
      }
      /* rio: reflexos horizontais */
      g.save();
      g.globalCompositeOperation = 'screen';
      for (var i = 0; i < 16; i++) {
        var t = i / 15;
        var y = S * 0.62 + t * S * 0.36;
        var w = S * (0.05 + rnd() * 0.20) * (1 - t * 0.3);
        g.fillStyle = hsl(h2 + 6, 70, lerp(78, 44, t), lerp(0.42, 0.10, t));
        g.fillRect(mx - w * 0.5 + (rnd() - 0.5) * S * 0.10, y, w, Math.max(1.5, S * 0.008));
      }
      g.restore();
      /* mata dos dois lados */
      g.fillStyle = hsl(h1 - 6, 70, 5, 0.95);
      for (var s = -1; s <= 1; s += 2) {
        for (var t2 = 0; t2 < 5; t2++) {
          var bx = s < 0 ? S * (0.02 + t2 * 0.055) : S * (0.98 - t2 * 0.055);
          var bh = S * (0.20 + rnd() * 0.16);
          g.beginPath();
          g.moveTo(bx, S);
          g.lineTo(bx - S * 0.012, S - bh);
          g.lineTo(bx + S * 0.012, S - bh);
          g.closePath(); g.fill();
          for (var lf = 0; lf < 5; lf++) {
            var la = -Math.PI * (0.20 + lf * 0.15) * (s < 0 ? 1 : -1);
            g.save(); g.translate(bx, S - bh); g.rotate(la);
            g.beginPath(); g.ellipse(S * 0.055, 0, S * 0.058, S * 0.011, 0, 0, TAU); g.fill();
            g.restore();
          }
        }
      }
      /* curimbo (tambor de tronco) no centro */
      g.fillStyle = hsl(h1 - 10, 55, 8, 0.96);
      g.beginPath();
      g.moveTo(S * 0.40, S * 0.99); g.lineTo(S * 0.435, S * 0.70);
      g.lineTo(S * 0.565, S * 0.70); g.lineTo(S * 0.60, S * 0.99);
      g.closePath(); g.fill();
      g.strokeStyle = hsl(h2, 80, 62, 0.75); g.lineWidth = Math.max(1.5, S * 0.006);
      g.beginPath(); g.ellipse(S * 0.50, S * 0.70, S * 0.065, S * 0.018, 0, 0, TAU); g.stroke();
      for (var hp = 1; hp <= 3; hp++) {
        var yy = S * (0.70 + hp * 0.072);
        g.globalAlpha = 0.45;
        g.beginPath(); g.moveTo(S * (0.435 - hp * 0.008), yy); g.lineTo(S * (0.565 + hp * 0.008), yy); g.stroke();
        g.globalAlpha = 1;
      }
    },

    /* Lambada: a mare subindo em espiral e as cristas da onda. */
    'tide-spiral': function (g, S, h1, h2, rnd) {
      var cx = S * 0.50, cy = S * 0.46;
      sunRays(g, cx, cy, S * 1.0, 36, 0.1, hsl(h1, 80, 26, 0.26), 'rgba(0,0,0,0)');
      var rg = g.createRadialGradient(cx, cy, 0, cx, cy, S * 0.55);
      rg.addColorStop(0, hsl(h2, 90, 52, 0.55));
      rg.addColorStop(1, hsl(h1, 85, 30, 0));
      g.fillStyle = rg; g.fillRect(0, 0, S, S);
      spiralDots(g, cx, cy, 3.35, S * 0.40, 96, h2, h1);
      /* cristas */
      g.save();
      g.globalCompositeOperation = 'screen';
      for (var i = 0; i < 5; i++) {
        var y = S * (0.76 + i * 0.05);
        waveBand(g, -10, S + 10, y, S * (0.020 + i * 0.006), S * (0.42 - i * 0.05),
          Math.max(1.5, S * 0.009 - i * 0.6), hsl(lerp(h2, h1, i / 4), 92, 66, 0.55 - i * 0.08), i * 2.1);
      }
      g.restore();
      /* respingos */
      for (var d = 0; d < 40; d++) {
        var a = rnd() * TAU, r = S * (0.42 + rnd() * 0.20);
        g.fillStyle = hsl(lerp(h1, h2, rnd()), 95, 78, 0.20 + rnd() * 0.45);
        g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.9, 1 + rnd() * 3.2, 0, TAU); g.fill();
      }
    },

    /* Brega: coracao de neon na aparelhagem, quatro da manha. */
    'neon-heart': function (g, S, h1, h2, rnd) {
      var cx = S * 0.50, cy = S * 0.47;
      sunRays(g, cx, cy, S * 1.05, 30, 0.35, hsl(h1, 88, 34, 0.24), 'rgba(0,0,0,0)');
      /* grade de alto-falante */
      g.strokeStyle = hsl(h1, 60, 60, 0.14);
      g.lineWidth = Math.max(1, S * 0.004);
      for (var r = S * 0.10; r < S * 0.62; r += S * 0.032) {
        g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke();
      }
      /* coracao com brilho */
      g.save();
      g.shadowColor = hsl(h1, 100, 62, 0.95);
      g.shadowBlur = S * 0.10;
      g.lineWidth = S * 0.036; g.lineJoin = 'round';
      g.strokeStyle = hsl(h1, 100, 60);
      heartPath(g, cx, cy - S * 0.02, S * 0.235); g.stroke();
      g.shadowBlur = S * 0.05;
      g.lineWidth = S * 0.016;
      g.strokeStyle = hsl(h1 + 12, 100, 88);
      heartPath(g, cx, cy - S * 0.02, S * 0.235); g.stroke();
      g.shadowBlur = 0;
      g.lineWidth = S * 0.006;
      g.strokeStyle = 'rgba(255,255,255,.92)';
      heartPath(g, cx, cy - S * 0.02, S * 0.235); g.stroke();
      g.restore();
      /* coracao menor, tubo secundario */
      g.save();
      g.globalAlpha = 0.55;
      g.shadowColor = hsl(h2, 100, 60, 0.9); g.shadowBlur = S * 0.06;
      g.strokeStyle = hsl(h2, 100, 62); g.lineWidth = S * 0.012;
      heartPath(g, cx, cy - S * 0.02, S * 0.30); g.stroke();
      g.restore();
      /* faiscas / purpurina */
      for (var i = 0; i < 46; i++) {
        var a = rnd() * TAU, d = S * (0.20 + rnd() * 0.40);
        var x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.95;
        var s = 1 + rnd() * 3.4;
        g.fillStyle = rnd() < 0.5 ? hsl(h2, 100, 78, 0.85) : 'rgba(255,255,255,.8)';
        g.beginPath(); g.arc(x, y, s, 0, TAU); g.fill();
        if (rnd() < 0.30) {
          g.strokeStyle = g.fillStyle; g.lineWidth = 1;
          g.beginPath(); g.moveTo(x - s * 3, y); g.lineTo(x + s * 3, y);
          g.moveTo(x, y - s * 3); g.lineTo(x, y + s * 3); g.stroke();
        }
      }
    },

    /* Frevo: sombrinha em chamas e os metais de aco. */
    'umbrella-fire': function (g, S, h1, h2, rnd) {
      var cx = S * 0.50, cy = S * 0.40, R = S * 0.335;
      sunRays(g, cx, cy, S * 1.05, 24, 0.18, hsl(h1, 92, 40, 0.26), 'rgba(0,0,0,0)');
      /* cabo */
      g.strokeStyle = hsl(20, 45, 16); g.lineWidth = S * 0.020; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy + S * 0.40);
      g.stroke();
      g.beginPath(); g.arc(cx - S * 0.030, cy + S * 0.40, S * 0.030, 0, Math.PI); g.stroke();
      /* gomos */
      var seg = 12, i;
      for (i = 0; i < seg; i++) {
        var a0 = Math.PI + (i / seg) * Math.PI;
        var a1 = Math.PI + ((i + 1) / seg) * Math.PI;
        var hue = (i % 2) ? h1 : h2;
        var gr = g.createLinearGradient(cx, cy - R, cx, cy);
        gr.addColorStop(0, hsl(hue, 95, 68));
        gr.addColorStop(1, hsl(hue - 8, 92, 46));
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a0, a1); g.closePath(); g.fill();
        g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = Math.max(1, S * 0.004);
        g.beginPath(); g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R); g.stroke();
      }
      /* barra recortada da sombrinha */
      g.fillStyle = hsl(h1, 96, 74);
      for (i = 0; i < seg; i++) {
        var am = Math.PI + ((i + 0.5) / seg) * Math.PI;
        var x = cx + Math.cos(am) * R, y = cy + Math.sin(am) * R;
        g.beginPath(); g.arc(x, y, R * 0.075, 0, TAU); g.fill();
      }
      /* ponteira */
      g.fillStyle = hsl(48, 90, 72);
      g.beginPath(); g.moveTo(cx - S * 0.012, cy - R);
      g.lineTo(cx, cy - R - S * 0.055); g.lineTo(cx + S * 0.012, cy - R);
      g.closePath(); g.fill();
      /* fogo subindo */
      g.save();
      g.globalCompositeOperation = 'screen';
      for (i = 0; i < 11; i++) {
        var fx = S * (0.06 + i * 0.088) + (rnd() - 0.5) * S * 0.03;
        var fh = S * (0.16 + rnd() * 0.24);
        flameShape(g, fx, S * 1.01, S * 0.11, fh * 1.5, hsl(8, 95, 42, 0.55));
        flameShape(g, fx, S * 1.01, S * 0.075, fh, hsl(28, 100, 55, 0.72));
        flameShape(g, fx, S * 1.01, S * 0.042, fh * 0.62, hsl(48, 100, 74, 0.8));
      }
      g.restore();
      /* confete */
      for (i = 0; i < 34; i++) {
        var px = rnd() * S, py = rnd() * S * 0.78;
        g.save(); g.translate(px, py); g.rotate(rnd() * TAU);
        g.fillStyle = hsl(rnd() < 0.5 ? h1 : h2, 95, 68, 0.55 + rnd() * 0.4);
        g.fillRect(-S * 0.010, -S * 0.004, S * 0.020, S * 0.008);
        g.restore();
      }
    },

    /* Samba-rock: o losango do sol de fim de tarde e o wah-wah. */
    'sun-diamond': function (g, S, h1, h2, rnd) {
      var cx = S * 0.50, cy = S * 0.44;
      sunRays(g, cx, cy, S * 1.05, 20, 0.0, hsl(h2, 82, 34, 0.30), 'rgba(0,0,0,0)');
      var i, k;
      /* losangos concentricos */
      for (k = 5; k >= 0; k--) {
        var r = S * (0.13 + k * 0.062);
        var t = k / 5;
        g.save();
        g.translate(cx, cy); g.rotate(Math.PI / 4);
        if (k === 0) {
          var gr = g.createLinearGradient(-r, -r, r, r);
          gr.addColorStop(0, hsl(h1 + 20, 92, 74));
          gr.addColorStop(1, hsl(h1 - 20, 88, 48));
          g.fillStyle = gr;
          g.fillRect(-r, -r, r * 2, r * 2);
        } else {
          g.strokeStyle = hsl(lerp(h1, h2, t), 88, lerp(70, 46, t), lerp(0.95, 0.30, t));
          g.lineWidth = Math.max(1.4, S * (0.016 - k * 0.002));
          g.strokeRect(-r, -r, r * 2, r * 2);
        }
        g.restore();
      }
      /* chevrons em cima e embaixo */
      g.lineCap = 'round';
      for (i = 0; i < 9; i++) {
        var x = S * (0.06 + i * 0.11);
        g.strokeStyle = hsl(lerp(h1, h2, i / 8), 90, 62, 0.55);
        g.lineWidth = Math.max(2, S * 0.010);
        g.beginPath();
        g.moveTo(x - S * 0.035, S * 0.10); g.lineTo(x, S * 0.055); g.lineTo(x + S * 0.035, S * 0.10);
        g.stroke();
        g.beginPath();
        g.moveTo(x - S * 0.035, S * 0.90); g.lineTo(x, S * 0.945); g.lineTo(x + S * 0.035, S * 0.90);
        g.stroke();
      }
      /* palma / raios do wah */
      g.save();
      g.globalCompositeOperation = 'screen';
      for (i = 0; i < 26; i++) {
        var a = (i / 26) * TAU + 0.12;
        var r0 = S * 0.42, r1 = S * (0.46 + rnd() * 0.16);
        g.strokeStyle = hsl(lerp(h2, h1, rnd()), 90, 66, 0.10 + rnd() * 0.22);
        g.lineWidth = Math.max(1.5, S * 0.008);
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        g.stroke();
      }
      g.restore();
    }
  };

  /* Desenha a capa completa de uma musica num canvas quadrado. */
  function paintCover(cv, song) {
    var S = cv.width;
    var g = cv.getContext('2d');
    var cov = (song && song.cover) || {};
    var h1 = (typeof cov.hue === 'number') ? cov.hue : 26;
    var h2 = (typeof cov.hue2 === 'number') ? cov.hue2 : 200;
    var motif = MOTIFS[cov.motif] ? cov.motif : 'guitar-wave';
    var rnd = makeRng(hashStr((song && song.id) || motif));

    g.save();
    g.clearRect(0, 0, S, S);

    /* 1. fundo: degrade diagonal entre as duas matizes, bem escuro */
    var bg = g.createLinearGradient(0, 0, S * 0.35, S);
    bg.addColorStop(0, hsl(h1, 62, 13));
    bg.addColorStop(0.48, hsl(lerp(h1, h2, 0.35), 58, 9));
    bg.addColorStop(1, hsl(h2, 66, 7));
    g.fillStyle = bg; g.fillRect(0, 0, S, S);

    /* 2. o motivo do genero */
    try { MOTIFS[motif](g, S, h1, h2, rnd); } catch (e) { /* capa segue viva */ }

    /* 3. friso marajoara no rodape (reaproveitado de GH.Materials) */
    var band = marajoaraCanvas();
    if (band) {
      g.save();
      g.globalAlpha = 0.17;
      g.globalCompositeOperation = 'screen';
      var bh = S * 0.052;
      g.drawImage(band, 0, band.height * 0.26, band.width, band.height * 0.48,
        0, S * 0.700, S, bh);
      g.restore();
    }

    /* 4. granulacao de filme */
    g.save();
    g.globalAlpha = 0.13;
    g.globalCompositeOperation = 'overlay';
    var grain = getGrain();
    for (var gy = 0; gy < S; gy += grain.height) {
      for (var gx = 0; gx < S; gx += grain.width) g.drawImage(grain, gx, gy);
    }
    g.restore();

    /* 5. vinheta */
    var vg = g.createRadialGradient(S * 0.5, S * 0.44, S * 0.20, S * 0.5, S * 0.5, S * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(0.72, 'rgba(0,0,0,.30)');
    vg.addColorStop(1, 'rgba(0,0,0,.80)');
    g.fillStyle = vg; g.fillRect(0, 0, S, S);

    /* 6. rotulo inferior — a capa tem tipografia, como disco de verdade */
    var lg = g.createLinearGradient(0, S * 0.72, 0, S);
    lg.addColorStop(0, 'rgba(4,3,10,0)');
    lg.addColorStop(0.42, 'rgba(4,3,10,.72)');
    lg.addColorStop(1, 'rgba(3,2,8,.95)');
    g.fillStyle = lg; g.fillRect(0, S * 0.70, S, S * 0.30);

    var title = ((song && song.title) || '').toUpperCase();
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    var fs = S * 0.072;
    g.font = '900 ' + fs.toFixed(1) + 'px "Arial Black","Segoe UI Black",Impact,sans-serif';
    while (g.measureText(title).width > S * 0.86 && fs > S * 0.035) {
      fs *= 0.94;
      g.font = '900 ' + fs.toFixed(1) + 'px "Arial Black","Segoe UI Black",Impact,sans-serif';
    }
    g.fillStyle = 'rgba(0,0,0,.7)';
    g.fillText(title, S * 0.072, S * 0.905 + S * 0.006);
    g.fillStyle = '#fff';
    g.fillText(title, S * 0.070, S * 0.905);

    g.font = '700 ' + (S * 0.036).toFixed(1) + 'px "Segoe UI",sans-serif';
    g.fillStyle = hsl(h1 + 14, 92, 66, 0.95);
    var gen = ((song && song.genre) || '').toUpperCase();
    g.fillText(gen, S * 0.072, S * 0.845);

    /* selo do ano, canto superior direito */
    g.textAlign = 'right';
    g.font = '800 ' + (S * 0.030).toFixed(1) + 'px "Segoe UI",sans-serif';
    g.fillStyle = 'rgba(255,255,255,.45)';
    g.fillText('LP · ' + ((song && song.year) || 2026), S * 0.93, S * 0.085);

    /* 7. moldura dupla de disco */
    g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = Math.max(1, S * 0.004);
    g.strokeRect(S * 0.026, S * 0.026, S * 0.948, S * 0.948);
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = Math.max(1, S * 0.002);
    g.strokeRect(S * 0.044, S * 0.044, S * 0.912, S * 0.912);

    g.restore();
    return cv;
  }

  function coverOf(song) {
    var id = (song && song.id) || 'x';
    if (coverCache[id]) return coverCache[id];
    var cv = document.createElement('canvas');
    cv.width = COVER_SIZE; cv.height = COVER_SIZE;
    try { paintCover(cv, song); } catch (e) { /* capa vazia e melhor que travar */ }
    coverCache[id] = cv;
    return cv;
  }

  /* Copia a capa mestra para um canvas menor (miniatura da lista). */
  function coverThumb(song, size) {
    var cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    try {
      var g = cv.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(coverOf(song), 0, 0, size, size);
    } catch (e) { /* ok */ }
    return cv;
  }

  /* =========================================================================
     6. RECORDES (localStorage, sempre defensivo — file:// pode nao ter)
     ========================================================================= */

  var BEST_KEY = 'guitarrada-hero.best.v1';
  var bestCache = null;

  /* SEGURANCA: o localStorage e compartilhado por TODA a origem. Num dominio
     tipo usuario.github.io qualquer outra pagina do mesmo usuario escreve
     nestas chaves. Entao o que sai daqui e ENTRADA NAO CONFIAVEL: normalizamos
     tipo por tipo antes de o recorde chegar perto de qualquer innerHTML.
     Numero vira numero finito; dificuldade so passa se estiver na lista. */
  function sanitizeBest(o) {
    if (!o || typeof o !== 'object') return null;
    var num = function (v, min, max) {
      var n = Number(v);
      if (!isFinite(n)) return min;
      return n < min ? min : (n > max ? max : n);
    };
    var ALLOWED_DIFF = ['facil', 'medio', 'dificil', 'guitarrada'];
    var d = String(o.difficulty === undefined || o.difficulty === null ? '' : o.difficulty);
    var okDiff = false, i;
    for (i = 0; i < ALLOWED_DIFF.length; i++) if (ALLOWED_DIFF[i] === d) okDiff = true;
    return {
      score: num(o.score, 0, 1e12),
      stars: Math.round(num(o.stars, 0, 6)),
      accuracy: num(o.accuracy, 0, 1),
      streak: Math.round(num(o.streak, 0, 1e9)),
      difficulty: okDiff ? d : 'medio'
    };
  }

  function bestAll() {
    if (bestCache) return bestCache;
    bestCache = {};
    try {
      var raw = window.localStorage ? window.localStorage.getItem(BEST_KEY) : null;
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o === 'object') {
          for (var k in o) {
            if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
            var rec = sanitizeBest(o[k]);
            if (rec) bestCache[String(k)] = rec;
          }
        }
      }
    } catch (e) { bestCache = {}; }
    return bestCache;
  }
  function bestOf(songId, diff) {
    var all = bestAll();
    return all[songId + '|' + diff] || null;
  }
  /* Melhor resultado da musica em QUALQUER dificuldade (para a lista). */
  function bestAny(songId) {
    var all = bestAll(), k, best = null;
    for (k in all) {
      if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
      if (k.indexOf(songId + '|') !== 0) continue;
      if (!best || all[k].score > best.score) best = all[k];
    }
    return best;
  }
  function recordBest(songId, diff, rec) {
    try {
      var all = bestAll();
      var key = songId + '|' + diff;
      var cur = all[key];
      if (!cur || rec.score > cur.score) {
        all[key] = rec;
        if (window.localStorage) window.localStorage.setItem(BEST_KEY, JSON.stringify(all));
        return true;
      }
    } catch (e) { /* sem armazenamento: o jogo segue igual */ }
    return false;
  }

  /* =========================================================================
     7. ESQUELETO DE TELA — foco, teclado e mouse falam a mesma lingua
     ========================================================================= */

  function makeScreen(name) {
    var s = {
      name: name,
      el: mk('div', 'scr scr-' + name),
      items: [],
      idx: 0,
      built: false,
      axis: 'y',            // 'y' = lista vertical, 'x' = fileira horizontal
      onFocus: null,        // (item, idx) sempre que o foco muda
      onEnter: null,        // ao abrir a tela
      onLeave: null,        // ao fechar
      onBack: null          // ESC/Backspace dentro da tela
    };
    screens[name] = s;
    add(root, s.el);
    return s;
  }

  /* Registra um elemento como item navegavel. `def` descreve o comportamento. */
  function item(scr, el, def) {
    def = def || {};
    def.el = el;
    def.index = scr.items.length;
    def.kind = def.kind || 'button';
    scr.items.push(def);
    el.classList.add('pe');
    /* mouse: passar por cima ja move o foco (como todo jogo bom faz) */
    el.addEventListener('mouseenter', function () {
      if (current !== scr) return;
      if (scr.idx !== def.index) { setFocus(scr, def.index, true); }
    }, false);
    el.addEventListener('mousedown', function (ev) {
      if (current !== scr) return;
      ev.preventDefault();
      setFocus(scr, def.index, false);
      activate(scr, def, ev);
    }, false);
    /* roda do mouse em barras deslizantes */
    if (def.kind === 'slider' || def.kind === 'choice') {
      el.addEventListener('wheel', function (ev) {
        if (current !== scr) return;
        ev.preventDefault();
        setFocus(scr, def.index, false);
        nudge(scr, def, ev.deltaY > 0 ? -1 : 1);
      }, { passive: false });
    }
    return def;
  }

  function setFocus(scr, i, playSound) {
    if (!scr.items.length) return;
    i = ((i % scr.items.length) + scr.items.length) % scr.items.length;
    /* pula itens desabilitados */
    var guard = 0;
    while (scr.items[i] && scr.items[i].disabled && guard++ < scr.items.length) {
      i = (i + 1) % scr.items.length;
    }
    var old = scr.items[scr.idx];
    if (old && old.el) old.el.classList.remove('foc');
    scr.idx = i;
    var it = scr.items[i];
    if (it && it.el) it.el.classList.add('foc');
    if (playSound) sfx('uiMove');
    if (scr.onFocus) { try { scr.onFocus(it, i); } catch (e) { /* ok */ } }
  }

  function activate(scr, it, ev) {
    if (!it || it.disabled) return;
    if (it.kind === 'toggle') { nudge(scr, it, 1); return; }
    if (it.kind === 'slider' || it.kind === 'choice') {
      if (it.onConfirm) { sfx('uiSelect'); it.onConfirm(it, ev); }
      else nudge(scr, it, 1);
      return;
    }
    sfx('uiSelect');
    if (it.onConfirm) { try { it.onConfirm(it, ev); } catch (e) { /* ok */ } }
    else if (it.action) emitChoose(it.action, it.payload);
  }

  /* Ajuste lateral: barras, escolhas e chaves liga/desliga. */
  function nudge(scr, it, dir) {
    if (!it || it.disabled) return;
    if (it.onNudge) { try { it.onNudge(dir); } catch (e) { /* ok */ } return; }
    if (typeof it.onSide === 'function') { it.onSide(dir); }
  }

  /* =========================================================================
     7B. MARCA DO ESTUDIO — "MEGA BRAIN GAMES BR"  (GH.Brand)
     ---------------------------------------------------------------------
     Estudio FICTICIO, criado so para este projeto didatico (secao 0.1 do
     ARCHITECTURE.md). A piada so funciona se a execucao for seria: logotipo
     tipografico com peso e tracking, emblema de cerebro desenhado em SVG
     inline (nada de arquivo externo, nada de CDN) e um selo que se comporta
     como selo de publisher de verdade.

     Vive aqui, mas e PUBLICO (GH.Brand): o src/main.js precisa do mesmo
     logotipo na tela de carregamento e menus.js carrega ANTES dele no
     index.html. A folha de estilo e GLOBAL de proposito (prefixo .ghb-),
     porque a tela de carregamento mora fora de #gh-menus.
     ========================================================================= */

  var BRAND = {
    NAME: 'MEGA BRAIN GAMES BR',
    W1: 'MEGA BRAIN',
    W2: 'GAMES BR',
    /* Frase da abertura, exigida por contrato. */
    PRESENTS_A: 'Um jogo',
    /* Aviso obrigatorio: ninguem pode achar que o estudio existe. */
    FICTION: 'Mega Brain Games BR é um estúdio fictício criado para este projeto didático.'
  };

  /* Cada emblema precisa de ids proprios para os gradientes: dois <svg> com o
     mesmo id fariam o segundo herdar o gradiente do primeiro. */
  var brandSeq = 0;

  /* Metade ESQUERDA do cerebro. A direita e a mesma path espelhada em x=32,
     o que garante simetria perfeita sem duplicar coordenada nenhuma. */
  var BRAIN_HALF =
    'M32 6.4c-5.9 0-10.4 2.9-11.8 7.1-5.1.3-8.9 4.2-8.9 9 0 2 .6 3.8 1.8 5.3' +
    '-1.9 1.6-3.1 4-3.1 6.6 0 3.9 2.4 7.3 5.9 8.7 0 4.7 3.8 8.6 8.8 8.6' +
    '2.9 0 5.4-1.4 7.3-3.5V6.4z';

  /* Sulcos (giros) da metade esquerda — tracos, nao preenchimento. */
  var BRAIN_FOLDS =
    '<path d="M24.6 11.8c-2.6 1.8-3.6 4.4-2.6 6.9"/>' +
    '<path d="M14.6 19.8c2.6-1.2 5.6-.2 6.8 2.4"/>' +
    '<path d="M12.4 31.4c3-1.6 6.6-.6 8.2 2.2"/>' +
    '<path d="M17.6 41.4c1.8-2.8 5.2-3.6 8-1.8"/>' +
    '<path d="M24.2 47.6c-.8-2.6.2-4.8 2.2-6.2"/>';

  var MIRROR = ' transform="translate(64,0) scale(-1,1)"';

  /* Emblema em SVG inline. `opts.ring` liga o anel externo (selo);
     `opts.flat` desliga o gradiente quente (versao apagada do rodape). */
  function brandEmblem(opts) {
    opts = opts || {};
    var id = 'ghbm' + (++brandSeq);
    var gA = id + 'a', gB = id + 'b';
    var ink = opts.ink || '#140a20';
    var out = '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" ' +
      'aria-hidden="true" focusable="false">' +
      '<defs>' +
        '<linearGradient id="' + gA + '" x1="0.12" y1="0" x2="0.88" y2="1">' +
          (opts.flat
            ? '<stop offset="0" stop-color="#c9d2ea"/><stop offset="1" stop-color="#7c87a6"/>'
            : '<stop offset="0" stop-color="#fff6da"/>' +
              '<stop offset="0.40" stop-color="#ffcf4a"/>' +
              '<stop offset="0.76" stop-color="#ff8a1e"/>' +
              '<stop offset="1" stop-color="#ff4d7a"/>') +
        '</linearGradient>' +
        '<linearGradient id="' + gB + '" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#8fe9ff"/><stop offset="1" stop-color="#25e8ce"/>' +
        '</linearGradient>' +
      '</defs>';

    if (opts.ring !== false) {
      out += '<circle cx="32" cy="32" r="30.3" fill="none" stroke="url(#' + gB + ')" ' +
             'stroke-width="1.5" opacity="' + (opts.flat ? '.30' : '.42') + '"/>' +
             '<circle cx="32" cy="32" r="27.4" fill="none" stroke="url(#' + gA + ')" ' +
             'stroke-width="0.8" opacity="' + (opts.flat ? '.26' : '.36') + '"/>';
    }

    out += '<g transform="translate(32,32) scale(0.88) translate(-32,-32)">' +
      /* massa cinzenta + tronco encefalico */
      '<g fill="url(#' + gA + ')">' +
        '<path d="M28.5 46.6h7v4.3a3.5 3.5 0 0 1-3.5 3.5 3.5 3.5 0 0 1-3.5-3.5z"/>' +
        '<path d="' + BRAIN_HALF + '"/>' +
        '<path d="' + BRAIN_HALF + '"' + MIRROR + '/>' +
      '</g>' +
      /* fissura central + sulcos: recorte escuro, o que da leitura de cerebro
         mesmo com o emblema do tamanho de uma unha */
      '<g fill="none" stroke="' + ink + '" stroke-width="1.9" stroke-linecap="round" ' +
        'opacity="' + (opts.flat ? '.5' : '.62') + '">' +
        '<path d="M32 8.6V50.4"/>' +
        BRAIN_FOLDS +
        '<g' + MIRROR + '>' + BRAIN_FOLDS + '</g>' +
      '</g>' +
      '</g></svg>';
    return out;
  }

  /* Logotipo completo: emblema + lockup tipografico em duas linhas.
     `opts.eyebrow` imprime a sobrelinha (ex.: "Um jogo", "Publicado por"). */
  function brandLockup(opts) {
    opts = opts || {};
    var cls = 'ghb' + (opts.mute ? ' mute' : '') + (opts.cls ? ' ' + opts.cls : '');
    var html = '<span class="' + cls + '">' +
      '<span class="ghb-mark">' + brandEmblem({ ring: opts.ring, flat: opts.mute }) + '</span>' +
      '<span class="ghb-word">' +
        (opts.eyebrow ? '<span class="ghb-eye">' + esc(opts.eyebrow) + '</span>' : '') +
        '<span class="ghb-w1">' + esc(BRAND.W1) + '</span>' +
        '<span class="ghb-w2"><span>' + esc(BRAND.W2) + '</span></span>' +
      '</span>' +
    '</span>';
    return html;
  }

  /* Folha de estilo GLOBAL da marca (nao escopada em #gh-menus, porque a tela
     de carregamento do main.js e irma, nao filha). Tudo em `em`: quem usa so
     precisa definir `font-size` no elemento .ghb e o lockup inteiro escala. */
  var BRAND_CSS = [
    '.ghb{display:inline-flex;align-items:center;gap:.62em;line-height:1;white-space:nowrap;',
    'font-family:"Segoe UI Black","Arial Black","Franklin Gothic Heavy",Impact,"Segoe UI",system-ui,sans-serif;',
    '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
    '.ghb-mark{position:relative;flex:0 0 auto;width:2.5em;height:2.5em}',
    '.ghb-mark svg{position:relative;z-index:1;display:block;width:100%;height:100%}',
    /* halo quente atras do emblema: descola o selo de qualquer fundo.
       Sem z-index negativo de proposito — em cima de um fundo opaco (a tela de
       carregamento) o halo simplesmente sumiria atras dele. */
    '.ghb-mark::before{content:"";position:absolute;left:-30%;top:-30%;right:-30%;bottom:-30%;',
    'border-radius:50%;z-index:0;',
    'background:radial-gradient(50% 50% at 50% 50%,rgba(255,176,64,.30),rgba(255,176,64,0) 70%)}',
    '.ghb-word{display:block;min-width:0}',
    '.ghb-eye{display:block;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;',
    'font-weight:800;font-size:.46em;letter-spacing:.42em;text-indent:.42em;text-transform:uppercase;',
    'color:#7f8aa8;margin-bottom:.55em;text-shadow:0 1px 2px rgba(0,0,0,.9)}',
    '.ghb-w1{display:block;font-weight:900;font-size:1em;letter-spacing:.085em;',
    'text-transform:uppercase;',
    'background-image:linear-gradient(178deg,#ffffff 0%,#ffeec2 34%,#f0bf5e 68%,#b9822f 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 1px 0 rgba(0,0,0,.9)) drop-shadow(0 0 .55em rgba(255,168,56,.30))}',
    '.ghb-w2{display:flex;align-items:center;gap:.5em;margin-top:.34em;',
    'font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;',
    'font-weight:800;font-size:.46em;letter-spacing:.44em;text-transform:uppercase;',
    'color:#98a3c2;text-shadow:0 1px 2px rgba(0,0,0,.95)}',
    '.ghb-w2>span{flex:0 0 auto;text-indent:.44em}',
    '.ghb-w2::before,.ghb-w2::after{content:"";flex:1 1 auto;height:1px;min-width:.7em;',
    'transform-origin:right center;',
    'background:linear-gradient(90deg,rgba(255,207,74,0),rgba(255,207,74,.60))}',
    '.ghb-w2::after{transform-origin:left center;',
    'background:linear-gradient(90deg,rgba(255,207,74,.60),rgba(255,207,74,0))}',
    /* variante discreta: o selo do rodape do titulo nao pode competir com o
       slogan nem com o aviso didatico, que sao os protagonistas */
    '.ghb.mute .ghb-w1{background-image:none;-webkit-background-clip:border-box;',
    'background-clip:border-box;color:#a7b1cd;filter:none;',
    'text-shadow:0 1px 2px rgba(0,0,0,.9)}',
    '.ghb.mute .ghb-w2{color:#6b7593}',
    '.ghb.mute .ghb-w2::before{background:linear-gradient(90deg,rgba(150,163,196,0),rgba(150,163,196,.45))}',
    '.ghb.mute .ghb-w2::after{background:linear-gradient(90deg,rgba(150,163,196,.45),rgba(150,163,196,0))}',
    '.ghb.mute .ghb-mark::before{display:none}'
  ].join('');

  function brandInjectCss() {
    if (document.getElementById('gh-brand-css')) return;
    var st = document.createElement('style');
    st.id = 'gh-brand-css';
    st.textContent = BRAND_CSS;
    document.head.appendChild(st);
  }

  GH.Brand = {
    name: BRAND.NAME,
    wordA: BRAND.W1,
    wordB: BRAND.W2,
    presents: BRAND.PRESENTS_A,
    fiction: BRAND.FICTION,
    emblem: brandEmblem,
    lockup: brandLockup,
    css: BRAND_CSS,
    injectCss: brandInjectCss
  };

  /* =========================================================================
     8. TELA DE TITULO — a primeira impressao do jogo
     ========================================================================= */

  /* Textos obrigatorios (secao 0.1 do ARCHITECTURE.md). Ficam em constantes
     para nao serem reescritos por engano em nenhuma das telas que os usam. */
  var SLOGAN_A = 'Queremos ver se o Brasil já está pronto';
  var SLOGAN_B = 'pra tocar as músicas do ';
  var SLOGAN_HERO = 'Ximbinha';
  var NOTICE_1 = 'Projeto didático, sem fins comerciais. Músicas originais geradas proceduralmente.';
  var NOTICE_2 = 'Homenagem — não afiliado a nenhum artista ou gravadora.';

  CSS.push([
    /* --------------------------------------------------------------- *
     * Cortina do titulo: preserva o por do sol do palco no meio e
     * afunda o topo e o rodape para o texto ganhar contraste.
     * --------------------------------------------------------------- */
    '#gh-menus .scr-title .scrim{background:',
    'radial-gradient(78% 58% at 50% 44%,rgba(8,4,20,.66) 0%,rgba(8,4,20,.30) 45%,rgba(6,3,14,.05) 100%),',
    'linear-gradient(180deg,rgba(4,2,10,.94) 0%,rgba(4,2,10,.62) 16%,rgba(4,2,10,.05) 38%,',
    'rgba(4,2,10,.10) 52%,rgba(4,2,10,.72) 82%,rgba(2,1,6,.97) 100%)}',

    '#gh-menus .t-wrap{position:absolute;inset:0;display:flex;flex-direction:column;',
    'align-items:center;justify-content:flex-start;padding:calc(var(--u)*3.4) calc(var(--u)*4) 0;',
    'box-sizing:border-box;text-align:center}',

    /* ---------------------------- LOGO ----------------------------- */
    '#gh-menus .logo{position:relative;margin:calc(var(--u)*1.1) 0 0;line-height:.92;',
    'font-family:var(--f-display);font-weight:900;font-style:italic;text-transform:uppercase;',
    'user-select:none;-webkit-user-select:none}',
    /* O texto da propria .ln e transparente: ele so segura o layout.
       As TRES camadas visiveis sao pseudo-elementos/filhos posicionados, e
       nessa ordem — extrusao, preenchimento em degrade, bisel. Fazer o
       preenchimento pelo BACKGROUND da .ln nao funciona: o background de um
       elemento e pintado ANTES dos filhos de z-index negativo, entao a
       extrusao cobria o degrade (foi exatamente o bug do primeiro print). */
    '#gh-menus .logo .ln{position:relative;display:block;white-space:nowrap;color:transparent}',
    '#gh-menus .logo .ln::before,#gh-menus .logo .ln::after,#gh-menus .logo .ln b{',
    'position:absolute;left:0;right:0;top:0;pointer-events:none;',
    'font:inherit;letter-spacing:inherit;text-transform:inherit}',

    /* camada 1 — extrusao + contorno escuro (legibilidade sobre o palco) */
    '#gh-menus .logo .ln::before{content:attr(data-text);color:#1c0512;',
    'text-shadow:-2px 0 0 #14030c,2px 0 0 #14030c,0 -2px 0 #14030c,-2px -2px 0 #14030c,2px -2px 0 #14030c,',
    '0 1px 0 #240617,0 2px 0 #220615,0 3px 0 #1e0513,0 4px 0 #1a0411,0 5px 0 #16030e,',
    '0 6px 0 #12030c,0 7px 0 #0e0209,0 8px 0 #0a0107,0 9px 0 #070005,',
    '0 calc(var(--u)*.9) calc(var(--u)*1.7) rgba(0,0,0,.9)}',
    '#gh-menus .logo .l2::before{color:#04121f;',
    'text-shadow:-2px 0 0 #020b14,2px 0 0 #020b14,0 -2px 0 #020b14,-2px -2px 0 #020b14,2px -2px 0 #020b14,',
    '0 1px 0 #06202f,0 2px 0 #061c2c,0 3px 0 #051726,0 4px 0 #041420,0 5px 0 #04111b,',
    '0 6px 0 #030e16,0 7px 0 #020a11,0 8px 0 #02070c,0 9px 0 #01050a,0 10px 0 #01040800,',
    '0 calc(var(--u)*1.1) calc(var(--u)*2.1) rgba(0,0,0,.92)}',

    /* camada 2 — o preenchimento em degrade */
    '#gh-menus .logo .ln::after{content:attr(data-text);',
    '-webkit-background-clip:text;background-clip:text;color:transparent}',
    /* ATENCAO: aqui vai `background-image` e NAO o atalho `background` — o
       atalho reseta background-clip para border-box e o degrade vazaria como
       um retangulo por cima do logo (bug real, visto no segundo print). */
    '#gh-menus .logo .l1::after{',
    'background-image:linear-gradient(178deg,#fffdf4 0%,#ffe490 16%,#ffb52e 38%,#e8620c 48%,'
    + '#7d2206 51%,#ff8a1e 57%,#ff5a3c 74%,#ff2f7d 92%,#c9155f 100%)}',
    '#gh-menus .logo .l2::after{',
    'background-image:linear-gradient(178deg,#ffffff 0%,#e6faff 14%,#9adcf2 32%,#2f8fb4 47%,'
    + '#0b3b5e 50%,#2fd0cd 56%,#7fe9dd 70%,#d9fbf6 86%,#4f9fc0 100%)}',

    /* camada 3 — bisel: luz na aresta de cima, sombra no pe da letra */
    '#gh-menus .logo .ln b{font-weight:inherit;font-style:inherit;',
    'background:linear-gradient(180deg,rgba(255,255,255,.70) 0%,rgba(255,255,255,.32) 9%,',
    'rgba(255,255,255,.05) 22%,rgba(255,255,255,0) 38%,rgba(0,0,0,.16) 80%,rgba(0,0,0,.36) 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent}',
    /* halo quente atras do logo: descola o bloco do palco sem apagar o fundo */
    '#gh-menus .logo::before{content:"";position:absolute;left:-14%;right:-14%;top:-16%;bottom:-6%;',
    'z-index:-1;pointer-events:none;',
    'background:radial-gradient(58% 52% at 50% 46%,rgba(255,120,40,.24) 0%,rgba(120,40,160,.16) 45%,rgba(0,0,0,0) 74%)}',

    /* linha 1 — GUITARRADA */
    '#gh-menus .logo .l1{font-size:calc(var(--u)*6.0);letter-spacing:.006em;',
    'filter:drop-shadow(0 calc(var(--u)*.5) calc(var(--u)*1.0) rgba(0,0,0,.8))',
    ' drop-shadow(0 0 calc(var(--u)*2.4) rgba(255,130,40,.45))}',
    /* linha 2 — HERO: cromado gelo, maior e espacado */
    '#gh-menus .logo .l2{font-size:calc(var(--u)*11.6);letter-spacing:.155em;margin-top:calc(var(--u)*-.55);',
    'filter:drop-shadow(0 calc(var(--u)*.6) calc(var(--u)*1.3) rgba(0,0,0,.86))',
    ' drop-shadow(0 0 calc(var(--u)*2.8) rgba(80,205,235,.42))}',
    /* a ultima letra ganha o espaco de tracking de volta, senao o bloco */
    /* inteiro fica deslocado meio caractere para a esquerda */
    '#gh-menus .logo .l2,#gh-menus .logo .l2::before,#gh-menus .logo .l2::after,',
    '#gh-menus .logo .l2 b{text-indent:.155em}',

    /* friso sob o logo */
    '#gh-menus .t-frieze{width:calc(var(--u)*30);margin:calc(var(--u)*1.15) 0 0;',
    'height:calc(var(--u)*2.7);opacity:.80;',
    'background:linear-gradient(90deg,transparent 0%,rgba(255,207,74,.65) 18%,var(--gold) 38%,',
    '#ffb04a 50%,var(--gold) 62%,rgba(255,207,74,.65) 82%,transparent 100%)}',

    /* --------------------------- SLOGAN ---------------------------- */
    '#gh-menus .t-slogan{margin:calc(var(--u)*1.35) 0 0;font-family:var(--f-serif);font-style:italic;',
    'font-size:calc(var(--u)*1.62);line-height:1.42;letter-spacing:.006em;color:#f4eeff;',
    'text-shadow:0 calc(var(--u)*.12) calc(var(--u)*.9) rgba(0,0,0,.92),0 0 calc(var(--u)*2.4) rgba(255,120,60,.22);',
    'max-width:calc(var(--u)*54)}',
    '#gh-menus .t-slogan b{font-style:italic;font-weight:700;color:var(--gold);',
    'text-shadow:0 0 calc(var(--u)*1.3) rgba(255,207,74,.65),0 calc(var(--u)*.1) calc(var(--u)*.6) rgba(0,0,0,.9)}',
    '#gh-menus .t-slogan .qq{color:var(--mag);font-size:1.25em;line-height:0;vertical-align:-.12em;opacity:.9}',

    /* ---------------------------- MENU ----------------------------- */
    '#gh-menus .t-menu{position:relative;margin:calc(var(--u)*1.9) 0 0;display:flex;flex-direction:column;',
    'align-items:center;gap:calc(var(--u)*.30)}',
    '#gh-menus .t-menu::before{content:"";position:absolute;left:-38%;right:-38%;top:-22%;bottom:-18%;',
    'z-index:-1;pointer-events:none;',
    'background:radial-gradient(52% 56% at 50% 50%,rgba(3,2,9,.86) 0%,rgba(3,2,9,.62) 44%,rgba(3,2,9,0) 76%)}',
    '#gh-menus .t-item{position:relative;display:flex;align-items:baseline;justify-content:center;',
    'gap:calc(var(--u)*.85);padding:calc(var(--u)*.36) calc(var(--u)*2.6);cursor:pointer;',
    'transition:transform .22s cubic-bezier(.2,1.4,.4,1),filter .22s ease}',
    '#gh-menus .t-item .lbl{font-family:var(--f-display);font-weight:900;font-style:italic;',
    'font-size:calc(var(--u)*2.15);letter-spacing:.035em;text-transform:uppercase;color:#b9c2dc;',
    'text-shadow:0 calc(var(--u)*.1) 0 rgba(0,0,0,.85),0 calc(var(--u)*.35) calc(var(--u)*.9) rgba(0,0,0,.7);',
    'transition:color .2s ease}',
    '#gh-menus .t-item .sub{font-size:calc(var(--u)*.70);font-weight:700;letter-spacing:.24em;',
    'text-transform:uppercase;color:transparent;transition:color .22s ease;white-space:nowrap}',
    /* losango marajoara como cursor */
    '#gh-menus .t-item::before{content:"";position:absolute;left:calc(var(--u)*.55);top:50%;',
    'width:calc(var(--u)*.62);height:calc(var(--u)*.62);margin-top:calc(var(--u)*-.31);',
    'background:linear-gradient(135deg,var(--gold),var(--mag));transform:rotate(45deg) scale(0);',
    'box-shadow:0 0 calc(var(--u)*.9) rgba(255,180,80,.9);',
    'transition:transform .26s cubic-bezier(.2,1.7,.4,1)}',
    /* sublinhado que abre a partir do centro */
    '#gh-menus .t-item::after{content:"";position:absolute;left:50%;right:50%;bottom:calc(var(--u)*.06);',
    'height:2px;background:linear-gradient(90deg,transparent,var(--gold),var(--mag),transparent);',
    'opacity:0;transition:left .28s cubic-bezier(.2,.9,.3,1),right .28s cubic-bezier(.2,.9,.3,1),opacity .2s ease}',
    '#gh-menus .t-item.foc{transform:scale(1.055)}',
    '#gh-menus .t-item.foc::before{transform:rotate(45deg) scale(1)}',
    '#gh-menus .t-item.foc::after{left:calc(var(--u)*1.9);right:calc(var(--u)*1.9);opacity:.95}',
    '#gh-menus .t-item.foc .lbl{color:#fff;',
    'text-shadow:0 calc(var(--u)*.1) 0 rgba(60,10,0,.9),0 0 calc(var(--u)*1.6) rgba(255,190,90,.85),',
    '0 calc(var(--u)*.4) calc(var(--u)*1.1) rgba(0,0,0,.8)}',
    '#gh-menus .t-item.foc .sub{color:var(--gold)}',

    /* -------------------------- RODAPE ----------------------------- */
    '#gh-menus .t-notice{position:absolute;left:0;right:0;bottom:calc(var(--u)*1.35);text-align:center;padding:0 6vw}',
    '#gh-menus .t-hints{position:absolute;right:calc(var(--u)*2.2);bottom:calc(var(--u)*3.6)}',
    '#gh-menus .t-stamp{position:absolute;left:calc(var(--u)*2.2);bottom:calc(var(--u)*3.6);',
    'font-size:calc(var(--u)*.68);letter-spacing:.22em;text-transform:uppercase;font-weight:700;',
    'color:var(--ink-faint)}',
    '#gh-menus .t-stamp b{color:var(--cyan)}',
    /* selo de canto superior direito */
    '#gh-menus .t-badge{position:absolute;right:calc(var(--u)*2.2);top:calc(var(--u)*2.0);',
    'display:flex;align-items:center;gap:calc(var(--u)*.6);',
    'font-size:calc(var(--u)*.66);letter-spacing:.24em;text-transform:uppercase;font-weight:800;',
    'color:var(--ink-dim);border:1px solid rgba(255,255,255,.14);border-radius:99px;',
    'padding:calc(var(--u)*.32) calc(var(--u)*.95);background:rgba(6,5,14,.5)}',
    '#gh-menus .t-badge i{width:calc(var(--u)*.4);height:calc(var(--u)*.4);border-radius:50%;',
    'background:var(--gold);box-shadow:0 0 calc(var(--u)*.7) var(--gold);display:block}',

    /* ------------------ SELO DE PUBLISHER (Mega Brain Games BR) ------------
       Rodape central, ACIMA do aviso didatico e da linha de dicas. Pequeno e
       discreto de proposito: o slogan e o aviso continuam sendo os
       protagonistas da tela. As duas hastes horizontais transformam o selo
       numa "linha de credito", que e como um selo de publisher se comporta. */
    /* Centralizado por flex e NAO por translateX(-50%): revealList() escreve
       em `transform` durante a entrada e apagaria a centralizacao. */
    '#gh-menus .t-pub{position:absolute;left:0;right:0;bottom:calc(var(--u)*6.0);',
    'display:flex;align-items:center;justify-content:center;gap:calc(var(--u)*1.25);',
    'opacity:.94;pointer-events:none}',
    '#gh-menus .t-pub::before,#gh-menus .t-pub::after{content:"";display:block;flex:0 0 auto;',
    'width:calc(var(--u)*5.6);height:1px;',
    'background:linear-gradient(90deg,transparent,rgba(255,207,74,.42))}',
    '#gh-menus .t-pub::after{background:linear-gradient(90deg,rgba(255,207,74,.42),transparent)}',
    '#gh-menus .t-pub .ghb{font-size:calc(var(--u)*1.10)}',
    '#gh-menus .t-pub .ghb-eye{font-size:.50em;margin-bottom:.5em}'
  ].join(''));

  var TITLE_ITEMS = [
    { label: 'Jogar', sub: 'escolher música', action: 'songselect' },
    { label: 'Opções', sub: 'calibrar e ajustar', action: 'settings' },
    { label: 'Créditos', sub: 'homenagens', action: 'credits' }
  ];

  function buildTitle() {
    var s = makeScreen('title');
    var el = s.el;
    add(el, mk('div', 'scrim'));

    var wrap = add(el, mk('div', 't-wrap'));

    var kick = add(wrap, mk('p', 'kick rule', 'Homenagem à guitarrada paraense'));

    var logo = add(wrap, mk('h1', 'logo'));
    logo.innerHTML =
      '<span class="ln l1" data-text="GUITARRADA">GUITARRADA<b>GUITARRADA</b></span>' +
      '<span class="ln l2" data-text="HERO">HERO<b>HERO</b></span>';

    var frieze = add(wrap, mk('div', 'frieze t-frieze'));

    var slogan = add(wrap, mk('p', 't-slogan'));
    slogan.innerHTML =
      '<span class="qq">&ldquo;</span>' + esc(SLOGAN_A) + '<br>' +
      esc(SLOGAN_B) + '<b>' + esc(SLOGAN_HERO) + '</b><span class="qq">&rdquo;</span>';

    var menu = add(wrap, mk('div', 't-menu'));
    var i, rows = [];
    for (i = 0; i < TITLE_ITEMS.length; i++) {
      var def = TITLE_ITEMS[i];
      var row = add(menu, mk('div', 't-item'));
      row.innerHTML = '<span class="lbl">' + esc(def.label) + '</span>' +
        '<span class="sub">' + esc(def.sub) + '</span>';
      item(s, row, { action: def.action });
      rows.push(row);
    }

    var badge = add(el, mk('div', 't-badge', '<i></i>Projeto didático'));

    /* selo do estudio ficticio — pequeno, no rodape, sem roubar a cena */
    var pub = add(el, mk('div', 't-pub',
      brandLockup({ eyebrow: 'Um jogo', mute: true, ring: true })));

    var notice = add(el, mk('p', 'notice t-notice'));
    notice.innerHTML = esc(NOTICE_1) + '<br>' + esc(NOTICE_2);

    add(el, mk('div', 'hints t-hints',
      '<span><b class="key">&uarr;</b><b class="key">&darr;</b> navegar</span>' +
      '<span><b class="key">Enter</b> confirmar</span>'));

    add(el, mk('div', 't-stamp', 'Guitarrada Hero <b>&middot;</b> 2026 <b>&middot;</b> Belém do Pará'));

    s.parts = { kick: kick, logo: logo, frieze: frieze, slogan: slogan, rows: rows,
                notice: notice, badge: badge, pub: pub };

    s.onEnter = function () {
      /* entrada: kicker, logo, friso, slogan e cada opcao, em cascata */
      revealList([kick], { delay: 0.02, dur: 0.55, dy: -14 });
      tween({
        delay: 0.10, dur: 0.72,
        apply: function (u) {
          var p = easeOutQuint(u);
          var o = easeOutCubic(clamp01(u * 1.6));
          logo.style.opacity = o.toFixed(3);
          logo.style.transform = 'translate3d(0,' + ((1 - p) * 34).toFixed(2) + 'px,0) scale(' +
            lerp(1.10, 1, p).toFixed(4) + ')';
          logo.style.filter = 'blur(' + ((1 - o) * 7).toFixed(2) + 'px)';
        },
        done: function () { logo.style.opacity = ''; logo.style.transform = ''; logo.style.filter = ''; }
      });
      tween({
        delay: 0.46, dur: 0.62,
        apply: function (u) {
          var p = easeOutQuint(u);
          frieze.style.opacity = (easeOutCubic(u) * 1).toFixed(3);
          frieze.style.transform = 'scaleX(' + lerp(0.25, 1, p).toFixed(4) + ')';
        },
        done: function () { frieze.style.opacity = ''; frieze.style.transform = ''; }
      });
      revealList([slogan], { delay: 0.60, dur: 0.62, dy: 16 });
      revealList(rows, { delay: 0.80, step: 0.075, dur: 0.52, dy: 18, dx: -10 });
      /* o selo entra por ultimo e por baixo — assinatura, nao manchete */
      revealList([notice, badge], { delay: 1.06, step: 0.06, dur: 0.5, dy: 10 });
      revealList([pub], { delay: 1.20, dur: 0.62, dy: 12 });
      setFocus(s, 0, false);
    };
    s.onBack = null;   /* no titulo, ESC nao leva a lugar nenhum */
    s.built = true;
    return s;
  }

  /* =========================================================================
     9. DIFICULDADES — tabela compartilhada por varias telas
     ========================================================================= */

  var DIFF_ORDER = ['facil', 'medio', 'dificil', 'guitarrada'];

  var DIFF_INFO = {
    facil: {
      label: 'Fácil', tag: 'I', lanes: '3 raias',
      desc: 'Três raias e uma nota de cada vez. Pra pegar o balanço da guitarrada sem susto.',
      hue: 145
    },
    medio: {
      label: 'Médio', tag: 'II', lanes: '4 raias',
      desc: 'Quatro raias e os primeiros acordes de duas notas. O braço começa a acordar.',
      hue: 48
    },
    dificil: {
      label: 'Difícil', tag: 'III', lanes: '5 raias',
      desc: 'As cinco raias, HOPOs e sustains longos. Já é show de verdade, com plateia.',
      hue: 217
    },
    guitarrada: {
      label: 'Guitarrada', tag: 'EXPERT', lanes: '5 raias',
      desc: 'Tudo: acordes de três, taps, notas abertas e o tremolo do Pará na velocidade do mestre.',
      hue: 353
    }
  };

  function diffLabel(d) {
    try {
      if (GH.Songs && typeof GH.Songs.labelOf === 'function') {
        var l = GH.Songs.labelOf(d);
        if (l && l !== d) return l;
      }
    } catch (e) { /* usa a tabela local */ }
    return (DIFF_INFO[d] && DIFF_INFO[d].label) || d;
  }

  /* Barra de 10 casas usada como "estrelas de dificuldade". */
  function pipsHTML(value, max, cls) {
    var v = Math.round(value || 0), m = max || 10, i, out = '';
    for (i = 1; i <= m; i++) {
      out += '<i class="' + (i <= v ? 'on' : '') + (i === m ? ' last' : '') + '"></i>';
    }
    return '<span class="pips ' + (cls || '') + '">' + out + '</span>';
  }

  function statsFor(song, diff) {
    try {
      if (song && song.chartStats && song.chartStats[diff]) return song.chartStats[diff];
    } catch (e) { /* ok */ }
    return { notes: 0, nps: 0, peakNps: 0, chords: 0, hopos: 0, taps: 0, opens: 0, sustains: 0 };
  }
  function starsFor(song, diff) {
    try {
      if (song && song.difficultyStars && typeof song.difficultyStars[diff] === 'number') {
        return song.difficultyStars[diff];
      }
    } catch (e) { /* ok */ }
    return 0;
  }

  /* -------------------------------------------------------------------------
     PREVIA DA PISTA — desenha um pedaco REAL do chart daquela dificuldade.
     E a forma honesta de mostrar "densidade de notas": em vez de um numero
     solto, o jogador ve a pista que vai encarar (acordes, HOPOs, taps,
     sustains e notas abertas, nas cores canonicas das raias).
     ------------------------------------------------------------------------- */
  function laneHex(i, part) {
    try {
      var P = GH.Palette;
      if (P && P.lanes && P.lanes[i]) return P.lanes[i].hex[part || 'base'];
    } catch (e) { /* ok */ }
    var fb = ['#16c25c', '#e31530', '#e8b707', '#1c63de', '#e9640a'];
    return fb[i % 5];
  }

  /* Acha a janela de `win` segundos com mais ataques (o trecho mais ilustrativo). */
  function densestWindow(notes, win) {
    if (!notes || !notes.length) return 0;
    var best = 0, bestN = -1, j = 0, i;
    for (i = 0; i < notes.length; i++) {
      while (notes[j] && notes[i].t - notes[j].t > win) j++;
      var n = i - j + 1;
      if (n > bestN) { bestN = n; best = notes[j] ? notes[j].t : 0; }
    }
    return best;
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w * 0.5, h * 0.5);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawChartPreview(cv, song, diff) {
    var S = sizeCanvas(cv);
    if (!S) return false;
    var g = S.g, W = S.w, H = S.h;
    var notes = (song && song.charts && song.charts[diff]) || [];
    var win = 4.0;
    var t0 = densestWindow(notes, win);
    var padX = W * 0.045;
    var laneW = (W - padX * 2) / 5;
    var baseY = H * 0.80;
    var cxW = W * 0.5;
    var i, k;

    /* perspectiva simples: a pista afunila para o fundo, como no jogo */
    function SC(y) { return 0.42 + 0.58 * clamp01(y / baseY); }
    function LX(l, y) { return cxW + (padX + laneW * (l + 0.5) - cxW) * SC(y); }
    function EDGE(k2, y) { return cxW + (padX + laneW * k2 - cxW) * SC(y); }
    function TY(t) { return baseY - ((t - t0) / win) * baseY; }

    /* superficie */
    g.beginPath();
    g.moveTo(EDGE(0, 0), 0); g.lineTo(EDGE(5, 0), 0);
    g.lineTo(EDGE(5, baseY), baseY); g.lineTo(EDGE(0, baseY), baseY);
    g.closePath();
    var bgp = g.createLinearGradient(0, 0, 0, baseY);
    bgp.addColorStop(0, 'rgba(10,8,22,.15)');
    bgp.addColorStop(0.55, 'rgba(12,9,26,.60)');
    bgp.addColorStop(1, 'rgba(6,5,14,.88)');
    g.fillStyle = bgp; g.fill();

    g.strokeStyle = 'rgba(255,255,255,.075)'; g.lineWidth = 1;
    for (k = 0; k <= 5; k++) {
      g.beginPath(); g.moveTo(EDGE(k, 0), 0); g.lineTo(EDGE(k, baseY), baseY); g.stroke();
    }
    var bpm = (song && song.bpm) || 120, barSec = (60 / bpm) * 4;
    g.strokeStyle = 'rgba(255,255,255,.11)';
    for (var bt = Math.ceil(t0 / barSec) * barSec; bt < t0 + win; bt += barSec) {
      var by = TY(bt);
      g.beginPath(); g.moveTo(EDGE(0, by), by); g.lineTo(EDGE(5, by), by); g.stroke();
    }

    var gemH0 = Math.max(4, laneW * 0.30);
    var gemW0 = laneW * 0.74;

    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.t < t0 - 0.05) continue;
      if (n.t > t0 + win) break;
      var y = TY(n.t), sc = SC(y);
      var gemH = gemH0 * sc, gemW = gemW0 * sc;
      if (n.dur > 0.02) {
        var y2 = Math.max(0, TY(n.t + n.dur));
        var sg = g.createLinearGradient(0, y, 0, y2);
        sg.addColorStop(0, n.open ? 'rgba(214,180,255,.9)' : laneHex(n.lane, 'glow'));
        sg.addColorStop(1, 'rgba(255,255,255,.04)');
        g.fillStyle = sg; g.globalAlpha = 0.55;
        g.beginPath();
        if (n.open) {
          g.moveTo(EDGE(0, y) + 4, y); g.lineTo(EDGE(5, y) - 4, y);
          g.lineTo(EDGE(5, y2) - 3, y2); g.lineTo(EDGE(0, y2) + 3, y2);
        } else {
          var w1 = gemW * 0.30, w2 = gemW0 * SC(y2) * 0.30;
          g.moveTo(LX(n.lane, y) - w1, y); g.lineTo(LX(n.lane, y) + w1, y);
          g.lineTo(LX(n.lane, y2) + w2, y2); g.lineTo(LX(n.lane, y2) - w2, y2);
        }
        g.closePath(); g.fill(); g.globalAlpha = 1;
      }
      if (n.open) {
        var og = g.createLinearGradient(EDGE(0, y), 0, EDGE(5, y), 0);
        og.addColorStop(0, 'rgba(180,120,255,.30)');
        og.addColorStop(0.5, 'rgba(238,224,255,.98)');
        og.addColorStop(1, 'rgba(180,120,255,.30)');
        g.fillStyle = og;
        roundRect(g, EDGE(0, y) + 3, y - gemH * 0.32, EDGE(5, y) - EDGE(0, y) - 6, gemH * 0.64, gemH * 0.3);
        g.fill();
        continue;
      }
      var cx = LX(n.lane, y);
      var hh = n.hopo ? gemH * 0.74 : gemH, ww = n.hopo ? gemW * 0.72 : gemW;
      var gg = g.createLinearGradient(0, y - hh * 0.5, 0, y + hh * 0.5);
      if (n.tap) { gg.addColorStop(0, 'rgba(38,34,54,.98)'); gg.addColorStop(1, 'rgba(8,7,16,.98)'); }
      else { gg.addColorStop(0, laneHex(n.lane, 'emissive')); gg.addColorStop(1, laneHex(n.lane, 'base')); }
      roundRect(g, cx - ww * 0.5, y - hh * 0.5, ww, hh, hh * 0.38);
      g.fillStyle = gg; g.fill();
      g.lineWidth = Math.max(0.8, hh * 0.16);
      g.strokeStyle = (n.hopo || n.tap) ? 'rgba(255,255,255,.92)' : laneHex(n.lane, 'rim');
      g.stroke();
    }

    /* linha de acerto + aros */
    var ly = baseY + gemH0 * 0.85;
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(EDGE(0, baseY), ly); g.lineTo(EDGE(5, baseY), ly); g.stroke();
    for (k = 0; k < 5; k++) {
      g.beginPath();
      g.ellipse(LX(k, baseY), ly, gemW0 * 0.40, gemH0 * 0.40, 0, 0, TAU);
      g.strokeStyle = laneHex(k, 'emissive');
      g.lineWidth = Math.max(1.2, gemH0 * 0.18);
      g.stroke();
    }

    var fg = g.createLinearGradient(0, 0, 0, H * 0.40);
    fg.addColorStop(0, 'rgba(9,7,20,1)');
    fg.addColorStop(1, 'rgba(9,7,20,0)');
    g.fillStyle = fg; g.fillRect(0, 0, W, H * 0.40);
    return true;
  }

  function refreshSongs() {
    songList = [];
    try {
      var S = GH.Songs;
      if (S && S.length) { for (var i = 0; i < S.length; i++) songList.push(S[i]); }
    } catch (e) { songList = []; }
    if (selectedSongIdx >= songList.length) selectedSongIdx = 0;
    return songList;
  }
  function currentSong() { return songList[selectedSongIdx] || null; }

  /* =========================================================================
     10. SELECAO DE MUSICA
     ========================================================================= */

  CSS.push([
    /* fundo: a propria capa, borrada e saturada, atras de tudo */
    '#gh-menus .ss-bg{position:absolute;inset:calc(var(--u)*-6);overflow:hidden}',
    '#gh-menus .ss-bg canvas{position:absolute;inset:0;width:100%;height:100%;',
    'filter:blur(calc(var(--u)*2.2)) saturate(1.6) brightness(.92);transform:scale(1.20);opacity:0}',
    '#gh-menus .ss-bg canvas.on{opacity:1}',
    '#gh-menus .scr-songselect .scrim{background:',
    'linear-gradient(105deg,rgba(4,3,12,.86) 0%,rgba(5,3,14,.62) 40%,rgba(4,3,12,.40) 66%,rgba(3,2,9,.80) 100%),',
    'radial-gradient(70% 60% at 22% 46%,rgba(0,0,0,.42),rgba(0,0,0,0) 72%),',
    'linear-gradient(180deg,rgba(3,2,9,.90) 0%,rgba(3,2,9,.18) 20%,rgba(3,2,9,.26) 72%,rgba(2,1,6,.94) 100%)}',

    '#gh-menus .pane{position:absolute;inset:0;display:flex;flex-direction:column;',
    'padding:calc(var(--u)*2.3) calc(var(--u)*3.0) calc(var(--u)*2.0);box-sizing:border-box}',

    /* cabecalho comum das telas internas */
    '#gh-menus .head{display:flex;align-items:flex-end;justify-content:space-between;',
    'gap:calc(var(--u)*2);flex:0 0 auto}',
    '#gh-menus .head h2{margin:calc(var(--u)*.30) 0 0;font-family:var(--f-display);font-weight:900;',
    'font-style:italic;text-transform:uppercase;font-size:calc(var(--u)*2.55);letter-spacing:.01em;',
    'line-height:1;background:linear-gradient(177deg,#fff8e6 4%,#ffd25e 42%,#ff7a2e 78%,#ff3d8a 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 calc(var(--u)*.14) 0 rgba(40,6,22,.9)) drop-shadow(0 calc(var(--u)*.4) calc(var(--u)*.8) rgba(0,0,0,.7))}',
    '#gh-menus .head .right{text-align:right;font-size:calc(var(--u)*.72);letter-spacing:.2em;',
    'text-transform:uppercase;font-weight:700;color:var(--ink-faint)}',
    '#gh-menus .head .right b{color:var(--ink);font-family:var(--f-num);font-size:calc(var(--u)*1.1)}',

    '#gh-menus .ss-body{flex:1 1 auto;display:flex;gap:calc(var(--u)*2.4);min-height:0;',
    'margin-top:calc(var(--u)*1.3)}',

    /* ------------------------------ HERO ---------------------------- */
    '#gh-menus .ss-hero{flex:0 0 calc(var(--u)*27);display:flex;flex-direction:column;',
    'min-height:0;overflow:hidden}',
    '#gh-menus .ss-art{position:relative;width:100%;height:calc(var(--u)*22);flex:0 0 auto;',
    'border-radius:calc(var(--u)*.55);overflow:hidden;align-self:flex-start;',
    'box-shadow:0 calc(var(--u)*1.6) calc(var(--u)*3.4) rgba(0,0,0,.75),',
    '0 0 0 1px rgba(255,255,255,.10),0 0 calc(var(--u)*3) rgba(255,120,60,.16)}',
    '#gh-menus .ss-art canvas{width:100%;height:100%;display:block}',
    /* brilho de verniz sobre a capa */
    '#gh-menus .ss-art::after{content:"";position:absolute;inset:0;pointer-events:none;',
    'background:linear-gradient(122deg,rgba(255,255,255,.20) 0%,rgba(255,255,255,.03) 28%,',
    'rgba(255,255,255,0) 52%,rgba(255,255,255,.07) 100%)}',
    '#gh-menus .ss-info{margin-top:calc(var(--u)*1.1);min-height:0}',
    '#gh-menus .ss-title{font-family:var(--f-display);font-weight:900;font-style:italic;',
    'font-size:calc(var(--u)*1.52);line-height:1.04;text-transform:uppercase;color:#fff;',
    'text-shadow:0 calc(var(--u)*.12) 0 rgba(0,0,0,.9),0 calc(var(--u)*.4) calc(var(--u)*1) rgba(0,0,0,.8)}',
    '#gh-menus .ss-sub{margin-top:calc(var(--u)*.35);font-size:calc(var(--u)*.82);color:var(--ink-dim);',
    'font-weight:600;letter-spacing:.02em}',
    '#gh-menus .ss-trib{margin-top:calc(var(--u)*.42);font-family:var(--f-serif);font-style:italic;',
    'font-size:calc(var(--u)*.92);color:var(--gold);opacity:.95;line-height:1.35}',
    '#gh-menus .chips{display:flex;flex-wrap:wrap;gap:calc(var(--u)*.45);margin-top:calc(var(--u)*.75)}',
    '#gh-menus .chip{display:flex;align-items:baseline;gap:calc(var(--u)*.3);',
    'padding:calc(var(--u)*.24) calc(var(--u)*.68);border-radius:calc(var(--u)*.28);',
    'background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.10);',
    'font-size:calc(var(--u)*.66);letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--ink-faint)}',
    '#gh-menus .chip b{font-family:var(--f-num);font-size:calc(var(--u)*.92);letter-spacing:0;color:var(--ink)}',

    /* tabela de dificuldade do hero */
    '#gh-menus .ss-diffs{margin-top:calc(var(--u)*.85);display:flex;flex-direction:column;gap:calc(var(--u)*.24)}',
    '#gh-menus .ss-diffs .row{display:flex;align-items:center;gap:calc(var(--u)*.55);',
    'font-size:calc(var(--u)*.70);letter-spacing:.12em;text-transform:uppercase;font-weight:700}',
    '#gh-menus .ss-diffs .nm{width:calc(var(--u)*5.4);color:var(--ink-dim)}',
    '#gh-menus .ss-diffs .nt{margin-left:auto;font-family:var(--f-num);letter-spacing:0;',
    'font-size:calc(var(--u)*.80);color:var(--ink-faint)}',
    '#gh-menus .pips{display:inline-flex;gap:calc(var(--u)*.14);align-items:center}',
    '#gh-menus .pips i{width:calc(var(--u)*.34);height:calc(var(--u)*.34);display:block;',
    'transform:rotate(45deg);background:rgba(255,255,255,.13);border-radius:1px}',
    '#gh-menus .pips i.on{background:linear-gradient(135deg,var(--gold),var(--sun));',
    'box-shadow:0 0 calc(var(--u)*.42) rgba(255,180,70,.75)}',
    '#gh-menus .pips.hot i.on{background:linear-gradient(135deg,#ff9a3c,#ff2e45);',
    'box-shadow:0 0 calc(var(--u)*.45) rgba(255,60,70,.85)}',
    '#gh-menus .pips.cool i.on{background:linear-gradient(135deg,#8fd8ff,#25e8ce);',
    'box-shadow:0 0 calc(var(--u)*.42) rgba(120,220,255,.7)}',

    /* ------------------------------ LISTA --------------------------- */
    '#gh-menus .ss-list{flex:1 1 auto;display:flex;flex-direction:column;gap:calc(var(--u)*.62);',
    'min-height:0;padding-right:calc(var(--u)*.4);align-content:flex-start}',
    '#gh-menus .ss-row{position:relative;display:flex;align-items:center;gap:calc(var(--u)*1.05);',
    'padding:calc(var(--u)*.70) calc(var(--u)*1.0);cursor:pointer;overflow:hidden;',
    'border-radius:calc(var(--u)*.45);border:1px solid rgba(255,255,255,.06);',
    'background:linear-gradient(100deg,rgba(18,16,34,.62),rgba(10,9,20,.42));',
    'transform-origin:left center;',
    'transition:transform .24s cubic-bezier(.2,1.3,.4,1),background .22s ease,border-color .22s ease,',
    'box-shadow .22s ease}',
    '#gh-menus .ss-row .tb{position:relative;width:calc(var(--u)*4.2);height:calc(var(--u)*4.2);',
    'flex:0 0 auto;border-radius:calc(var(--u)*.28);overflow:hidden;',
    'box-shadow:0 calc(var(--u)*.3) calc(var(--u)*.7) rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.10)}',
    '#gh-menus .ss-row .tb canvas{width:100%;height:100%;display:block}',
    '#gh-menus .ss-row .mid{flex:1 1 auto;min-width:0}',
    '#gh-menus .ss-row .nm{font-weight:800;font-size:calc(var(--u)*1.14);color:#dfe5f5;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.005em;',
    'text-shadow:0 1px 2px rgba(0,0,0,.8)}',
    '#gh-menus .ss-row .mt{margin-top:calc(var(--u)*.14);font-size:calc(var(--u)*.66);',
    'letter-spacing:.16em;text-transform:uppercase;font-weight:700;color:var(--ink-faint);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#gh-menus .ss-row .rt{flex:0 0 auto;text-align:right}',
    '#gh-menus .ss-row .dur{font-family:var(--f-num);font-size:calc(var(--u)*1.05);color:var(--ink-dim)}',
    '#gh-menus .ss-row .dc{flex:0 0 auto;text-align:right;margin-right:calc(var(--u)*.6)}',
    '#gh-menus .ss-row .dc .lb{font-size:calc(var(--u)*.58);letter-spacing:.18em;text-transform:uppercase;',
    'font-weight:800;color:var(--ink-faint);margin-bottom:calc(var(--u)*.2)}',
    '#gh-menus .ss-row .best{margin-top:calc(var(--u)*.12);font-size:calc(var(--u)*.60);',
    'letter-spacing:.14em;text-transform:uppercase;font-weight:800;color:var(--ink-faint)}',
    '#gh-menus .ss-row .best.has{color:var(--gold)}',
    /* barra de raia colorida na borda esquerda */
    '#gh-menus .ss-row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:calc(var(--u)*.20);',
    'background:linear-gradient(180deg,var(--gold),var(--mag));opacity:0;transition:opacity .2s ease}',
    '#gh-menus .ss-row.foc{background:linear-gradient(100deg,rgba(58,32,74,.86),rgba(20,12,32,.62));',
    'border-color:rgba(255,190,110,.42);transform:scale(1.035);',
    'box-shadow:0 calc(var(--u)*.7) calc(var(--u)*1.8) rgba(0,0,0,.65),',
    'inset 0 1px 0 rgba(255,255,255,.14),0 0 calc(var(--u)*2.2) rgba(255,120,60,.22)}',
    '#gh-menus .ss-row.foc::before{opacity:1}',
    '#gh-menus .ss-row.foc .nm{color:#fff}',
    '#gh-menus .ss-row.foc .mt{color:var(--gold)}',

    '#gh-menus .foot{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;',
    'gap:calc(var(--u)*2);margin-top:calc(var(--u)*1.0)}'
  ].join(''));

  function buildSongSelect() {
    var s = makeScreen('songselect');
    var el = s.el;

    var bg = add(el, mk('div', 'ss-bg'));
    var bgA = add(bg, document.createElement('canvas'));
    var bgB = add(bg, document.createElement('canvas'));
    bgA.width = bgB.width = 192; bgA.height = bgB.height = 108;
    var bgFlip = 0;

    add(el, mk('div', 'scrim'));

    var pane = add(el, mk('div', 'pane'));

    var head = add(pane, mk('div', 'head'));
    var headL = add(head, mk('div'));
    add(headL, mk('p', 'kick', 'Repertório'));
    add(headL, mk('h2', null, 'Escolha a música'));
    var headR = add(head, mk('div', 'right'));

    var body = add(pane, mk('div', 'ss-body'));

    /* ---- hero ---- */
    var hero = add(body, mk('div', 'ss-hero'));
    var art = add(hero, mk('div', 'ss-art'));
    var artCv = add(art, document.createElement('canvas'));
    artCv.width = COVER_SIZE; artCv.height = COVER_SIZE;
    var info = add(hero, mk('div', 'ss-info'));
    var hTitle = add(info, mk('div', 'ss-title'));
    var hSub = add(info, mk('div', 'ss-sub'));
    var hTrib = add(info, mk('div', 'ss-trib'));
    var hChips = add(info, mk('div', 'chips'));
    var hDiffs = add(info, mk('div', 'ss-diffs'));
    add(info, mk('div', 'frieze thin', '')).style.marginTop = 'calc(var(--u)*1.1)';

    /* ---- lista ---- */
    var list = add(body, mk('div', 'ss-list'));

    var foot = add(pane, mk('div', 'foot'));
    add(foot, mk('p', 'notice', esc(NOTICE_1) + ' ' + esc(NOTICE_2)));
    add(foot, mk('div', 'hints',
      '<span><b class="key">&uarr;</b><b class="key">&darr;</b> navegar</span>' +
      '<span><b class="key">Enter</b> escolher</span>' +
      '<span><b class="key">Esc</b> voltar</span>'));

    s.parts = { list: list, art: art, artCv: artCv, hTitle: hTitle, hSub: hSub, hTrib: hTrib,
                hChips: hChips, hDiffs: hDiffs, headR: headR, bgA: bgA, bgB: bgB, rows: [] };

    /* Reconstroi a lista quando o catalogo muda (so acontece uma vez). */
    s.rebuild = function () {
      refreshSongs();
      list.innerHTML = '';
      s.items.length = 0;
      s.parts.rows = [];
      var i;
      for (i = 0; i < songList.length; i++) {
        (function (song, idx) {
          var row = add(list, mk('div', 'ss-row'));
          var tb = add(row, mk('div', 'tb'));
          add(tb, coverThumb(song, 128));
          var mid = add(row, mk('div', 'mid'));
          add(mid, mk('div', 'nm', esc(song.title)));
          add(mid, mk('div', 'mt', esc(song.genre) + ' &middot; ' + Math.round(song.bpm) + ' BPM'));
          var dc = add(row, mk('div', 'dc'));
          add(dc, mk('div', 'lb', 'guitarrada'));
          add(dc, mk('div', null, pipsHTML(starsFor(song, 'guitarrada'), 10, 'hot')));
          var rt = add(row, mk('div', 'rt'));
          add(rt, mk('div', 'dur', fmtTime(song.durationSec)));
          var b = bestAny(song.id);
          var bestEl = add(rt, mk('div', 'best' + (b ? ' has' : ''),
            b ? (fmtInt(b.score) + ' pts') : 'nunca jogada'));
          s.parts.rows.push({ row: row, bestEl: bestEl, song: song });
          item(s, row, {
            onConfirm: function () {
              selectedSongIdx = idx;
              emitChoose('song', { action: 'song', songId: song.id, song: song });
            }
          });
        })(songList[i], i);
      }
      headR.innerHTML = '<b>' + songList.length + '</b> faixas originais';
    };

    /* Pinta o painel grande com a musica em foco. */
    function paintHero(song, animate) {
      if (!song) return;
      try {
        var g = artCv.getContext('2d');
        g.clearRect(0, 0, COVER_SIZE, COVER_SIZE);
        g.drawImage(coverOf(song), 0, 0);
      } catch (e) { /* ok */ }

      hTitle.textContent = song.title;
      hSub.textContent = song.artist + '  ·  ' + song.genre;
      hTrib.textContent = song.tribute || (song.cover && song.cover.subtitle) || '';

      hChips.innerHTML =
        '<span class="chip">bpm<b>' + Math.round(song.bpm) + '</b></span>' +
        '<span class="chip">duração<b>' + fmtTime(song.durationSec) + '</b></span>' +
        '<span class="chip">tom<b>' + esc(song.key || '—') + '</b></span>' +
        '<span class="chip">' + song.timeSig[0] + '/' + song.timeSig[1] + '<b>' + (song.year || 2026) + '</b></span>';

      var i, html = '';
      for (i = 0; i < DIFF_ORDER.length; i++) {
        var d = DIFF_ORDER[i];
        var st = statsFor(song, d);
        var cls = (d === 'guitarrada') ? 'hot' : (d === 'dificil' ? 'cool' : '');
        html += '<div class="row"><span class="nm">' + esc(diffLabel(d)) + '</span>' +
          pipsHTML(starsFor(song, d), 10, cls) +
          '<span class="nt">' + fmtInt(st.notes) + ' notas</span></div>';
      }
      var rec = bestAny(song.id);
      html += '<div class="row" style="margin-top:calc(var(--u)*.5)"><span class="nm">Recorde</span>' +
        '<span class="nt" style="margin-left:0;color:' + (rec ? 'var(--gold)' : 'var(--ink-faint)') + '">' +
        (rec ? (fmtInt(rec.score) + ' pts · ' + esc(diffLabel(rec.difficulty)) + ' · ' + fmtInt(rec.stars) + '★')
             : 'ainda sem recorde') + '</span></div>';
      hDiffs.innerHTML = html;

      /* fundo: a capa borrada troca com fade */
      try {
        var cv = bgFlip ? bgA : bgB;
        var other = bgFlip ? bgB : bgA;
        var gb = cv.getContext('2d');
        gb.clearRect(0, 0, cv.width, cv.height);
        gb.drawImage(coverOf(song), 0, COVER_SIZE * 0.16, COVER_SIZE, COVER_SIZE * 0.56,
          0, 0, cv.width, cv.height);
        cv.classList.add('on');
        other.classList.remove('on');
        bgFlip = bgFlip ? 0 : 1;
      } catch (e2) { /* ok */ }

      if (animate) {
        tween({
          dur: 0.42,
          apply: function (u) {
            var p = easeOutSoftBack(u);
            art.style.transform = 'scale(' + lerp(0.955, 1, p).toFixed(4) + ')';
            info.style.opacity = easeOutCubic(clamp01(u * 1.8)).toFixed(3);
            info.style.transform = 'translate3d(0,' + ((1 - p) * 9).toFixed(2) + 'px,0)';
          },
          done: function () { art.style.transform = ''; info.style.opacity = ''; info.style.transform = ''; }
        });
      }
    }

    s.onFocus = function (it, i) {
      selectedSongIdx = i;
      var song = songList[i];
      paintHero(song, true);
      /* o tema cromatico do palco acompanha a musica em foco */
      if (song && song.palette) call('Palette', 'setTheme', song.palette);
    };

    s.onEnter = function () {
      if (!s.parts.rows.length || s.parts.rows.length !== (GH.Songs ? GH.Songs.length : 0)) s.rebuild();
      /* atualiza recordes (podem ter mudado desde a ultima visita) */
      bestCache = null;
      for (var r = 0; r < s.parts.rows.length; r++) {
        var b = bestAny(s.parts.rows[r].song.id);
        s.parts.rows[r].bestEl.className = 'best' + (b ? ' has' : '');
        s.parts.rows[r].bestEl.textContent = b ? (fmtInt(b.score) + ' pts') : 'nunca jogada';
      }
      var idx = clamp(selectedSongIdx, 0, Math.max(0, s.items.length - 1));
      setFocus(s, idx, false);
      paintHero(songList[idx], false);
      revealList([head], { delay: 0.02, dur: 0.5, dy: -14 });
      revealList([art], { delay: 0.10, dur: 0.6, dy: 24, scale: 0.92 });
      revealList([info], { delay: 0.20, dur: 0.55, dy: 18 });
      var rows = [];
      for (var i = 0; i < s.parts.rows.length; i++) rows.push(s.parts.rows[i].row);
      revealList(rows, { delay: 0.16, step: 0.055, dur: 0.48, dy: 14, dx: 26 });
      revealList([foot], { delay: 0.42, dur: 0.5, dy: 12 });
    };
    s.onBack = function () { emitChoose('title'); };
    s.built = true;
    return s;
  }

  /* =========================================================================
     11. SELECAO DE DIFICULDADE
     ========================================================================= */

  CSS.push([
    '#gh-menus .scr-difficulty .scrim{background:',
    'radial-gradient(90% 70% at 50% 40%,rgba(6,4,16,.55),rgba(4,3,10,.92) 78%),',
    'linear-gradient(180deg,rgba(3,2,9,.94) 0%,rgba(3,2,9,.35) 22%,rgba(3,2,9,.45) 70%,rgba(2,1,6,.97) 100%)}',

    '#gh-menus .dc-row{flex:1 1 auto;display:flex;gap:calc(var(--u)*1.15);align-items:stretch;',
    'margin-top:calc(var(--u)*1.9);min-height:0}',

    '#gh-menus .dcard{position:relative;flex:1 1 0;display:flex;flex-direction:column;',
    'padding:calc(var(--u)*1.25) calc(var(--u)*1.15) calc(var(--u)*1.05);cursor:pointer;overflow:hidden;',
    'border-radius:calc(var(--u)*.62);border:1px solid rgba(255,255,255,.085);',
    'background:linear-gradient(168deg,rgba(24,20,44,.86),rgba(9,8,19,.92));',
    'box-shadow:0 calc(var(--u)*1.0) calc(var(--u)*2.2) rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.07);',
    'transform-origin:50% 100%;',
    'transition:transform .26s cubic-bezier(.2,1.35,.4,1),border-color .22s ease,box-shadow .24s ease}',
    /* faixa de cor no topo do cartao */
    '#gh-menus .dcard::before{content:"";position:absolute;left:0;right:0;top:0;height:calc(var(--u)*.22);',
    'background:var(--cardc,#888);opacity:.85}',
    /* luz interna que so acende no foco */
    '#gh-menus .dcard::after{content:"";position:absolute;inset:0;pointer-events:none;opacity:0;',
    'background:radial-gradient(120% 80% at 50% 0%,var(--cardglow,rgba(255,255,255,.18)),transparent 62%);',
    'transition:opacity .26s ease}',
    '#gh-menus .dcard.foc{transform:scale(1.035);',
    'border-color:var(--cardc,#fff);',
    'box-shadow:0 calc(var(--u)*1.8) calc(var(--u)*3.6) rgba(0,0,0,.72),',
    'inset 0 1px 0 rgba(255,255,255,.16),0 0 calc(var(--u)*2.6) var(--cardglow,rgba(255,255,255,.3))}',
    '#gh-menus .dcard.foc::after{opacity:1}',

    '#gh-menus .dcard .tag{align-self:flex-start;font-family:var(--f-num);font-weight:800;',
    'font-size:calc(var(--u)*.68);letter-spacing:.24em;text-transform:uppercase;',
    'padding:calc(var(--u)*.20) calc(var(--u)*.58);border-radius:calc(var(--u)*.24);',
    'color:#0a0710;background:var(--cardc,#888)}',
    '#gh-menus .dcard .dnm{margin-top:calc(var(--u)*.70);font-family:var(--f-display);font-weight:900;',
    'font-style:italic;text-transform:uppercase;font-size:calc(var(--u)*1.92);line-height:.98;color:#fff;',
    'letter-spacing:.005em;text-shadow:0 calc(var(--u)*.12) 0 rgba(0,0,0,.85),0 calc(var(--u)*.4) calc(var(--u)*.9) rgba(0,0,0,.7)}',
    '#gh-menus .dcard .dpips{margin-top:calc(var(--u)*.55)}',
    '#gh-menus .dcard .ddesc{margin-top:calc(var(--u)*.75);font-size:calc(var(--u)*.83);line-height:1.5;',
    'color:var(--ink-dim);flex:0 0 auto;min-height:calc(var(--u)*3.6)}',
    /* previa da pista: um pedaco real do chart daquela dificuldade */
    '#gh-menus .dcard .prevwrap{position:relative;flex:1 1 auto;min-height:calc(var(--u)*6);',
    'margin-top:calc(var(--u)*.7);border-radius:calc(var(--u)*.3);overflow:hidden;',
    'box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}',
    '#gh-menus .dcard .prevwrap canvas{position:absolute;inset:0;width:100%;height:100%}',
    '#gh-menus .dcard .prevwrap .cap{position:absolute;left:calc(var(--u)*.4);top:calc(var(--u)*.3);',
    'font-size:calc(var(--u)*.56);letter-spacing:.18em;text-transform:uppercase;font-weight:800;',
    'color:rgba(190,200,225,.55)}',
    '#gh-menus .dcard .dstats{margin-top:calc(var(--u)*.75);display:flex;flex-direction:column;',
    'gap:calc(var(--u)*.22);border-top:1px solid rgba(255,255,255,.09);padding-top:calc(var(--u)*.65)}',
    '#gh-menus .dcard .dstats .r{display:flex;justify-content:space-between;align-items:baseline;',
    'font-size:calc(var(--u)*.68);letter-spacing:.14em;text-transform:uppercase;font-weight:700;',
    'color:var(--ink-faint)}',
    '#gh-menus .dcard .dstats .r b{font-family:var(--f-num);letter-spacing:0;font-size:calc(var(--u)*.92);',
    'color:var(--ink)}',
    '#gh-menus .dcard .feats{display:flex;flex-wrap:wrap;gap:calc(var(--u)*.28);margin-top:calc(var(--u)*.62)}',
    '#gh-menus .dcard .feat{font-size:calc(var(--u)*.60);letter-spacing:.16em;text-transform:uppercase;',
    'font-weight:800;padding:calc(var(--u)*.16) calc(var(--u)*.48);border-radius:calc(var(--u)*.22);',
    'background:rgba(255,255,255,.07);color:var(--ink-dim);border:1px solid rgba(255,255,255,.08)}',
    '#gh-menus .dcard .feat.on{background:var(--cardc,#888);color:#0a0710;border-color:transparent}',

    /* o cartao GUITARRADA: preto, fogo e aviso */
    '#gh-menus .dcard.expert{background:linear-gradient(168deg,rgba(28,6,10,.94),rgba(8,3,6,.97));',
    'border-color:rgba(255,90,60,.30)}',
    /* O gradiente antigo entregava a metade de baixo das letras em #ff3550
       sobre um cartao quase preto: "GUITARRADA" — o nome da dificuldade
       maxima e do proprio jogo — era o texto MENOS legivel da tela. Agora o
       vermelho so aparece no ultimo quinto do glifo. */
    '#gh-menus .dcard.expert .dnm{background:linear-gradient(178deg,#fffaf0 0%,#ffeab4 40%,#ffc258 76%,#ff8f4a 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 calc(var(--u)*.12) 0 rgba(50,4,6,.95)) drop-shadow(0 0 calc(var(--u)*1.4) rgba(255,90,30,.55))}',
    /* labaredas na base do cartao */
    '#gh-menus .dcard.expert .fire{position:absolute;left:0;right:0;bottom:0;height:calc(var(--u)*5.5);',
    'pointer-events:none;opacity:.72;',
    'background:radial-gradient(60% 100% at 20% 100%,rgba(255,120,20,.55),transparent 70%),',
    'radial-gradient(50% 100% at 52% 100%,rgba(255,60,30,.55),transparent 70%),',
    'radial-gradient(56% 100% at 84% 100%,rgba(255,180,40,.42),transparent 70%);',
    'filter:blur(calc(var(--u)*.25));mix-blend-mode:screen}',
    /* altura reservada em TODOS os cartoes (ver comentario no buildDifficulty) */
    '#gh-menus .dcard .warnslot{margin-top:calc(var(--u)*.55);min-height:calc(var(--u)*.95)}',
    '#gh-menus .dcard.expert .warn{display:flex;align-items:center;',
    'gap:calc(var(--u)*.4);font-size:calc(var(--u)*.64);letter-spacing:.16em;text-transform:uppercase;',
    'font-weight:800;color:#ff8a5c}',
    '#gh-menus .dcard.expert .warn i{width:0;height:0;border-left:calc(var(--u)*.34) solid transparent;',
    'border-right:calc(var(--u)*.34) solid transparent;border-bottom:calc(var(--u)*.58) solid #ff8a5c;display:block}',

    /* cabecalho da tela de dificuldade com a capa pequena */
    '#gh-menus .dhead{display:flex;align-items:center;gap:calc(var(--u)*1.1)}',
    '#gh-menus .dhead .mini{width:calc(var(--u)*4.2);height:calc(var(--u)*4.2);border-radius:calc(var(--u)*.38);',
    'overflow:hidden;box-shadow:0 calc(var(--u)*.5) calc(var(--u)*1.2) rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.12)}',
    '#gh-menus .dhead .mini canvas{width:100%;height:100%;display:block}'
  ].join(''));

  function buildDifficulty() {
    var s = makeScreen('difficulty');
    s.axis = 'x';
    var el = s.el;
    add(el, mk('div', 'scrim'));
    var pane = add(el, mk('div', 'pane'));

    var head = add(pane, mk('div', 'head'));
    var headL = add(head, mk('div', 'dhead'));
    var mini = add(headL, mk('div', 'mini'));
    var miniCv = add(mini, document.createElement('canvas'));
    miniCv.width = 256; miniCv.height = 256;
    var headTxt = add(headL, mk('div'));
    add(headTxt, mk('p', 'kick', 'Dificuldade'));
    var hTitle = add(headTxt, mk('h2', null, 'Como você vai encarar?'));
    var headR = add(head, mk('div', 'right'));

    var row = add(pane, mk('div', 'dc-row'));

    var cards = [];
    var i;
    for (i = 0; i < DIFF_ORDER.length; i++) {
      (function (key, idx) {
        var inf = DIFF_INFO[key];
        var card = add(row, mk('div', 'dcard' + (key === 'guitarrada' ? ' expert' : '')));
        var c = GH.Palette && GH.Palette.lanes ? null : null;
        card.style.setProperty('--cardc', hsl(inf.hue, 88, 58));
        card.style.setProperty('--cardglow', hsl(inf.hue, 92, 55, 0.30));
        if (key === 'guitarrada') add(card, mk('div', 'fire'));
        add(card, mk('span', 'tag', esc(inf.tag)));
        add(card, mk('div', 'dnm', esc(inf.label)));
        var pip = add(card, mk('div', 'dpips'));
        add(card, mk('p', 'ddesc', esc(inf.desc)));
        var pw = add(card, mk('div', 'prevwrap'));
        var pcv = add(pw, document.createElement('canvas'));
        add(pw, mk('span', 'cap', 'trecho real do chart'));
        var feats = add(card, mk('div', 'feats'));
        var st = add(card, mk('div', 'dstats'));
        /* O aviso do EXPERT existe so num dos quatro cartoes. Como .prevwrap e
           flex:1, ele roubava altura da previa e desalinhava a grade inteira:
           no print, "trecho real do chart", os selos e as estatisticas do
           cartao GUITARRADA ficavam ~23 px acima dos irmaos. O slot vazio nos
           outros tres devolve as quatro colunas a mesma linha de base. */
        var wslot = add(card, mk('div', 'warnslot'));
        if (key === 'guitarrada') {
          add(wslot, mk('div', 'warn', '<i></i>Só encara quem tem calo no dedo'));
        }
        cards.push({ key: key, el: card, pip: pip, feats: feats, st: st, cv: pcv });
        item(s, card, {
          onConfirm: function () {
            selectedDifficulty = key;
            emitChoose('difficulty', { action: 'difficulty', difficulty: key, songId: (currentSong() || {}).id });
          }
        });
      })(DIFF_ORDER[i], i);
    }

    var foot = add(pane, mk('div', 'foot'));
    add(foot, mk('p', 'notice', 'A dificuldade muda o chart inteiro: número de raias, acordes, HOPOs, taps e sustains.'));
    add(foot, mk('div', 'hints',
      '<span><b class="key">&larr;</b><b class="key">&rarr;</b> escolher</span>' +
      '<span><b class="key">Enter</b> tocar</span>' +
      '<span><b class="key">Esc</b> voltar</span>'));

    s.parts = { cards: cards, hTitle: hTitle, headR: headR, miniCv: miniCv, head: head, row: row, foot: foot };

    s.fill = function (song) {
      if (!song) song = currentSong();
      if (!song) return;
      try {
        var g = miniCv.getContext('2d');
        g.clearRect(0, 0, 256, 256);
        g.drawImage(coverOf(song), 0, 0, 256, 256);
      } catch (e) { /* ok */ }
      hTitle.textContent = song.title;
      headR.innerHTML = esc(song.genre) + ' &middot; <b>' + Math.round(song.bpm) + '</b> bpm &middot; <b>' +
        fmtTime(song.durationSec) + '</b>';

      for (var k = 0; k < cards.length; k++) {
        var c = cards[k];
        var stt = statsFor(song, c.key);
        var rec = bestOf(song.id, c.key);
        c.pip.innerHTML = pipsHTML(starsFor(song, c.key), 10,
          c.key === 'guitarrada' ? 'hot' : (c.key === 'dificil' ? 'cool' : ''));
        c.feats.innerHTML =
          '<span class="feat' + (stt.chords > 0 ? ' on' : '') + '">acordes</span>' +
          '<span class="feat' + (stt.hopos > 0 ? ' on' : '') + '">hopo</span>' +
          '<span class="feat' + (stt.taps > 0 ? ' on' : '') + '">tap</span>' +
          '<span class="feat' + (stt.opens > 0 ? ' on' : '') + '">abertas</span>';
        c.st.innerHTML =
          '<div class="r"><span>notas</span><b>' + fmtInt(stt.notes) + '</b></div>' +
          '<div class="r"><span>densidade</span><b>' + (stt.nps || 0).toFixed(1).replace('.', ',') + ' n/s</b></div>' +
          '<div class="r"><span>pico</span><b>' + (stt.peakNps || 0).toFixed(1).replace('.', ',') + ' n/s</b></div>' +
          '<div class="r"><span>sustains</span><b>' + fmtInt(stt.sustains) + '</b></div>' +
          '<div class="r"><span>recorde</span><b style="color:' + (rec ? 'var(--gold)' : 'var(--ink-faint)') + '">' +
          (rec ? fmtInt(rec.score) : '—') + '</b></div>';
      }
      /* previas: precisam do layout pronto; se o cartao ainda nao tem tamanho,
         a tarefa entra na fila e o update() tenta de novo no proximo quadro */
      s._prevJob = function () {
        var okAll = true;
        for (var q = 0; q < cards.length; q++) {
          if (!drawChartPreview(cards[q].cv, song, cards[q].key)) okAll = false;
        }
        return okAll;
      };
      if (!s._prevJob()) pendingLayout.push(s._prevJob);
    };

    s.onEnter = function (song) {
      bestCache = null;
      var sg = song || currentSong();
      if (sg) {
        for (var q = 0; q < songList.length; q++) if (songList[q] === sg || songList[q].id === sg.id) selectedSongIdx = q;
      }
      s.fill(sg);
      var want = DIFF_ORDER.indexOf(selectedDifficulty);
      if (want < 0) want = 1;
      setFocus(s, want, false);
      revealList([head], { delay: 0.02, dur: 0.5, dy: -14 });
      var els = [];
      for (var i = 0; i < cards.length; i++) els.push(cards[i].el);
      revealList(els, { delay: 0.10, step: 0.07, dur: 0.55, dy: 30, scale: 0.94 });
      revealList([foot], { delay: 0.38, dur: 0.5, dy: 12 });
    };
    s.onFocus = function (it, i) { selectedDifficulty = DIFF_ORDER[i] || 'medio'; };
    s.onBack = function () { emitChoose('songselect'); };
    s.built = true;
    return s;
  }

  /* =========================================================================
     12. GRAFICOS DO RESULTADO (canvas 2D)
     Dados REAIS: GH.Chart.groups + GH.Scoring.groupResult/groupDelta dao a
     historia nota a nota; stats.histogram da a distribuicao de desvio.
     ========================================================================= */

  /* Prepara o canvas para desenho nitido (respeita devicePixelRatio). */
  function sizeCanvas(cv) {
    var w = cv.clientWidth || 0, h = cv.clientHeight || 0;
    if (w < 4 || h < 4) return null;
    var dpr = Math.min(2, (window.devicePixelRatio || 1));
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g: g, w: w, h: h };
  }

  /* Reconstroi a corrida a partir do chart julgado. */
  function runSeries() {
    var out = { pts: [], misses: [], mult: [], phrases: [], sections: [], dur: 0, truncated: false };
    var C = GH.Chart, S = GH.Scoring;
    if (!C || !C.groups || !C.groups.length) return out;
    var g = C.groups;
    out.dur = (C.stats && C.stats.durationSec) ? C.stats.durationSec : (g[g.length - 1].t + 2);
    var streak = 0, i, r, t;
    for (i = 0; i < g.length; i++) {
      t = g[i].t;
      r = (S && typeof S.groupResult === 'function') ? S.groupResult(i) : 'none';
      if (r === 'none') { out.truncated = true; break; }
      if (r === 'miss') { streak = 0; out.misses.push(t); }
      else {
        streak++;
        out.pts.push({ t: t, ms: (typeof S.groupDelta === 'function') ? S.groupDelta(i) : 0, perfect: r === 'perfect' });
      }
      out.mult.push({ t: t, m: Math.min(4, 1 + Math.floor(streak / 10)) });
    }
    try {
      var ph = C.starPowerPhrases || [];
      for (i = 0; i < ph.length; i++) out.phrases.push({ a: ph[i].tStart, b: ph[i].tEnd });
    } catch (e) { /* ok */ }
    try {
      var sec = (C.song && C.song.sections) || [];
      for (i = 0; i < sec.length; i++) out.sections.push({ t: sec[i].t, name: sec[i].name });
    } catch (e2) { /* ok */ }
    return out;
  }

  /* indexado pelo VALOR do multiplicador (1..4) — nada de magenta aqui:
     magenta e a cor de erro do jogo e confundia a leitura do grafico */
  var MULT_COLORS = ['#5a6485', '#5a6485', '#39e08a', '#ffdc3a', '#ff8a2b'];

  function drawRunGraph(cv, data, winMs) {
    var S = sizeCanvas(cv);
    if (!S) return false;
    var g = S.g, W = S.w, H = S.h;
    var padL = 40, padR = 12, padT = 18, padB = 26;
    var pw = W - padL - padR, phh = H - padT - padB;
    if (pw < 10 || phh < 10) return false;
    var dur = Math.max(1, data.dur);
    var win = winMs || 70;
    var multH = phh * 0.24;
    var lineH = phh - multH;
    var midY = padT + lineH * 0.5;

    function X(t) { return padL + (clamp01(t / dur)) * pw; }
    function Y(ms) { return midY - clamp(ms / win, -1.25, 1.25) * (lineH * 0.44); }

    /* fundo do painel */
    var bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, 'rgba(16,14,32,.62)');
    bg.addColorStop(1, 'rgba(7,6,16,.72)');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);

    /* faixas de Star Power */
    var i;
    for (i = 0; i < data.phrases.length; i++) {
      var a = X(data.phrases[i].a), b = X(data.phrases[i].b);
      g.fillStyle = 'rgba(143,216,255,.030)';
      g.fillRect(a, padT, Math.max(1.5, b - a), phh);
      g.fillStyle = 'rgba(143,216,255,.55)';
      g.fillRect(a, padT - 4, Math.max(1.5, b - a), 2.5);
    }

    /* grade vertical a cada 30 s + secoes */
    g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1;
    for (var t = 0; t <= dur; t += 30) {
      var x = Math.round(X(t)) + 0.5;
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + phh); g.stroke();
    }
    g.font = '600 9px "Segoe UI",sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'top';
    for (i = 0; i < data.sections.length; i++) {
      var sx = X(data.sections[i].t);
      g.strokeStyle = 'rgba(255,255,255,.12)';
      g.beginPath(); g.moveTo(Math.round(sx) + 0.5, padT); g.lineTo(Math.round(sx) + 0.5, padT + 7); g.stroke();
      if (pw / Math.max(1, data.sections.length) > 46) {
        g.fillStyle = 'rgba(160,172,205,.72)';
        g.fillText(data.sections[i].name, sx + 3, padT - 13);
      }
    }

    /* janela perfeita e janela boa */
    g.fillStyle = 'rgba(255,228,92,.07)';
    var perfY = Y(25) , perfY2 = Y(-25);
    g.fillRect(padL, perfY2, pw, perfY - perfY2);
    g.strokeStyle = 'rgba(255,255,255,.10)'; g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(padL, Y(win)); g.lineTo(padL + pw, Y(win));
    g.moveTo(padL, Y(-win)); g.lineTo(padL + pw, Y(-win)); g.stroke();
    g.setLineDash([]);
    /* linha do zero */
    g.strokeStyle = 'rgba(255,255,255,.34)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, Math.round(midY) + 0.5); g.lineTo(padL + pw, Math.round(midY) + 0.5); g.stroke();

    /* --- area do multiplicador (base do grafico) --- */
    var multY0 = padT + lineH, multY1 = padT + phh;
    var prevX = padL, prevM = 1;
    for (i = 0; i < data.mult.length; i++) {
      var mx = X(data.mult[i].t);
      var hgt = (prevM / 4) * (multY1 - multY0);
      g.fillStyle = MULT_COLORS[Math.min(4, prevM)];
      g.globalAlpha = 0.34;
      g.fillRect(prevX, multY1 - hgt, Math.max(0.6, mx - prevX), hgt);
      g.globalAlpha = 1;
      prevX = mx; prevM = data.mult[i].m;
    }
    if (prevX < padL + pw) {
      var hg2 = (prevM / 4) * (multY1 - multY0);
      g.fillStyle = MULT_COLORS[Math.min(4, prevM)];
      g.globalAlpha = 0.34;
      g.fillRect(prevX, multY1 - hg2, padL + pw - prevX, hg2);
      g.globalAlpha = 1;
    }
    g.strokeStyle = 'rgba(255,255,255,.16)';
    g.beginPath(); g.moveTo(padL, Math.round(multY0) + 0.5); g.lineTo(padL + pw, Math.round(multY0) + 0.5); g.stroke();
    /* escala do multiplicador na canhota: sem isso a faixa vira so cor */
    g.font = '700 9px "Segoe UI",sans-serif';
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (var mm = 1; mm <= 4; mm++) {
      var my = multY1 - (mm / 4) * (multY1 - multY0);
      g.fillStyle = 'rgba(150,162,196,' + (mm === 4 ? '.85' : '.45') + ')';
      g.fillText(mm + 'x', padL - 6, my + 4);
      if (mm < 4) {
        g.strokeStyle = 'rgba(255,255,255,.07)';
        g.beginPath(); g.moveTo(padL, Math.round(my) + 0.5); g.lineTo(padL + pw, Math.round(my) + 0.5); g.stroke();
      }
    }

    /* --- desvio nota a nota --- */
    if (data.pts.length > 1) {
      /* nuvem crua, bem fina */
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(143,216,255,.30)';
      g.beginPath();
      for (i = 0; i < data.pts.length; i++) {
        var px = X(data.pts[i].t), py = Y(data.pts[i].ms);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();

      /* media movel — a leitura que interessa */
      var win2 = Math.max(3, Math.round(data.pts.length / 60));
      var sum = 0, q = [];
      g.lineWidth = 2.2; g.lineJoin = 'round'; g.lineCap = 'round';
      var grad = g.createLinearGradient(padL, padT, padL, padT + lineH);
      grad.addColorStop(0, '#5ce0d8');
      grad.addColorStop(0.5, '#ffe45c');
      grad.addColorStop(1, '#c98cff');
      g.strokeStyle = grad;
      g.shadowColor = 'rgba(255,220,120,.45)'; g.shadowBlur = 6;
      g.beginPath();
      for (i = 0; i < data.pts.length; i++) {
        q.push(data.pts[i].ms); sum += data.pts[i].ms;
        if (q.length > win2) sum -= q.shift();
        var ay = Y(sum / q.length), ax = X(data.pts[i].t);
        if (i === 0) g.moveTo(ax, ay); else g.lineTo(ax, ay);
      }
      g.stroke();
      g.shadowBlur = 0;
    }

    /* --- erros --- */
    g.strokeStyle = 'rgba(255,74,90,.92)'; g.lineWidth = 1.6;
    for (i = 0; i < data.misses.length; i++) {
      var ex = Math.round(X(data.misses[i])) + 0.5;
      g.beginPath(); g.moveTo(ex, padT + 2); g.lineTo(ex, padT + lineH - 2); g.stroke();
    }
    if (data.misses.length) {
      g.fillStyle = 'rgba(255,74,90,.95)';
      for (i = 0; i < data.misses.length; i++) {
        g.fillRect(X(data.misses[i]) - 1.5, padT + lineH - 5, 3, 5);
      }
    }

    /* --- eixos --- */
    g.font = '700 9px "Segoe UI",sans-serif';
    g.fillStyle = 'rgba(150,162,196,.85)';
    g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText('+' + win, padL - 6, Y(win));
    g.fillText('0', padL - 6, midY);
    g.fillText('-' + win, padL - 6, Y(-win));
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillStyle = 'rgba(201,140,255,.85)';
    g.fillText('ATRASADO', padL + 34, Y(win) - 11);
    g.fillStyle = 'rgba(92,224,216,.85)';
    g.textBaseline = 'bottom';
    g.fillText('ADIANTADO', padL + 34, Y(-win) + 12);
    g.textAlign = 'right'; g.textBaseline = 'top';
    g.fillStyle = 'rgba(150,162,196,.7)';
    g.fillText(fmtTime(dur), padL + pw, padT + phh + 5);
    g.textAlign = 'left';
    g.fillText('0:00', padL, padT + phh + 5);
    g.textAlign = 'center';
    g.fillStyle = 'rgba(150,162,196,.55)';
    g.fillText('MULTIPLICADOR', padL + pw * 0.5, padT + phh + 5);
    return true;
  }

  function drawHistogram(cv, hist, avgMs, perfMs) {
    var S = sizeCanvas(cv);
    if (!S) return false;
    var g = S.g, W = S.w, H = S.h;
    var padL = 12, padR = 12, padT = 14, padB = 22;
    var pw = W - padL - padR, phh = H - padT - padB;
    if (pw < 10 || phh < 10 || !hist || !hist.counts) return false;

    var counts = hist.counts, nAll = counts.length, i;
    var binMs = hist.binMs || 5;
    var centerAll = (nAll - 1) / 2;
    /* Recorta simetricamente para a faixa que realmente tem dados: com um
       jogador preciso, 90% das barras ficariam espremidas no meio de um eixo
       de +-100 ms e o grafico pareceria vazio. */
    var span = 4;
    for (i = 0; i < nAll; i++) {
      if (counts[i] > 0) { var d0 = Math.abs(i - centerAll); if (d0 > span) span = d0; }
    }
    span = Math.min(centerAll, Math.ceil(span * 1.15));
    var i0 = Math.round(centerAll - span), i1 = Math.round(centerAll + span);
    var n = i1 - i0 + 1;
    var maxC = 1;
    for (i = i0; i <= i1; i++) if (counts[i] > maxC) maxC = counts[i];
    var bw = pw / n;
    var center = centerAll - i0;

    var bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, 'rgba(16,14,32,.62)');
    bg.addColorStop(1, 'rgba(7,6,16,.72)');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);

    /* faixa da janela perfeita */
    var pf = (perfMs || 25) / binMs;
    g.fillStyle = 'rgba(255,228,92,.055)';
    g.fillRect(padL + (center - pf + 0.5) * bw, padT, pf * 2 * bw, phh);

    for (i = 0; i < n; i++) {
      var c = counts[i0 + i];
      if (!c) continue;
      var h = Math.max(1.5, (c / maxC) * phh);
      var x = padL + i * bw;
      var d = Math.abs(i - center) * binMs;
      var gr = g.createLinearGradient(0, padT + phh - h, 0, padT + phh);
      gr.addColorStop(0, (d <= (perfMs || 25)) ? '#fff3b0' : (i < center ? '#a8f2ea' : '#dcc0ff'));
      gr.addColorStop(1, (d <= (perfMs || 25)) ? '#ff9a2b' : (i < center ? '#1fa9a2' : '#8a5ad6'));
      g.fillStyle = gr;
      g.fillRect(x + bw * 0.10, padT + phh - h, bw * 0.80, h);
    }

    /* linha do zero */
    var zx = Math.round(padL + (center + 0.5) * bw) + 0.5;
    g.strokeStyle = 'rgba(255,255,255,.42)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(zx, padT - 4); g.lineTo(zx, padT + phh + 2); g.stroke();

    /* media */
    var ax = padL + (center + 0.5 + (avgMs || 0) / binMs) * bw;
    if (ax > padL && ax < padL + pw) {
      g.strokeStyle = '#ff3d8a'; g.lineWidth = 1.6; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(ax, padT - 4); g.lineTo(ax, padT + phh + 2); g.stroke();
      g.setLineDash([]);
    }

    g.font = '700 9px "Segoe UI",sans-serif';
    g.textBaseline = 'top';
    g.fillStyle = 'rgba(92,224,216,.9)'; g.textAlign = 'left';
    g.fillText('ADIANTADO  -' + Math.round(span * binMs) + 'ms', padL, padT + phh + 5);
    g.fillStyle = 'rgba(201,140,255,.9)'; g.textAlign = 'right';
    g.fillText('+' + Math.round(span * binMs) + 'ms  ATRASADO', padL + pw, padT + phh + 5);
    g.fillStyle = 'rgba(255,255,255,.55)'; g.textAlign = 'center';
    g.fillText('0', zx, padT + phh + 5);
    return true;
  }

  /* =========================================================================
     13. TELA DE RESULTADOS — o momento de recompensa
     ========================================================================= */

  CSS.push([
    '#gh-menus .scr-results .scrim{background:',
    'radial-gradient(85% 62% at 50% 26%,rgba(60,22,10,.42),rgba(4,3,10,.90) 72%),',
    'linear-gradient(180deg,rgba(3,2,9,.92) 0%,rgba(3,2,9,.55) 20%,rgba(3,2,9,.66) 72%,rgba(2,1,6,.97) 100%)}',

    '#gh-menus .rs-top{flex:0 0 auto;display:flex;align-items:flex-end;justify-content:space-between;gap:calc(var(--u)*2)}',
    '#gh-menus .rs-top .mini{width:calc(var(--u)*3.6);height:calc(var(--u)*3.6);border-radius:calc(var(--u)*.34);',
    'overflow:hidden;box-shadow:0 calc(var(--u)*.5) calc(var(--u)*1.2) rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.12)}',
    '#gh-menus .rs-top .mini canvas{width:100%;height:100%;display:block}',
    '#gh-menus .rs-top .l{display:flex;align-items:center;gap:calc(var(--u)*.9)}',
    '#gh-menus .rs-badge{display:inline-block;font-family:var(--f-num);font-weight:800;',
    'font-size:calc(var(--u)*.72);letter-spacing:.2em;text-transform:uppercase;color:#0a0710;',
    'padding:calc(var(--u)*.2) calc(var(--u)*.6);border-radius:calc(var(--u)*.24);',
    'background:linear-gradient(135deg,var(--gold),var(--sun))}',

    /* ------------------------- ESTRELAS ---------------------------- */
    '#gh-menus .rs-stars{flex:0 0 auto;display:flex;align-items:center;justify-content:center;',
    'gap:calc(var(--u)*1.05);margin:calc(var(--u)*.85) 0 0;height:calc(var(--u)*7.1)}',
    '#gh-menus .stw{position:relative;width:calc(var(--u)*6.5);height:calc(var(--u)*6.5);',
    'display:flex;align-items:center;justify-content:center}',
    '#gh-menus .stw.gold{width:calc(var(--u)*7.8);height:calc(var(--u)*7.8)}',
    '#gh-menus .stw .base{position:absolute;inset:12%;background:rgba(255,255,255,.07);',
    'box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}',
    '#gh-menus .stw .fill{position:absolute;inset:8%;opacity:0;',
    'background:linear-gradient(168deg,#fff6d0 0%,#ffd75c 34%,#ff9a1e 68%,#ff5a2e 100%)}',
    '#gh-menus .stw.gold .fill{inset:5%;',
    'background:linear-gradient(168deg,#ffffff 0%,#fffbe0 14%,#ffe066 38%,#ffab1e 64%,#ff5a2e 84%,#ff2f7d 100%)}',
    /* nucleo branco: e o que separa a estrela de ouro das outras cinco */
    '#gh-menus .stw .core{position:absolute;inset:34%;opacity:0;pointer-events:none;',
    'background:linear-gradient(180deg,#ffffff,#fff3b8)}',
    '#gh-menus .stw.gold .core{inset:30%}',
    /* raios girando atras da estrela de ouro */
    '#gh-menus .stw .rays{position:absolute;inset:-34%;opacity:0;pointer-events:none;border-radius:50%;',
    'background:conic-gradient(from 0deg,rgba(255,214,120,.55) 0deg,rgba(255,214,120,0) 12deg,',
    'rgba(255,214,120,0) 33deg,rgba(255,214,120,.55) 45deg,rgba(255,214,120,0) 57deg,',
    'rgba(255,214,120,0) 78deg,rgba(255,214,120,.55) 90deg,rgba(255,214,120,0) 102deg,',
    'rgba(255,214,120,0) 123deg,rgba(255,214,120,.55) 135deg,rgba(255,214,120,0) 147deg,',
    'rgba(255,214,120,0) 168deg,rgba(255,214,120,.55) 180deg,rgba(255,214,120,0) 192deg,',
    'rgba(255,214,120,0) 213deg,rgba(255,214,120,.55) 225deg,rgba(255,214,120,0) 237deg,',
    'rgba(255,214,120,0) 258deg,rgba(255,214,120,.55) 270deg,rgba(255,214,120,0) 282deg,',
    'rgba(255,214,120,0) 303deg,rgba(255,214,120,.55) 315deg,rgba(255,214,120,0) 327deg,',
    'rgba(255,214,120,0) 348deg,rgba(255,214,120,.55) 360deg);',
    '-webkit-mask-image:radial-gradient(circle,#000 30%,transparent 72%);',
    'mask-image:radial-gradient(circle,#000 30%,transparent 72%)}',
    '#gh-menus .stw .halo{position:absolute;inset:-30%;border-radius:50%;opacity:0;pointer-events:none;',
    'background:radial-gradient(circle,rgba(255,196,80,.62) 0%,rgba(255,140,40,.22) 42%,rgba(255,120,30,0) 70%)}',
    '#gh-menus .stw.gold .halo{background:radial-gradient(circle,rgba(255,235,150,.75) 0%,rgba(255,90,160,.28) 40%,rgba(255,60,140,0) 72%)}',
    '#gh-menus .stw .ring{position:absolute;inset:0;border-radius:50%;opacity:0;pointer-events:none;',
    'border:2px solid rgba(255,222,140,.9)}',

    /* ------------------------- FAIXA 5 ESTRELAS -------------------- */
    '#gh-menus .rs-banner{flex:0 0 auto;text-align:center;margin-top:calc(var(--u)*.1);height:calc(var(--u)*3.1)}',
    '#gh-menus .rs-banner .big{font-family:var(--f-display);font-weight:900;font-style:italic;',
    'text-transform:uppercase;font-size:calc(var(--u)*2.5);letter-spacing:.03em;line-height:1;',
    'background:linear-gradient(177deg,#fffbe8 2%,#ffd75c 34%,#ff8a1e 66%,#ff2f7d 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 calc(var(--u)*.12) 0 rgba(50,8,26,.95)) drop-shadow(0 0 calc(var(--u)*2.2) rgba(255,150,50,.55))}',
    '#gh-menus .rs-banner .sm{margin-top:calc(var(--u)*.22);font-size:calc(var(--u)*.74);',
    'letter-spacing:.30em;text-transform:uppercase;font-weight:700;color:var(--ink-dim)}',
    '#gh-menus .rs-banner.fail .big{background:linear-gradient(177deg,#ffd6d6 0%,#ff6b6b 48%,#8e1b10 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 calc(var(--u)*.12) 0 rgba(40,2,2,.95)) drop-shadow(0 0 calc(var(--u)*1.8) rgba(255,60,60,.5))}',

    /* --------------------------- CORPO ----------------------------- */
    '#gh-menus .rs-body{flex:1 1 auto;display:flex;gap:calc(var(--u)*1.6);min-height:0;',
    'margin-top:calc(var(--u)*.7);overflow:hidden}',
    '#gh-menus .rs-left{flex:0 0 32%;display:flex;flex-direction:column;gap:calc(var(--u)*.8);min-height:0}',
    '#gh-menus .rs-right{flex:1 1 auto;display:flex;flex-direction:column;gap:calc(var(--u)*.8);min-height:0}',

    '#gh-menus .rs-score{padding:calc(var(--u)*.75) calc(var(--u)*1.05);flex:0 0 auto}',
    '#gh-menus .rs-score .lbl{font-size:calc(var(--u)*.68);letter-spacing:.28em;text-transform:uppercase;',
    'font-weight:800;color:var(--ink-faint)}',
    '#gh-menus .rs-score .val{font-family:var(--f-num);font-weight:800;font-size:calc(var(--u)*3.5);',
    'line-height:1.02;letter-spacing:-.015em;',
    'background:linear-gradient(177deg,#fffdf2 0%,#ffd75c 46%,#ff9a1e 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 calc(var(--u)*.1) 0 rgba(40,10,0,.9)) drop-shadow(0 0 calc(var(--u)*1.6) rgba(255,180,60,.35))}',
    '#gh-menus .rs-score .rec{margin-top:calc(var(--u)*.2);font-size:calc(var(--u)*.68);',
    'letter-spacing:.18em;text-transform:uppercase;font-weight:800;color:var(--gold);opacity:0}',
    '#gh-menus .rs-score .rec.on{opacity:1}',

    '#gh-menus .rs-grid{flex:1 1 auto;display:grid;grid-template-columns:1fr 1fr;',
    'gap:calc(var(--u)*.42);align-content:start;min-height:0;overflow:hidden}',
    '#gh-menus .tile{padding:calc(var(--u)*.50) calc(var(--u)*.7);border-radius:calc(var(--u)*.38);',
    'background:linear-gradient(160deg,rgba(22,19,42,.66),rgba(9,8,19,.72));',
    'border:1px solid rgba(255,255,255,.07)}',
    '#gh-menus .tile .k{font-size:calc(var(--u)*.62);letter-spacing:.20em;text-transform:uppercase;',
    'font-weight:800;color:var(--ink-faint)}',
    '#gh-menus .tile .v{margin-top:calc(var(--u)*.12);font-family:var(--f-num);font-weight:800;',
    'font-size:calc(var(--u)*1.42);color:var(--ink);line-height:1}',
    '#gh-menus .tile .v small{font-size:.58em;font-weight:700;color:var(--ink-dim);margin-left:.25em}',
    '#gh-menus .tile.good .v{color:#7dffbb}',
    '#gh-menus .tile.warm .v{color:var(--gold)}',
    '#gh-menus .tile.bad .v{color:#ff6b78}',
    '#gh-menus .tile.ice .v{color:var(--ice)}',

    '#gh-menus .rs-chart{position:relative;padding:calc(var(--u)*.7) calc(var(--u)*.85) calc(var(--u)*.55);',
    'display:flex;flex-direction:column;min-height:0}',
    '#gh-menus .rs-chart .ct{display:flex;align-items:baseline;justify-content:space-between;',
    'font-size:calc(var(--u)*.66);letter-spacing:.22em;text-transform:uppercase;font-weight:800;',
    'color:var(--ink-faint);flex:0 0 auto}',
    '#gh-menus .rs-chart .ct em{font-style:normal;letter-spacing:.06em;text-transform:none;',
    'font-family:var(--f-num);font-size:calc(var(--u)*.86);color:var(--ink-dim)}',
    '#gh-menus .rs-chart canvas{flex:1 1 auto;width:100%;min-height:0;border-radius:calc(var(--u)*.3);',
    'margin-top:calc(var(--u)*.38)}',
    '#gh-menus .rs-graph{flex:1 1 62%}',
    '#gh-menus .rs-hist{flex:1 1 38%}',

    '#gh-menus .rs-actions{display:flex;gap:calc(var(--u)*.7);align-items:center}',
    '#gh-menus .btn{position:relative;cursor:pointer;padding:calc(var(--u)*.45) calc(var(--u)*1.5);',
    'border-radius:calc(var(--u)*.36);border:1px solid rgba(255,255,255,.14);',
    'background:linear-gradient(180deg,rgba(38,32,64,.8),rgba(14,12,28,.86));',
    'font-family:var(--f-display);font-weight:900;font-style:italic;text-transform:uppercase;',
    'font-size:calc(var(--u)*1.02);letter-spacing:.06em;color:#cfd6ea;',
    'transition:transform .2s cubic-bezier(.2,1.4,.4,1),color .18s ease,border-color .18s ease,box-shadow .2s ease;',
    'text-shadow:0 1px 0 rgba(0,0,0,.8)}',
    '#gh-menus .btn.foc{color:#fff;transform:scale(1.06);border-color:rgba(255,190,110,.6);',
    'box-shadow:0 calc(var(--u)*.5) calc(var(--u)*1.4) rgba(0,0,0,.6),0 0 calc(var(--u)*1.6) rgba(255,140,60,.38);',
    'background:linear-gradient(180deg,rgba(86,44,26,.92),rgba(30,14,20,.92))}'
  ].join(''));

  var RESULT_RANKS = [
    { min: 6, name: 'Mestre da Guitarrada', sub: 'estrela de ouro' },
    { min: 5, name: 'Ximbinha aprovaria', sub: 'cinco estrelas' },
    { min: 4, name: 'A galera pediu bis', sub: 'quatro estrelas' },
    { min: 3, name: 'Show honesto', sub: 'três estrelas' },
    { min: 2, name: 'Deu pra dançar', sub: 'duas estrelas' },
    { min: 1, name: 'Tá afinando ainda', sub: 'uma estrela' },
    { min: 0, name: 'A plateia foi embora', sub: 'sem estrela' }
  ];
  function rankOf(stars) {
    for (var i = 0; i < RESULT_RANKS.length; i++) if (stars >= RESULT_RANKS[i].min) return RESULT_RANKS[i];
    return RESULT_RANKS[RESULT_RANKS.length - 1];
  }

  function buildResults() {
    var s = makeScreen('results');
    s.axis = 'x';
    var el = s.el;
    add(el, mk('div', 'scrim'));
    var pane = add(el, mk('div', 'pane'));

    /* topo */
    var top = add(pane, mk('div', 'rs-top'));
    var topL = add(top, mk('div', 'l'));
    var mini = add(topL, mk('div', 'mini'));
    var miniCv = add(mini, document.createElement('canvas'));
    miniCv.width = 256; miniCv.height = 256;
    var topTxt = add(topL, mk('div'));
    var kick = add(topTxt, mk('p', 'kick gold', 'Resultado'));
    var hTitle = add(topTxt, mk('h2', null, '—'));
    var topR = add(top, mk('div', 'right'));

    /* estrelas */
    var starsRow = add(pane, mk('div', 'rs-stars'));
    var starEls = [];
    for (var i = 0; i < 6; i++) {
      var w = add(starsRow, mk('div', 'stw' + (i === 5 ? ' gold' : '')));
      var halo = add(w, mk('i', 'halo'));
      var rays = add(w, mk('i', 'rays'));
      var base = add(w, mk('i', 'base starshape'));
      var fill = add(w, mk('i', 'fill starshape'));
      var core = add(w, mk('i', 'core starshape'));
      var ring = add(w, mk('i', 'ring'));
      starEls.push({ w: w, halo: halo, base: base, fill: fill, ring: ring, core: core, rays: rays });
    }

    /* faixa */
    var banner = add(pane, mk('div', 'rs-banner'));
    var bannerBig = add(banner, mk('div', 'big'));
    var bannerSm = add(banner, mk('div', 'sm'));

    /* corpo */
    var body = add(pane, mk('div', 'rs-body'));
    var left = add(body, mk('div', 'rs-left'));
    var scorePanel = add(left, mk('div', 'glass rs-score'));
    add(scorePanel, mk('div', 'lbl', 'Pontuação'));
    var scoreVal = add(scorePanel, mk('div', 'val num', '0'));
    var scoreRec = add(scorePanel, mk('div', 'rec', 'novo recorde!'));
    var grid = add(left, mk('div', 'rs-grid'));

    var right = add(body, mk('div', 'rs-right'));
    var gWrap = add(right, mk('div', 'glass rs-chart rs-graph'));
    var gTitle = add(gWrap, mk('div', 'ct', '<span>Desempenho ao longo da música</span><em></em>'));
    var gCv = add(gWrap, document.createElement('canvas'));
    var hWrap = add(right, mk('div', 'glass rs-chart rs-hist'));
    var hTitleC = add(hWrap, mk('div', 'ct', '<span>Desvio de tempo</span><em></em>'));
    var hCv = add(hWrap, document.createElement('canvas'));

    /* rodape */
    var foot = add(pane, mk('div', 'foot'));
    var actions = add(foot, mk('div', 'rs-actions'));
    var btnGo = add(actions, mk('div', 'btn', 'Continuar'));
    var btnAgain = add(actions, mk('div', 'btn', 'Tocar de novo'));
    item(s, btnGo, { action: 'title' });
    item(s, btnAgain, { action: 'restart' });
    add(foot, mk('div', 'hints',
      '<span><b class="key">Enter</b> confirmar</span><span><b class="key">R</b> repetir</span>'));

    s.parts = { starEls: starEls, banner: banner, bannerBig: bannerBig, bannerSm: bannerSm,
                scoreVal: scoreVal, scoreRec: scoreRec, grid: grid, gCv: gCv, hCv: hCv,
                gTitle: gTitle, hTitleC: hTitleC, miniCv: miniCv, hTitle: hTitle, topR: topR,
                top: top, body: body, foot: foot, kick: kick };

    /* --------- animacao das estrelas: uma a uma, com impacto ---------- */
    function popStar(idx, delay, gold) {
      var st = starEls[idx];
      tween({
        delay: delay, dur: 0.44,
        apply: function (u) {
          var p = easeOutSoftBack(u);
          var o = easeOutCubic(clamp01(u * 2.2));
          st.fill.style.opacity = o.toFixed(3);
          st.w.style.transform = 'scale(' + lerp(gold ? 2.4 : 1.9, 1, p).toFixed(4) +
            ') rotate(' + ((1 - p) * (gold ? -26 : 16)).toFixed(2) + 'deg)';
          st.halo.style.opacity = (Math.sin(clamp01(u) * Math.PI) * (gold ? 1 : 0.75)).toFixed(3);
          if (gold) {
            st.core.style.opacity = (o * 0.9).toFixed(3);
            st.rays.style.opacity = (o * 0.75).toFixed(3);
            st.rays.style.transform = 'rotate(' + (p * 42).toFixed(1) + 'deg)';
          }
        },
        done: function () {
          st.fill.style.opacity = '1';
          st.w.style.transform = '';
          st.halo.style.opacity = gold ? '0.85' : '0.55';
          if (gold) { st.core.style.opacity = '0.9'; st.rays.style.opacity = '0.75'; }
          sfx(gold ? 'starPowerOn' : 'uiSelect');
          if (gold) { call('Engine', 'flash', '#ffd34a', 0.24, 0.42); call('Engine', 'bloomPulse', 0.35, 0.9); }
          else { call('Engine', 'bloomPulse', 0.14, 0.5); }
        }
      });
      /* anel de choque */
      tween({
        delay: delay, dur: 0.55,
        apply: function (u) {
          var p = easeOutQuint(u);
          st.ring.style.opacity = ((1 - u) * 0.85).toFixed(3);
          st.ring.style.transform = 'scale(' + lerp(0.5, gold ? 2.6 : 2.0, p).toFixed(3) + ')';
        },
        done: function () { st.ring.style.opacity = '0'; }
      });
    }

    function resetStars() {
      for (var i = 0; i < starEls.length; i++) {
        starEls[i].fill.style.opacity = '0';
        starEls[i].halo.style.opacity = '0';
        starEls[i].ring.style.opacity = '0';
        starEls[i].core.style.opacity = '0';
        starEls[i].rays.style.opacity = '0';
        starEls[i].w.style.transform = '';
      }
    }

    s.fill = function (stats) {
      stats = stats || call('Scoring', 'getStats') || {};
      var song = (stats.song) || (GH.Chart && GH.Chart.song) || currentSong();
      var starsN = (typeof stats.starsDisplay === 'number') ? stats.starsDisplay
                 : (typeof stats.stars === 'number' ? stats.stars : 0);
      var gold = starsN >= 6 || !!stats.goldStar;
      var starsFull = gold ? 5 : Math.min(5, starsN);
      var failed = !!stats.failed;

      if (song) {
        try {
          var mg = miniCv.getContext('2d');
          mg.clearRect(0, 0, 256, 256);
          mg.drawImage(coverOf(song), 0, 0, 256, 256);
        } catch (e) { /* ok */ }
      }
      hTitle.textContent = (stats.songTitle || (song && song.title) || 'Música');
      var dl = stats.difficultyLabel || diffLabel(stats.difficulty || selectedDifficulty);
      topR.innerHTML = '<span class="rs-badge">' + esc(dl) + '</span>&nbsp;&nbsp;' +
        esc((song && song.genre) || '') + ' &middot; <b>' + fmtTime(stats.durationSec || (song && song.durationSec) || 0) + '</b>';

      /* faixa de celebracao / fracasso */
      var rk = rankOf(gold ? 6 : starsFull);
      banner.className = 'rs-banner' + (failed ? ' fail' : '');
      if (failed) {
        bannerBig.textContent = 'A GALERA NÃO AGUENTOU.';
        bannerSm.textContent = 'o rock meter zerou — tenta de novo, o Pará espera';
      } else if (starsFull >= 5) {
        bannerBig.textContent = 'O BRASIL TÁ PRONTO.';
        bannerSm.textContent = gold ? 'estrela de ouro · ' + rk.name : rk.name;
      } else {
        bannerBig.textContent = rk.name + '.';
        bannerSm.textContent = rk.sub;
      }

      /* placar e ladrilhos */
      var acc = (typeof stats.accuracy === 'number') ? stats.accuracy : 0;
      var hit = stats.notesHit || 0, tot = stats.notesTotal || 0;
      var fc = !!stats.fullCombo;
      grid.innerHTML =
        '<div class="tile ' + (acc >= 0.95 ? 'good' : (acc >= 0.8 ? 'warm' : '')) + '">' +
          '<div class="k">Precisão</div><div class="v">' + fmtPct(acc, 1) + '</div></div>' +
        '<div class="tile warm"><div class="k">Maior sequência</div><div class="v">' +
          fmtInt(stats.bestStreak || 0) + (fc ? '<small>FC</small>' : '') + '</div></div>' +
        '<div class="tile"><div class="k">Notas</div><div class="v">' + fmtInt(hit) +
          '<small>/ ' + fmtInt(tot) + '</small></div></div>' +
        '<div class="tile good"><div class="k">Perfeitas</div><div class="v">' + fmtInt(stats.perfects || 0) + '</div></div>' +
        '<div class="tile ice"><div class="k">Boas</div><div class="v">' + fmtInt(stats.goods || 0) + '</div></div>' +
        '<div class="tile ' + ((stats.misses || 0) ? 'bad' : 'good') + '"><div class="k">Erros</div><div class="v">' +
          fmtInt(stats.misses || 0) + (stats.overstrums ? '<small>+' + stats.overstrums + ' palh.</small>' : '') + '</div></div>' +
        '<div class="tile ice"><div class="k">Star Power</div><div class="v">' +
          fmtInt(stats.spPhrasesHit || 0) + '<small>/ ' + fmtInt(stats.spPhrasesTotal || 0) + '</small></div></div>' +
        '<div class="tile"><div class="k">Desvio médio</div><div class="v">' +
          fmtMs(stats.avgDeltaMs || 0) + '</div></div>' +
        '<div class="tile"><div class="k">Consistência</div><div class="v">&plusmn;' +
          (stats.stdDeltaMs || 0).toFixed(1).replace('.', ',') + '<small>ms</small></div></div>' +
        '<div class="tile warm"><div class="k">Nota do show</div><div class="v" style="font-size:calc(var(--u)*1.05)">' +
          esc(rk.name) + '</div></div>';

      countUp(scoreVal, stats.score || 0, { dur: 1.25, delay: 0.30 });

      /* recorde */
      var sid = (song && song.id) || stats.songId || '';
      var dkey = stats.difficulty || selectedDifficulty;
      var wasBest = false;
      if (sid && !failed) {
        wasBest = recordBest(sid, dkey, {
          score: stats.score || 0, stars: gold ? 6 : starsFull,
          accuracy: acc, streak: stats.bestStreak || 0, difficulty: dkey
        });
        bestCache = null;
      }
      scoreRec.className = 'rec' + (wasBest ? ' on' : '');

      /* estrelas */
      resetStars();
      starEls[5].w.style.display = gold ? '' : 'none';
      var d0 = 0.34;
      for (var k = 0; k < 5; k++) {
        if (k < starsFull) popStar(k, d0 + k * 0.26, false);
      }
      if (gold) popStar(5, d0 + 5 * 0.26 + 0.14, true);

      /* graficos com dados reais */
      var series = runSeries();
      var winMs = stats.hitWindowMs || 70;
      var perfMs = stats.perfectWindowMs || 25;
      gTitle.querySelector('em').textContent =
        series.misses.length + ' erro' + (series.misses.length === 1 ? '' : 's') +
        ' · pico ' + (function () {
          var m = 1; for (var q = 0; q < series.mult.length; q++) if (series.mult[q].m > m) m = series.mult[q].m;
          return m + 'x';
        })();
      hTitleC.querySelector('em').textContent =
        'média ' + fmtMs(stats.avgDeltaMs || 0) + ' · desvio ' + (stats.stdDeltaMs || 0).toFixed(1).replace('.', ',') + ' ms' +
        ' · ' + (stats.earlyCount || 0) + ' adiantadas / ' + (stats.lateCount || 0) + ' atrasadas';

      s._chartJob = function () {
        var okA = drawRunGraph(gCv, series, winMs);
        var okB = drawHistogram(hCv, stats.histogram, stats.avgDeltaMs || 0, perfMs);
        return okA && okB;
      };
      if (!s._chartJob()) pendingLayout.push(s._chartJob);
    };

    s.onEnter = function (stats) {
      s.fill(stats);
      setFocus(s, 0, false);
      revealList([top], { delay: 0.02, dur: 0.5, dy: -16 });
      revealList([banner], { delay: 1.70, dur: 0.6, dy: 14, scale: 0.9 });
      revealList([scorePanel], { delay: 0.22, dur: 0.55, dy: 20, dx: -18 });
      revealList([grid], { delay: 0.32, dur: 0.55, dy: 20, dx: -14 });
      revealList([gWrap], { delay: 0.28, dur: 0.6, dy: 22, dx: 20 });
      revealList([hWrap], { delay: 0.38, dur: 0.6, dy: 22, dx: 20 });
      revealList([foot], { delay: 0.60, dur: 0.5, dy: 12 });
    };
    s.onBack = function () { emitChoose('title'); };
    s.built = true;
    return s;
  }

  /* =========================================================================
     14. PAUSA
     ========================================================================= */

  CSS.push([
    /* O contrato pede "menu de pausa sobre o jogo DESFOCADO". As tres camadas
       somadas (.58 de scrim + brightness .80 do backdrop + scrim2 ate .74)
       apagavam o jogo por completo — o print virou um retangulo preto com uma
       caixa no meio. Aqui o jogo continua legivel por tras, so recuado. */
    '#gh-menus .scr-pause .scrim{background:rgba(4,3,10,.14);',
    '-webkit-backdrop-filter:blur(calc(var(--u)*.55)) saturate(.80) brightness(.86);',
    'backdrop-filter:blur(calc(var(--u)*.55)) saturate(.80) brightness(.86)}',
    /* segunda camada: garante escurecimento mesmo onde backdrop-filter nao pega */
    '#gh-menus .scr-pause .scrim2{position:absolute;inset:0;',
    'background:radial-gradient(82% 72% at 50% 50%,rgba(4,3,10,0),rgba(3,2,8,.34) 92%)}',

    '#gh-menus .pz{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
    'width:calc(var(--u)*34);padding:calc(var(--u)*1.9) calc(var(--u)*2.2) calc(var(--u)*1.6);',
    'box-sizing:border-box;text-align:center}',
    '#gh-menus .pz h3{margin:calc(var(--u)*.5) 0 0;font-family:var(--f-display);font-weight:900;',
    'font-style:italic;text-transform:uppercase;font-size:calc(var(--u)*3.0);line-height:1;letter-spacing:.02em;',
    'background:linear-gradient(177deg,#fff8e6 4%,#ffd25e 42%,#ff7a2e 78%,#ff3d8a 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 calc(var(--u)*.14) 0 rgba(40,6,22,.9)) drop-shadow(0 calc(var(--u)*.4) calc(var(--u)*.9) rgba(0,0,0,.75))}',
    '#gh-menus .pz .song{margin-top:calc(var(--u)*.4);font-size:calc(var(--u)*.86);font-weight:700;',
    'color:var(--ink-dim)}',
    '#gh-menus .pz .strip{display:flex;justify-content:center;gap:calc(var(--u)*1.6);',
    'margin:calc(var(--u)*1.0) 0 calc(var(--u)*1.1);padding:calc(var(--u)*.6) 0;',
    'border-top:1px solid rgba(255,255,255,.09);border-bottom:1px solid rgba(255,255,255,.09)}',
    '#gh-menus .pz .strip div{text-align:center}',
    '#gh-menus .pz .strip .k{font-size:calc(var(--u)*.6);letter-spacing:.2em;text-transform:uppercase;',
    'font-weight:800;color:var(--ink-faint)}',
    '#gh-menus .pz .strip .v{font-family:var(--f-num);font-weight:800;font-size:calc(var(--u)*1.3);color:var(--ink)}',
    '#gh-menus .pz .plist{display:flex;flex-direction:column;gap:calc(var(--u)*.3)}',
    '#gh-menus .pitem{position:relative;cursor:pointer;padding:calc(var(--u)*.44) calc(var(--u)*1.2);',
    'border-radius:calc(var(--u)*.34);font-family:var(--f-display);font-weight:900;font-style:italic;',
    'text-transform:uppercase;font-size:calc(var(--u)*1.28);letter-spacing:.04em;color:#b9c2dc;',
    'border:1px solid transparent;text-shadow:0 1px 0 rgba(0,0,0,.85);',
    'transition:transform .2s cubic-bezier(.2,1.4,.4,1),color .18s ease,background .18s ease,border-color .18s ease}',
    '#gh-menus .pitem.foc{color:#fff;transform:scale(1.05);border-color:rgba(255,190,110,.45);',
    'background:linear-gradient(100deg,rgba(80,40,26,.75),rgba(28,14,32,.55));',
    'box-shadow:0 calc(var(--u)*.5) calc(var(--u)*1.3) rgba(0,0,0,.6),0 0 calc(var(--u)*1.5) rgba(255,140,60,.32)}',
    '#gh-menus .pitem.danger.foc{border-color:rgba(255,90,90,.5);',
    'background:linear-gradient(100deg,rgba(88,22,26,.78),rgba(30,10,16,.55));',
    'box-shadow:0 calc(var(--u)*.5) calc(var(--u)*1.3) rgba(0,0,0,.6),0 0 calc(var(--u)*1.5) rgba(255,70,70,.34)}',
    '#gh-menus .pz .frieze{margin-top:calc(var(--u)*1.0)}',
    '#gh-menus .pz .cover{width:calc(var(--u)*5.2);height:calc(var(--u)*5.2);margin:0 auto;',
    'border-radius:calc(var(--u)*.4);overflow:hidden;',
    'box-shadow:0 calc(var(--u)*.7) calc(var(--u)*1.6) rgba(0,0,0,.75),0 0 0 1px rgba(255,255,255,.12)}',
    '#gh-menus .pz .cover canvas{width:100%;height:100%;display:block}'
  ].join(''));

  function buildPause() {
    var s = makeScreen('pause');
    var el = s.el;
    add(el, mk('div', 'scrim'));
    add(el, mk('div', 'scrim2'));

    var box = add(el, mk('div', 'glass pz'));
    var cover = add(box, mk('div', 'cover'));
    var coverCv = add(cover, document.createElement('canvas'));
    coverCv.width = 256; coverCv.height = 256;
    add(box, mk('p', 'kick', 'Intervalo')).style.marginTop = 'calc(var(--u)*.85)';
    add(box, mk('h3', null, 'Pausa'));
    var songLine = add(box, mk('div', 'song', ''));
    var strip = add(box, mk('div', 'strip'));
    var plist = add(box, mk('div', 'plist'));

    var defs = [
      { label: 'Continuar', action: 'resume' },
      { label: 'Recomeçar', action: 'restart' },
      { label: 'Configurações', settings: true },
      { label: 'Sair para o título', action: 'quit', danger: true }
    ];
    var rows = [];
    for (var i = 0; i < defs.length; i++) {
      (function (d) {
        var r = add(plist, mk('div', 'pitem' + (d.danger ? ' danger' : ''), esc(d.label)));
        item(s, r, {
          onConfirm: function () {
            if (d.settings) { openSettings('pause'); return; }
            emitChoose(d.action);
          }
        });
        rows.push(r);
      })(defs[i]);
    }
    add(box, mk('div', 'frieze thin'));

    s.parts = { box: box, songLine: songLine, strip: strip, rows: rows };

    s.onEnter = function () {
      var song = (GH.Chart && GH.Chart.song) || currentSong();
      var Sc = GH.Scoring || {};
      songLine.innerHTML = song
        ? (esc(song.title) + ' &middot; ' + esc(diffLabel((GH.Chart && GH.Chart.difficulty) || selectedDifficulty)))
        : '';
      if (song) {
        try {
          var cg = coverCv.getContext('2d');
          cg.clearRect(0, 0, 256, 256);
          cg.drawImage(coverOf(song), 0, 0, 256, 256);
        } catch (e) { /* ok */ }
      }
      strip.innerHTML =
        '<div><div class="k">Pontos</div><div class="v">' + fmtInt(Sc.score || 0) + '</div></div>' +
        '<div><div class="k">Sequência</div><div class="v">' + fmtInt(Sc.streak || 0) + '</div></div>' +
        '<div><div class="k">Precisão</div><div class="v">' + fmtPct(Sc.accuracy || 0, 0) + '</div></div>' +
        '<div><div class="k">Vida</div><div class="v">' + fmtPct(Sc.health === undefined ? 1 : Sc.health, 0) + '</div></div>';
      setFocus(s, 0, false);
      /* rapido de proposito: a captura `pause` congela 0,4 s depois de abrir */
      tween({
        dur: 0.26,
        apply: function (u) {
          var p = easeOutSoftBack(u);
          box.style.opacity = easeOutCubic(clamp01(u * 2)).toFixed(3);
          box.style.transform = 'translate(-50%,-50%) scale(' + lerp(0.90, 1, p).toFixed(4) + ')';
        },
        done: function () { box.style.opacity = ''; box.style.transform = ''; }
      });
      revealList(rows, { delay: 0.06, step: 0.028, dur: 0.24, dy: 8 });
    };
    s.onBack = function () { emitChoose('resume'); };
    s.built = true;
    return s;
  }

  /* =========================================================================
     15. CREDITOS — homenagem com respeito e sem afiliacao
     ========================================================================= */

  CSS.push([
    '#gh-menus .scr-credits .scrim{background:',
    'radial-gradient(80% 60% at 50% 38%,rgba(8,4,20,.62),rgba(3,2,10,.94) 76%),',
    'linear-gradient(180deg,rgba(3,2,9,.95) 0%,rgba(3,2,9,.55) 22%,rgba(3,2,9,.62) 72%,rgba(2,1,6,.97) 100%)}',
    '#gh-menus .cr-body{flex:0 0 auto;display:grid;grid-template-columns:1.15fr 1fr 1fr;',
    'gap:calc(var(--u)*1.8);margin-top:calc(var(--u)*1.2);min-height:0;overflow:hidden}',
    '#gh-menus .cr-col{min-height:0}',
    '#gh-menus .cr-h{font-size:calc(var(--u)*.70);letter-spacing:.30em;text-transform:uppercase;',
    'font-weight:800;color:var(--cyan);margin-bottom:calc(var(--u)*.55);',
    'display:flex;align-items:center;gap:calc(var(--u)*.6)}',
    '#gh-menus .cr-h::after{content:"";flex:1 1 auto;height:1px;',
    'background:linear-gradient(90deg,currentColor,transparent);opacity:.4}',
    '#gh-menus .cr-h.g{color:var(--gold)}',
    '#gh-menus .cr-name{font-family:var(--f-display);font-weight:900;font-style:italic;',
    'text-transform:uppercase;font-size:calc(var(--u)*1.18);line-height:1.15;color:#fff;',
    'margin-top:calc(var(--u)*.62);text-shadow:0 1px 0 rgba(0,0,0,.85)}',
    '#gh-menus .cr-desc{font-size:calc(var(--u)*.80);line-height:1.5;color:var(--ink-dim);',
    'margin-top:calc(var(--u)*.14)}',
    '#gh-menus .cr-p{font-size:calc(var(--u)*.82);line-height:1.62;color:var(--ink-dim);',
    'margin:calc(var(--u)*.5) 0 0}',
    '#gh-menus .cr-p b{color:var(--ink);font-weight:700}',
    '#gh-menus .cr-quote{font-family:var(--f-serif);font-style:italic;font-size:calc(var(--u)*1.12);',
    'line-height:1.45;color:#f2ecff;margin:calc(var(--u)*.7) 0 0;',
    'padding-left:calc(var(--u)*.85);border-left:2px solid var(--mag)}',
    '#gh-menus .cr-quote b{color:var(--gold);font-style:italic}',
    '#gh-menus .cr-list{margin:calc(var(--u)*.35) 0 0;font-size:calc(var(--u)*.82);line-height:1.75;',
    'color:var(--ink-dim)}',
    '#gh-menus .cr-list b{color:#e6ecff;font-weight:700}',
    '#gh-menus .cr-warn{margin-top:calc(var(--u)*.9);padding:calc(var(--u)*.7) calc(var(--u)*.9);',
    'border-radius:calc(var(--u)*.36);background:rgba(255,255,255,.045);',
    'border:1px solid rgba(255,255,255,.09);font-size:calc(var(--u)*.74);line-height:1.6;',
    'color:var(--ink-faint)}',
    '#gh-menus .cr-warn b{color:var(--gold);font-weight:700}',
    /* faixa da trilha sonora original: as seis capas geradas por codigo */
    '#gh-menus .cr-track{flex:0 1 auto;min-height:0;margin-top:calc(var(--u)*.7)}',
    '#gh-menus .cr-track .row{display:flex;gap:calc(var(--u)*.85);margin-top:calc(var(--u)*.5);',
    'justify-content:center}',
    /* Teto de largura das capas: se algum texto crescer numa traducao ou numa
       janela estreita, a faixa encolhe em vez de empurrar o rodape para fora
       da tela (foi exatamente o que aconteceu ao entrar a caixa do estudio). */
    '#gh-menus .cr-track .it{flex:1 1 0;min-width:0;max-width:calc(var(--u)*14.4)}',
    '#gh-menus .cr-track .ar{position:relative;width:100%;aspect-ratio:1/1;overflow:hidden;',
    'border-radius:calc(var(--u)*.34);box-shadow:0 calc(var(--u)*.5) calc(var(--u)*1.2) rgba(0,0,0,.7),',
    '0 0 0 1px rgba(255,255,255,.10)}',
    '#gh-menus .cr-track .ar canvas{width:100%;height:100%;display:block}',
    '#gh-menus .cr-track .nm{margin-top:calc(var(--u)*.35);font-size:calc(var(--u)*.72);font-weight:700;',
    'color:var(--ink-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#gh-menus .cr-track .gn{font-size:calc(var(--u)*.60);letter-spacing:.16em;text-transform:uppercase;',
    'font-weight:800;color:var(--ink-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',

    /* ---------------- ESTUDIO (com destaque, como o contrato pede) --------- */
    '#gh-menus .cr-studio{display:flex;align-items:center;justify-content:flex-end;',
    'gap:calc(var(--u)*1.1)}',
    '#gh-menus .cr-studio .ghb{font-size:calc(var(--u)*1.62)}',
    '#gh-menus .cr-studio .ghb-eye{font-size:.44em}',
    /* nota "estudio ficticio": nao pode passar por rodape decorativo */
    '#gh-menus .cr-fic{margin-top:calc(var(--u)*.42);padding:calc(var(--u)*.5) calc(var(--u)*.8);',
    'border-radius:calc(var(--u)*.32);background:rgba(255,207,74,.07);',
    'border:1px solid rgba(255,207,74,.24);font-size:calc(var(--u)*.74);line-height:1.55;',
    'color:var(--ink-dim);display:flex;gap:calc(var(--u)*.6);align-items:flex-start}',
    '#gh-menus .cr-fic b{color:var(--gold);font-weight:800}',
    '#gh-menus .cr-fic .em{flex:0 0 auto;width:calc(var(--u)*2.0);height:calc(var(--u)*2.0);',
    'margin-top:calc(var(--u)*.05)}',
    '#gh-menus .cr-fic .em svg{display:block;width:100%;height:100%}'
  ].join(''));

  var MASTERS = [
    { n: 'Ximbinha', d: 'A guitarra que virou assinatura do Pará. Este jogo existe por causa dele.' },
    { n: 'Mestre Vieira', d: 'O pai da guitarrada. Pegou o carimbó, o merengue e a lambada e botou tudo no braço.' },
    { n: 'Aldo Sena', d: 'Fraseado limpo e tremolo de mestre — a escola do Ver-o-Peso.' },
    { n: 'Beto Metralha', d: 'Velocidade, ataque e swing: a guitarrada que não pede licença.' },
    { n: 'Pinduca', d: 'O rei do carimbó. Sem o tambor dele nada disso balança.' }
  ];

  function buildCredits() {
    var s = makeScreen('credits');
    var el = s.el;
    add(el, mk('div', 'scrim'));
    var pane = add(el, mk('div', 'pane'));

    var head = add(pane, mk('div', 'head'));
    var headL = add(head, mk('div'));
    add(headL, mk('p', 'kick', 'Créditos'));
    add(headL, mk('h2', null, 'Isto aqui é uma homenagem'));
    /* O selo do estudio ocupa o lugar de honra do cabecalho — e o "publicado
       por" da tela de creditos. O aviso de que ele e FICTICIO vem logo abaixo,
       na coluna do projeto, em caixa propria. */
    var studio = add(head, mk('div', 'right cr-studio',
      brandLockup({ eyebrow: 'Publicado por', ring: true })));

    var body = add(pane, mk('div', 'cr-body'));

    /* coluna 1 — o projeto */
    var c1 = add(body, mk('div', 'cr-col'));
    add(c1, mk('div', 'cr-h g', 'O projeto'));
    var q = add(c1, mk('p', 'cr-quote'));
    q.innerHTML = '&ldquo;' + esc(SLOGAN_A) + ' ' + esc(SLOGAN_B) + '<b>' + esc(SLOGAN_HERO) + '</b>&rdquo;';
    var p1 = add(c1, mk('p', 'cr-p'));
    p1.innerHTML = '<b>Guitarrada Hero</b> é um jogo de ritmo feito como estudo técnico: ' +
      'toda a imagem é geometria e textura gerada em tempo real, e toda a música é ' +
      '<b>sintetizada nota a nota</b> no navegador — sem nenhum arquivo de áudio, ' +
      'gravação ou composição de terceiros.';
    var p2 = add(c1, mk('p', 'cr-p'));
    p2.innerHTML = 'As seis faixas são <b>composições originais procedurais</b>: guitarrada, ' +
      'carimbó, lambada, brega, frevo e samba-rock.';
    var warn = add(c1, mk('div', 'cr-warn'));
    warn.innerHTML = '<b>' + esc(NOTICE_1) + '</b><br>' + esc(NOTICE_2) +
      '<br>Os nomes citados aparecem apenas como atribuição e homenagem textual.';
    /* A piada precisa vir com a legenda: o estudio nao existe. */
    var fic = add(c1, mk('div', 'cr-fic'));
    fic.innerHTML = '<span class="em">' + brandEmblem({ ring: false }) + '</span>' +
      '<span><b>Mega Brain Games BR</b> é um <b>estúdio fictício</b>, criado só para este ' +
      'projeto didático: não existe empresa nem produto comercial por trás do nome.</span>';

    /* coluna 2 — os mestres */
    var c2 = add(body, mk('div', 'cr-col'));
    add(c2, mk('div', 'cr-h', 'Os mestres da guitarrada'));
    for (var i = 0; i < MASTERS.length; i++) {
      add(c2, mk('div', 'cr-name', esc(MASTERS[i].n)));
      add(c2, mk('div', 'cr-desc', esc(MASTERS[i].d)));
    }

    /* coluna 3 — a musica brasileira */
    var c3 = add(body, mk('div', 'cr-col'));
    add(c3, mk('div', 'cr-h', 'E a todos os que seguram a guitarra'));
    var l1 = add(c3, mk('div', 'cr-list'));
    l1.innerHTML =
      'Aos guitarristas e músicos brasileiros que fizeram a nossa língua caber em seis cordas: ' +
      '<b>Baden Powell</b>, <b>Jorge Ben Jor</b>, <b>Pepeu Gomes</b>, <b>Lanny Gordin</b>, ' +
      '<b>Heraldo do Monte</b>, <b>Dominguinhos</b>, <b>Sivuca</b>, <b>Hermeto Pascoal</b>, ' +
      '<b>Yamandu Costa</b>, <b>Toninho Horta</b> — e aos que tocam todo fim de semana em ' +
      'aparelhagem, arraial, praça e beira de rio, sem nunca sair num disco.';
    add(c3, mk('div', 'cr-h', 'Feito com'));
    var l2 = add(c3, mk('div', 'cr-list'));
    l2.innerHTML = 'WebGL &middot; Three.js r147 &middot; Web Audio API &middot; canvas 2D.<br>' +
      'Sem servidor, sem rede, sem dependência: abre o arquivo e toca.<br>' +
      'Todas as texturas, materiais, capas e instrumentos são <b>gerados por código</b>.';
    var l3 = add(c3, mk('div', 'cr-list'));
    l3.innerHTML = '<br>Referência de gênero: Guitar Hero, Rock Band e Clone Hero — ' +
      'nenhum deles afiliado a este projeto.';

    /* trilha sonora: as seis capas, todas desenhadas por codigo */
    var track = add(pane, mk('div', 'cr-track'));
    add(track, mk('div', 'cr-h g', 'Trilha sonora original — seis composições procedurais'));
    var trackRow = add(track, mk('div', 'row'));

    var foot = add(pane, mk('div', 'foot'));
    var back = add(foot, mk('div', 'btn', 'Voltar'));
    item(s, back, { action: 'title' });
    add(foot, mk('div', 'hints', '<span><b class="key">Esc</b> voltar</span>'));

    s.parts = { cols: [c1, c2, c3], head: head, foot: foot, back: back,
                track: track, studio: studio, fiction: fic };
    s.onEnter = function () {
      refreshSongs();
      if (trackRow.childNodes.length !== songList.length) {
        trackRow.innerHTML = '';
        for (var t = 0; t < songList.length; t++) {
          var it = add(trackRow, mk('div', 'it'));
          var ar = add(it, mk('div', 'ar'));
          add(ar, coverThumb(songList[t], 200));
          add(it, mk('div', 'nm', esc(songList[t].title)));
          add(it, mk('div', 'gn', esc(songList[t].genre) + ' &middot; ' + Math.round(songList[t].bpm) + ' bpm'));
        }
      }
      setFocus(s, 0, false);
      revealList([head], { delay: 0.02, dur: 0.5, dy: -14 });
      revealList([c1, c2, c3], { delay: 0.10, step: 0.09, dur: 0.6, dy: 22 });
      revealList([track], { delay: 0.34, dur: 0.6, dy: 22 });
      revealList([foot], { delay: 0.46, dur: 0.5, dy: 12 });
    };
    s.onBack = function () { emitChoose('title'); };
    s.built = true;
    return s;
  }

  /* =========================================================================
     16. CONFIGURACOES
     ========================================================================= */

  CSS.push([
    '#gh-menus .scr-settings .scrim{background:',
    'linear-gradient(180deg,rgba(3,2,9,.95) 0%,rgba(4,3,12,.86) 24%,rgba(4,3,12,.86) 74%,rgba(2,1,6,.97) 100%)}',
    '#gh-menus .st-body{flex:1 1 auto;display:grid;grid-template-columns:1fr 1fr 1fr;',
    'gap:calc(var(--u)*1.6);margin-top:calc(var(--u)*1.1);min-height:0}',
    '#gh-menus .st-col{min-height:0;display:flex;flex-direction:column;gap:calc(var(--u)*.18)}',
    '#gh-menus .st-h{font-size:calc(var(--u)*.68);letter-spacing:.28em;text-transform:uppercase;',
    'font-weight:800;color:var(--cyan);margin:calc(var(--u)*.75) 0 calc(var(--u)*.35);',
    'display:flex;align-items:center;gap:calc(var(--u)*.55)}',
    '#gh-menus .st-h:first-child{margin-top:0}',
    '#gh-menus .st-h::after{content:"";flex:1 1 auto;height:1px;',
    'background:linear-gradient(90deg,currentColor,transparent);opacity:.35}',

    '#gh-menus .srow{position:relative;display:flex;align-items:center;gap:calc(var(--u)*.7);',
    'padding:calc(var(--u)*.34) calc(var(--u)*.6);border-radius:calc(var(--u)*.3);cursor:pointer;',
    'border:1px solid transparent;',
    'transition:background .16s ease,border-color .16s ease,transform .18s cubic-bezier(.2,1.4,.4,1)}',
    '#gh-menus .srow .sk{flex:1 1 auto;font-size:calc(var(--u)*.80);font-weight:600;color:var(--ink-dim);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#gh-menus .srow .sv{flex:0 0 auto;display:flex;align-items:center;gap:calc(var(--u)*.42);',
    'font-family:var(--f-num);font-weight:700;font-size:calc(var(--u)*.86);color:var(--ink)}',
    '#gh-menus .srow.foc{background:linear-gradient(100deg,rgba(72,40,28,.62),rgba(24,14,32,.42));',
    'border-color:rgba(255,190,110,.36);transform:translateX(calc(var(--u)*.18))}',
    '#gh-menus .srow.foc .sk{color:#fff}',
    '#gh-menus .srow.foc .sv{color:var(--gold)}',
    '#gh-menus .srow.act{border-color:var(--cyan);background:rgba(37,232,206,.12)}',

    '#gh-menus .bar{position:relative;width:calc(var(--u)*7.2);height:calc(var(--u)*.34);',
    'border-radius:99px;background:rgba(255,255,255,.11);overflow:hidden;display:block}',
    '#gh-menus .bar i{position:absolute;left:0;top:0;bottom:0;display:block;border-radius:99px;',
    'background:linear-gradient(90deg,var(--cyan),var(--gold));',
    'box-shadow:0 0 calc(var(--u)*.5) rgba(255,200,90,.6)}',
    '#gh-menus .bar.bi i{background:linear-gradient(90deg,#5ce0d8,#ffcf4a,#c98cff)}',
    '#gh-menus .barv{min-width:calc(var(--u)*3.1);text-align:right}',
    '#gh-menus .cyc{display:flex;align-items:center;gap:calc(var(--u)*.38);',
    'color:var(--ink-faint)}',
    '#gh-menus .cyc b{color:var(--ink);min-width:calc(var(--u)*4.4);text-align:center;font-weight:700}',
    '#gh-menus .srow.foc .cyc b{color:var(--gold)}',
    '#gh-menus .sw{position:relative;width:calc(var(--u)*2.1);height:calc(var(--u)*1.0);border-radius:99px;',
    'background:rgba(255,255,255,.12);display:block;transition:background .18s ease}',
    '#gh-menus .sw i{position:absolute;top:calc(var(--u)*.13);left:calc(var(--u)*.13);',
    'width:calc(var(--u)*.74);height:calc(var(--u)*.74);border-radius:50%;background:#8a93ad;display:block;',
    'transition:transform .2s cubic-bezier(.2,1.5,.4,1),background .18s ease}',
    '#gh-menus .sw.on{background:linear-gradient(90deg,rgba(37,232,206,.5),rgba(255,207,74,.6))}',
    '#gh-menus .sw.on i{transform:translateX(calc(var(--u)*1.1));background:#fff;',
    'box-shadow:0 0 calc(var(--u)*.6) rgba(255,220,140,.9)}',
    '#gh-menus .kc{font-family:var(--f-ui);min-width:calc(var(--u)*2.05);margin-right:0}',
    '#gh-menus .kc.wait{min-width:calc(var(--u)*3.4);color:var(--cyan);',
    'border-color:rgba(37,232,206,.55)}',
    '#gh-menus .kc.none{opacity:.5}',
    '#gh-menus .kmore{font-size:calc(var(--u)*.62);font-weight:800;color:var(--ink-faint);',
    'letter-spacing:.06em}',
    /* recado curto sobre a ultima remapeagem: sem ele o jogador nao sabe se a
       tecla entrou, saiu ou foi recusada */
    '#gh-menus .st-keymsg{min-height:calc(var(--u)*1.5);margin-top:calc(var(--u)*.35);',
    'font-size:calc(var(--u)*.70);line-height:1.4;color:var(--ink-faint);opacity:0}',
    '#gh-menus .st-keymsg.bad{color:#ffb0a0}',
    '#gh-menus .st-keymsg b{color:var(--gold);font-weight:700}',

    /* metronomo visual */
    '#gh-menus .metro{margin-top:calc(var(--u)*.5);padding:calc(var(--u)*.75) calc(var(--u)*.85);',
    'border-radius:calc(var(--u)*.42);background:rgba(255,255,255,.045);',
    'border:1px solid rgba(255,255,255,.09)}',
    '#gh-menus .metro .beats{display:flex;gap:calc(var(--u)*.55);align-items:center;justify-content:center}',
    '#gh-menus .metro .bt{width:calc(var(--u)*1.05);height:calc(var(--u)*1.05);border-radius:50%;',
    'background:rgba(255,255,255,.10);display:block;box-shadow:inset 0 0 0 1px rgba(255,255,255,.10)}',
    '#gh-menus .metro .bt.hot{background:var(--gold);box-shadow:0 0 calc(var(--u)*1.1) var(--gold)}',
    '#gh-menus .metro .ring{position:relative;height:calc(var(--u)*.28);border-radius:99px;',
    'margin-top:calc(var(--u)*.6);background:rgba(255,255,255,.10);overflow:hidden}',
    '#gh-menus .metro .ring i{position:absolute;top:0;bottom:0;width:calc(var(--u)*.5);',
    'border-radius:99px;background:var(--cyan);box-shadow:0 0 calc(var(--u)*.7) var(--cyan);display:block}',
    '#gh-menus .metro .info{margin-top:calc(var(--u)*.55);display:flex;justify-content:space-between;',
    'font-size:calc(var(--u)*.66);letter-spacing:.14em;text-transform:uppercase;font-weight:700;',
    'color:var(--ink-faint)}',
    '#gh-menus .metro .info b{font-family:var(--f-num);letter-spacing:0;color:var(--ink);',
    'font-size:calc(var(--u)*.88)}',
    '#gh-menus .metro.on{border-color:rgba(37,232,206,.45);background:rgba(37,232,206,.08)}',

    /* cartao explicativo no pe de cada coluna — enche o espaco com conteudo
       util em vez de deixar meia tela vazia */
    '#gh-menus .st-note{margin-top:auto;padding:calc(var(--u)*.7) calc(var(--u)*.85);',
    'border-radius:calc(var(--u)*.36);background:rgba(255,255,255,.04);',
    'border:1px solid rgba(255,255,255,.08);font-size:calc(var(--u)*.72);line-height:1.6;',
    'color:var(--ink-faint)}',
    '#gh-menus .st-note b{color:var(--ink-dim);font-weight:700}',
    '#gh-menus .st-note .t{display:block;font-size:calc(var(--u)*.62);letter-spacing:.22em;',
    'text-transform:uppercase;font-weight:800;color:var(--gold);margin-bottom:calc(var(--u)*.3)}'
  ].join(''));

  /* Rotulo humano para um KeyboardEvent.code. */
  var KEY_NAMES = {
    Space: 'Espaço', Enter: 'Enter', NumpadEnter: 'Num Enter', Escape: 'Esc',
    Backspace: 'Backspace', Tab: 'Tab', ShiftLeft: 'Shift E', ShiftRight: 'Shift D',
    ControlLeft: 'Ctrl E', ControlRight: 'Ctrl D', AltLeft: 'Alt', AltRight: 'Alt Gr',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '='
  };
  function keyLabel(code) {
    if (!code) return '—';
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    if (code.indexOf('Key') === 0) return code.slice(3);
    if (code.indexOf('Digit') === 0) return code.slice(5);
    if (code.indexOf('Numpad') === 0) return 'Num ' + code.slice(6);
    return code;
  }
  /* Lista (copia) das teclas de uma acao. */
  function bindingList(action) {
    try {
      var b = GH.Input && GH.Input.bindings && GH.Input.bindings[action];
      if (b && b.length) return b.slice();
    } catch (e) { /* ok */ }
    return [];
  }

  /* Rotulo de UMA tecla (compatibilidade — ainda usado por telas de dica). */
  function bindingLabel(action) {
    var b = bindingList(action);
    return b.length ? keyLabel(b[0]) : '—';
  }

  /* Todas as alternativas, em chips. O jogador precisa VER que a acao tem mais
     de uma tecla — senao ele nao entende por que "A" continua funcionando
     depois de mapear "H". Acima de MAX_CHIPS resumimos com "+n". */
  var MAX_CHIPS = 3;
  function bindingChips(action) {
    var b = bindingList(action);
    if (!b.length) return '<span class="key kc none">—</span>';
    var out = '', n = Math.min(b.length, MAX_CHIPS), i;
    for (i = 0; i < n; i++) out += '<span class="key kc">' + esc(keyLabel(b[i])) + '</span>';
    if (b.length > n) out += '<span class="kmore">+' + (b.length - n) + '</span>';
    return out;
  }

  function setting(path, fallback) {
    try {
      var S = GH.Settings;
      if (!S) return fallback;
      if (path.indexOf('volumes.') === 0) {
        var v = S.volumes ? S.volumes[path.slice(8)] : undefined;
        return (typeof v === 'number') ? v : fallback;
      }
      return (S[path] === undefined) ? fallback : S[path];
    } catch (e) { return fallback; }
  }
  function setSetting(path, value) {
    try {
      if (GH.Settings && typeof GH.Settings.set === 'function') { GH.Settings.set(path, value); return; }
      if (GH.Settings) {
        if (path.indexOf('volumes.') === 0) GH.Settings.volumes[path.slice(8)] = value;
        else GH.Settings[path] = value;
      }
    } catch (e) { /* ok */ }
  }

  var metro = { on: false, bpm: 100, phase: 0, beat: 0, flash: 0, taps: [], avg: 0, el: null };

  function buildSettings() {
    var s = makeScreen('settings');
    var el = s.el;
    add(el, mk('div', 'scrim'));
    var pane = add(el, mk('div', 'pane'));

    var head = add(pane, mk('div', 'head'));
    var headL = add(head, mk('div'));
    add(headL, mk('p', 'kick', 'Ajustes'));
    add(headL, mk('h2', null, 'Configurações'));
    var headR = add(head, mk('div', 'right', 'tudo é salvo automaticamente'));

    var body = add(pane, mk('div', 'st-body'));
    var col1 = add(body, mk('div', 'st-col'));
    var col2 = add(body, mk('div', 'st-col'));
    var col3 = add(body, mk('div', 'st-col'));

    var rows = [];

    /* Estado da captura de tecla. Declarado AQUI (e nao la embaixo) porque a
       fabrica de linhas ja consulta `listening` na primeira renderizacao. */
    var listening = null;
    var listenDef = null;
    var listenHandler = null;
    var keyMsg = null;

    /* ---- fabrica de linhas ------------------------------------------- */
    function row(parent, def) {
      var r = add(parent, mk('div', 'srow'));
      add(r, mk('span', 'sk', esc(def.label)));
      var sv = add(r, mk('span', 'sv'));
      def.sv = sv; def.row = r;

      function render() {
        var v = def.get();
        if (def.kind === 'slider') {
          var t = clamp01((v - def.min) / (def.max - def.min));
          sv.innerHTML = '<span class="bar' + (def.bipolar ? ' bi' : '') + '"><i style="width:' +
            (t * 100).toFixed(1) + '%"></i></span><span class="barv">' + def.fmt(v) + '</span>';
        } else if (def.kind === 'choice') {
          var lbl = v;
          for (var i = 0; i < def.options.length; i++) if (def.options[i].v === v) lbl = def.options[i].label;
          sv.innerHTML = '<span class="cyc">&lsaquo;<b>' + esc(lbl) + '</b>&rsaquo;</span>';
        } else if (def.kind === 'toggle') {
          sv.innerHTML = '<span class="sw' + (v ? ' on' : '') + '"><i></i></span>';
        } else if (def.kind === 'key') {
          /* Todas as alternativas ficam visiveis: e assim que o jogador
             entende que remapear ACRESCENTA em vez de apagar. */
          sv.innerHTML = (listening === def.action)
            ? '<span class="key kc wait">aperte…</span>'
            : bindingChips(def.action);
        } else {
          sv.innerHTML = '<span class="cyc"><b>' + esc(def.hint || 'ativar') + '</b></span>';
        }
      }
      def.render = render;
      render();

      var it = item(s, r, {
        kind: def.kind,
        onNudge: function (dir) {
          if (def.kind === 'slider') {
            var nv = clamp(def.get() + dir * def.step, def.min, def.max);
            def.set(Math.round(nv * 1000) / 1000);
          } else if (def.kind === 'choice') {
            var cur = def.get(), idx = 0, i;
            for (i = 0; i < def.options.length; i++) if (def.options[i].v === cur) idx = i;
            idx = (idx + dir + def.options.length) % def.options.length;
            def.set(def.options[idx].v);
          } else if (def.kind === 'toggle') {
            def.set(!def.get());
          } else return;
          render();
          sfx('uiMove');
        },
        onConfirm: function () {
          if (def.kind === 'toggle') { def.set(!def.get()); render(); return; }
          if (def.onAct) def.onAct(def);
          else if (def.kind === 'choice' || def.kind === 'slider') { /* Enter nao muda valor */ }
        }
      });
      def.item = it;
      rows.push(def);
      return def;
    }

    /* ---- COLUNA 1: calibracao + audio -------------------------------- */
    add(col1, mk('div', 'st-h', 'Calibração de latência'));
    row(col1, {
      label: 'Atraso do áudio', kind: 'slider', min: -300, max: 300, step: 5, bipolar: true,
      get: function () { return setting('audioOffsetMs', 0); },
      set: function (v) { setSetting('audioOffsetMs', v); },
      fmt: function (v) { return (v > 0 ? '+' : '') + Math.round(v) + ' ms'; }
    });
    row(col1, {
      label: 'Atraso do vídeo', kind: 'slider', min: -300, max: 300, step: 5, bipolar: true,
      get: function () { return setting('videoOffsetMs', 0); },
      set: function (v) { setSetting('videoOffsetMs', v); },
      fmt: function (v) { return (v > 0 ? '+' : '') + Math.round(v) + ' ms'; }
    });
    var metroRow = row(col1, {
      label: 'Teste de metrônomo', kind: 'action',
      hint: 'iniciar',
      get: function () { return metro.on; },
      set: function () {},
      onAct: function (d) {
        metro.on = !metro.on;
        metro.phase = 0; metro.beat = 0; metro.flash = 0;
        /* So zera as batidas ao LIGAR. Ao parar (Esc) a medida tem que
           sobreviver — e ela que a linha "Aplicar desvio medido" consome. */
        if (metro.on) metro.taps.length = 0;
        d.hint = metro.on ? 'Esc para parar' : 'iniciar';
        d.render();
        metroBox.className = 'metro' + (metro.on ? ' on' : '');
        updateMetroInfo();
      }
    });
    var metroBox = add(col1, mk('div', 'metro'));
    var beatsEl = add(metroBox, mk('div', 'beats'));
    var beatDots = [];
    for (var bi = 0; bi < 4; bi++) beatDots.push(add(beatsEl, mk('i', 'bt')));
    var ringEl = add(metroBox, mk('div', 'ring'));
    var ringDot = add(ringEl, mk('i'));
    var metroInfo = add(metroBox, mk('div', 'info'));
    metro.el = { box: metroBox, dots: beatDots, dot: ringDot, info: metroInfo };

    function updateMetroInfo() {
      var n = metro.taps.length;
      metroInfo.innerHTML =
        '<span>' + (metro.on ? 'toque <b>Enter</b> na batida &middot; <b>Esc</b> para parar'
                             : (n ? 'parado &middot; aplique o desvio medido' : 'parado')) + '</span>' +
        '<span>toques <b>' + n + '</b></span>' +
        '<span>desvio <b>' + (n ? fmtMs(metro.avg) : '—') + '</b></span>';
    }
    updateMetroInfo();

    row(col1, {
      label: 'Aplicar desvio medido', kind: 'action', hint: 'aplicar',
      get: function () { return 0; }, set: function () {},
      onAct: function () {
        if (!metro.taps.length) { sfx('uiBack'); return; }
        var cur = setting('videoOffsetMs', 0);
        setSetting('videoOffsetMs', clamp(Math.round(cur - metro.avg), -300, 300));
        refreshAll();
      }
    });
    /* BUG RELATADO PELO JOGADOR: "no teste do metronomo, quando aperto Enter
       para tocar na batida, ele DESLIGA o teste".
       Causa: estas duas linhas marcavam a propria linha "Teste de metronomo"
       como noTap. Como o foco CONTINUA nela depois de ligar o teste (foi ela
       que o jogador acabou de acionar), o Enter seguinte caia em activate() e
       alternava o teste, em vez de virar uma batida. Media do harness:
       8 Enter na batida -> 0 toques registrados, desvio "—".
       Com o metronomo LIGADO, Enter agora e SEMPRE batida, em qualquer linha;
       quem para o teste e o Esc (ja tratado em onBack e no globalKeyCapture),
       e as batidas medidas sobrevivem para a linha "Aplicar desvio medido". */

    add(col1, mk('div', 'st-h', 'Volumes'));
    var BUSES = [
      { k: 'master', l: 'Geral' }, { k: 'music', l: 'Música' }, { k: 'guitar', l: 'Guitarra' },
      { k: 'drums', l: 'Bateria' }, { k: 'sfx', l: 'Efeitos' }, { k: 'crowd', l: 'Plateia' }
    ];
    for (var vb = 0; vb < BUSES.length; vb++) {
      (function (b) {
        row(col1, {
          label: b.l, kind: 'slider', min: 0, max: 1, step: 0.05,
          get: function () { return setting('volumes.' + b.k, 0.8); },
          set: function (v) { setSetting('volumes.' + b.k, v); },
          fmt: function (v) { return Math.round(v * 100) + '%'; }
        });
      })(BUSES[vb]);
    }

    /* ---- COLUNA 2: video + jogo -------------------------------------- */
    add(col2, mk('div', 'st-h', 'Vídeo'));
    row(col2, {
      label: 'Qualidade', kind: 'choice',
      options: [{ v: 'low', label: 'Baixa' }, { v: 'med', label: 'Média' },
                { v: 'high', label: 'Alta' }, { v: 'ultra', label: 'Ultra' }],
      get: function () { return setting('quality', 'high'); },
      set: function (v) { setSetting('quality', v); call('Engine', 'setQuality', v); }
    });
    row(col2, {
      label: 'Flash no acerto', kind: 'toggle',
      get: function () { return !!setting('hitFlash', true); },
      set: function (v) { setSetting('hitFlash', v); }
    });
    row(col2, {
      label: 'Mostrar FPS', kind: 'toggle',
      get: function () { return !!setting('showFPS', false); },
      set: function (v) { setSetting('showFPS', v); }
    });
    row(col2, {
      label: 'Plateia nos menus', kind: 'toggle',
      get: function () { return !!setting('crowdAmbience', true); },
      set: function (v) { setSetting('crowdAmbience', v); call('Audio', 'ambience', v, 0.5); }
    });

    add(col2, mk('div', 'st-h', 'Jogo'));
    row(col2, {
      label: 'Velocidade da pista', kind: 'slider', min: 6, max: 32, step: 1,
      get: function () { return setting('scrollSpeed', 14); },
      set: function (v) { setSetting('scrollSpeed', v); try { if (GH.Chart) GH.Chart.speed = v; } catch (e) {} },
      fmt: function (v) { return Math.round(v) + ' u/s'; }
    });
    row(col2, {
      label: 'Dificuldade preferida', kind: 'choice',
      options: [{ v: 'facil', label: 'Fácil' }, { v: 'medio', label: 'Médio' },
                { v: 'dificil', label: 'Difícil' }, { v: 'guitarrada', label: 'Guitarrada' }],
      get: function () { return setting('difficulty', 'medio'); },
      set: function (v) { setSetting('difficulty', v); selectedDifficulty = v; }
    });
    row(col2, {
      label: 'Modo treino (sem falhar)', kind: 'toggle',
      get: function () { return !!setting('noFail', false); },
      set: function (v) { setSetting('noFail', v); }
    });
    row(col2, {
      label: 'Canhoto (inverte as raias)', kind: 'toggle',
      get: function () { return !!setting('lefty', false); },
      set: function (v) { setSetting('lefty', v); }
    });
    row(col2, {
      label: 'Inverter palhetada', kind: 'toggle',
      get: function () { return !!setting('invertStrum', false); },
      set: function (v) { setSetting('invertStrum', v); }
    });
    row(col2, {
      label: 'Reverb', kind: 'choice',
      options: [{ v: 'clube', label: 'Clube' }, { v: 'arena', label: 'Arena' }],
      get: function () { return setting('reverbIR', 'clube'); },
      set: function (v) { setSetting('reverbIR', v); call('Audio', 'setReverbIR', v); }
    });

    /* ---- COLUNA 3: controles ---------------------------------------- */
    add(col3, mk('div', 'st-h', 'Controles'));
    var BINDS = [
      { a: 'fret0', l: 'Raia 1 · verde' }, { a: 'fret1', l: 'Raia 2 · vermelho' },
      { a: 'fret2', l: 'Raia 3 · amarelo' }, { a: 'fret3', l: 'Raia 4 · azul' },
      { a: 'fret4', l: 'Raia 5 · laranja' },
      { a: 'strumUp', l: 'Palhetada ↑' }, { a: 'strumDown', l: 'Palhetada ↓' },
      { a: 'starpower', l: 'Star Power' }, { a: 'pause', l: 'Pausar' }
    ];
    var BIND_LABEL = {};
    for (var kb = 0; kb < BINDS.length; kb++) {
      BIND_LABEL[BINDS[kb].a] = BINDS[kb].l;
      (function (b) {
        row(col3, {
          label: b.l, kind: 'key', action: b.a,
          get: function () { return bindingLabel(b.a); },
          set: function () {},
          onAct: function (d) { startListening(b.a, d); }
        });
      })(BINDS[kb]);
    }
    row(col3, {
      label: 'Restaurar teclas padrão', kind: 'action', hint: 'restaurar',
      get: function () { return 0; }, set: function () {},
      onAct: function () {
        call('Input', 'resetBindings'); call('Input', 'saveBindings');
        bindMsg('Teclas de volta ao padrão de fábrica.', false);
        refreshAll();
      }
    });
    row(col3, {
      label: 'Restaurar tudo', kind: 'action', hint: 'padrão',
      get: function () { return 0; }, set: function () {},
      onAct: function () { call('Settings', 'reset'); refreshAll(); }
    });

    keyMsg = add(col3, mk('div', 'st-keymsg', ''));

    /* ---- captura de tecla --------------------------------------------------
       POR QUE ACRESCENTAR EM VEZ DE SUBSTITUIR
       ----------------------------------------
       `GH.Input.setBinding(action, code)` faz `bindings[action] = [code]`.
       Um Enter a mais explorando esta coluna transformava 'Enter' na Raia 1 e
       APAGAVA 'A', '1' e 'Numpad1' de uma vez so. Dali em diante o jogador nao
       acertava mais nada e nao tinha como descobrir por que — o pior tipo de
       bug, porque parece que o jogo quebrou.

       Escolhemos ACRESCENTAR (`GH.Input.addBinding`) em vez de pedir
       confirmacao, por tres motivos:
         1. e seguro por construcao — nenhum toque acidental pode deixar uma
            acao sem tecla, entao nao existe estado "injogavel" para confirmar;
         2. um dialogo modal nao existe neste menu e seria a quarta camada de
            navegacao numa tela ja densa; alem disso ninguem le modal;
         3. o teclado padrao JA tem alternativas (A / 1 / Num 1). "Varias
            teclas por acao" e o modelo mental correto deste jogo, nao uma
            excecao inventada agora.
       Para PODAR sem dialogo: apertar a MESMA tecla de novo na mesma linha
       remove o vinculo (desde que sobre pelo menos uma tecla). E
       "Restaurar teclas padrao" continua zerando tudo de uma vez. */

    var MAX_KEYS = 6;

    /* Acoes de NAVEGACAO compartilham tecla de proposito (Enter = palhetada
       para baixo E confirmar); quem separa as duas e o contexto do GH.Input.
       Roubar a tecla delas quebraria o menu — entao nunca mexemos nelas. */
    var NAV_SAFE = { up: 1, down: 1, left: 1, right: 1, start: 1, back: 1, restart: 1 };

    function actionLabel(a) { return BIND_LABEL[a] || a; }

    /* Recado curto sobre a ultima remapeagem (entrou / saiu / recusada). */
    function bindMsg(html, bad) {
      if (!keyMsg) return;
      keyMsg.innerHTML = html;
      keyMsg.className = 'st-keymsg' + (bad ? ' bad' : '');
      tween({
        dur: 4.2,
        apply: function (u) { keyMsg.style.opacity = (u > 0.86 ? (1 - u) / 0.14 : 1).toFixed(3); },
        done: function () { keyMsg.style.opacity = '0'; }
      });
    }

    /* Quem MAIS usa este codigo hoje (fora as acoes de navegacao)? */
    function ownersOf(code, exceptAction) {
      var out = [], b = null, k;
      try { b = GH.Input && GH.Input.bindings; } catch (e) { b = null; }
      if (!b) return out;
      for (k in b) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
        if (k === exceptAction || NAV_SAFE[k]) continue;
        if (b[k] && b[k].indexOf && b[k].indexOf(code) >= 0) out.push(k);
      }
      return out;
    }

    /* Aplica a tecla capturada. Devolve true se algo mudou de verdade. */
    function applyKey(action, code) {
      var mine = bindingList(action);
      var kl = '<b>' + esc(keyLabel(code)) + '</b>';
      var i;

      /* 1) mesma tecla de novo na mesma linha => PODA */
      if (mine.indexOf(code) >= 0) {
        if (mine.length <= 1) {
          bindMsg(kl + ' é a única tecla de “' + esc(actionLabel(action)) +
                  '”. Não dá para remover — a ação ficaria sem controle.', true);
          return false;
        }
        call('Input', 'removeBinding', action, code);
        call('Input', 'saveBindings');
        bindMsg(kl + ' removida de “' + esc(actionLabel(action)) + '”.', false);
        return true;
      }

      /* 2) teto de alternativas: mais que isso vira sopa na linha */
      if (mine.length >= MAX_KEYS) {
        bindMsg('“' + esc(actionLabel(action)) + '” já tem ' + mine.length +
                ' teclas. Aperte uma delas de novo para tirá-la antes de somar outra.', true);
        return false;
      }

      /* 3) conflito com outra acao de JOGO: so tomamos a tecla se a dona
            continuar com pelo menos uma. Se for a ultima dela, recusamos —
            trocar um controle quebrado por outro nao e conserto. */
      var owners = ownersOf(code, action);
      for (i = 0; i < owners.length; i++) {
        if (bindingList(owners[i]).length <= 1) {
          bindMsg(kl + ' é a única tecla de “' + esc(actionLabel(owners[i])) +
                  '”. Escolha outra tecla.', true);
          return false;
        }
      }
      for (i = 0; i < owners.length; i++) call('Input', 'removeBinding', owners[i], code);

      call('Input', 'addBinding', action, code);
      call('Input', 'saveBindings');

      var extra = '';
      if (owners.length) extra = ' (saiu de “' + esc(actionLabel(owners[0])) + '”)';
      bindMsg(kl + ' somada a “' + esc(actionLabel(action)) + '”' + extra +
              '. As teclas antigas continuam valendo.', false);
      return true;
    }

    function stopListening() {
      if (!listening) return;
      if (listenHandler) { window.removeEventListener('keydown', listenHandler, true); listenHandler = null; }
      if (listenDef && listenDef.row) listenDef.row.classList.remove('act');
      listening = null; listenDef = null;
      call('Input', 'setEnabled', true);
      refreshAll();
    }
    function startListening(action, def) {
      stopListening();
      listening = action; listenDef = def;
      def.row.classList.add('act');
      def.render();
      bindMsg('Aperte a tecla que você quer <b>somar</b> a “' + esc(actionLabel(action)) +
              '”. A mesma tecla de novo remove. <b>Esc</b> cancela.', false);
      call('Input', 'setEnabled', false);
      listenHandler = function (ev) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        var code = ev.code || ('Key' + String.fromCharCode(ev.keyCode));
        if (code !== 'Escape') {
          if (applyKey(action, code)) sfx('uiSelect');
          else sfx('uiBack');
        } else {
          bindMsg('Remapeamento cancelado.', false);
          sfx('uiBack');
        }
        stopListening();
      };
      window.addEventListener('keydown', listenHandler, true);
    }

    function refreshAll() {
      for (var i = 0; i < rows.length; i++) { try { rows[i].render(); } catch (e) { /* ok */ } }
      updateMetroInfo();
    }
    s.refreshAll = refreshAll;
    s.stopListening = stopListening;
    s.isListening = function () { return !!listening; };
    s.metroTap = function () {
      if (!metro.on) return false;
      /* desvio em ms em relacao a batida mais proxima */
      var p = metro.phase - Math.round(metro.phase);
      var ms = p * (60000 / metro.bpm);
      metro.taps.push(ms);
      if (metro.taps.length > 12) metro.taps.shift();
      var sum = 0;
      for (var i = 0; i < metro.taps.length; i++) sum += metro.taps[i];
      metro.avg = sum / metro.taps.length;
      updateMetroInfo();
      sfx('uiMove');
      return true;
    };

    var n1 = add(col1, mk('div', 'st-note'));
    n1.innerHTML = '<span class="t">Como calibrar</span>' +
      'Ligue o metrônomo e toque <b>Enter</b> junto com a batida umas dez vezes — ' +
      'com o teste ligado, <b>Enter</b> é sempre batida. Aperte <b>Esc</b> para parar ' +
      '(a medida fica guardada) e depois <b>aplicar desvio medido</b>: ' +
      'o jogo compensa sozinho.';
    var n2 = add(col2, mk('div', 'st-note'));
    n2.innerHTML = '<span class="t">Qualidade</span>' +
      '<b>Ultra</b> liga sombras suaves, bloom largo e SMAA. <b>Baixa</b> desliga sombra e ' +
      'reduz a resolução interna — use se a taxa de quadros cair. A pista continua ' +
      'legível em todos os níveis: espetáculo nunca atrapalha a jogabilidade.';
    var n3 = add(col3, mk('div', 'st-note'));
    n3.innerHTML = '<span class="t">Controle</span>' +
      'Nota = <b>traste</b> + <b>palhetada</b>: segure <b>A S D F G</b> e bata a ' +
      '<b>seta para baixo</b> (ou <b>Enter</b>). Segurar o traste sozinho só acende o aro.<br>' +
      'Remapear <b>soma</b> a tecla — as antigas continuam valendo. Aperte a mesma ' +
      'tecla de novo para tirá-la. ' +
      '<span id="gh-pad-st">Guitarra USB e gamepad são reconhecidos automaticamente.</span>';

    var foot = add(pane, mk('div', 'foot'));
    add(foot, mk('p', 'notice',
      'A calibração é o que faz um jogo de ritmo parecer justo: ajuste até a nota bater junto com o som.'));
    add(foot, mk('div', 'hints',
      '<span><b class="key">↑</b><b class="key">↓</b> linha</span>' +
      '<span><b class="key">←</b><b class="key">→</b> valor</span>' +
      '<span><b class="key">Enter</b> ativar</span>' +
      '<span><b class="key">Esc</b> voltar</span>'));

    s.parts = { cols: [col1, col2, col3], head: head, foot: foot, headR: headR };
    s.onEnter = function () {
      stopListening();
      refreshAll();
      headR.textContent = settingsReturn === 'pause' ? 'voltando para a pausa' : 'tudo é salvo automaticamente';
      setFocus(s, 0, false);
      revealList([head], { delay: 0.02, dur: 0.5, dy: -14 });
      revealList([col1, col2, col3], { delay: 0.08, step: 0.07, dur: 0.55, dy: 20 });
      revealList([n1, n2, n3], { delay: 0.24, step: 0.05, dur: 0.5, dy: 14 });
      revealList([foot], { delay: 0.32, dur: 0.5, dy: 12 });
    };
    s.onLeave = function () {
      stopListening();
      metro.on = false; metroRow.hint = 'iniciar'; metroRow.render();
      metroBox.className = 'metro';
      updateMetroInfo();
    };
    s.onBack = function () {
      if (listening) { stopListening(); return; }
      if (metro.on) {
        metro.on = false; metroRow.hint = 'iniciar'; metroRow.render();
        metroBox.className = 'metro';
        updateMetroInfo();
        /* Parou o teste com medida na mao: o proximo passo obvio e aplicar.
           Deixamos o foco exatamente na linha "Aplicar desvio medido". */
        if (metro.taps.length) setFocus(s, 3, false);
        return;
      }
      if (settingsReturn === 'pause') { showScreen('pause'); return; }
      emitChoose('title');
    };
    s.built = true;
    return s;
  }

  /* Abre a configuracao SEM trocar o estado do GH.Game (usado a partir da
     pausa: o jogo continua pausado, so a camada de menu troca). */
  function openSettings(from) {
    settingsReturn = from || 'title';
    showScreen('settings');
  }

  /* =========================================================================
     17. TROCA DE TELA
     ========================================================================= */

  function hideAll() {
    if (current) {
      settleTweens();
      if (current.onLeave) { try { current.onLeave(); } catch (e) { /* ok */ } }
      current.el.classList.remove('on');
    }
    var k;
    for (k in screens) {
      if (Object.prototype.hasOwnProperty.call(screens, k)) screens[k].el.classList.remove('on');
    }
    current = null;
  }

  function showScreen(name, arg) {
    var s = screens[name];
    if (!s) return null;
    if (current === s) {
      /* re-entrada no mesmo estado: refaz a entrada (o Game pode reabrir) */
      settleTweens();
    } else {
      hideAll();
    }
    current = s;
    s.el.classList.add('on');
    if (s.onEnter) { try { s.onEnter(arg); } catch (e) { /* ok */ } }
    /* rede de seguranca em tempo REAL: se por qualquer motivo o updater nao
       estiver girando, a tela ainda assim assenta no estado final. */
    if (safetyTimer) { try { clearTimeout(safetyTimer); } catch (e2) { /* ok */ } }
    safetyTimer = setTimeout(function () { safetyTimer = 0; settleTweens(); }, 3400);
    return s;
  }

  /* =========================================================================
     18. NAVEGACAO
     ========================================================================= */

  function move(dir) {
    if (!current || !current.items.length) return;
    var s = current;
    var it = s.items[s.idx];
    if (s.name === 'settings') {
      if (dir === 'up') setFocus(s, s.idx - 1, false);
      else if (dir === 'down') setFocus(s, s.idx + 1, false);
      else nudge(s, it, dir === 'right' ? 1 : -1);
      return;
    }
    if (s.axis === 'x') {
      if (dir === 'left' || dir === 'up') setFocus(s, s.idx - 1, false);
      else setFocus(s, s.idx + 1, false);
      return;
    }
    if (dir === 'up') setFocus(s, s.idx - 1, false);
    else if (dir === 'down') setFocus(s, s.idx + 1, false);
    else if (dir === 'left') nudge(s, it, -1);
    else if (dir === 'right') nudge(s, it, 1);
  }

  function confirm() {
    if (!current || !current.items.length) return;
    var s = current;
    var it = s.items[s.idx];
    /* Metronomo ligado: Enter e SEMPRE "toque na batida", em qualquer linha.
       Sem excecao — a excecao era justamente o bug (ver o comentario grande em
       buildSettings). Para sair do teste: Esc. */
    if (s.name === 'settings' && metro.on) {
      if (s.metroTap && s.metroTap()) return;
    }
    activate(s, it, null);
  }

  function back() {
    if (!current) return;
    sfx('uiBack');
    if (current.onBack) { try { current.onBack(); } catch (e) { /* ok */ } }
  }

  /* ESC dentro da configuracao aberta A PARTIR DA PAUSA nao pode chegar ao
     GH.Input (la ele significa "despausar"). Interceptamos na fase de captura,
     que roda antes do listener do input. */
  function globalKeyCapture(ev) {
    if (!current) return;
    var isEsc = (ev.code === 'Escape' || ev.key === 'Escape');
    if (!isEsc) return;
    if (current.name === 'settings' && (settingsReturn === 'pause' || (current.isListening && current.isListening()) || metro.on)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      back();
    }
  }

  /* Teclado proprio — so entra em cena se o GH.Game nao existir para rotear
     (ferramentas de teste, paginas isoladas). Nunca duplica o fluxo normal. */
  function standaloneKey(ev) {
    if (GH.Game) return;
    if (!current) return;
    var c = ev.code;
    if (c === 'ArrowUp') { move('up'); sfx('uiMove'); }
    else if (c === 'ArrowDown') { move('down'); sfx('uiMove'); }
    else if (c === 'ArrowLeft') { move('left'); sfx('uiMove'); }
    else if (c === 'ArrowRight') { move('right'); sfx('uiMove'); }
    else if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') confirm();
    else if (c === 'Escape' || c === 'Backspace') back();
    else return;
    ev.preventDefault();
  }

  /* =========================================================================
     19. FRISO MARAJOARA COMO MASCARA CSS
     Reaproveita a textura ja gerada por GH.Materials (nao duplicamos nada).
     ========================================================================= */

  function buildFriezeMask() {
    try {
      var band = marajoaraCanvas();
      if (!band) return '';
      /* recorta a faixa central e reduz: mascara leve, sem serrilha */
      var w = 512, h = 96;
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var g = cv.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.drawImage(band, 0, band.height * 0.10, band.width, band.height * 0.80, 0, 0, w, h);
      return 'url(' + cv.toDataURL('image/png') + ')';
    } catch (e) { return ''; }
  }

  function applyFriezes() {
    if (!friezeMask) return;
    var list = root.querySelectorAll('.frieze');
    for (var i = 0; i < list.length; i++) {
      list[i].style.webkitMaskImage = friezeMask;
      list[i].style.maskImage = friezeMask;
    }
  }

  /* =========================================================================
     20. CICLO
     ========================================================================= */

  function update(dt) {
    if (!inited) return;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;
    clockAccum += dt;

    stepTweens(dt);

    /* metronomo visual */
    if (metro.on && metro.el) {
      metro.phase += dt * (metro.bpm / 60);
      var b = Math.floor(metro.phase);
      if (b !== metro.beat) {
        metro.beat = b;
        metro.flash = 1;
        sfx('uiMove');
      }
      metro.flash = Math.max(0, metro.flash - dt * 5.0);
      var frac = metro.phase - Math.floor(metro.phase);
      var idx = ((b % 4) + 4) % 4;
      for (var i = 0; i < metro.el.dots.length; i++) {
        metro.el.dots[i].className = 'bt' + (i === idx ? ' hot' : '');
        metro.el.dots[i].style.transform = (i === idx)
          ? 'scale(' + (1 + metro.flash * 0.45).toFixed(3) + ')' : '';
      }
      metro.el.dot.style.left = 'calc(' + (frac * 100).toFixed(1) + '% - ' +
        (frac * 0.5).toFixed(2) + 'em)';
    }

    /* canvases que ainda nao tinham tamanho quando foram pedidos */
    if (pendingLayout.length) {
      for (var p = pendingLayout.length - 1; p >= 0; p--) {
        var ok = false;
        try { ok = pendingLayout[p](); } catch (e) { ok = true; }
        if (ok) pendingLayout.splice(p, 1);
      }
    }
  }

  function onResize() {
    if (current === screens.results && screens.results && screens.results._chartJob) {
      pendingLayout.push(screens.results._chartJob);
    }
  }

  /* =========================================================================
     21. INIT
     ========================================================================= */

  function init(container) {
    if (inited) return GH.Menus;
    var host = container || document.getElementById('gh-ui') || document.body;

    /* folha da marca do estudio: global e idempotente (o main.js tambem chama,
       porque a tela de carregamento nasce antes de qualquer menu) */
    brandInjectCss();

    styleEl = document.createElement('style');
    styleEl.id = 'gh-menus-css';
    document.head.appendChild(styleEl);

    root = mk('div');
    root.id = 'gh-menus';
    host.appendChild(root);

    /* paleta em variaveis CSS (idempotente — o main.js tambem chama) */
    call('Palette', 'applyCssVars');

    refreshSongs();
    try {
      var pref = setting('difficulty', 'medio');
      if (DIFF_INFO[pref]) selectedDifficulty = pref;
    } catch (e) { /* ok */ }

    buildTitle();
    buildSongSelect();
    buildDifficulty();
    buildResults();
    buildPause();
    buildSettings();
    buildCredits();

    styleEl.textContent = CSS.join('');

    friezeMask = buildFriezeMask();
    applyFriezes();

    window.addEventListener('keydown', globalKeyCapture, true);
    window.addEventListener('keydown', standaloneKey, false);
    window.addEventListener('resize', onResize, false);

    /* Somos auto-conduzidos: o GH.Game respeita `selfDriven` e nao chama
       update() de novo (evita dois passos de animacao por frame). */
    call('Engine', 'addUpdater', update);

    inited = true;
    GH.Menus.ready = true;
    return GH.Menus;
  }

  function dispose() {
    if (!inited) return;
    try { window.removeEventListener('keydown', globalKeyCapture, true); } catch (e) { /* ok */ }
    try { window.removeEventListener('keydown', standaloneKey, false); } catch (e) { /* ok */ }
    try { window.removeEventListener('resize', onResize, false); } catch (e) { /* ok */ }
    call('Engine', 'removeUpdater', update);
    try { if (root && root.parentNode) root.parentNode.removeChild(root); } catch (e) { /* ok */ }
    try { if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); } catch (e) { /* ok */ }
    screens = {}; current = null; inited = false;
    GH.Menus.ready = false;
  }

  /* =========================================================================
     22. API PUBLICA (contrato da secao 6)
     ========================================================================= */

  GH.Menus = {
    /* o GH.Game nao deve chamar update() por nos: ja estamos no updater do
       engine, e animar duas vezes por frame dobraria a velocidade da UI */
    selfDriven: true,
    ready: false,

    init: init,
    dispose: dispose,
    update: update,

    showTitle: function () { return showScreen('title'); },
    showSongSelect: function () { return showScreen('songselect'); },
    showDifficulty: function (song) { return showScreen('difficulty', song); },
    showResults: function (stats) { return showScreen('results', stats); },
    showPause: function () { return showScreen('pause'); },
    showSettings: function () { settingsReturn = 'title'; return showScreen('settings'); },
    showCredits: function () { return showScreen('credits'); },
    hideAll: hideAll,

    /* navegacao — o GH.Game prefere estes se existirem */
    move: move,
    nav: move,
    confirm: confirm,
    back: back,

    onChoose: function (fn) {
      if (typeof fn === 'function' && chooseHandlers.indexOf(fn) < 0) chooseHandlers.push(fn);
      return fn;
    },
    offChoose: function (fn) {
      var i = chooseHandlers.indexOf(fn);
      if (i >= 0) chooseHandlers.splice(i, 1);
    },

    /* consultas uteis para outros modulos e ferramentas */
    get state() { return current ? current.name : ''; },
    get song() { return currentSong(); },
    get difficulty() { return selectedDifficulty; },
    selectSong: function (idOrIndex) {
      var i;
      if (typeof idOrIndex === 'number') i = idOrIndex;
      else { for (i = 0; i < songList.length; i++) if (songList[i].id === idOrIndex) break; }
      if (i >= 0 && i < songList.length) {
        selectedSongIdx = i;
        if (current === screens.songselect) setFocus(screens.songselect, i, false);
      }
      return currentSong();
    },
    selectDifficulty: function (d) {
      if (DIFF_INFO[d]) selectedDifficulty = d;
      return selectedDifficulty;
    },
    /* usados por ferramentas de captura/depuracao */
    settle: settleTweens,
    coverCanvas: coverOf,
    bestOf: bestOf,
    root: null,
    debug: function () {
      return {
        screen: current ? current.name : '',
        items: current ? current.items.length : 0,
        focus: current ? current.idx : -1,
        songs: songList.length,
        song: (currentSong() || {}).id || '',
        difficulty: selectedDifficulty,
        tweens: tweens.length,
        frieze: !!friezeMask,
        pendingCharts: pendingLayout.length
      };
    }
  };

  /* `root` so existe depois do init; expomos via getter para ferramentas. */
  Object.defineProperty(GH.Menus, 'root', {
    get: function () { return root; }, enumerable: false, configurable: true
  });

})(window.GH = window.GH || {});

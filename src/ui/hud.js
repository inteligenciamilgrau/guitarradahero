/* ===========================================================================
   GUITARRADA HERO — src/ui/hud.js
   ---------------------------------------------------------------------------
   A interface DURANTE a musica, em HTML/CSS por cima do canvas WebGL.
   Texto em HTML e muito mais nitido que texto em textura — e o unico jeito de
   ter tipografia de nivel AAA num jogo em Three.js.

   CONTRATO (secao 6 do ARCHITECTURE.md):
     GH.HUD = { init(container), update(dt), show(), hide(),
                setSong(song, difficulty), event(e), reset() }

   PECAS
   -----
     placar          numero grande com odometro: cada digito troca sozinho,
                     deslizando, com contorno duro e halo quente
     multiplicador   medalhao com anel de progresso (quantas notas faltam para
                     o proximo nivel) e tratamento visual proprio por nivel
     sequencia       contador com tranco de incremento e marcos comemorativos
     rock meter      medidor VERTICAL com zonas verde/amarela/vermelha,
                     liquido com mola (overshoot), ponteiro e alerta pulsante
     star power      medidor vertical dividido nas 4 frases, brilho aos 50%
                     ("PODE ATIVAR") e um estado ATIVO completamente diferente
     progresso       barra fina com marcadores de secao e das frases de SP
     julgamento      PERFEITO! / BOM / ERROU saindo da raia acertada
     info da musica  titulo, artista, genero, dificuldade e a homenagem
     aviso didatico  selo permanente, discreto
     contagem        3 · 2 · 1 · VAI!

   DECISOES TECNICAS QUE IMPORTAM
   ------------------------------
   1. TUDO e animado em JavaScript dentro de update(dt) — NUNCA por
      `transition` ou `@keyframes`. Motivo concreto: o modo captura roda a
      simulacao inteira num unico bloco sincrono e so depois deixa o TEMPO
      VIRTUAL do Chromium correr ate o screenshot. Qualquer animacao CSS teria
      terminado antes do print (e ficaria no estado final, invisivel).
      Animando por dt, o frame capturado e exatamente o frame simulado.
   2. So mexemos em `transform`, `opacity` e `clip-path` no loop quente. As
      barras crescem por translate dentro de um clipe com overflow:hidden, e
      NAO por scaleY — assim o gradiente nao estica (o defeito classico).
   3. Texto so e reescrito quando o valor exibido MUDA. A raiz tem
      `contain:layout style`, entao nem a troca de um digito reflui a pagina.
   4. Nada de getComputedStyle no loop: as cores da paleta sao lidas UMA vez
      (e de novo quando GH.Palette troca de tema) e guardadas em `COL`.
   5. Cor vem SEMPRE de GH.Palette. Os unicos literais aqui sao pretos e
      brancos de sombra/vidro, que nao pertencem a identidade cromatica.
   =========================================================================== */
(function (GH) {
  'use strict';

  /* =========================================================================
     0. MATEMATICA LOCAL
     ========================================================================= */

  var _abs = Math.abs, _min = Math.min, _max = Math.max, _round = Math.round,
      _floor = Math.floor, _exp = Math.exp, _sin = Math.sin;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function easeOutCubic(t) { t = 1 - t; return 1 - t * t * t; }
  function easeOutQuint(t) { t = 1 - t; return 1 - t * t * t * t * t; }
  function easeOutBack(t, s) {
    s = (s === undefined) ? 1.70158 : s;
    t = t - 1;
    return t * t * ((s + 1) * t + s) + 1;
  }
  /* Aproximacao exponencial estavel em qualquer frame rate. */
  function damp(cur, target, lambda, dt) {
    return target + (cur - target) * _exp(-lambda * dt);
  }

  /* =========================================================================
     1. CONSTANTES DE COMPORTAMENTO
     ========================================================================= */

  var STREAK_PER_STEP = 10;     // notas para subir um nivel de multiplicador
  var MAX_BASE_MULT   = 4;      // 1x -> 4x (8x com Star Power)
  var SP_ACTIVATE_MIN = 0.5;    // metade do medidor libera a ativacao

  var DANGER_H        = 0.32;   // abaixo disto o rock meter entra em alerta
  var CRITICAL_H      = 0.16;   // abaixo disto o alerta vira panico

  var FLOAT_POOL      = 16;     // julgamentos flutuantes simultaneos
  var FLOAT_LIFE      = 1.02;
  var FLOAT_LIFE_MISS = 1.25;   // o erro fica um pouco mais na tela
  /* A raia so recebe um julgamento novo depois que o anterior sumiu — dois
     textos empilhados na mesma raia viram borrao ilegivel. */
  var FLOAT_CD_LANE   = 0.80;
  /* 0,13 s de intervalo com 0,88 s de vida deixava ate SETE julgamentos vivos
     ao mesmo tempo: no print de acordes sairam dois "PERFEITO!" empilhados na
     diagonal. Com 0,34 s praticamente nunca ha mais de um legivel na tela. */
  var FLOAT_CD_ANY    = 0.34;   // intervalo minimo global
  var DIGIT_ROLL      = 0.17;   // duracao do giro de um digito
  var DIGIT_COOL      = 0.20;   // digito que troca mais rapido que isso nao gira

  /* Rodape de ajuda: quanto tempo o lembrete "traste + palhetada" fica na tela
     na PRIMEIRA musica da sessao, e em que instante ele comeca a sumir. */
  var TUT_HOLD        = 6.4;    // segundos de musica com o texto cheio
  var TUT_END         = 8.0;    // fim da janela (~8 s, como pedido)

  var SECTION_POP     = 1.9;    // duracao do destaque do nome da secao
  var MILESTONE_LIFE  = 1.6;
  var COUNT_LIFE      = 0.95;
  var RING_C          = 263.894;  // 2*PI*42, o raio do anel do medalhao

  /* Marcos comemorativos da sequencia (os classicos do genero). */
  var MILESTONES = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];

  var DIFF_LABEL = {
    facil: 'FÁCIL', medio: 'MÉDIO', dificil: 'DIFÍCIL', guitarrada: 'GUITARRADA'
  };

  /* =========================================================================
     2. FOLHA DE ESTILO — tudo escopado em #gh-hud.
     Medidas em % e vmin: a mesma composicao de 1280x720 a 4K.
     ========================================================================= */

  var CSS = [
    /* ------------------------------------------------------------------ raiz */
    '#gh-hud{position:absolute;inset:0;z-index:20;pointer-events:none;overflow:hidden;',
    'contain:layout style;opacity:0;visibility:hidden;color:#eef2ff;',
    '-webkit-font-smoothing:antialiased;font-kerning:normal;',
    '--ghh-ui:"Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif;',
    '--ghh-display:"Segoe UI Black","Arial Black","Franklin Gothic Heavy",Impact,"Segoe UI",system-ui,sans-serif;',
    '--ghh-gold:var(--gh-gold,#ffcf4a);',
    '--ghh-acc:var(--gh-ui-accent,#ff3d8a);',
    '--ghh-neon:var(--gh-neon,#25e8ce);',
    '--ghh-spc:var(--gh-sp,#8fd8ff);',
    '--ghh-dim:var(--gh-textDim,#95a0c0);',
    '--ghh-faint:var(--gh-textFaint,#5a6485);',
    '--ghh-danger:var(--gh-danger,#ff3b4e);',
    '--ghh-ok:var(--gh-success,#39e08a);',
    '--ghh-glass:linear-gradient(158deg,rgba(19,24,44,.80) 0%,rgba(6,8,16,.88) 100%);',
    '--ghh-edge:rgba(255,255,255,.11);',
    'font-family:var(--ghh-ui)}',
    '#gh-hud *{box-sizing:border-box;margin:0;padding:0;font:inherit;color:inherit}',
    '#gh-hud .k{font-weight:700;letter-spacing:.32em;text-transform:uppercase;',
    'font-size:clamp(8px,1.16vmin,15px);color:var(--ghh-dim);',
    'text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 10px rgba(0,0,0,.8)}',

    /* ======================================================== INFO DA MUSICA */
    '#gh-hud .ghh-song{position:absolute;left:0;top:2.7%;max-width:28%;min-width:20%;',
    'filter:drop-shadow(0 .9vmin 2.4vmin rgba(0,0,0,.78))}',
    '#gh-hud .ghh-song-in{position:relative;padding:1.15vmin 1.7vmin 1.25vmin 1.7vmin;',
    'background:var(--ghh-glass);',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.09),inset -1px 0 0 rgba(255,255,255,.06);',
    'clip-path:polygon(0 0,100% 0,100% calc(100% - 1.3vmin),calc(100% - 1.3vmin) 100%,0 100%)}',
    /* faixa marajoara: trama geometrica paraense, nao uma barrinha lisa */
    '#gh-hud .ghh-song-in::before{content:"";position:absolute;left:0;top:0;bottom:0;width:.5vmin;',
    'background:repeating-linear-gradient(180deg,var(--ghh-acc) 0 .46vmin,rgba(0,0,0,.55) .46vmin .68vmin,',
    'var(--ghh-neon) .68vmin 1.14vmin,rgba(0,0,0,.55) 1.14vmin 1.36vmin)}',
    '#gh-hud .ghh-song-title{font-family:var(--ghh-display);font-weight:900;',
    'font-size:clamp(13px,2.30vmin,30px);line-height:1.05;letter-spacing:-.014em;',
    'text-transform:uppercase;color:#fff;',
    'text-shadow:0 1px 0 rgba(0,0,0,.95),0 3px 10px rgba(0,0,0,.85);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#gh-hud .ghh-song-line{margin-top:.42vmin;display:flex;align-items:center;gap:.62vmin;',
    'font-size:clamp(8px,1.28vmin,16px);font-weight:600;letter-spacing:.045em;color:var(--ghh-dim);',
    'white-space:nowrap;overflow:hidden;text-shadow:0 1px 3px rgba(0,0,0,.9)}',
    '#gh-hud .ghh-song-line b{color:#dde4fb;font-weight:700}',
    '#gh-hud .ghh-sep{width:.32vmin;height:.32vmin;border-radius:50%;background:var(--ghh-acc);',
    'flex:0 0 auto}',
    '#gh-hud .ghh-song-diff{margin-top:.78vmin;display:flex;align-items:center;gap:.72vmin}',
    '#gh-hud .ghh-pill{font-weight:800;letter-spacing:.16em;text-transform:uppercase;',
    'font-size:clamp(7px,1.06vmin,13px);padding:.26vmin .66vmin;border-radius:.34vmin;',
    'background:linear-gradient(180deg,var(--ghh-acc),rgba(0,0,0,.42));color:#fff;',
    'box-shadow:0 .2vmin .6vmin rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.32);',
    'text-shadow:0 1px 2px rgba(0,0,0,.75);white-space:nowrap}',
    '#gh-hud .ghh-pips{display:flex;gap:.24vmin;align-items:center}',
    '#gh-hud .ghh-pip{width:.32vmin;height:1.0vmin;border-radius:.1vmin;',
    'background:rgba(255,255,255,.12);box-shadow:inset 0 0 0 1px rgba(0,0,0,.4)}',
    '#gh-hud .ghh-pip.on{background:linear-gradient(180deg,#fff3c8,var(--ghh-gold));',
    'box-shadow:0 0 .55vmin rgba(255,207,74,.9)}',
    '#gh-hud .ghh-song-tribute{margin-top:.68vmin;font-size:clamp(7px,1.12vmin,14px);',
    'line-height:1.3;font-style:italic;color:var(--ghh-faint);',
    'text-shadow:0 1px 3px rgba(0,0,0,.9)}',

    /* ================================================================ PLACAR */
    '#gh-hud .ghh-score{position:absolute;right:2.1%;top:2.5%;',
    'display:flex;flex-direction:column;align-items:flex-end}',
    '#gh-hud .ghh-score-kick{display:flex;align-items:center;gap:.75vmin;margin-bottom:.1vmin}',
    '#gh-hud .ghh-score-kick i{display:block;width:3.2vmin;height:1px;',
    'background:linear-gradient(90deg,transparent,var(--ghh-gold))}',
    '#gh-hud .ghh-score-num{font-family:var(--ghh-display);font-weight:900;',
    'font-size:clamp(30px,7.4vmin,98px);line-height:1;',
    'display:flex;align-items:flex-start;justify-content:flex-end;',
    'transform-origin:100% 40%;will-change:transform;',
    'filter:drop-shadow(0 .26vmin 0 rgba(0,0,0,.95)) drop-shadow(0 0 .24vmin rgba(0,0,0,.95))',
    ' drop-shadow(0 .7vmin 1.8vmin rgba(0,0,0,.65)) drop-shadow(0 0 2.8vmin rgba(255,170,50,.32))}',
    '#gh-hud .ghh-dslot{position:relative;display:inline-block;flex:0 0 auto;',
    'width:.645em;height:1.1em;overflow:hidden}',
    '#gh-hud .ghh-dslot span{position:absolute;left:0;right:0;top:0;height:1.1em;',
    'line-height:1.1em;text-align:center;will-change:transform,opacity;',
    'background:linear-gradient(177deg,#ffffff 2%,#fff1c6 30%,var(--ghh-gold) 66%,#ff8f22 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent}',
    '#gh-hud .ghh-dgap{display:inline-block;flex:0 0 auto;width:.17em}',
    '#gh-hud .ghh-score-under{display:flex;align-items:center;gap:.85vmin;margin-top:.45vmin;',
    'font-size:clamp(8px,1.22vmin,15px);font-weight:700;letter-spacing:.14em;',
    'color:var(--ghh-dim);text-transform:uppercase;text-shadow:0 1px 3px rgba(0,0,0,.95)}',
    '#gh-hud .ghh-score-under b{color:#fff;font-weight:800;font-variant-numeric:tabular-nums}',
    '#gh-hud .ghh-score-under u{display:block;width:1px;height:1.2vmin;',
    'background:rgba(255,255,255,.2);text-decoration:none}',
    '#gh-hud .ghh-stars{display:flex;gap:.36vmin;margin-top:.62vmin;',
    'filter:drop-shadow(0 1px 2px rgba(0,0,0,.95))}',
    '#gh-hud .ghh-star{position:relative;width:2.0vmin;height:2.0vmin}',
    '#gh-hud .ghh-star b,#gh-hud .ghh-star i{position:absolute;inset:0;display:block;',
    'background-repeat:no-repeat;background-position:center;background-size:100% 100%}',
    '#gh-hud .ghh-star b{background-image:var(--ghh-star-off)}',
    '#gh-hud .ghh-star i{background-image:var(--ghh-star-on);will-change:clip-path;',
    'clip-path:inset(0 100% 0 0)}',

    /* ============================================================ PROGRESSO */
    '#gh-hud .ghh-prog{position:absolute;left:50%;top:2.6%;width:30%;',
    'transform:translateX(-50%);display:flex;flex-direction:column;align-items:center}',
    /* veu proprio: no fundo do palco tem telao de LED e refletor branco, e sem
       isto a barra de progresso some sobre o cenario claro */
    '#gh-hud .ghh-prog::before{content:"";position:absolute;z-index:-1;',
    'left:-26%;right:-26%;top:-2.8vmin;bottom:-1.8vmin;',
    'background:radial-gradient(ellipse 56% 108% at 50% 42%,rgba(2,3,9,.90) 0%,',
    'rgba(2,3,9,.72) 40%,rgba(2,3,9,.30) 72%,rgba(2,3,9,0) 100%)}',
    '#gh-hud .ghh-prog-track{position:relative;width:100%;height:.8vmin;border-radius:99px;',
    'background:rgba(3,5,12,.92);overflow:hidden;',
    'box-shadow:inset 0 0 0 1px rgba(255,255,255,.24),0 .3vmin 1.2vmin rgba(0,0,0,.85)}',
    '#gh-hud .ghh-prog-clip{position:absolute;inset:0;overflow:hidden}',
    '#gh-hud .ghh-prog-fill{position:absolute;inset:0;',
    'background:linear-gradient(90deg,var(--ghh-neon),var(--ghh-gold) 58%,var(--ghh-acc));',
    'will-change:transform}',
    '#gh-hud .ghh-spseg{position:absolute;top:0;bottom:0;',
    'background:linear-gradient(180deg,#ffffff,var(--ghh-spc));opacity:.9}',
    '#gh-hud .ghh-tick{position:absolute;top:0;bottom:0;width:1px;background:rgba(0,0,0,.55);',
    'box-shadow:1px 0 0 rgba(255,255,255,.28)}',
    '#gh-hud .ghh-prog-head{position:absolute;left:0;top:.4vmin;width:1.05vmin;height:1.05vmin;',
    'margin:-.525vmin 0 0 -.525vmin;border-radius:50%;background:#fff;will-change:transform;',
    'box-shadow:0 0 .8vmin #fff,0 0 2.4vmin var(--ghh-gold)}',
    '#gh-hud .ghh-prog-meta{margin-top:.42vmin;width:100%;display:flex;',
    'justify-content:space-between;font-size:clamp(7px,1.06vmin,13px);font-weight:800;',
    'letter-spacing:.16em;color:rgba(205,214,238,.78);font-variant-numeric:tabular-nums;',
    'text-shadow:0 1px 0 rgba(0,0,0,.95),0 0 .9vmin rgba(0,0,0,1)}',
    '#gh-hud .ghh-section{margin-top:.55vmin;text-align:center;will-change:transform,opacity;',
    'font-family:var(--ghh-display);font-weight:900;text-transform:uppercase;',
    'font-size:clamp(9px,1.72vmin,22px);letter-spacing:.24em;text-indent:.24em;color:#e6ecff;',
    'white-space:nowrap;opacity:0;',
    'text-shadow:0 1px 0 rgba(0,0,0,.95),0 2px 9px rgba(0,0,0,.9)}',
    '#gh-hud .ghh-section.hot{color:#fff;',
    'text-shadow:0 1px 0 rgba(0,0,0,.95),0 2px 9px rgba(0,0,0,.9),0 0 2.4vmin var(--ghh-gold)}',

    /* =============================================== MEDIDORES (rock / sp) */
    '#gh-hud .ghh-gauge{position:absolute;top:31.5%;height:47%;width:7.8vmin;',
    'display:flex;flex-direction:column;align-items:center}',
    '#gh-hud .ghh-rock{left:2.3%}',
    '#gh-hud .ghh-spg{right:2.3%}',
    '#gh-hud .ghh-tube{position:relative;flex:1 1 auto;width:4.6vmin;border-radius:.9vmin;',
    'overflow:hidden;background:linear-gradient(180deg,rgba(3,4,10,.9),rgba(9,11,22,.94));',
    'box-shadow:inset 0 0 0 1px rgba(255,255,255,.13),inset 0 .3vmin 1vmin rgba(0,0,0,.85),',
    '0 .5vmin 2vmin rgba(0,0,0,.65)}',
    '#gh-hud .ghh-zones{position:absolute;inset:0;background:linear-gradient(0deg,',
    'rgba(255,36,56,.34) 0%,rgba(255,36,56,.18) 24%,rgba(255,210,74,.16) 26%,',
    'rgba(255,210,74,.11) 49%,rgba(57,224,138,.11) 51%,rgba(57,224,138,.05) 100%)}',
    '#gh-hud .ghh-liquid{position:absolute;left:0;right:0;bottom:0;height:100%;',
    'will-change:transform;background-image:linear-gradient(180deg,rgba(255,255,255,.62) 0%,',
    'rgba(255,255,255,.14) 5%,rgba(255,255,255,0) 20%,rgba(0,0,0,.34) 100%)}',
    '#gh-hud .ghh-men{position:absolute;left:0;right:0;top:0;height:.42vmin;background:#fff;',
    'will-change:opacity}',
    '#gh-hud .ghh-grid{position:absolute;inset:0;background-image:repeating-linear-gradient(',
    '0deg,rgba(0,0,0,.45) 0 1px,transparent 1px 1.2vmin)}',
    '#gh-hud .ghh-gloss{position:absolute;left:0;top:0;bottom:0;width:34%;',
    'background:linear-gradient(90deg,rgba(255,255,255,.22),rgba(255,255,255,0))}',
    '#gh-hud .ghh-cursor{position:absolute;top:0;width:1.15vmin;height:1.3vmin;',
    'will-change:transform;background:#fff;',
    'filter:drop-shadow(0 0 .55vmin rgba(255,255,255,.85))}',
    '#gh-hud .ghh-rock .ghh-cursor{left:.22vmin;clip-path:polygon(0 0,100% 50%,0 100%)}',
    '#gh-hud .ghh-spg .ghh-cursor{right:.22vmin;clip-path:polygon(100% 0,0 50%,100% 100%)}',
    '#gh-hud .ghh-gauge-cap{width:4.6vmin;height:.5vmin;border-radius:99px;margin-bottom:.6vmin;',
    'background:rgba(255,255,255,.15);box-shadow:inset 0 0 0 1px rgba(0,0,0,.55)}',
    '#gh-hud .ghh-gauge-lbl{margin-top:.75vmin;text-align:center;font-weight:800;',
    'letter-spacing:.18em;font-size:clamp(7px,1.04vmin,13px);line-height:1.24;',
    'text-transform:uppercase;color:var(--ghh-dim);text-shadow:0 1px 3px rgba(0,0,0,.98)}',
    '#gh-hud .ghh-spmark{position:absolute;left:0;right:0;height:1px;background:rgba(0,0,0,.6);',
    'box-shadow:0 1px 0 rgba(255,255,255,.12)}',
    '#gh-hud .ghh-spmark.half{height:.24vmin;background:rgba(255,255,255,.62);',
    'box-shadow:0 0 .7vmin rgba(255,255,255,.55)}',
    '#gh-hud .ghh-warn{position:absolute;left:50%;top:-2.7vmin;transform:translateX(-50%);',
    'font-family:var(--ghh-display);font-weight:900;letter-spacing:.18em;white-space:nowrap;',
    'font-size:clamp(8px,1.42vmin,18px);color:var(--ghh-danger);opacity:0;',
    'text-transform:uppercase;',
    'will-change:opacity,transform;',
    'text-shadow:0 1px 0 rgba(0,0,0,.95),0 0 1.6vmin rgba(255,59,78,.95)}',
    '#gh-hud .ghh-spcall{position:absolute;right:9.4%;top:50%;text-align:right;opacity:0;',
    'transform-origin:100% 50%;will-change:transform,opacity}',
    '#gh-hud .ghh-spcall .t1{font-family:var(--ghh-display);font-weight:900;',
    'font-size:clamp(11px,2.1vmin,27px);letter-spacing:.09em;text-transform:uppercase;',
    'color:#fff;white-space:nowrap;',
    'text-shadow:0 1px 0 rgba(0,0,0,.95),0 0 1.8vmin var(--ghh-spc),0 0 4.5vmin rgba(143,216,255,.8)}',
    '#gh-hud .ghh-spcall .t2{margin-top:.42vmin;font-weight:800;letter-spacing:.2em;',
    'font-size:clamp(7px,1.06vmin,13px);color:var(--ghh-spc);text-transform:uppercase}',
    '#gh-hud .ghh-spcall .key{display:inline-block;padding:.2vmin .58vmin;border-radius:.3vmin;',
    'background:rgba(143,216,255,.16);box-shadow:inset 0 0 0 1px rgba(143,216,255,.55);color:#eaf8ff}',

    /* ================================================= MULTIPLICADOR + SEQ */
    '#gh-hud .ghh-mult{position:absolute;left:12.6%;top:60%;width:15.6vmin;height:15.6vmin;',
    'margin:-7.8vmin 0 0 -7.8vmin;will-change:transform}',
    '#gh-hud .ghh-mult svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}',
    /* A pista do anel e cortada em 10 entalhes — um por nota que falta para o
       proximo nivel. O jogador LE quantas faltam, nao so estima. */
    '#gh-hud .ghh-mult .trk{fill:none;stroke:rgba(255,255,255,.16);stroke-width:5.6;',
    'stroke-dasharray:22.39 4;transform:rotate(-90deg);transform-origin:50% 50%}',
    '#gh-hud .ghh-mult .bez{fill:none;stroke:rgba(255,255,255,.13);stroke-width:.9}',
    '#gh-hud .ghh-mult .prg{fill:none;stroke:url(#ghhMultGrad);stroke-width:5.6;',
    'stroke-linecap:round;transform:rotate(-90deg);transform-origin:50% 50%}',
    '#gh-hud .ghh-mult .spk{fill:none;stroke:#fff;stroke-width:1.7;stroke-linecap:round;',
    'transform-origin:50% 50%;opacity:0}',
    '#gh-hud .ghh-mult .ga{stop-color:#c6cfe6}#gh-hud .ghh-mult .gb{stop-color:#6f7c9c}',
    '#gh-hud .ghh-mult.l2 .ga{stop-color:#c8ffe4}#gh-hud .ghh-mult.l2 .gb{stop-color:var(--ghh-ok)}',
    '#gh-hud .ghh-mult.l3 .ga{stop-color:#fff2b8}#gh-hud .ghh-mult.l3 .gb{stop-color:#ffab21}',
    '#gh-hud .ghh-mult.l4 .ga{stop-color:#fffdee}#gh-hud .ghh-mult.l4 .gb{stop-color:#ff5f14}',
    '#gh-hud .ghh-mult.lsp .ga{stop-color:#ffffff}#gh-hud .ghh-mult.lsp .gb{stop-color:var(--ghh-spc)}',
    '#gh-hud .ghh-disc{position:absolute;inset:11.5%;border-radius:50%;display:flex;',
    'align-items:center;justify-content:center;',
    'background:radial-gradient(circle at 50% 26%,rgba(40,49,80,.96),rgba(11,14,26,.97) 58%,',
    'rgba(4,5,11,.98) 100%);',
    /* aro metalico: luz vindo de cima, sombra em baixo */
    'box-shadow:inset 0 .16vmin 0 rgba(255,255,255,.20),',
    'inset 0 -.16vmin 0 rgba(0,0,0,.85),inset 0 0 0 .12vmin rgba(255,255,255,.09),',
    'inset 0 .6vmin 1.8vmin rgba(0,0,0,.7),0 .7vmin 2.6vmin rgba(0,0,0,.8)}',
    '#gh-hud .ghh-halo{position:absolute;inset:-16%;border-radius:50%;opacity:0;',
    'will-change:opacity,transform;',
    'background:radial-gradient(circle,rgba(255,160,40,.60) 0%,rgba(255,120,20,.18) 46%,transparent 70%)}',
    '#gh-hud .ghh-mult.lsp .ghh-halo{background:radial-gradient(circle,rgba(190,240,255,.75) 0%,',
    'rgba(90,180,255,.24) 46%,transparent 70%)}',
    '#gh-hud .ghh-x{font-family:var(--ghh-display);font-weight:900;line-height:.9;',
    'font-size:clamp(20px,5.7vmin,74px);letter-spacing:-.035em;position:relative;top:.12vmin;',
    'background:linear-gradient(176deg,#ffffff 4%,#e9eeff 34%,#8e9cbe 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 .2vmin 0 rgba(0,0,0,.95)) drop-shadow(0 0 .2vmin rgba(0,0,0,.95))}',
    '#gh-hud .ghh-x small{font-size:.5em;letter-spacing:0;opacity:.9}',
    '#gh-hud .ghh-mult.l2 .ghh-x{background:linear-gradient(176deg,#f4fffa 4%,#8dffc4 40%,#12b46a 100%);',
    '-webkit-background-clip:text;background-clip:text}',
    '#gh-hud .ghh-mult.l3 .ghh-x{background:linear-gradient(176deg,#fffdf2 4%,#ffe58a 38%,#ff9d13 100%);',
    '-webkit-background-clip:text;background-clip:text}',
    '#gh-hud .ghh-mult.l4 .ghh-x{background:linear-gradient(176deg,#fffdf4 4%,#ffd45e 34%,#ff5510 100%);',
    '-webkit-background-clip:text;background-clip:text;',
    'filter:drop-shadow(0 .2vmin 0 rgba(0,0,0,.95)) drop-shadow(0 0 1.7vmin rgba(255,140,40,.9))}',
    '#gh-hud .ghh-mult.lsp .ghh-x{background:linear-gradient(176deg,#ffffff 4%,#e2f5ff 36%,#54b9ff 100%);',
    '-webkit-background-clip:text;background-clip:text;',
    'filter:drop-shadow(0 .2vmin 0 rgba(0,0,0,.95)) drop-shadow(0 0 2.1vmin rgba(143,216,255,1))}',
    '#gh-hud .ghh-mult-tag{position:absolute;left:50%;bottom:-.5vmin;transform:translateX(-50%);',
    'font-weight:800;letter-spacing:.19em;font-size:clamp(6px,.96vmin,12px);text-transform:uppercase;',
    'color:var(--ghh-dim);white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,.98);',
    'background:rgba(4,6,13,.85);padding:.2vmin .7vmin;border-radius:99px;',
    'box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}',
    '#gh-hud .ghh-mult.lsp .ghh-mult-tag{color:#dff2ff;',
    'box-shadow:inset 0 0 0 1px rgba(143,216,255,.5)}',

    '#gh-hud .ghh-streak{position:absolute;left:12.6%;top:78.2%;transform:translateX(-50%);',
    'text-align:center;width:28vmin}',
    '#gh-hud .ghh-streak-n{font-family:var(--ghh-display);font-weight:900;line-height:.94;',
    'font-size:clamp(18px,4.8vmin,62px);letter-spacing:-.02em;font-variant-numeric:tabular-nums;',
    'transform-origin:50% 60%;will-change:transform;',
    'background:linear-gradient(177deg,#ffffff 6%,#eaf0ff 40%,#93a5cf 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 .2vmin 0 rgba(0,0,0,.95)) drop-shadow(0 .5vmin 1.3vmin rgba(0,0,0,.7))}',
    '#gh-hud .ghh-streak.hot .ghh-streak-n{',
    'background:linear-gradient(177deg,#fffdf2 6%,#ffd257 44%,#ff5510 100%);',
    '-webkit-background-clip:text;background-clip:text;',
    'filter:drop-shadow(0 .2vmin 0 rgba(0,0,0,.95)) drop-shadow(0 0 1.9vmin rgba(255,150,40,.85))}',
    '#gh-hud .ghh-streak.broke .ghh-streak-n{',
    'background:linear-gradient(177deg,#fff0f1 6%,#ff8494 42%,#c1091f 100%);',
    '-webkit-background-clip:text;background-clip:text;',
    'filter:drop-shadow(0 .2vmin 0 rgba(0,0,0,.95)) drop-shadow(0 0 1.7vmin rgba(255,50,70,.9))}',
    '#gh-hud .ghh-streak-l{margin-top:.15vmin;font-weight:800;letter-spacing:.26em;',
    'text-indent:.26em;font-size:clamp(7px,1.04vmin,13px);text-transform:uppercase;',
    'color:var(--ghh-dim);text-shadow:0 1px 3px rgba(0,0,0,.98)}',
    '#gh-hud .ghh-mile{position:absolute;left:12.6%;top:71.6%;transform:translateX(-50%);',
    'white-space:nowrap;opacity:0;will-change:transform,opacity;transform-origin:50% 50%;',
    'font-family:var(--ghh-display);font-weight:900;text-transform:uppercase;',
    'font-size:clamp(10px,2.0vmin,26px);letter-spacing:.05em;color:#fff;',
    'text-shadow:0 1px 0 rgba(0,0,0,.95),0 0 1.8vmin var(--ghh-gold),0 0 4vmin rgba(255,140,40,.8)}',

    /* ================================================ JULGAMENTO FLUTUANTE */
    '#gh-hud .ghh-floats{position:absolute;inset:0}',
    '#gh-hud .ghh-fl{position:absolute;left:0;top:0;opacity:0;white-space:nowrap;',
    'transform-origin:50% 50%;will-change:transform,opacity;',
    'font-family:var(--ghh-display);font-weight:900;text-transform:uppercase;',
    'font-size:clamp(11px,2.62vmin,34px);letter-spacing:.035em;',
    /* O julgamento cai em cima da parte MAIS CLARA da pista (o clarao do
       acerto). Contorno preto em 8 direcoes + um veu escuro eliptico atras:
       com Star Power ligado a pista estoura em branco e sem isso o texto
       simplesmente desaparece. */
    'padding:.55vmin 2.1vmin;',
    'background:radial-gradient(ellipse 38% 74% at 50% 50%,rgba(0,0,0,.90) 0%,',
    'rgba(0,0,0,.70) 52%,rgba(0,0,0,0) 100%),',
    'radial-gradient(ellipse 74% 138% at 50% 50%,rgba(0,0,0,.58) 0%,rgba(0,0,0,0) 76%);',
    'text-shadow:0 0 .28vmin rgba(0,0,0,1),0 0 .28vmin rgba(0,0,0,1),',
    '0 1px 0 rgba(0,0,0,1),0 -1px 0 rgba(0,0,0,.95),1px 0 0 rgba(0,0,0,.95),',
    '-1px 0 0 rgba(0,0,0,.95),0 .28vmin .8vmin rgba(0,0,0,1),0 0 2.2vmin rgba(0,0,0,.95)}',

    /* escurecimento local atras do placar: o por do sol do palco e claro
       demais para texto dourado por cima sem perda de leitura */
    '#gh-hud .ghh-scrim{position:absolute;right:0;top:0;width:34%;height:30%;',
    'background:radial-gradient(ellipse 110% 110% at 100% 0%,rgba(2,3,9,.78) 0%,',
    'rgba(2,3,9,.46) 42%,rgba(2,3,9,0) 76%)}',
    '#gh-hud .ghh-scrim2{position:absolute;left:0;top:0;width:30%;height:26%;',
    'background:radial-gradient(ellipse 110% 110% at 0% 0%,rgba(2,3,9,.62) 0%,',
    'rgba(2,3,9,.32) 44%,rgba(2,3,9,0) 78%)}',

    /* ============================================================ CONTAGEM */
    '#gh-hud .ghh-count{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);',
    'text-align:center;opacity:0;will-change:opacity}',
    '#gh-hud .ghh-count-n{font-family:var(--ghh-display);font-weight:900;line-height:.88;',
    'font-size:clamp(60px,21vmin,280px);letter-spacing:-.04em;transform-origin:50% 50%;',
    'will-change:transform;',
    'background:linear-gradient(176deg,#ffffff 4%,#fff1c0 28%,var(--ghh-gold) 58%,#ff5510 100%);',
    '-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 .5vmin 0 rgba(0,0,0,.9)) drop-shadow(0 0 .4vmin rgba(0,0,0,.95))',
    ' drop-shadow(0 0 5vmin rgba(255,150,40,.7))}',
    '#gh-hud .ghh-count-k{margin-top:-.2vmin;font-weight:800;letter-spacing:.6em;',
    'text-indent:.6em;font-size:clamp(9px,1.5vmin,19px);text-transform:uppercase;color:#e2e9ff;',
    'text-shadow:0 1px 0 rgba(0,0,0,.95),0 0 2vmin rgba(0,0,0,.95)}',
    '#gh-hud .ghh-count-r{position:absolute;left:50%;top:46%;width:24vmin;height:24vmin;',
    'margin:-12vmin 0 0 -12vmin;border-radius:50%;opacity:0;will-change:transform,opacity;',
    'box-shadow:0 0 0 .28vmin rgba(255,255,255,.7),0 0 4vmin rgba(255,207,74,.55)}',

    /* ======================================================= CAMADAS DE ESTADO */
    '#gh-hud .ghh-aura{position:absolute;inset:0;opacity:0;will-change:opacity;',
    'background:radial-gradient(ellipse 76% 60% at 50% 58%,rgba(143,216,255,0) 40%,',
    'rgba(90,180,255,.22) 76%,rgba(28,86,196,.50) 100%)}',
    '#gh-hud .ghh-aura::before,#gh-hud .ghh-aura::after{content:"";position:absolute;',
    'left:0;right:0;height:15%;background:linear-gradient(180deg,rgba(160,225,255,.38),transparent)}',
    '#gh-hud .ghh-aura::before{top:0}',
    '#gh-hud .ghh-aura::after{bottom:0;transform:scaleY(-1)}',
    '#gh-hud .ghh-hurt{position:absolute;inset:0;opacity:0;will-change:opacity;',
    'background:radial-gradient(ellipse 72% 58% at 50% 62%,rgba(255,40,60,0) 38%,',
    'rgba(255,26,52,.26) 74%,rgba(176,6,26,.62) 100%)}',
    '#gh-hud .ghh-spband{position:absolute;left:50%;top:12.4%;opacity:0;',
    'will-change:opacity,transform;text-align:center;white-space:nowrap;',
    'font-family:var(--ghh-display);font-weight:900;text-transform:uppercase;',
    'font-size:clamp(12px,2.55vmin,34px);letter-spacing:.36em;text-indent:.36em;color:#fff;',
    'padding:.9vmin 4.5vmin;',
    /* o palco fica ESTOURADO de luz quando o Star Power liga; sem um veu
       proprio a faixa some justamente no momento mais importante */
    'background:radial-gradient(ellipse 46% 92% at 50% 50%,rgba(2,6,18,.86) 0%,',
    'rgba(2,6,18,.60) 46%,rgba(2,6,18,0) 100%);',
    'text-shadow:0 1px 0 rgba(0,0,0,.95),0 0 2.2vmin var(--ghh-spc),0 0 6vmin rgba(90,180,255,.95)}',

    /* ================================================== RODAPE DE AJUDA ====
       Duas mensagens que existem por um motivo medido, nao por enfeite:

       1) AVISO DE AUDIO — quando GH.Conductor.audioStalled fica true o jogador
          esta tocando SEM SOM e nao tem como saber por que (politica de
          autoplay, maquina sem saida de audio, fone plugado depois).
       2) COMO SE TOCA — no primeiro teste com um humano, a pessoa segurou
          A/S/D/F/G, viu o aro acender e nada acontecer, e concluiu que "o jogo
          nao registra". Nota = TRASTE + PALHETADA. Nada na tela dizia isso.

       Ficam empilhados no rodape central, longe da linha de acerto e dos
       medidores, com veu proprio: o fim da pista e claro quando ha chama. */
    '#gh-hud .ghh-foot{position:absolute;left:0;right:0;bottom:3.3%;',
    'display:flex;flex-direction:column;align-items:center;gap:1.0vmin;',
    'pointer-events:none}',
    '#gh-hud .ghh-fmsg{display:flex;align-items:center;gap:1.0vmin;white-space:nowrap;',
    'padding:.62vmin 1.7vmin;border-radius:99px;opacity:0;will-change:opacity,transform;',
    'font-size:clamp(9px,1.32vmin,17px);font-weight:600;letter-spacing:.035em;',
    'color:#dde4fb;background:linear-gradient(180deg,rgba(10,13,26,.90),rgba(4,6,13,.94));',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 .6vmin 2.2vmin rgba(0,0,0,.72);',
    'text-shadow:0 1px 3px rgba(0,0,0,.95)}',
    '#gh-hud .ghh-fmsg b.kk{display:inline-block;min-width:2.0vmin;padding:.12vmin .58vmin;',
    'margin:0 .12vmin;border-radius:.42vmin;text-align:center;font-weight:800;',
    'font-size:clamp(8px,1.20vmin,15px);color:#fff;',
    'background:linear-gradient(180deg,rgba(255,255,255,.20),rgba(255,255,255,.06));',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.26),0 1px 0 rgba(0,0,0,.6),',
    '0 0 0 1px rgba(255,255,255,.18)}',
    '#gh-hud .ghh-fmsg i{font-style:normal;font-weight:800;color:var(--ghh-gold);',
    'letter-spacing:.1em}',
    '#gh-hud .ghh-fmsg u{text-decoration:none;color:var(--ghh-dim);font-weight:700;',
    'letter-spacing:.16em;text-transform:uppercase;font-size:.86em}',
    /* variante de alerta: o aviso de audio precisa ser notado sem gritar */
    '#gh-hud .ghh-fmsg.warn{color:#ffe3b0;',
    'background:linear-gradient(180deg,rgba(46,26,6,.92),rgba(20,10,2,.95));',
    'box-shadow:inset 0 1px 0 rgba(255,220,150,.20),0 0 0 1px rgba(255,180,70,.34),',
    '0 .6vmin 2.2vmin rgba(0,0,0,.72)}',
    '#gh-hud .ghh-fmsg.warn .dot{width:.9vmin;height:.9vmin;border-radius:50%;flex:0 0 auto;',
    'background:var(--ghh-gold);box-shadow:0 0 1.4vmin var(--ghh-gold)}',
    '#gh-hud .ghh-fmsg .lane{width:.95vmin;height:.95vmin;border-radius:50%;flex:0 0 auto;',
    'box-shadow:inset 0 0 0 1px rgba(0,0,0,.55)}',

    /* ======================================================= AVISO DIDATICO */
    '#gh-hud .ghh-notice{position:absolute;right:1.9%;bottom:2.2%;',
    'font-size:clamp(7px,1.0vmin,12px);font-weight:700;letter-spacing:.17em;',
    'text-transform:uppercase;color:rgba(198,207,230,.64);',
    'background:rgba(4,6,13,.6);box-shadow:inset 0 0 0 1px rgba(255,255,255,.09);',
    'border-radius:99px;padding:.36vmin 1.0vmin;white-space:nowrap;',
    'text-shadow:0 1px 2px rgba(0,0,0,.95)}',
    '#gh-hud .ghh-notice b{color:var(--ghh-gold);font-weight:800;opacity:.85}'
  ].join('');

  /* Estrela desenhada em SVG (data-URI): nao depende do glifo do sistema, que
     muda de desenho de fonte para fonte. */
  function starDataURI(fill, stroke) {
    var d = 'M12 1.6l3.09 6.86 7.41.72-5.6 5.03 1.63 7.39L12 17.9l-6.53 3.7 1.63-7.39' +
            '-5.6-5.03 7.41-.72z';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<path d="' + d + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.2" ' +
      'stroke-linejoin="round"/></svg>';
    return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
  }

  /* =========================================================================
     3. ESTADO INTERNO
     ========================================================================= */

  var inited = false;
  var root = null;
  var D = {};                       // referencias de DOM (nada de query no loop)

  var visible = false, vis = 0, visWritten = -1;
  var clock = 0;

  /* placar */
  var scoreTarget = 0, scoreShown = 0, scoreText = '', scorePunch = 0;
  var digitSlots = [];

  /* multiplicador */
  var multValue = 1, multPunch = 0, multLevelCls = '';
  var ringShown = 0, sparkPhase = 0, haloPulse = 0;

  /* sequencia */
  var streakValue = 0, streakPunch = 0, streakHot = false, streakCls = '';
  var streakBreak = 0;
  var mileT = 0, lastMilestone = 0;

  /* rock meter */
  var healthTarget = 0.5, healthVel = 0, healthShown = 0.5;
  var warnPhase = 0, hurt = 0, healthBucket = -1;

  /* star power */
  var spTarget = 0, spShown = 0, spActive = false, spReady = false;
  var spCallPhase = 0, spPulse = 0, aura = 0, bandT = 0, spGlowWritten = -1;

  /* progresso / secao */
  var songDuration = 0, progressShown = 0;
  var sections = null, secIdx = -1, secPop = 0, secHot = false;

  /* estrelas ao vivo */
  var starsShown = 0;

  /* contagem regressiva */
  var countT = 0, countKind = '';

  /* rodape de ajuda */
  var warnShown = 0;            // opacidade suavizada do aviso de audio
  var tutShown = 0;             // opacidade suavizada do tutorial
  var tutArmed = false;         // o tutorial vale para a musica corrente?
  var tutSpent = false;         // a cortesia da sessao ja foi gasta?

  /* julgamentos */
  var floats = [];
  var floatCd = 0;
  var laneCd = [0, 0, 0, 0, 0];
  var laneX = [36.1, 43.0, 50.0, 57.0, 63.9];
  var laneY = 72.0;
  var probeT = 0;
  var _projV = null;

  /* metricas medidas (px) — evita mexer em `top`/`left` no loop */
  var M = { tubeTop: 0, tubeH: 1, trackW: 1 };

  /* musica */
  var curSong = null, curDiff = '';

  /* cache de texto ja escrito no DOM */
  var last = {};

  /* cores da paleta, lidas UMA vez (e de novo quando o tema troca) */
  var COL = {
    perfect: '#ffe45c', good: '#8fd8ff', miss: '#ff4a5a',
    spGlow: '#8fd8ff', spCore: '#f2fbff',
    danger: '#ff2438', warning: '#ffa22b', success: '#39e08a',
    star: '#ffd34a', accent: '#ff3d8a'
  };
  /* rampa do rock meter pre-calculada em 33 passos: nenhuma cor e criada no
     loop, so um indice de array. */
  var HEALTH_RAMP = [];

  /* =========================================================================
     4. HELPERS
     ========================================================================= */

  function mk(tag, cls, parent, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  }

  function setText(node, txt, key) {
    if (!node || last[key] === txt) return;
    last[key] = txt;
    node.textContent = txt;
  }

  function paletteHex(path, fallback) {
    try {
      var P = GH.Palette;
      if (P && typeof P.getHex === 'function') {
        var h = P.getHex(path);
        if (h) return h;
      }
    } catch (e) { /* fallback */ }
    return fallback;
  }

  /* Le a paleta inteira de uma vez e monta a rampa do rock meter. */
  function refreshColors() {
    COL.perfect = paletteHex('judgment.perfect', COL.perfect);
    COL.good    = paletteHex('judgment.good', COL.good);
    COL.miss    = paletteHex('judgment.miss', COL.miss);
    COL.spGlow  = paletteHex('sp.glow', COL.spGlow);
    COL.spCore  = paletteHex('sp.core', COL.spCore);
    COL.danger  = paletteHex('ui.danger', COL.danger);
    COL.warning = paletteHex('ui.warning', COL.warning);
    COL.success = paletteHex('ui.success', COL.success);
    COL.star    = paletteHex('ui.star', COL.star);
    COL.accent  = paletteHex('uiAccent', COL.accent);

    HEALTH_RAMP.length = 0;
    var P = GH.Palette, tmp = null, i, h;
    for (i = 0; i <= 32; i++) {
      h = i / 32;
      var css = null;
      try {
        if (P && typeof P.healthColor === 'function') {
          tmp = P.healthColor(h, tmp);
          if (tmp) css = '#' + tmp.getHexString();
        }
      } catch (e) { css = null; }
      if (!css) css = (h < 0.25) ? COL.danger : (h < 0.5 ? COL.warning : COL.success);
      HEALTH_RAMP.push(css);
    }
    if (root) {
      root.style.setProperty('--ghh-star-on', starDataURI(COL.star, 'rgba(255,255,255,.85)'));
    }
    healthBucket = -1;   /* forca reescrita da cor do medidor */
    spGlowWritten = -1;
  }

  function fmtTime(sec) {
    if (!(sec > 0)) sec = 0;
    var m = _floor(sec / 60), s = _floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* Cor de uma raia em CSS (para os chips A S D F G do tutorial). */
  function laneCss(i, part) {
    try {
      if (GH.Palette && typeof GH.Palette.laneCss === 'function') return GH.Palette.laneCss(i, part);
    } catch (e) { /* fallback */ }
    return ['#39e08a', '#ff3b4e', '#ffcf4a', '#4aa8ff', '#ff8a2b'][i % 5];
  }

  /* Frase de ensino: nota = TRASTE + PALHETADA.
     Os chips das 5 raias saem NA COR da raia, entao a instrucao aponta para os
     aros que o jogador esta vendo na pista em vez de virar texto abstrato. */
  function tutorialHTML() {
    var keys = ['A', 'S', 'D', 'F', 'G'], out = '', i;
    for (i = 0; i < 5; i++) {
      out += '<b class="kk" style="color:' + laneCss(i, 'glow') +
             ';box-shadow:inset 0 1px 0 rgba(255,255,255,.26),0 1px 0 rgba(0,0,0,.6),' +
             '0 0 0 1px ' + laneCss(i, 'glow') + '99">' + keys[i] + '</b>';
    }
    return out +
      '<span>nos trastes</span>' +
      '<i>+</i>' +
      '<b class="kk">&darr;</b>' +
      /* margin-right zerado no chip do Enter: com a margem padrao sobrava um
         vao feio entre a tecla e o parentese que fecha */
      '<span>Seta para baixo (ou <b class="kk" style="margin-right:0">Enter</b>) ' +
      'para palhetar</span>';
  }

  /* =========================================================================
     5. CONSTRUCAO DA INTERFACE
     ========================================================================= */

  function injectCss() {
    if (document.getElementById('gh-hud-css')) return;
    var st = document.createElement('style');
    st.id = 'gh-hud-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function build(container) {
    root = mk('div', '', container);
    root.id = 'gh-hud';
    root.style.setProperty('--ghh-star-off',
      starDataURI('rgba(255,255,255,.09)', 'rgba(255,255,255,.24)'));
    root.style.setProperty('--ghh-star-on',
      starDataURI(COL.star, 'rgba(255,255,255,.85)'));

    /* ------------------------------- camadas de estado (ao fundo) --------- */
    D.aura = mk('div', 'ghh-aura', root);
    D.hurt = mk('div', 'ghh-hurt', root);
    mk('div', 'ghh-scrim', root);
    mk('div', 'ghh-scrim2', root);

    /* ------------------------------- info da musica ----------------------- */
    var song = mk('div', 'ghh-song', root);
    var songIn = mk('div', 'ghh-song-in', song);
    D.songTitle = mk('div', 'ghh-song-title', songIn, 'Guitarrada Hero');
    var line = mk('div', 'ghh-song-line', songIn);
    D.songArtist = mk('b', '', line, '&mdash;');
    mk('span', 'ghh-sep', line);
    D.songGenre = mk('span', '', line, '&mdash;');
    var dif = mk('div', 'ghh-song-diff', songIn);
    D.songDiff = mk('span', 'ghh-pill', dif, 'Guitarrada');
    D.songPips = mk('span', 'ghh-pips', dif);
    for (var p = 0; p < 10; p++) mk('i', 'ghh-pip', D.songPips);
    D.songTribute = mk('div', 'ghh-song-tribute', songIn, '');

    /* ------------------------------- placar ------------------------------- */
    var sc = mk('div', 'ghh-score', root);
    var kick = mk('div', 'ghh-score-kick', sc);
    mk('i', '', kick);
    mk('span', 'k', kick, 'Pontos');
    D.scoreNum = mk('div', 'ghh-score-num', sc);
    D.stars = mk('div', 'ghh-stars', sc);
    D.starFill = [];
    for (var s = 0; s < 5; s++) {
      var cell = mk('div', 'ghh-star', D.stars);
      mk('b', '', cell);
      D.starFill.push(mk('i', '', cell));
    }
    var und = mk('div', 'ghh-score-under', sc);
    D.acc = mk('b', '', und, '100%');
    mk('span', '', und, 'precis&atilde;o');
    mk('u', '', und);
    D.notes = mk('b', '', und, '0/0');
    mk('span', '', und, 'notas');

    /* ------------------------------- progresso ---------------------------- */
    var pr = mk('div', 'ghh-prog', root);
    D.progTrack = mk('div', 'ghh-prog-track', pr);
    var clip = mk('div', 'ghh-prog-clip', D.progTrack);
    D.progFill = mk('div', 'ghh-prog-fill', clip);
    D.progSp = mk('div', '', D.progTrack);      /* segmentos de star power */
    D.progTicks = mk('div', '', D.progTrack);   /* marcadores de secao */
    D.progHead = mk('div', 'ghh-prog-head', pr);
    var pm = mk('div', 'ghh-prog-meta', pr);
    D.progTime = mk('span', '', pm, '0:00');
    D.progTotal = mk('span', '', pm, '0:00');
    D.section = mk('div', 'ghh-section', pr, '');

    /* ------------------------------- rock meter --------------------------- */
    var rock = mk('div', 'ghh-gauge ghh-rock', root);
    mk('div', 'ghh-gauge-cap', rock);
    D.rockTube = mk('div', 'ghh-tube', rock);
    mk('div', 'ghh-zones', D.rockTube);
    D.rockLiquid = mk('div', 'ghh-liquid', D.rockTube);
    D.rockMen = mk('div', 'ghh-men', D.rockLiquid);
    mk('div', 'ghh-grid', D.rockTube);
    mk('div', 'ghh-gloss', D.rockTube);
    D.rockCursor = mk('div', 'ghh-cursor', rock);
    D.rockWarn = mk('div', 'ghh-warn', rock, 'Perigo');
    mk('div', 'ghh-gauge-lbl', rock, 'Rock<br>Meter');

    /* ------------------------------- star power --------------------------- */
    var spg = mk('div', 'ghh-gauge ghh-spg', root);
    mk('div', 'ghh-gauge-cap', spg);
    D.spTube = mk('div', 'ghh-tube', spg);
    D.spLiquid = mk('div', 'ghh-liquid', D.spTube);
    D.spMen = mk('div', 'ghh-men', D.spLiquid);
    mk('div', 'ghh-grid', D.spTube);
    var qs = [0.25, 0.5, 0.75];
    for (var q = 0; q < qs.length; q++) {
      var mrk = mk('div', 'ghh-spmark' + (qs[q] === 0.5 ? ' half' : ''), D.spTube);
      mrk.style.bottom = (qs[q] * 100) + '%';
    }
    mk('div', 'ghh-gloss', D.spTube);
    D.spCursor = mk('div', 'ghh-cursor', spg);
    mk('div', 'ghh-gauge-lbl', spg, 'Star<br>Power');

    D.spCall = mk('div', 'ghh-spcall', root);
    D.spCallT1 = mk('div', 't1', D.spCall, 'Pode ativar');
    D.spCallT2 = mk('div', 't2', D.spCall, '<span class="key">Espa&ccedil;o</span>');

    /* ------------------------------- multiplicador ------------------------ */
    D.mult = mk('div', 'ghh-mult l1', root);
    D.halo = mk('div', 'ghh-halo', D.mult);

    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    var defs = document.createElementNS(NS, 'defs');
    var grad = document.createElementNS(NS, 'linearGradient');
    grad.setAttribute('id', 'ghhMultGrad');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    var sa = document.createElementNS(NS, 'stop');
    sa.setAttribute('offset', '0'); sa.setAttribute('class', 'ga');
    var sb = document.createElementNS(NS, 'stop');
    sb.setAttribute('offset', '1'); sb.setAttribute('class', 'gb');
    grad.appendChild(sa); grad.appendChild(sb);
    defs.appendChild(grad); svg.appendChild(defs);

    /* aro externo fino: da acabamento de peca usinada ao medalhao */
    var bez = document.createElementNS(NS, 'circle');
    bez.setAttribute('class', 'bez');
    bez.setAttribute('cx', '50'); bez.setAttribute('cy', '50'); bez.setAttribute('r', '46.6');
    svg.appendChild(bez);

    var trk = document.createElementNS(NS, 'circle');
    trk.setAttribute('class', 'trk');
    trk.setAttribute('cx', '50'); trk.setAttribute('cy', '50'); trk.setAttribute('r', '42');
    svg.appendChild(trk);

    D.ring = document.createElementNS(NS, 'circle');
    D.ring.setAttribute('class', 'prg');
    D.ring.setAttribute('cx', '50'); D.ring.setAttribute('cy', '50'); D.ring.setAttribute('r', '42');
    D.ring.setAttribute('stroke-dasharray', String(RING_C));
    D.ring.setAttribute('stroke-dashoffset', String(RING_C));
    svg.appendChild(D.ring);

    D.spark = document.createElementNS(NS, 'circle');
    D.spark.setAttribute('class', 'spk');
    D.spark.setAttribute('cx', '50'); D.spark.setAttribute('cy', '50'); D.spark.setAttribute('r', '48');
    D.spark.setAttribute('stroke-dasharray', '3 27');
    svg.appendChild(D.spark);
    D.mult.appendChild(svg);

    var disc = mk('div', 'ghh-disc', D.mult);
    D.multX = mk('div', 'ghh-x', disc, '<small>x</small>1');
    D.multTag = mk('div', 'ghh-mult-tag', D.mult, 'Multiplicador');

    /* ------------------------------- sequencia ---------------------------- */
    D.streak = mk('div', 'ghh-streak', root);
    D.streakN = mk('div', 'ghh-streak-n', D.streak, '0');
    mk('div', 'ghh-streak-l', D.streak, 'Sequ&ecirc;ncia');
    D.mile = mk('div', 'ghh-mile', root, '');

    /* ------------------------------- julgamentos -------------------------- */
    D.floats = mk('div', 'ghh-floats', root);
    for (var f = 0; f < FLOAT_POOL; f++) {
      floats.push({
        el: mk('div', 'ghh-fl', D.floats),
        t: 0, life: 1, x: 0, y: 0, sc: 1, txt: '', col: '', on: false
      });
    }

    /* ------------------------------- faixa de star power ------------------ */
    D.spBand = mk('div', 'ghh-spband', root, 'Star Power');

    /* ------------------------------- contagem ----------------------------- */
    D.count = mk('div', 'ghh-count', root);
    D.countRing = mk('div', 'ghh-count-r', D.count);
    D.countN = mk('div', 'ghh-count-n', D.count, '3');
    D.countK = mk('div', 'ghh-count-k', D.count, 'Prepare-se');

    /* ------------------------------- rodape de ajuda ---------------------- */
    var foot = mk('div', 'ghh-foot', root);
    /* ordem visual: o aviso de audio fica ACIMA do tutorial (é o mais urgente
       dos dois e some sozinho quando o som volta) */
    D.audioWarn = mk('div', 'ghh-fmsg warn', foot,
      '<span class="dot"></span><span>Som indispon&iacute;vel &mdash; ' +
      'clique para ligar o &aacute;udio</span>');
    D.tut = mk('div', 'ghh-fmsg', foot, tutorialHTML());

    /* ------------------------------- aviso didatico ----------------------- */
    mk('div', 'ghh-notice', root,
       'Projeto did&aacute;tico <b>&middot;</b> sem fins comerciais');

    rebuildScoreSlots(1);
    applyMultLevel(1, false);
  }

  /* =========================================================================
     6. PLACAR — odometro de digitos
     Cada digito e uma janela com dois textos: quando o valor muda, o antigo
     sobe e some enquanto o novo entra por baixo. Custa 2 nos por digito e roda
     inteiramente em transform/opacity.
     ========================================================================= */

  function rebuildScoreSlots(count) {
    if (!D.scoreNum) return;
    D.scoreNum.textContent = '';
    digitSlots.length = 0;
    for (var i = 0; i < count; i++) {
      var fromRight = count - i;
      if (i > 0 && fromRight % 3 === 0) mk('span', 'ghh-dgap', D.scoreNum);
      var slot = mk('span', 'ghh-dslot', D.scoreNum);
      var prev = mk('span', '', slot, '');
      var cur = mk('span', '', slot, '0');
      prev.style.opacity = '0';
      digitSlots.push({ cur: cur, prev: prev, ch: '0', anim: 0, cool: 0 });
    }
  }

  /* Regra que salva a legibilidade: um digito so GIRA se estiver trocando
     devagar. As casas baixas de um placar que sobe sem parar trocariam a cada
     frame — duas metades de algarismo empilhadas viram ruido. Essas trocam
     seco (nitidas), enquanto as casas altas ganham o giro bonito. */
  function pushScoreText(txt) {
    if (txt === scoreText) return;
    if (txt.length !== digitSlots.length) rebuildScoreSlots(txt.length);
    for (var i = 0; i < digitSlots.length; i++) {
      var d = digitSlots[i];
      var c = txt.charAt(i);
      if (d.ch === c) continue;
      var old = d.ch;
      d.ch = c;
      d.cur.textContent = c;
      if (d.cool > 0) {
        /* troca seca: nitida, sem giro */
        d.anim = 0;
        d.cur.style.transform = 'translateY(0%)';
        d.cur.style.opacity = '1';
        d.prev.style.opacity = '0';
      } else {
        d.prev.textContent = old;
        d.anim = 1;
      }
      d.cool = DIGIT_COOL;
    }
    scoreText = txt;
  }

  function updateScoreSlots(dt) {
    var k = dt / DIGIT_ROLL;
    for (var i = 0; i < digitSlots.length; i++) {
      var d = digitSlots[i];
      if (d.cool > 0) { d.cool -= dt; if (d.cool < 0) d.cool = 0; }
      if (d.anim <= 0) continue;
      d.anim -= k;
      if (d.anim < 0) d.anim = 0;
      var t = easeOutQuint(1 - d.anim);
      d.cur.style.transform = 'translateY(' + ((1 - t) * 106).toFixed(2) + '%)';
      d.prev.style.transform = 'translateY(' + (-t * 106).toFixed(2) + '%)';
      var o = clamp01(t * 2.4);
      d.cur.style.opacity = o.toFixed(3);
      d.prev.style.opacity = clamp01(1 - t * 2.4).toFixed(3);
      if (d.anim === 0) {
        d.cur.style.transform = 'translateY(0%)';
        d.cur.style.opacity = '1';
        d.prev.style.opacity = '0';
      }
    }
  }

  /* =========================================================================
     7. MULTIPLICADOR
     ========================================================================= */

  function applyMultLevel(mult, punch) {
    var cls = 'l1';
    if (mult >= 8) cls = 'lsp';
    else if (mult >= 4) cls = 'l4';
    else if (mult >= 3) cls = 'l3';
    else if (mult >= 2) cls = 'l2';
    if (cls !== multLevelCls) {
      multLevelCls = cls;
      D.mult.className = 'ghh-mult ' + cls;
      setText(D.multTag, (cls === 'lsp') ? 'STAR POWER' : 'MULTIPLICADOR', 'multTag');
    }
    if (('x' + mult) !== last.multTxt) {
      last.multTxt = 'x' + mult;
      D.multX.innerHTML = '<small>x</small>' + mult;
    }
    if (punch) { multPunch = 1; haloPulse = 1; }
  }

  /* =========================================================================
     8. JULGAMENTO FLUTUANTE
     ========================================================================= */

  /* O ultimo objeto do pool e reservado para o erro (ver onMiss). */
  function spawnFloat(lane, txt, color, big, life) {
    var f = null, oldest = null, oldT = 2;
    for (var i = 0; i < floats.length - 1; i++) {
      if (!floats[i].on) { f = floats[i]; break; }
      if (floats[i].t < oldT) { oldT = floats[i].t; oldest = floats[i]; }
    }
    if (!f) f = oldest;
    if (!f) return;

    /* UM julgamento legivel por vez. Antes o pool deixava dois "PERFEITO!"
       vivos ao mesmo tempo em raias diferentes e eles saiam empilhados na
       diagonal, um por cima do outro — visto no print de acordes. Ao nascer
       um novo, os que ainda estao na tela vao embora depressa: continua
       havendo movimento e sobreposicao momentanea de opacidade baixa, nunca
       duas palavras cheias disputando o mesmo espaco. */
    for (i = 0; i < floats.length - 1; i++) {
      /* 0,09 da vida restante: a curva de opacidade acima ja esta em ~40% e
         caindo, entao o julgamento anterior sai de cena em menos de 0,1 s.
         Com valores maiores ele continuava em opacidade CHEIA (a curva so
         comeca a apagar em 76% da vida) e o print pegava os dois inteiros. */
      if (floats[i] !== f && floats[i].on) {
        if (floats[i].t > 0.09) floats[i].t = 0.09;
        /* Encurtar a vida nao bastava: a curva de opacidade so comeca a apagar
           em 76% da vida, entao o julgamento anterior continuava desenhado em
           ~37% — legivel o suficiente para o print pegar DOIS "PERFEITO!"
           inteiros na diagonal (visto em gameplay_chords). O teto de opacidade
           derruba o antigo na hora: ele vira rastro, nao palavra. */
        floats[i].fade = 0.20;
      }
    }

    f.x = (lane >= 0 && lane < 5) ? laneX[lane] : 50;
    f.y = laneY;
    f.t = 1;
    f.life = life || FLOAT_LIFE;
    f.sc = big ? 1.26 : 1.0;
    f.fade = 1;
    f.on = true;
    if (f.txt !== txt) { f.el.textContent = txt; f.txt = txt; }
    if (f.col !== color) { f.el.style.color = color; f.col = color; }
    f.el.style.opacity = '0';
  }

  function updateFloats(dt) {
    for (var i = 0; i < floats.length; i++) {
      var f = floats[i];
      if (!f.on) continue;
      f.t -= dt / f.life;
      if (f.t <= 0) { f.t = 0; f.on = false; f.el.style.opacity = '0'; continue; }
      var a = 1 - f.t;
      var rise = easeOutCubic(clamp01(a * 1.3)) * 7.4;             /* % da altura */
      var pop = (a < 0.20) ? easeOutBack(a / 0.20, 2.6) : 1;
      var sc = f.sc * (0.70 + 0.30 * pop);
      /* fica em opacidade cheia ate 65% da vida e so entao sai — o print tem
         que pegar o julgamento LEGIVEL, nao no meio do fade */
      var op = (a < 0.07) ? (a / 0.07) : (a > 0.76 ? (1 - (a - 0.76) / 0.24) : 1);
      if (f.fade != null) op *= f.fade;
      f.el.style.transform =
        'translate(' + f.x.toFixed(2) + 'vw,' + (f.y - rise).toFixed(2) + 'vh) ' +
        'translate(-50%,-50%) scale(' + sc.toFixed(3) + ')';
      f.el.style.opacity = clamp01(op).toFixed(3);
    }
  }

  /* Reprojeta as raias na tela: o julgamento sai EXATAMENTE de cima do aro de
     fret, mesmo se o dono do engine mexer na camera. Tambem mede o que o loop
     precisa em pixels (tubo e barra), para nao tocar em layout por frame. */
  function probeMetrics() {
    try {
      var E = GH.Engine, cam = E && E.camera, L = GH.Layout;
      if (cam && L && typeof THREE !== 'undefined' && THREE.Vector3) {
        if (!_projV) _projV = new THREE.Vector3();
        cam.updateMatrixWorld();
        var sumY = 0, ok = true;
        for (var i = 0; i < 5; i++) {
          /* y=0.35: logo acima do aro de fret. Mais alto que isso e o texto
             sobe para o meio da pista e atrapalha a leitura das notas. */
          _projV.set(L.laneX(i), 0.35, L.STRIKE_Z);
          _projV.project(cam);
          if (!isFinite(_projV.x) || !isFinite(_projV.y)) { ok = false; break; }
          laneX[i] = (_projV.x * 0.5 + 0.5) * 100;
          sumY += (0.5 - _projV.y * 0.5) * 100;
        }
        if (ok) {
          var y = sumY / 5;
          if (y > 8 && y < 96) laneY = y;
        }
      }
    } catch (e) { /* mantem os valores anteriores */ }

    try {
      if (D.rockTube) {
        M.tubeTop = D.rockTube.offsetTop;
        M.tubeH = _max(1, D.rockTube.offsetHeight);
      }
      if (D.progTrack) M.trackW = _max(1, D.progTrack.offsetWidth);
    } catch (e2) { /* metricas antigas continuam validas */ }
  }

  /* =========================================================================
     9. PROGRESSO DA MUSICA — marcadores construidos uma unica vez
     ========================================================================= */

  function buildProgressMarks(song) {
    if (!D.progTicks) return;
    D.progTicks.textContent = '';
    D.progSp.textContent = '';
    var dur = songDuration;
    if (!(dur > 0)) return;

    var secs = (song && song.sections) || [];
    for (var i = 0; i < secs.length; i++) {
      var t = secs[i].t;
      if (!(t > 0) || t >= dur) continue;
      var tick = mk('div', 'ghh-tick', D.progTicks);
      tick.style.left = ((t / dur) * 100).toFixed(3) + '%';
    }

    /* frases de star power: o jogador enxerga onde estao as chances */
    var ph = null;
    try { ph = GH.Chart && GH.Chart.starPowerPhrases; } catch (e) { ph = null; }
    if (ph && ph.length) {
      for (var j = 0; j < ph.length; j++) {
        var a = clamp01(ph[j].tStart / dur), b = clamp01(ph[j].tEnd / dur);
        if (b <= a) continue;
        var seg = mk('div', 'ghh-spseg', D.progSp);
        seg.style.left = (a * 100).toFixed(3) + '%';
        seg.style.width = _max(0.4, (b - a) * 100).toFixed(3) + '%';
      }
    }
  }

  /* Secao corrente derivada do tempo: assim o nome esta SEMPRE certo, mesmo
     sem evento (modo captura entra no meio da musica). */
  function syncSection(t) {
    if (!sections || !sections.length) return;
    var i = secIdx;
    if (i < 0 || t < sections[i].t) i = 0;
    while (i + 1 < sections.length && sections[i + 1].t <= t) i++;
    if (i === secIdx) return;
    secIdx = i;
    setText(D.section, sections[i].name || '', 'sectionTxt');
    secPop = 1;
  }

  /* =========================================================================
     10. LOOP PRINCIPAL
     ========================================================================= */

  function readScoring() {
    var S = GH.Scoring;
    if (!S) return;
    scoreTarget = S.score || 0;
    healthTarget = (typeof S.health === 'number') ? clamp01(S.health) : 1;
    spTarget = (typeof S.starPower === 'number') ? clamp01(S.starPower) : 0;
    spActive = !!S.starPowerActive;

    var m = S.multiplier || 1;
    if (m !== multValue) {
      var up = m > multValue;
      multValue = m;
      applyMultLevel(m, up);
    }
    var st = S.streak || 0;
    if (st !== streakValue) {
      if (st > streakValue) streakPunch = 1;
      streakValue = st;
    }
    spReady = (!spActive && spTarget >= SP_ACTIVATE_MIN);
  }

  function songTimeNow(explicit) {
    if (typeof explicit === 'number' && isFinite(explicit)) return explicit;
    try {
      if (GH.Game && typeof GH.Game.songTime === 'number' && isFinite(GH.Game.songTime)) {
        return GH.Game.songTime;
      }
      if (GH.Conductor && typeof GH.Conductor.time === 'number') return GH.Conductor.time;
    } catch (e) { /* ok */ }
    return 0;
  }

  function update(dt, songTimeArg) {
    if (!inited || !root) return;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;
    clock += dt;

    /* ---------- visibilidade (animada em JS: o modo captura exige) -------- */
    var visTarget = visible ? 1 : 0;
    vis = damp(vis, visTarget, 14, dt);
    if (_abs(vis - visTarget) < 0.004) vis = visTarget;
    if (_abs(vis - visWritten) > 0.003) {
      visWritten = vis;
      root.style.opacity = vis.toFixed(3);
      root.style.visibility = (vis > 0.004) ? 'visible' : 'hidden';
    }
    if (vis <= 0.004 && !visible) return;

    readScoring();

    /* ======================================================= PLACAR ======= */
    var d0 = scoreTarget - scoreShown;
    if (_abs(d0) < 0.6) {
      scoreShown = scoreTarget;
    } else {
      scoreShown = damp(scoreShown, scoreTarget, 11, dt);
      if (_abs(scoreTarget - scoreShown) < 0.6) scoreShown = scoreTarget;
      scorePunch = _min(1, scorePunch + _min(0.5, _abs(d0) / 2600));
    }
    pushScoreText(String(_max(0, _round(scoreShown))));
    updateScoreSlots(dt);
    scorePunch = _max(0, scorePunch - dt * 3.2);
    D.scoreNum.style.transform = 'scale(' + (1 + 0.05 * easeOutCubic(scorePunch)).toFixed(4) + ')';

    var S = GH.Scoring;
    if (S) {
      setText(D.acc, _round(clamp01(S.accuracy || 0) * 100) + '%', 'accTxt');
      setText(D.notes, (S.notesHit || 0) + '/' + (S.notesTotal || 0), 'notesTxt');
      var lsf = (typeof S.liveStarsFloat === 'number') ? S.liveStarsFloat
              : ((typeof S.liveStars === 'number') ? S.liveStars : 0);
      starsShown = damp(starsShown, clamp(lsf, 0, 5), 6, dt);
      for (var si = 0; si < 5; si++) {
        var fill = clamp01(starsShown - si);
        D.starFill[si].style.clipPath = 'inset(0 ' + ((1 - fill) * 100).toFixed(1) + '% 0 0)';
      }
    }

    /* ================================================= MULTIPLICADOR ====== */
    multPunch = _max(0, multPunch - dt * 2.3);
    haloPulse = _max(0, haloPulse - dt * 1.4);
    var mp = easeOutBack(clamp01(1 - multPunch), 3.0);
    var breathe = 1 + 0.016 * _sin(clock * (multValue >= 4 ? 7.6 : 4.0));
    D.mult.style.transform = 'scale(' + ((0.80 + 0.20 * mp) * breathe).toFixed(4) + ')';

    var baseM = (S && S.baseMultiplier) ? S.baseMultiplier : _min(MAX_BASE_MULT, multValue);
    var ringTarget = (baseM >= MAX_BASE_MULT)
      ? 1 : ((streakValue % STREAK_PER_STEP) / STREAK_PER_STEP);
    ringShown = damp(ringShown, ringTarget, 15, dt);
    D.ring.style.strokeDashoffset = (RING_C * (1 - ringShown)).toFixed(2);

    var sparkOn = (baseM >= MAX_BASE_MULT || spActive) ? 1 : 0;
    sparkPhase = (sparkPhase + dt * (spActive ? 200 : 115)) % 360;
    D.spark.style.transform = 'rotate(' + sparkPhase.toFixed(1) + 'deg)';
    D.spark.style.opacity = (sparkOn * (0.45 + 0.30 * _sin(clock * 6))).toFixed(3);

    var haloBase = (multValue >= 8) ? 0.9 : (multValue >= 4 ? 0.55 : (multValue >= 3 ? 0.22 : 0));
    D.halo.style.opacity = clamp01(haloBase + haloPulse * 0.5).toFixed(3);
    D.halo.style.transform = 'scale(' + (1 + 0.13 * haloPulse + 0.035 * _sin(clock * 5.5)).toFixed(3) + ')';

    /* ======================================================= SEQUENCIA ==== */
    streakPunch = _max(0, streakPunch - dt * 4.6);
    streakBreak = _max(0, streakBreak - dt * 1.6);
    setText(D.streakN, String(streakValue), 'streakTxt');
    D.streakN.style.transform = 'scale(' + (1 + 0.16 * easeOutCubic(streakPunch)).toFixed(4) + ')';
    var hot = (streakValue >= 30 || multValue >= 4);
    var wantCls = (streakBreak > 0.02) ? ' broke' : (hot ? ' hot' : '');
    if (wantCls !== streakCls) {
      streakCls = wantCls;
      streakHot = hot;
      D.streak.className = 'ghh-streak' + wantCls;
    }

    if (mileT > 0) {
      mileT -= dt / MILESTONE_LIFE;
      if (mileT < 0) mileT = 0;
      var ma = 1 - mileT;
      var mpop = (ma < 0.24) ? easeOutBack(ma / 0.24, 3.2) : 1;
      var mop = (ma > 0.60) ? (1 - (ma - 0.60) / 0.40) : 1;
      D.mile.style.transform = 'translateX(-50%) translateY(' + (-ma * 2.6).toFixed(2) +
        'vmin) scale(' + (0.58 + 0.42 * mpop).toFixed(3) + ')';
      D.mile.style.opacity = clamp01(mop).toFixed(3);
    } else if (D.mile.style.opacity !== '0') {
      D.mile.style.opacity = '0';
    }

    /* ======================================================= ROCK METER === */
    /* mola: a barra ultrapassa o alvo e volta — leitura viva, nao digital */
    healthVel += (healthTarget - healthShown) * 200 * dt;
    healthVel -= healthVel * _min(1, 21 * dt);
    healthShown += healthVel * dt;
    if (healthShown < 0) { healthShown = 0; healthVel *= -0.25; }
    if (healthShown > 1) { healthShown = 1; healthVel *= -0.25; }

    D.rockLiquid.style.transform = 'translateY(' + ((1 - healthShown) * 100).toFixed(2) + '%)';
    D.rockCursor.style.transform =
      'translateY(' + (M.tubeTop + (1 - healthShown) * M.tubeH).toFixed(1) + 'px) ' +
      'translateY(-50%)';

    var hb = _round(healthShown * 32);
    if (hb !== healthBucket) {
      healthBucket = hb;
      var hc = HEALTH_RAMP[clamp(hb, 0, 32)] || COL.success;
      D.rockLiquid.style.backgroundColor = hc;
      D.rockMen.style.boxShadow = '0 0 1.1vmin ' + hc + ',0 0 2.8vmin ' + hc;
      D.rockTube.style.boxShadow =
        'inset 0 0 0 1px rgba(255,255,255,.13),inset 0 .3vmin 1vmin rgba(0,0,0,.85),' +
        '0 .5vmin 2vmin rgba(0,0,0,.65),0 0 2.4vmin ' + hc + '66';
    }
    D.rockMen.style.opacity = (0.72 + 0.28 * _sin(clock * 7.5)).toFixed(3);

    var danger = healthShown < DANGER_H;
    warnPhase += dt * (healthShown < CRITICAL_H ? 12 : 6.5);
    var warnOp = danger ? (0.40 + 0.60 * _max(0, _sin(warnPhase))) : 0;
    D.rockWarn.style.opacity = warnOp.toFixed(3);
    D.rockWarn.style.transform = 'translateX(-50%) scale(' + (0.92 + 0.12 * warnOp).toFixed(3) + ')';

    hurt = _max(0, hurt - dt * 2.0);
    var lowH = danger ? (1 - healthShown / DANGER_H) : 0;
    D.hurt.style.opacity =
      clamp01(hurt * 0.62 + lowH * (0.18 + 0.16 * _max(0, _sin(warnPhase)))).toFixed(3);

    /* ======================================================= STAR POWER === */
    spShown = damp(spShown, spTarget, spActive ? 17 : 9, dt);
    if (_abs(spShown - spTarget) < 0.002) spShown = spTarget;
    D.spLiquid.style.transform = 'translateY(' + ((1 - spShown) * 100).toFixed(2) + '%)';
    D.spCursor.style.transform =
      'translateY(' + (M.tubeTop + (1 - spShown) * M.tubeH).toFixed(1) + 'px) translateY(-50%)';

    spPulse += dt * (spActive ? 9.5 : (spReady ? 5.4 : 2.0));
    var spWave = 0.5 + 0.5 * _sin(spPulse);
    var spGlow = spActive ? (0.78 + 0.22 * spWave) : (spReady ? (0.30 + 0.45 * spWave) : 0.08);
    var gq = _round(spGlow * 24);
    if (gq !== spGlowWritten) {
      spGlowWritten = gq;
      var g = gq / 24;
      D.spLiquid.style.backgroundColor = spActive ? '#ffffff' : (spReady ? COL.spCore : COL.spGlow);
      D.spMen.style.boxShadow = '0 0 1.2vmin ' + COL.spCore + ',0 0 3.2vmin ' + COL.spGlow;
      D.spTube.style.boxShadow =
        'inset 0 0 0 1px rgba(255,255,255,' + (0.13 + 0.4 * g).toFixed(3) + '),' +
        'inset 0 .3vmin 1vmin rgba(0,0,0,.85),0 .5vmin 2vmin rgba(0,0,0,.65),' +
        '0 0 ' + (1.4 + 5.2 * g).toFixed(2) + 'vmin rgba(143,216,255,' + (0.22 + 0.72 * g).toFixed(3) + ')';
    }
    D.spMen.style.opacity = (0.62 + 0.38 * spWave).toFixed(3);

    var callWant = (spActive || spReady) ? 1 : 0;
    spCallPhase = damp(spCallPhase, callWant, 10, dt);
    D.spCall.style.opacity = (spCallPhase * (spActive ? 1 : (0.62 + 0.38 * spWave))).toFixed(3);
    D.spCall.style.transform =
      'translateY(-50%) translateX(' + ((1 - spCallPhase) * 3.4).toFixed(2) + 'vmin) ' +
      'scale(' + (0.86 + 0.14 * spCallPhase * (1 + 0.05 * _sin(spPulse * 1.7))).toFixed(3) + ')';

    aura = damp(aura, spActive ? 1 : 0, spActive ? 9 : 4, dt);
    D.aura.style.opacity = (aura * (0.70 + 0.30 * spWave)).toFixed(3);

    bandT = spActive ? _min(1, bandT + dt * 3.2) : _max(0, bandT - dt * 3.6);
    D.spBand.style.opacity = (bandT * (0.80 + 0.20 * spWave)).toFixed(3);
    D.spBand.style.transform =
      'translateX(-50%) translateY(' + ((1 - bandT) * -2.6).toFixed(2) + 'vmin) ' +
      'scale(' + (0.90 + 0.10 * bandT).toFixed(3) + ')';

    /* ======================================================= PROGRESSO ==== */
    var t = songTimeNow(songTimeArg);
    if (songDuration > 0) {
      progressShown = damp(progressShown, clamp01(t / songDuration), 18, dt);
      D.progFill.style.transform = 'translateX(' + ((progressShown - 1) * 100).toFixed(3) + '%)';
      D.progHead.style.transform =
        'translateX(' + (progressShown * M.trackW).toFixed(1) + 'px) ' +
        'scale(' + (1 + 0.2 * _sin(clock * 6)).toFixed(3) + ')';
      setText(D.progTime, fmtTime(_max(0, t)), 'timeTxt');
      setText(D.progTotal, fmtTime(songDuration), 'totalTxt');
      syncSection(t);
    }

    /* nome da secao: repouso discreto, destaque forte quando muda */
    if (secPop > 0) {
      secPop -= dt / SECTION_POP;
      if (secPop < 0) secPop = 0;
    }
    var sIn = easeOutCubic(clamp01((1 - secPop) * 5));    /* entrada rapida */
    var flare = secPop * secPop;                          /* decai depressa */
    var secVis = (sections && sections.length) ? 1 : 0;
    D.section.style.opacity = (secVis * (0.60 + 0.40 * flare) * sIn).toFixed(3);
    D.section.style.transform =
      'translateY(' + ((1 - sIn) * 1.6).toFixed(2) + 'vmin) scale(' + (1 + 0.09 * flare).toFixed(3) + ')';
    var wantHot = flare > 0.28;
    if (wantHot !== secHot) {
      secHot = wantHot;
      D.section.className = 'ghh-section' + (wantHot ? ' hot' : '');
    }

    /* ======================================================= FLUTUANTES === */
    probeT -= dt;
    if (probeT <= 0) { probeT = 0.25; probeMetrics(); }
    floatCd = _max(0, floatCd - dt);
    for (var li = 0; li < 5; li++) laneCd[li] = _max(0, laneCd[li] - dt);
    updateFloats(dt);

    /* ================================================ RODAPE DE AJUDA ===== */
    /* 1) AUDIO PARADO. GH.Conductor.audioStalled fica true quando o relogio de
          audio nao anda: o jogador esta tocando no silencio e nao tem como
          adivinhar. O aviso vive enquanto durar o problema e some sozinho
          quando o contexto acorda (o src/main.js segue tentando religar). */
    var stalled = false;
    try { stalled = !!(GH.Conductor && GH.Conductor.audioStalled); } catch (e4) { stalled = false; }
    warnShown = damp(warnShown, stalled ? 1 : 0, 8, dt);
    if (_abs(warnShown - (stalled ? 1 : 0)) < 0.004) warnShown = stalled ? 1 : 0;
    D.audioWarn.style.opacity = warnShown.toFixed(3);
    D.audioWarn.style.transform =
      'translateY(' + ((1 - warnShown) * 1.4).toFixed(2) + 'vmin) scale(' +
      (0.94 + 0.06 * warnShown).toFixed(3) + ')';
    D.audioWarn.style.display = (warnShown > 0.004) ? '' : 'none';

    /* 2) COMO SE TOCA. So na primeira musica da sessao e so nos primeiros
          ~8 s: depois disso vira ruido para quem ja entendeu. */
    var tutWant = 0;
    if (tutArmed) {
      if (t < TUT_HOLD) tutWant = 1;
      else if (t < TUT_END) tutWant = 1 - (t - TUT_HOLD) / (TUT_END - TUT_HOLD);
      else { tutWant = 0; tutArmed = false; }
    }
    tutShown = damp(tutShown, tutWant, 9, dt);
    if (_abs(tutShown - tutWant) < 0.004) tutShown = tutWant;
    D.tut.style.opacity = tutShown.toFixed(3);
    D.tut.style.transform =
      'translateY(' + ((1 - tutShown) * 1.6).toFixed(2) + 'vmin) scale(' +
      (0.94 + 0.06 * tutShown).toFixed(3) + ')';
    D.tut.style.display = (tutShown > 0.004) ? '' : 'none';

    /* ======================================================= CONTAGEM ===== */
    if (countT > 0) {
      countT -= dt / COUNT_LIFE;
      if (countT < 0) countT = 0;
      var ca = 1 - countT;
      var cpop = easeOutBack(clamp01(ca / 0.32), 2.2);
      var cs = (countKind === 'go') ? (0.55 + 0.75 * cpop) : (2.05 - 1.05 * cpop);
      var co = (ca > 0.55) ? (1 - (ca - 0.55) / 0.45) : 1;
      D.count.style.opacity = clamp01(co).toFixed(3);
      D.countN.style.transform = 'scale(' + cs.toFixed(3) + ')';
      var rr = easeOutCubic(clamp01(ca / 0.6));
      D.countRing.style.transform = 'scale(' + (0.22 + 1.2 * rr).toFixed(3) + ')';
      D.countRing.style.opacity = clamp01((1 - rr) * 0.85).toFixed(3);
    } else if (D.count.style.opacity !== '0') {
      D.count.style.opacity = '0';
    }
  }

  /* =========================================================================
     11. BARRAMENTO DE EVENTOS
     Recebe TODO o fluxo de GH.Scoring mais os eventos que o GH.Game inventa
     (section / countdown / go / sync / spDenied). O que nao usamos, ignoramos
     de proposito.
     ========================================================================= */

  var JUDGE = { perfect: 'PERFEITO!', good: 'BOM', miss: 'ERROU' };

  function onHit(e) {
    var lane = (typeof e.lane === 'number') ? e.lane : -1;
    var q = e.quality || e.result || 'good';
    var big = !!(e.open || (e.chordSize && e.chordSize >= 3));
    /* Sem limite de cadencia um trecho denso vira sopa de texto ilegivel. */
    if (floatCd > 0) return;
    if (lane >= 0 && laneCd[lane] > 0) return;
    var txt = e.open ? 'ABERTA!' : ((e.chordSize >= 3) ? 'ACORDE!' : (JUDGE[q] || JUDGE.good));
    spawnFloat(lane, txt, (q === 'perfect') ? COL.perfect : COL.good, big, FLOAT_LIFE);
    floatCd = FLOAT_CD_ANY;
    if (lane >= 0) laneCd[lane] = FLOAT_CD_LANE;
  }

  /* O erro tem um lugar SO DELE no pool (o ultimo do array). Uma rajada de
     notas perdidas empilhava cinco "ERROU" um por cima do outro e o print
     virava borrao — agora o erro mais recente reaproveita sempre o mesmo
     objeto e pula para a raia certa. Um julgamento de erro por vez. */
  function onMiss(e) {
    var lane = (typeof e.lane === 'number') ? e.lane : -1;
    var f = floats[floats.length - 1];
    var txt = (e.reason === 'overstrum') ? 'PALHETADA' : JUDGE.miss;
    if (f) {
      f.x = (lane >= 0 && lane < 5) ? laneX[lane] : 50;
      f.y = laneY;
      f.t = 1;
      f.life = FLOAT_LIFE_MISS;
      f.sc = 1.3;
      f.on = true;
      if (f.txt !== txt) { f.el.textContent = txt; f.txt = txt; }
      if (f.col !== COL.miss) { f.el.style.color = COL.miss; f.col = COL.miss; }
    }
    if (lane >= 0) laneCd[lane] = FLOAT_CD_LANE;
    floatCd = _max(floatCd, FLOAT_CD_ANY);
    hurt = _min(1, hurt + ((e.reason === 'overstrum') ? 0.45 : 0.8));
    streakBreak = 1;
    lastMilestone = 0;
  }

  function onStreak(e) {
    if (!e.up) { lastMilestone = 0; return; }
    var S = GH.Scoring;
    var st = S ? (S.streak || 0) : streakValue;
    for (var i = 0; i < MILESTONES.length; i++) {
      var m = MILESTONES[i];
      if (st >= m && m > lastMilestone) {
        lastMilestone = m;
        D.mile.textContent = m + ' SEGUIDAS!';
        mileT = 1;
      }
    }
    multPunch = 1;
    haloPulse = 1;
  }

  function spCallText(active) {
    if (active) {
      setText(D.spCallT1, 'STAR POWER', 'spT1');
      if (last.spT2 !== 'ativo') {
        last.spT2 = 'ativo';
        D.spCallT2.innerHTML = '<span class="key">Ativo</span>';
      }
    } else {
      setText(D.spCallT1, 'Pode ativar', 'spT1');
      if (last.spT2 !== 'espaco') {
        last.spT2 = 'espaco';
        D.spCallT2.innerHTML = '<span class="key">Espa&ccedil;o</span>';
      }
    }
  }

  function onSp(e) {
    var act = e.action;
    if (act === 'start') { spPulse = 0; spCallText(true); haloPulse = 1; multPunch = 1; }
    else if (act === 'end') { spCallText(false); }
    else if (act === 'ready') { spPulse = 0; spCallText(false); }
    else if (act === 'phrase') { spPulse = 0; }
  }

  function onCountdown(e) {
    if (e.phase === 'begin') { countKind = 'arm'; return; }
    if (!(e.count >= 1)) return;
    countKind = 'n';
    setText(D.countN, String(e.count), 'countTxt');
    setText(D.countK, 'Prepare-se', 'countK');
    countT = 1;
  }

  function event(e) {
    if (!inited || !e || !e.type) return;
    try {
      switch (e.type) {
        case 'hit':       onHit(e); break;
        case 'miss':      onMiss(e); break;
        case 'streak':    onStreak(e); break;
        case 'sp':        onSp(e); break;
        case 'countdown': onCountdown(e); break;

        case 'section':
          /* o nome tambem e derivado do tempo; o evento so faz o destaque */
          if (e.name) { setText(D.section, e.name, 'sectionTxt'); secPop = 1; }
          if (typeof e.index === 'number') secIdx = e.index;
          break;

        case 'go':
          countKind = 'go';
          setText(D.countN, 'VAI!', 'countTxt');
          setText(D.countK, 'Manda ver', 'countK');
          countT = 1;
          break;

        case 'fail':
          hurt = 1;
          countKind = 'go';
          setText(D.countN, 'FALHOU', 'countTxt');
          setText(D.countK, 'A plateia foi embora', 'countK');
          countT = 1;
          break;

        case 'spDenied':
          spCallPhase = 0.05;
          spPulse = 0;
          break;

        case 'sync':
          /* Modo captura ajustando os numeros: sem comemoracao nenhuma. */
          readScoring();
          multPunch = 0; streakPunch = 0; mileT = 0;
          lastMilestone = 0;
          for (var i = 0; i < MILESTONES.length; i++) {
            if (streakValue >= MILESTONES[i]) lastMilestone = MILESTONES[i];
          }
          spCallText(spActive);
          break;

        default: break;   /* sustain / sustainEnd / finish: nada a fazer aqui */
      }
    } catch (err) {
      /* Um evento malformado nunca pode derrubar o HUD no meio da musica. */
      try { if (window.console && console.warn) console.warn('GH.HUD.event', err); }
      catch (e2) { /* ok */ }
    }
  }

  /* =========================================================================
     12. API PUBLICA
     ========================================================================= */

  function init(container) {
    if (inited) return GH.HUD;
    var host = container || document.getElementById('gh-ui') || document.body;
    injectCss();
    refreshColors();
    build(host);
    inited = true;
    GH.HUD.ready = true;
    GH.HUD.root = root;

    /* a paleta troca de tema entre musicas: as cores em cache seguem junto */
    try {
      if (GH.Palette && typeof GH.Palette.onChange === 'function') {
        GH.Palette.onChange(refreshColors);
      }
    } catch (e) { /* tema fixo tambem serve */ }

    reset();
    probeMetrics();
    return GH.HUD;
  }

  function setSong(song, difficulty) {
    if (!inited) return;
    curSong = song || null;
    curDiff = difficulty || '';

    setText(D.songTitle, (song && song.title) || 'Guitarrada Hero', 'title');
    setText(D.songArtist, (song && song.artist) || 'Guitarrada Hero Band', 'artist');
    setText(D.songGenre, (song && song.genre) || '', 'genre');
    setText(D.songTribute, (song && song.tribute) || '', 'tribute');

    var lbl = DIFF_LABEL[curDiff] || (curDiff ? curDiff.toUpperCase() : '—');
    try {
      if (GH.Songs && typeof GH.Songs.labelOf === 'function' && curDiff) {
        lbl = String(GH.Songs.labelOf(curDiff)).toUpperCase();
      }
    } catch (e) { /* rotulo local serve */ }
    setText(D.songDiff, lbl, 'diff');

    var stars = 0;
    try {
      if (song && song.difficultyStars && curDiff) stars = song.difficultyStars[curDiff] || 0;
    } catch (e2) { stars = 0; }
    var pips = D.songPips.children;
    for (var i = 0; i < pips.length; i++) {
      pips[i].className = 'ghh-pip' + (i < stars ? ' on' : '');
    }

    songDuration = 0;
    try { if (GH.Chart && GH.Chart.duration > 0) songDuration = GH.Chart.duration; }
    catch (e3) { /* ok */ }
    if (!(songDuration > 0) && song && song.durationSec > 0) songDuration = song.durationSec;

    /* O lembrete "traste + palhetada" e cortesia de UMA vez por sessao: quem
       ja passou pela primeira musica nao precisa mais dele no rodape. */
    if (!tutSpent) { tutSpent = true; tutArmed = true; }

    sections = (song && song.sections && song.sections.length) ? song.sections : null;
    secIdx = -1; secPop = 0;
    buildProgressMarks(song);
    setText(D.progTotal, fmtTime(songDuration), 'totalTxt');
    probeMetrics();
  }

  function reset() {
    if (!inited) return;
    scoreTarget = 0; scoreShown = 0; scorePunch = 0;
    pushScoreText('0');
    for (var i = 0; i < digitSlots.length; i++) {
      digitSlots[i].anim = 0;
      digitSlots[i].cool = 0;
      digitSlots[i].cur.style.transform = 'translateY(0%)';
      digitSlots[i].cur.style.opacity = '1';
      digitSlots[i].prev.style.opacity = '0';
    }

    multValue = 1; multPunch = 0; ringShown = 0; haloPulse = 0;
    applyMultLevel(1, false);

    streakValue = 0; streakPunch = 0; lastMilestone = 0; mileT = 0;
    setText(D.streakN, '0', 'streakTxt');

    healthTarget = 0.5; healthShown = 0.5; healthVel = 0; hurt = 0; warnPhase = 0;
    healthBucket = -1; spGlowWritten = -1;

    spTarget = 0; spShown = 0; spActive = false; spReady = false;
    spCallPhase = 0; spPulse = 0; aura = 0; bandT = 0;
    spCallText(false);

    progressShown = 0; secIdx = -1; secPop = 0; secHot = false;
    D.section.className = 'ghh-section';
    starsShown = 0;
    countT = 0; countKind = '';
    floatCd = 0;
    for (var f = 0; f < floats.length; f++) {
      floats[f].on = false; floats[f].t = 0; floats[f].el.style.opacity = '0';
    }
    for (var l = 0; l < 5; l++) laneCd[l] = 0;

    D.aura.style.opacity = '0';
    D.hurt.style.opacity = '0';
    D.spBand.style.opacity = '0';
    D.count.style.opacity = '0';
    D.section.style.opacity = '0';
    D.mile.style.opacity = '0';

    /* Rodape de ajuda. `tutArmed` cai aqui e so volta em setSong() — se o
       jogador desistir da primeira musica antes dos 8 s, o lembrete NAO
       reaparece na proxima. `tutSpent` sobrevive: a cortesia e da sessao
       inteira, nao da partida. */
    warnShown = 0; tutShown = 0; tutArmed = false;
    D.audioWarn.style.opacity = '0'; D.audioWarn.style.display = 'none';
    D.tut.style.opacity = '0'; D.tut.style.display = 'none';
  }

  function show() {
    if (!inited) return;
    visible = true;
    /* No modo captura o HUD entra instantaneo: o print nao pode pegar o fade. */
    if (window.__GH_CAP) {
      vis = 1; visWritten = 1;
      root.style.opacity = '1';
      root.style.visibility = 'visible';
    }
  }

  function hide() {
    if (!inited) return;
    visible = false;
    if (window.__GH_CAP) {
      vis = 0; visWritten = 0;
      root.style.opacity = '0';
      root.style.visibility = 'hidden';
    }
  }

  function dispose() {
    if (!inited) return;
    try { if (root && root.parentNode) root.parentNode.removeChild(root); } catch (e) { /* ok */ }
    var st = document.getElementById('gh-hud-css');
    try { if (st && st.parentNode) st.parentNode.removeChild(st); } catch (e2) { /* ok */ }
    root = null; D = {}; digitSlots.length = 0; floats.length = 0;
    inited = false;
    GH.HUD.ready = false;
    GH.HUD.root = null;
  }

  /* Diagnostico legivel por maquina — as ferramentas conferem a cena sem pixel. */
  function debug() {
    var nf = 0;
    for (var i = 0; i < floats.length; i++) if (floats[i].on) nf++;
    return {
      visible: visible, vis: _round(vis * 100) / 100,
      score: _round(scoreShown), scoreTarget: scoreTarget,
      mult: multValue, level: multLevelCls, streak: streakValue,
      health: _round(healthShown * 1000) / 1000,
      sp: _round(spShown * 1000) / 1000, spActive: spActive, spReady: spReady,
      section: (sections && sections[secIdx]) ? sections[secIdx].name : '',
      progress: _round(progressShown * 1000) / 1000,
      floats: nf, duration: songDuration,
      song: curSong ? curSong.id : '', difficulty: curDiff,
      audioWarn: _round(warnShown * 100) / 100,
      tutorial: _round(tutShown * 100) / 100,
      tutorialArmed: tutArmed
    };
  }

  GH.HUD = {
    init: init,
    update: update,
    show: show,
    hide: hide,
    setSong: setSong,
    event: event,
    reset: reset,
    dispose: dispose,
    debug: debug,
    ready: false,
    root: null,
    selfDriven: false        /* quem chama update() e o GH.Game */
  };

})(window.GH = window.GH || {});

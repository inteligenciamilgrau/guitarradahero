// GERADO AUTOMATICAMENTE por tools/embed_art.sh — NAO EDITE A MAO.
// Imagens de art_source/ embutidas como data-URI (file:// bloqueia fetch).
// Se este arquivo nao existir ou estiver vazio, o jogo usa as texturas
// procedurais normalmente. GH.Art e sempre opcional.
(function (GH) {
  'use strict';
  var A = GH.Art = GH.Art || {};
  A.__count = 0;
  A.has = function (k) { return typeof A[k] === 'string' && A[k].length > 64; };
  // Carrega uma imagem embutida como THREE.Texture. Devolve null se nao existir,
  // e o chamador segue com a textura procedural.
  A.texture = function (k, opts) {
    if (!A.has(k) || typeof THREE === 'undefined') return null;
    opts = opts || {};
    var img = new Image();
    var tex = new THREE.Texture(img);
    img.onload = function () {
      tex.needsUpdate = true;
      if (opts.onLoad) { try { opts.onLoad(tex); } catch (e) {} }
    };
    img.src = A[k];
    if (opts.srgb !== false) tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = opts.wrapS || THREE.ClampToEdgeWrapping;
    tex.wrapT = opts.wrapT || THREE.ClampToEdgeWrapping;
    tex.anisotropy = opts.anisotropy || 8;
    tex.generateMipmaps = opts.mipmaps !== false;
    tex.minFilter = opts.mipmaps === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  };
})(window.GH = window.GH || {});

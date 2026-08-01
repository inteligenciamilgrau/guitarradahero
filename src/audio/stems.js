(function (GH) {
  'use strict';

  /* ======================================================================
   * REPRODUTOR DE STEMS PRE-RENDERIZADOS
   *
   * A musica procedural original cria milhares de osciladores, filtros,
   * convolvers e automacoes enquanto o jogo roda. Mesmo com CPU total baixa,
   * a thread de audio pode perder o prazo de um bloco de 128 amostras; a
   * placa recebe silencio e o resultado e o ciclo picote -> silencio -> volta.
   *
   * Aqui a mesma sintese e executada uma vez, fora da partida. Em jogo ficam
   * somente tres AudioBufferSourceNodes sincronizados pelo GH.Conductor:
   *   backing -> bus music, drums -> bus drums, guitar -> bus guitar.
   * Isso preserva volumes, efeitos globais e o mute da guitarra nos erros.
   * Se os arquivos nao existirem ou falharem ao decodificar, schedule()
   * devolve false e GH.Synth usa o caminho procedural antigo.
   * ==================================================================== */

  var STEMS = ['backing', 'drums', 'guitar'];
  var BUS = { backing: 'music', drums: 'drums', guitar: 'guitar' };
  var _audio = null;
  var _ctx = null;
  var _cache = {};
  var _preparedId = '';
  var _session = null;
  var _runMode = null;       /* null | waiting | stems | live */
  var _muted = false;
  var _sp = false;
  var _diag = {
    loads: 0, loadFailures: 0, starts: 0, fallbacks: 0,
    lastError: '', song: '', state: 'idle'
  };

  function entryFor(song) {
    if (!song) return null;
    var M = GH.GeneratedStems;
    return M && M.songs ? (M.songs[song.id] || null) : null;
  }

  function context() {
    var a = _audio || GH.Audio;
    var c = null;
    try { c = a && a.ctx; } catch (e) { c = null; }
    if (c && typeof c.createBufferSource === 'function') {
      _audio = a;
      _ctx = c;
      return c;
    }
    return null;
  }

  function loadArrayBuffer(url) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      try {
        x.open('GET', url, true);
        x.responseType = 'arraybuffer';
        x.onload = function () {
          /* file:// devolve status 0 mesmo quando a leitura foi bem-sucedida. */
          if ((x.status >= 200 && x.status < 300) || (x.status === 0 && x.response)) {
            resolve(x.response);
          } else {
            reject(new Error('HTTP ' + x.status + ' em ' + url));
          }
        };
        x.onerror = function () { reject(new Error('nao foi possivel ler ' + url)); };
        x.send(null);
      } catch (e) { reject(e); }
    });
  }

  function decode(c, data) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function ok(v) { if (!settled) { settled = true; resolve(v); } }
      function bad(e) { if (!settled) { settled = true; reject(e || new Error('decodeAudioData')); } }
      try {
        var p = c.decodeAudioData(data, ok, bad);
        if (p && typeof p.then === 'function') p.then(ok, bad);
      } catch (e) { bad(e); }
    });
  }

  function beginLoad(song) {
    var ent = entryFor(song);
    var c = context();
    if (!ent || !c) return null;
    var id = song.id;
    var old = _cache[id];
    if (old && (old.state === 'loading' || old.state === 'ready')) return old;

    var rec = { state: 'loading', buffers: {}, error: '', entry: ent };
    _cache[id] = rec;
    _diag.loads++;
    _diag.song = id;
    _diag.state = 'loading';

    var jobs = STEMS.map(function (name) {
      var url = ent[name];
      if (!url) return Promise.reject(new Error('stem ausente: ' + name));
      return loadArrayBuffer(url).then(function (bytes) {
        return decode(c, bytes);
      }).then(function (buf) {
        rec.buffers[name] = buf;
      });
    });

    rec.promise = Promise.all(jobs).then(function () {
      rec.state = 'ready';
      _diag.state = 'ready';
      return rec;
    }, function (err) {
      rec.state = 'failed';
      rec.error = String(err && err.message ? err.message : err);
      rec.buffers = {};
      _diag.loadFailures++;
      _diag.lastError = rec.error;
      _diag.state = 'failed';
      return rec;
    });
    return rec;
  }

  function hold(param, at) {
    if (!param) return;
    try {
      if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(at);
      } else {
        var v = param.value;
        param.cancelScheduledValues(at);
        param.setValueAtTime(v, at);
      }
    } catch (e) {}
  }

  function ramp(param, value, seconds) {
    if (!_ctx || !param) return;
    var now = _ctx.currentTime;
    try {
      hold(param, now);
      param.linearRampToValueAtTime(value, now + seconds);
    } catch (e) { try { param.value = value; } catch (e2) {} }
  }

  function stopSession() {
    var s = _session;
    _session = null;
    if (!s || !_ctx) return;
    var now = _ctx.currentTime;
    for (var i = 0; i < s.gates.length; i++) {
      try {
        hold(s.gates[i].gain, now);
        s.gates[i].gain.linearRampToValueAtTime(0, now + 0.035);
      } catch (e) {}
    }
    for (var j = 0; j < s.sources.length; j++) {
      try { s.sources[j].stop(now + 0.055); } catch (e2) {}
    }
    setTimeout(function () {
      for (var k = 0; k < s.nodes.length; k++) {
        try { s.nodes[k].disconnect(); } catch (e3) {}
      }
    }, 100);
  }

  function startSession(song, rec) {
    var c = context();
    var a = _audio || GH.Audio;
    if (!c || !a || !a.buses) return false;

    var C = GH.Conductor;
    var when = c.currentTime + 0.020;
    var offset = 0;
    try {
      var zeroAt = C && C.ctxTimeAt ? C.ctxTimeAt(0) : 0;
      if (zeroAt > when) {
        when = zeroAt;
        offset = 0;
      } else if (C && C.songTimeAtCtx) {
        offset = Math.max(0, C.songTimeAtCtx(when));
      } else if (C && typeof C.rawTime === 'number') {
        offset = Math.max(0, C.rawTime + (when - c.currentTime));
      }
    } catch (e) { offset = Math.max(0, offset); }

    var session = {
      id: song.id, sources: [], gates: [], nodes: [], guitarGain: null,
      guitarBright: null, when: when, offset: offset
    };

    try {
      for (var i = 0; i < STEMS.length; i++) {
        var name = STEMS[i];
        var buf = rec.buffers[name];
        var out = a.buses[BUS[name]];
        if (!buf || !out) throw new Error('buffer/bus ausente: ' + name);

        var src = c.createBufferSource();
        var gate = c.createGain();
        src.buffer = buf;
        gate.gain.setValueAtTime(0, c.currentTime);
        gate.gain.linearRampToValueAtTime(1, when + 0.012);

        src.connect(gate);
        if (name === 'guitar') {
          var bright = c.createBiquadFilter();
          var mute = c.createGain();
          bright.type = 'highshelf';
          bright.frequency.value = 3400;
          bright.gain.value = _sp ? 4 : 0;
          mute.gain.value = _muted ? 0 : 1;
          gate.connect(bright); bright.connect(mute); mute.connect(out);
          session.guitarGain = mute;
          session.guitarBright = bright;
          session.nodes.push(bright, mute);
        } else {
          gate.connect(out);
        }
        session.sources.push(src);
        session.gates.push(gate);
        session.nodes.push(src, gate);
      }

      /* Os tres buffers foram gerados com a mesma taxa, inicio e numero de
         quadros. Uma unica chamada start por fonte, no MESMO AudioParam time,
         os deixa alinhados em precisao de amostra. */
      for (var j = 0; j < session.sources.length; j++) {
        var b = session.sources[j].buffer;
        if (offset < b.duration) session.sources[j].start(when, offset);
      }
    } catch (err) {
      for (var k = 0; k < session.nodes.length; k++) {
        try { session.nodes[k].disconnect(); } catch (e2) {}
      }
      _diag.lastError = String(err && err.message ? err.message : err);
      return false;
    }

    _session = session;
    _runMode = 'stems';
    _diag.starts++;
    _diag.state = 'playing';
    return true;
  }

  GH.Stems = {
    init: function (audio) {
      _audio = audio || GH.Audio || null;
      return !!context();
    },

    hasSong: function (song) { return !!entryFor(song); },

    prepare: function (song) {
      if (!song || !entryFor(song)) return false;
      if (_preparedId !== song.id) {
        _preparedId = song.id;
        _runMode = null;
      }
      beginLoad(song);
      return true;
    },

    /* true = esta musica pertence ao caminho de stems, portanto Synth nao
       deve criar vozes. false = fallback procedural para esta execucao. */
    schedule: function (song, fromSec, toSec) {
      if (!song || !entryFor(song) || !context()) return false;
      if (_preparedId !== song.id) GH.Stems.prepare(song);
      if (_runMode === 'live') return false;
      if (_session && _session.id === song.id) return true;

      var rec = _cache[song.id] || beginLoad(song);
      if (rec && rec.state === 'ready') {
        if (startSession(song, rec)) return true;
        rec.state = 'failed';
      }
      if (!rec || rec.state === 'failed') {
        _runMode = 'live';
        _diag.fallbacks++;
        _diag.state = 'fallback';
        return false;
      }

      /* prepare() normalmente ganha os quatro segundos da contagem inicial.
         Se a decodificacao ainda nao acabou 150 ms depois do inicio real da
         musica, usamos o synth ate o proximo restart em vez de introduzir um
         silencio longo e trocar de motor no meio do compasso. */
      if (fromSec >= 0.15) {
        _runMode = 'live';
        _diag.fallbacks++;
        _diag.state = 'fallback-loading';
        return false;
      }
      _runMode = 'waiting';
      return true;
    },

    stopAll: function () {
      stopSession();
      _runMode = null;
      if (_diag.state === 'playing') _diag.state = 'ready';
    },

    setGuitarMuted: function (on) {
      _muted = !!on;
      if (_session && _session.guitarGain) ramp(_session.guitarGain.gain, _muted ? 0 : 1, _muted ? 0.012 : 0.035);
    },

    setStarPower: function (on) {
      _sp = !!on;
      if (_session && _session.guitarBright) ramp(_session.guitarBright.gain, _sp ? 4 : 0, 0.06);
    },

    diag: function () {
      return {
        available: !!entryFor({ id: _preparedId }), song: _diag.song,
        state: _diag.state, mode: _runMode || 'none', loads: _diag.loads,
        loadFailures: _diag.loadFailures, starts: _diag.starts,
        fallbacks: _diag.fallbacks, lastError: _diag.lastError,
        sources: _session ? _session.sources.length : 0,
        offset: _session ? Math.round(_session.offset * 1000) / 1000 : 0
      };
    }
  };

})(window.GH = window.GH || {});

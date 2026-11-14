(() => {
  'use strict';

  const SC_ORIGIN = 'https://w.soundcloud.com';
  const PARENT_ORIGIN = 'http://tempo-sc-playback.localhost';
  const FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const EQ_BANDS = 10;
  const NUM_BINS = 64;
  const SPECTRUM_INTERVAL_MS = 40;
  const LOUDNESS_TARGET = -14;
  const LOUDNESS_CEILING = -1.5;
  const LOUDNESS_GATE = -70;
  const LOUDNESS_BUCKETS = 111;
  const sourceGraphs = new WeakMap();

  if (location.origin !== SC_ORIGIN || !location.pathname.startsWith('/player/')) return;
  if (window.parent === window) return;

  let active = null;
  let currentGraph = null;
  let spectrumTimer = null;
  let lastSpectrumAt = 0;
  let capabilityTimer = null;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function numericId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 32
      && /^[0-9]+$/.test(value);
  }

  function hasOnlyKeys(value, keys) {
    const ownKeys = Object.keys(value);
    return ownKeys.length <= keys.length && ownKeys.every((key) => keys.includes(key));
  }

  function validSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !hasOnlyKeys(value, ['volume', 'playbackRate', 'preservePitch', 'equalizerEnabled',
        'equalizerGains', 'normalize', 'spectrumEnabled'])
      || !Array.isArray(value.equalizerGains) || value.equalizerGains.length !== EQ_BANDS) return null;
    const numbers = [value.volume, value.playbackRate, ...value.equalizerGains];
    if (numbers.some((item) => !finite(item))) return null;
    if (typeof value.preservePitch !== 'boolean'
      || typeof value.equalizerEnabled !== 'boolean'
      || typeof value.normalize !== 'boolean'
      || typeof value.spectrumEnabled !== 'boolean') return null;
    return {
      playbackRate: clamp(value.playbackRate, 0.5, 2),
      preservePitch: value.preservePitch,
      equalizerEnabled: value.equalizerEnabled,
      equalizerGains: value.equalizerGains.map((gain) => clamp(gain, -18, 18)),
      normalize: value.normalize,
      spectrumEnabled: value.spectrumEnabled,
    };
  }

  function report(type, details) {
    if (!active) return;
    window.parent.postMessage({
      protocol: 1,
      type,
      nonce: active.nonce,
      generation: active.generation,
      trackId: active.trackId,
      ...details,
    }, PARENT_ORIGIN);
  }

  function reportCapabilities(error) {
    const supported = !!(currentGraph && currentGraph.source && currentGraph.nodes);
    report('capabilities', {
      equalizer: supported,
      gain: supported,
      spectrum: supported,
      error: error ? 'audio-processing-unavailable' : null,
    });
  }

  function clearSpectrumTimer() {
    if (spectrumTimer !== null) {
      clearInterval(spectrumTimer);
      spectrumTimer = null;
    }
  }

  function startSpectrumTimer() {
    clearSpectrumTimer();
    if (!active || !active.settings.spectrumEnabled
      || !currentGraph || !currentGraph.nodes.analyser || currentGraph.element.paused) return;
    spectrumTimer = setInterval(() => {
      if (!active || !active.settings.spectrumEnabled
        || !currentGraph || currentGraph.element.paused) {
        clearSpectrumTimer();
        return;
      }
      const now = performance.now();
      if (now - lastSpectrumAt < 34) return;
      lastSpectrumAt = now;
      const analyser = currentGraph.nodes.analyser;
      const data = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(data);
      const sampleRate = currentGraph.context.sampleRate;
      const nyquist = Math.max(1, sampleRate * 0.5);
      const minHz = Math.min(50, nyquist * 0.5);
      const logMin = Math.log(minHz);
      const logMax = Math.log(nyquist);
      const logRange = Math.max(1e-3, logMax - logMin);
      const values = new Array(NUM_BINS).fill(0);
      for (let index = 0; index < data.length; index += 1) {
        const frequency = index * sampleRate / analyser.fftSize;
        if (frequency < minHz || frequency >= nyquist) continue;
        const decibels = data[index];
        if (!finite(decibels) || decibels <= -85) continue;
        const position = clamp((Math.log(frequency) - logMin) / logRange, 0, 0.999);
        const bin = Math.floor(position * NUM_BINS);
        const level = clamp((decibels + 85) / 70, 0, 1);
        values[bin] = Math.max(values[bin], level);
      }
      const bins = values.map((value) => {
        const transformed = Math.log10(1 + clamp(value, 0, 1) * 9);
        return finite(transformed) ? clamp(transformed, 0, 1) : 0;
      });
      report('spectrum', { bins });
    }, SPECTRUM_INTERVAL_MS);
  }

  function makeLoudnessMeter(graph) {
    const { source, context } = graph;
    const connect = window.__tempoNativeAudioConnect;
    const shelf = context.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1681.97;
    shelf.gain.value = 4;
    const highpass = context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 38.14;
    highpass.Q.value = 0.5;
    const weighted = context.createChannelSplitter(2);
    const raw = context.createChannelSplitter(2);
    const analysers = [0, 1, 2, 3].map(() => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 2 ** Math.floor(Math.log2(context.sampleRate / 10));
      return analyser;
    });
    connect.call(shelf, highpass);
    connect.call(highpass, weighted);
    for (let channel = 0; channel < 2; channel += 1) {
      connect.call(weighted, analysers[channel], channel);
      connect.call(raw, analysers[channel + 2], channel);
    }
    connect.call(source, shelf);
    connect.call(source, raw);
    return {
      disconnect: () => {
        source.disconnect(shelf);
        source.disconnect(raw);
      },
      analysers,
      data: new Float32Array(analysers[0].fftSize),
      counts: new Uint32Array(LOUDNESS_BUCKETS),
      energies: new Float64Array(LOUDNESS_BUCKETS),
      blocks: new Float64Array(4),
      peak: 0,
      ticks: 0,
      volume: graph.element.volume,
      settleUntil: 0,
      timer: null,
    };
  }

  function measureLoudness(graph, meter) {
    const element = graph.element;
    if (!active?.playing || !active.settings.normalize || element.paused
      || element.readyState < 3 || element.seeking || element.muted
      || graph.context.state !== 'running') return;
    // Chromium applies the element volume before MediaElementAudioSourceNode.
    // Wait for the analyser window to refresh if that volume changed.
    const volume = element.volume;
    if (meter.volume !== volume) {
      meter.volume = volume;
      return;
    }
    if (!(volume > 0) || graph.context.currentTime < meter.settleUntil) return;
    let energy = 0;
    let peak = 0;
    for (let channel = 0; channel < 2; channel += 1) {
      meter.analysers[channel].getFloatTimeDomainData(meter.data);
      for (const value of meter.data) energy += value * value;
      meter.analysers[channel + 2].getFloatTimeDomainData(meter.data);
      for (const value of meter.data) peak = Math.max(peak, Math.abs(value));
    }
    meter.peak = Math.max(meter.peak, peak / volume);
    meter.blocks[meter.ticks % meter.blocks.length] = energy / (meter.data.length * volume * volume);
    meter.ticks += 1;
    if (meter.ticks < meter.blocks.length) return;
    const block = meter.blocks.reduce((sum, value) => sum + value, 0) / meter.blocks.length;
    const lufs = -0.691 + 10 * Math.log10(block);
    if (finite(lufs) && lufs >= LOUDNESS_GATE) {
      const index = Math.min(LOUDNESS_BUCKETS - 1, Math.floor(lufs - LOUDNESS_GATE));
      meter.counts[index] += 1;
      meter.energies[index] += block;
    }
    if (meter.ticks !== meter.blocks.length && meter.ticks % 10 !== 0) return;
    let sum = meter.energies.reduce((total, value) => total + value, 0);
    let count = meter.counts.reduce((total, value) => total + value, 0);
    if (!count || !(meter.peak > 0)) return;
    const relativeGate = -0.691 + 10 * Math.log10(sum / count) - 10;
    const threshold = clamp(Math.floor(relativeGate - LOUDNESS_GATE), 0, LOUDNESS_BUCKETS);
    for (let index = 0; index < threshold; index += 1) {
      count -= meter.counts[index];
      sum -= meter.energies[index];
    }
    if (!count || !(sum > 0)) return;
    const integrated = -0.691 + 10 * Math.log10(sum / count);
    const peakGain = LOUDNESS_CEILING - 20 * Math.log10(meter.peak);
    const gainDb = Math.min(clamp(LOUDNESS_TARGET - integrated, -30, 0), peakGain);
    const gain = Math.pow(10, gainDb / 20);
    // A quiet passage or new graph must not release the same track's cut.
    if (gain >= active.loudnessGain) return;
    active.loudnessGain = gain;
    graph.nodes.trackGain.gain.setTargetAtTime(gain, graph.context.currentTime, 0.075);
  }

  function stopLoudnessTimer(graph) {
    const meter = graph?.meter;
    if (meter && meter.timer !== null) {
      clearInterval(meter.timer);
      meter.timer = null;
    }
  }

  function resetLoudness(graph) {
    if (!graph?.meter) return;
    stopLoudnessTimer(graph);
    try { graph.meter.disconnect(); } catch (_) {}
    graph.meter = null;
  }

  function updateLoudness(graph) {
    if (!graph?.nodes) return;
    const enabled = active?.settings.normalize === true;
    if (enabled && !graph.meter) {
      try { graph.meter = makeLoudnessMeter(graph); } catch (_) {}
    } else if (!enabled) {
      resetLoudness(graph);
    }
    const meter = graph.meter;
    if (enabled && active.playing && !graph.element.paused) {
      if (meter && meter.timer === null) {
        meter.timer = setInterval(() => measureLoudness(graph, meter), 100);
      }
    } else {
      stopLoudnessTimer(graph);
    }
    graph.nodes.trackGain.gain.setTargetAtTime(enabled ? active.loudnessGain : 1, graph.context.currentTime, 0.075);
  }

  function settleLoudnessMeter(graph) {
    const meter = graph.meter;
    if (!meter) return;
    meter.volume = graph.element.volume;
    meter.settleUntil = graph.context.currentTime + meter.data.length / graph.context.sampleRate;
  }

  function applyMediaSettings(graph) {
    if (!active || !graph || !graph.element) return;
    const settings = active.settings;
    const element = graph.element;
    try {
      element.playbackRate = settings.playbackRate;
      element.defaultPlaybackRate = settings.playbackRate;
      if ('preservesPitch' in element) element.preservesPitch = settings.preservePitch;
      else if ('webkitPreservesPitch' in element) element.webkitPreservesPitch = settings.preservePitch;
      else if ('mozPreservesPitch' in element) element.mozPreservesPitch = settings.preservePitch;
    } catch (_) {
      // Playback remains available even if a browser rejects one optional property.
    }

    if (!graph.nodes) return;
    const now = graph.context.currentTime;
    for (let index = 0; index < EQ_BANDS; index += 1) {
      const amount = settings.equalizerEnabled ? settings.equalizerGains[index] : 0;
      graph.nodes.equalizer[index].gain.setTargetAtTime(amount, now, 0.01);
    }
    const hasBoost = settings.equalizerEnabled
      && settings.equalizerGains.some((amount) => amount > 0.01);
    graph.nodes.limiter.threshold.setTargetAtTime(settings.normalize ? LOUDNESS_CEILING : -1, now, 0.01);
    graph.nodes.limiter.ratio.setTargetAtTime(settings.normalize || hasBoost ? 20 : 1, now, 0.01);
    updateLoudness(graph);
    startSpectrumTimer();
  }

  function disconnectGraph(graph) {
    if (!graph) return;
    clearSpectrumTimer();
    resetLoudness(graph);
    if (graph.mediaListeners) {
      graph.element.removeEventListener('play', graph.mediaListeners.play);
      graph.element.removeEventListener('pause', graph.mediaListeners.pause);
      graph.element.removeEventListener('ended', graph.mediaListeners.pause);
      graph.element.removeEventListener('volumechange', graph.mediaListeners.volumeChange);
    }
    try { graph.source.disconnect(); } catch (_) {}
    if (graph.nodes) {
      for (const node of graph.nodes.equalizer) {
        try { node.disconnect(); } catch (_) {}
      }
      for (const node of [graph.nodes.trackGain, graph.nodes.limiter, graph.nodes.analyser, graph.nodes.output]) {
        try { node.disconnect(); } catch (_) {}
      }
    }
  }

  function createGraph(source, element, context) {
    const graph = { source, element, context, nodes: null, meter: null, connectedSource: false };
    graph.mediaListeners = {
      play: () => {
        if (currentGraph !== graph) return;
        startSpectrumTimer();
        updateLoudness(graph);
      },
      pause: () => {
        if (currentGraph !== graph) return;
        clearSpectrumTimer();
        stopLoudnessTimer(graph);
      },
      volumeChange: () => settleLoudnessMeter(graph),
    };
    element.addEventListener('play', graph.mediaListeners.play);
    element.addEventListener('pause', graph.mediaListeners.pause);
    element.addEventListener('ended', graph.mediaListeners.pause);
    element.addEventListener('volumechange', graph.mediaListeners.volumeChange);
    try {
      const trackGain = context.createGain();
      if (active?.settings.normalize) trackGain.gain.value = active.loudnessGain;
      const equalizer = [];
      const nyquist = Math.max(1, context.sampleRate * 0.5);
      for (let index = 0; index < EQ_BANDS; index += 1) {
        const filter = context.createBiquadFilter();
        filter.type = index === 0 ? 'lowshelf'
          : index === EQ_BANDS - 1 ? 'highshelf' : 'peaking';
        filter.frequency.value = Math.min(FREQUENCIES[index], nyquist * 0.95);
        filter.Q.value = index === 0 || index === EQ_BANDS - 1
          ? Math.SQRT1_2 : 1.414;
        filter.gain.value = 0;
        equalizer.push(filter);
      }
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 1;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.14;
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.minDecibels = -85;
      analyser.maxDecibels = -15;
      analyser.smoothingTimeConstant = 0.8;
      const output = context.createGain();
      const nodes = { trackGain, equalizer, limiter, analyser, output };
      const originalConnect = window.__tempoNativeAudioConnect;
      if (typeof originalConnect !== 'function') throw new Error('audio-processing-unavailable');
      originalConnect.call(source, trackGain);
      graph.connectedSource = true;
      let previous = trackGain;
      for (const filter of equalizer) {
        originalConnect.call(previous, filter);
        previous = filter;
      }
      originalConnect.call(previous, limiter);
      originalConnect.call(limiter, analyser);
      originalConnect.call(analyser, output);
      graph.nodes = nodes;
      return graph;
    } catch (_) {
      disconnectGraph(graph);
      throw new Error('audio-processing-unavailable');
    }
  }

  function patchMediaSourceCreation() {
    const constructors = [window.AudioContext, window.webkitAudioContext].filter(Boolean);
    for (const Constructor of constructors) {
      const prototype = Constructor.prototype;
      if (!prototype || typeof prototype.createMediaElementSource !== 'function'
        || prototype.__tempoBrowserPatched) continue;
      const originalCreate = prototype.createMediaElementSource;
      Object.defineProperty(prototype, '__tempoBrowserPatched', { value: true });
      prototype.createMediaElementSource = function (element) {
        const source = originalCreate.call(this, element);
        if (!(element instanceof HTMLMediaElement)) return source;
        if (currentGraph) disconnectGraph(currentGraph);
        let graph = null;
        try {
          graph = createGraph(source, element, this);
          currentGraph = graph;
          sourceGraphs.set(source, graph);
          applyMediaSettings(graph);
          if (active) reportCapabilities(false);
        } catch (_) {
          if (graph) {
            disconnectGraph(graph);
            sourceGraphs.delete(source);
          }
          if (currentGraph === graph) currentGraph = null;
          reportCapabilities(true);
        }
        return source;
      };
    }
  }

  const nativeConnect = window.AudioNode && window.AudioNode.prototype.connect;
  if (typeof nativeConnect === 'function') {
    Object.defineProperty(window, '__tempoNativeAudioConnect', {
      value: nativeConnect,
      configurable: false,
    });
    window.AudioNode.prototype.connect = function (destination, outputIndex, inputIndex) {
      const graph = sourceGraphs.get(this);
      if (!graph || !graph.nodes || !(destination instanceof AudioNode)
        || destination instanceof AudioParam) {
        if (arguments.length === 1) return nativeConnect.call(this, destination);
        if (arguments.length === 2) return nativeConnect.call(this, destination, outputIndex);
        return nativeConnect.call(this, destination, outputIndex, inputIndex);
      }
      try {
        if (!graph.connectedSource) {
          nativeConnect.call(this, graph.nodes.trackGain, outputIndex || 0);
          graph.connectedSource = true;
        }
        if (arguments.length === 1) return nativeConnect.call(graph.nodes.output, destination);
        if (arguments.length === 2) return nativeConnect.call(graph.nodes.output, destination, outputIndex);
        return nativeConnect.call(graph.nodes.output, destination, 0, inputIndex || 0);
      } catch (_) {
        if (arguments.length === 1) return nativeConnect.call(this, destination);
        if (arguments.length === 2) return nativeConnect.call(this, destination, outputIndex);
        return nativeConnect.call(this, destination, outputIndex, inputIndex);
      }
    };
  }

  patchMediaSourceCreation();

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.origin !== PARENT_ORIGIN || event.source !== window.parent
      || !message || typeof message !== 'object'
      || Array.isArray(message)
      || !hasOnlyKeys(message, ['protocol', 'type', 'command', 'nonce', 'generation', 'trackId', 'settings'])
      || message.protocol !== 1 || message.type !== 'tempo-control') return;

    if (!['activate', 'configure', 'play', 'pause'].includes(message.command)) return;
    const replacingTrack = message.command === 'activate'
      && (!active || message.generation > active.generation);
    if (replacingTrack) {
      if (!numericId(message.trackId)
        || !Number.isSafeInteger(message.generation)
        || typeof message.nonce !== 'string' || message.nonce.length > 80) return;
      const initialSettings = validSettings(message.settings);
      if (!initialSettings) return;
      resetLoudness(currentGraph);
      active = {
        trackId: message.trackId,
        generation: message.generation,
        nonce: message.nonce,
        settings: initialSettings,
        playing: false,
        loudnessGain: 1,
      };
    } else if (!active || message.nonce !== active.nonce
      || message.generation !== active.generation
      || message.trackId !== active.trackId) {
      return;
    }
    if (message.command === 'play') {
      active.playing = true;
      if (currentGraph) startSpectrumTimer();
      updateLoudness(currentGraph);
      return;
    }
    if (message.command === 'pause') {
      active.playing = false;
      clearSpectrumTimer();
      stopLoudnessTimer(currentGraph);
      return;
    }
    const settings = validSettings(message.settings);
    if (!settings) {
      report('frame-error', {});
      return;
    }
    active.settings = settings;
    if (currentGraph) applyMediaSettings(currentGraph);
    if (message.command === 'activate') {
      active.playing = false;
      clearTimeout(capabilityTimer);
      if (currentGraph) reportCapabilities(false);
      else {
        capabilityTimer = setTimeout(() => reportCapabilities(true), 1800);
      }
    }
  });

})();

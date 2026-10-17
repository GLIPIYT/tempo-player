(() => {
  'use strict';

  if (location.origin !== 'https://w.soundcloud.com'
    || !location.pathname.startsWith('/player/')
    || window.parent === window) return;

  const SC_ORIGIN = 'https://w.soundcloud.com';
  const HOST_ORIGIN = 'http://tempo-sc-recording.localhost';
  const MAX_CHUNK_BYTES = 256 * 1024;
  const BRIDGE_CHUNK_BYTES = 64 * 1024;
  const SOURCE_READY_TIMEOUT_MS = 25000;
  const BaseAudioContext = window.AudioContext || window.webkitAudioContext;
  const nativeConnect = window.AudioNode && window.AudioNode.prototype.connect;
  const sources = [];
  const state = window.__tempoRecordingFrame = {
    active: null,
    sources,
    job: null,
    hold: false,
  };

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const bounded = (value, low, high) => Math.min(high, Math.max(low, value));

  function validPlan(plan, expectedDuration, part) {
    return plan && plan.part === part && typeof plan.last === 'boolean'
      && finite(plan.start) && finite(plan.end)
      && plan.start >= 0 && plan.end > plan.start && plan.end <= expectedDuration + 0.001;
  }

  function reply(message, ok, result, error) {
    if (!state.active || !window.parent) return;
    try {
      window.parent.postMessage({
        protocol: 1,
        type: 'tempo-recording-reply',
        nonce: state.active.nonce,
        trackId: state.active.trackId,
        part: state.active.part,
        requestId: message.requestId,
        ok,
        result,
        error,
      }, HOST_ORIGIN);
    } catch (_) {
      // A closed local host will discard the active browser window.
    }
  }

  function connectDirect(source, destination, ...args) {
    return nativeConnect.call(source, destination, ...args);
  }

  if (BaseAudioContext && nativeConnect && window.AudioNode && !window.__tempoRecordingPatched) {
    Object.defineProperty(window, '__tempoRecordingPatched', { value: true });
    window.AudioNode.prototype.connect = function (destination, ...args) {
      if (destination instanceof AudioDestinationNode) return destination;
      return nativeConnect.call(this, destination, ...args);
    };

    const originalCreate = BaseAudioContext.prototype.createMediaElementSource;
    BaseAudioContext.prototype.createMediaElementSource = function (element) {
      const source = originalCreate.call(this, element);
      if (!(element instanceof HTMLMediaElement)) return source;
      try {
        const tap = this.createMediaStreamDestination();
        const analyser = this.createAnalyser();
        analyser.fftSize = 2048;
        const silent = this.createGain();
        silent.gain.value = 0;
        connectDirect(source, tap);
        connectDirect(source, analyser);
        connectDirect(source, silent);
        connectDirect(silent, this.destination);
        sources.push({ source, element, context: this, tap, analyser });
      } catch (_) {
        state.captureError = 'audio-source-unavailable';
      }
      return source;
    };

    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (state.hold) {
        try { this.pause(); } catch (_) {}
        return Promise.resolve();
      }
      return originalPlay.apply(this, args);
    };

    if (window.AudioContext) {
      window.AudioContext = new Proxy(window.AudioContext, {
        construct(Target, args) {
          const options = { ...(args[0] || {}), sampleRate: 48000 };
          try { return Reflect.construct(Target, [options], Target); }
          catch (_) { return Reflect.construct(Target, args, Target); }
        },
      });
    }
    if (window.webkitAudioContext) window.webkitAudioContext = window.AudioContext;
  }

  function reportSnapshot() {
    const job = state.job;
    const source = sources[0];
    const element = source && source.element;
    let rms = 0;
    if (source && source.analyser) {
      try {
        const samples = new Float32Array(source.analyser.fftSize);
        source.analyser.getFloatTimeDomainData(samples);
        let square = 0;
        for (const sample of samples) square += sample * sample;
        rms = Math.sqrt(square / samples.length);
      } catch (_) {}
    }
    return {
      part: state.active.part,
      state: job ? job.state : 'configured',
      start: state.active.plan.start,
      end: state.active.plan.end,
      mediaStart: job ? job.mediaStart : null,
      mediaEnd: job ? job.mediaEnd : null,
      currentTime: element && finite(element.currentTime) ? element.currentTime : null,
      wallSeconds: job && job.wallStart ? (performance.now() - job.wallStart) / 1000 : 0,
      finish: job ? job.finish : null,
      paused: element ? !!element.paused : null,
      totalBytes: job ? job.totalBytes : 0,
      queued: job ? job.queue.length : 0,
      chunks: job ? (() => {
        let bytes = 0;
        let full = false;
        return job.queue.filter(chunk => {
          if (full) return false;
          if (bytes + chunk.bytes > job.pullLimit) { full = true; return false; }
          bytes += chunk.bytes;
          return true;
        });
      })() : [],
      errors: job ? job.errors : state.captureError ? [state.captureError] : [],
      rms,
    };
  }

  async function seekTo(target) {
    const element = sources[0] && sources[0].element;
    if (!element) throw new Error('audio-source-unavailable');
    element.pause();
    element.playbackRate = 1;
    element.defaultPlaybackRate = 1;
    if ('preservesPitch' in element) element.preservesPitch = true;
    else if ('webkitPreservesPitch' in element) element.webkitPreservesPitch = true;
    element.currentTime = target;
    const deadline = performance.now() + 20000;
    let lastSeekRequest = performance.now();
    while (element.seeking || Math.abs(element.currentTime - target) > 0.02) {
      if (performance.now() >= deadline) throw new Error('capture-seek-timeout');
      // The upstream player can restore its old position in response to a
      // paused seek. Reassert our held target without restarting good audio.
      if (!element.seeking && Math.abs(element.currentTime - target) > 0.02
        && performance.now() - lastSeekRequest >= 500) {
        element.pause();
        element.currentTime = target;
        lastSeekRequest = performance.now();
      }
      await wait(20);
    }
  }

  async function waitForAudioSource(expectedDuration) {
    const deadline = performance.now() + SOURCE_READY_TIMEOUT_MS;
    while (performance.now() < deadline) {
      if (state.captureError) throw new Error(state.captureError);
      const source = sources.find(entry => entry.element instanceof HTMLMediaElement);
      if (source && source.tap && source.context && source.analyser) {
        const element = source.element;
        let hasStream = false;
        try { hasStream = source.tap.stream.getAudioTracks().length > 0; } catch (_) {}
        if (finite(element.duration)
          && Math.abs(element.duration - expectedDuration) <= Math.max(2, expectedDuration * 0.01)
          && !!element.mediaKeys
          && element.readyState >= 3 && element.currentTime >= 0.03
          && hasStream) return source;
      }
      await wait(100);
    }
    throw new Error('audio-source-readiness-timeout');
  }

  async function prepare(message) {
    if (!state.active || !validPlan(message.plan, state.active.expectedDuration, state.active.part)) {
      throw new Error('invalid-capture-plan');
    }
    const source = await waitForAudioSource(state.active.expectedDuration);
    const element = source.element;
    state.hold = true;
    await seekTo(message.plan.start);
    await source.context.resume();
    const mime = 'audio/webm;codecs=pcm';
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(mime)) {
      throw new Error('pcm-media-recorder-unavailable');
    }
    const perFrameLimit = Number.isSafeInteger(message.perFrameLimit)
      ? bounded(message.perFrameLimit, 64 * 1024, 2 * 1024 * 1024)
      : 2 * 1024 * 1024;
    const job = state.job = {
      state: 'prepared',
      plan: message.plan,
      mediaStart: element.currentTime,
      mediaEnd: null,
      finish: null,
      wallStart: 0,
      lastMediaTime: element.currentTime,
      lastProgressAt: performance.now(),
      queue: [],
      nextSeq: 0,
      ackSeq: -1,
      totalBytes: 0,
      queueBytes: 0,
      perFrameLimit,
      pullLimit: Number.isSafeInteger(message.pullLimit)
        ? bounded(message.pullLimit, BRIDGE_CHUNK_BYTES, 2 * 1024 * 1024)
        : MAX_CHUNK_BYTES,
      errors: [],
      pending: Promise.resolve(),
      recorder: null,
      timer: null,
      stopping: false,
      finalState: 'complete',
    };
    const recorder = job.recorder = new MediaRecorder(source.tap.stream, { mimeType: mime });
    recorder.ondataavailable = event => {
      if (!event.data || !event.data.size) return;
      job.pending = job.pending.then(async () => {
        const bytes = new Uint8Array(await event.data.arrayBuffer());
        if (bytes.length > job.perFrameLimit || job.queueBytes + bytes.length > job.perFrameLimit) {
          job.errors.push('capture-queue-overflow');
          stopJob('failed');
          return;
        }
        for (let offset = 0; offset < bytes.length; offset += BRIDGE_CHUNK_BYTES) {
          const piece = bytes.subarray(offset, offset + BRIDGE_CHUNK_BYTES);
          let binary = '';
          for (let index = 0; index < piece.length; index += 32768) {
            binary += String.fromCharCode(...piece.subarray(index, index + 32768));
          }
          job.queue.push({ seq: job.nextSeq++, data: btoa(binary), bytes: piece.length });
        }
        job.queueBytes += bytes.length;
        job.totalBytes += bytes.length;
      }).catch(() => {
        job.errors.push('capture-chunk-failed');
        stopJob('failed');
      });
    };
    recorder.onerror = () => {
      job.errors.push('media-recorder-failed');
      stopJob('failed');
    };
    recorder.onstop = () => {
      job.pending.then(() => {
        job.state = job.errors.length ? 'failed' : job.finalState;
      }).catch(() => {
        job.errors.push('capture-chunk-failed');
        job.state = 'failed';
      });
    };
    return { snapshot: reportSnapshot() };
  }

  async function arm() {
    const job = state.job;
    const source = sources[0];
    if (!job || job.state !== 'prepared' || !source) throw new Error('capture-not-prepared');
    state.hold = true;
    await seekTo(job.plan.start);
    await source.context.resume();
    job.mediaStart = source.element.currentTime;
    job.lastMediaTime = job.mediaStart;
    job.lastProgressAt = performance.now();
    job.wallStart = performance.now();
    job.recorder.start(100);
    job.state = 'armed';
    return { armed: true };
  }

  async function release() {
    const job = state.job;
    const source = sources[0];
    if (!job || job.state !== 'armed' || !source) throw new Error('capture-not-armed');
    job.state = 'recording';
    state.hold = false;
    try {
      await source.element.play();
    } catch (_) {
      job.errors.push('soundcloud-playback-failed');
      stopJob('failed');
      throw new Error('soundcloud-playback-failed');
    }
    job.timer = setInterval(() => {
      if (!state.active || state.job !== job || job.state !== 'recording') return;
      const element = source.element;
      const now = performance.now();
      if (job.plan.last && job.finish !== null) {
        if (Math.abs(job.finish - job.plan.end) > 0.5) {
          job.errors.push('widget-finish-position-invalid');
          stopJob('failed', job.finish);
        } else {
          stopJob('complete', job.finish);
        }
        return;
      }
      if (!job.plan.last && element.currentTime >= job.plan.end - 0.01) {
        stopJob('complete', element.currentTime);
        return;
      }
      if (element.ended) {
        job.errors.push('widget-finish-missing');
        stopJob('failed', element.currentTime);
        return;
      }
      if (element.paused) {
        if (job.plan.last
          && (job.finish !== null || job.lastMediaTime >= job.plan.end - 0.5)
          && now - job.lastProgressAt < 2000) return;
        job.errors.push('playback-paused');
        stopJob('failed', element.currentTime);
        return;
      }
      if (Math.abs(element.currentTime - job.lastMediaTime) >= 0.01) {
        job.lastMediaTime = element.currentTime;
        job.lastProgressAt = now;
      } else if (now - job.lastProgressAt > 30000) {
        job.errors.push('playback-stalled');
        stopJob('failed', element.currentTime);
        return;
      }
      if ((now - job.wallStart) / 1000 > Math.max(90, (job.plan.end - job.plan.start) * 3 + 30)) {
        job.errors.push('capture-time-budget');
        stopJob('failed', element.currentTime);
      }
    }, 100);
    return { snapshot: reportSnapshot() };
  }

  function stopJob(stateName, endPosition) {
    const job = state.job;
    if (!job || job.stopping) return;
    job.stopping = true;
    job.finalState = stateName;
    job.state = 'stopping';
    if (finite(endPosition)) job.mediaEnd = endPosition;
    else if (sources[0] && finite(sources[0].element.currentTime)) job.mediaEnd = sources[0].element.currentTime;
    state.hold = true;
    if (job.timer) clearInterval(job.timer);
    if (sources[0]) {
      try { sources[0].element.pause(); } catch (_) {}
    }
    if (job.recorder && job.recorder.state !== 'inactive') {
      try { job.recorder.stop(); } catch (_) { job.state = 'failed'; }
    } else {
      job.state = job.errors.length ? 'failed' : stateName;
    }
  }

  async function handle(message) {
    switch (message.command) {
      case 'configure': {
        if (state.active || !/^[0-9]{1,32}$/.test(message.trackId)
          || typeof message.nonce !== 'string' || message.nonce.length !== 48
          || !finite(message.expectedDuration) || message.expectedDuration <= 0
          || !validPlan(message.plan, message.expectedDuration, message.part)) {
          throw new Error('invalid-frame-configuration');
        }
        state.active = {
          trackId: message.trackId,
          nonce: message.nonce,
          part: message.part,
          expectedDuration: message.expectedDuration,
          plan: message.plan,
        };
        return { configured: true };
      }
      case 'prepare':
        return prepare(message);
      case 'arm':
        return arm();
      case 'release':
        return release();
      case 'pull':
        if (!state.job) throw new Error('capture-not-prepared');
        await state.job.pending;
        return { snapshot: reportSnapshot() };
      case 'ack': {
        const job = state.job;
        if (!job || !Number.isSafeInteger(message.seq) || message.seq < job.ackSeq || message.seq >= job.nextSeq) {
          throw new Error('invalid-capture-ack');
        }
        job.ackSeq = message.seq;
        job.queue = job.queue.filter(chunk => chunk.seq > message.seq);
        job.queueBytes = job.queue.reduce((total, chunk) => total + chunk.bytes, 0);
        return { acknowledged: true };
      }
      case 'stop':
        if (state.job && !['complete', 'failed'].includes(state.job.state)) {
          state.job.errors.push('capture-cancelled');
          stopJob('failed');
        }
        return { snapshot: reportSnapshot() };
      case 'finish': {
        if (!state.job || !state.active.plan.last || state.job.state !== 'recording') return { ignored: true };
        const position = finite(message.position) ? message.position : state.active.expectedDuration;
        state.job.finish = position;
        return { accepted: true };
      }
      default:
        throw new Error('unknown-frame-command');
    }
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (event.origin !== HOST_ORIGIN || event.source !== window.parent
      || !message || typeof message !== 'object'
      || message.protocol !== 1 || message.type !== 'tempo-recording-control'
      || typeof message.command !== 'string') return;

    if (message.command === 'configure') {
      if (state.active) return;
      Promise.resolve().then(() => handle(message)).then(result => {
        state.active = state.active;
        reply(message, true, result);
      }).catch(error => reply(message, false, null, error instanceof Error ? error.message : 'frame-failed'));
      return;
    }
    const active = state.active;
    if (!active || message.nonce !== active.nonce
      || message.trackId !== active.trackId || message.part !== active.part) return;
    if (message.command === 'finish') {
      void handle(message).catch(() => {});
      return;
    }
    if (typeof message.requestId !== 'string' || message.requestId.length > 48) return;
    Promise.resolve().then(() => handle(message)).then(result => {
      reply(message, true, result);
    }).catch(error => {
      const code = error instanceof Error ? error.message : 'frame-failed';
      reply(message, false, null, /^[a-z0-9_-]{1,80}$/i.test(code) ? code : 'frame-failed');
    });
  });
})();

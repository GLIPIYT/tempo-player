(() => {
  'use strict';

  const PROTOCOL = 1;
  const PARENT_ORIGIN = 'http://tempo-sc-recording.localhost';
  const SC_ORIGIN = 'https://w.soundcloud.com';
  const API_URL = SC_ORIGIN + '/player/api.js';
  const MAX_PARTS = 12;
  const MAX_CHUNK_BYTES = 256 * 1024;
  const MAX_PULL_BYTES = 2 * 1024 * 1024;
  const MAX_PULL_RESPONSE_BYTES = 3 * 1024 * 1024;
  // Prepare waits up to 25 s for audio readiness and 20 s for seek completion.
  const PREPARE_FRAME_TIMEOUT_MS = 50000;
  // Arm repeats the seek, with 5 s left for setup and the reply.
  const ARM_FRAME_TIMEOUT_MS = 25000;
  const RELEASE_FRAME_TIMEOUT_MS = 15000;
  const root = document.getElementById('widgets');
  const frames = new Map();
  const results = new Map();
  let active = null;
  let frameRequestId = 1;

  window.__tempoRecordingReady = true;

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const numericId = value => typeof value === 'string'
    && value.length > 0 && value.length <= 32 && /^[0-9]+$/.test(value);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function safeError(error) {
    const message = error instanceof Error ? error.message : String(error || 'capture-failed');
    return /^[a-z0-9_-]{1,80}$/i.test(message) ? message : 'capture-failed';
  }

  function makeNonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }

  function trackWidgetUrl(trackId, part) {
    const trackUrl = 'https://api.soundcloud.com/tracks/' + encodeURIComponent(trackId);
    const params = new URLSearchParams({
      url: trackUrl,
      auto_play: 'true',
      single_active: 'false',
      hide_related: 'true',
      show_comments: 'false',
      show_user: 'false',
      show_reposts: 'false',
      visual: 'false',
      buying: 'false',
      sharing: 'false',
      download: 'false',
      tempo_capture_part: String(part),
    });
    return SC_ORIGIN + '/player/?' + params.toString();
  }

  function loadWidgetApi() {
    if (window.SC && typeof window.SC.Widget === 'function') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => reject(new Error('widget-api-timeout')), 15000);
      script.src = API_URL;
      script.async = true;
      script.onload = () => {
        clearTimeout(timeout);
        if (window.SC && typeof window.SC.Widget === 'function') resolve();
        else reject(new Error('widget-api-unavailable'));
      };
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('widget-api-unavailable'));
      };
      document.head.appendChild(script);
    });
  }

  function sendControl(frame, command, payload = {}) {
    if (!active || !frame.iframe.contentWindow) return;
    try {
      frame.iframe.contentWindow.postMessage({
        protocol: PROTOCOL,
        type: 'tempo-recording-control',
        command,
        nonce: active.nonce,
        trackId: active.trackId,
        part: frame.plan.part,
        ...payload,
      }, SC_ORIGIN);
    } catch (_) {
      // A navigated or closed SoundCloud frame cannot receive a control message.
    }
  }

  function requestFrame(frame, command, payload = {}, timeoutMs = 10000) {
    const requestId = 'f' + (frameRequestId++).toString(36);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        frame.pending.delete(requestId);
        reject(new Error('frame-request-timeout'));
      }, timeoutMs);
      frame.pending.set(requestId, { resolve, reject, timer });
      sendControl(frame, command, { ...payload, requestId });
    });
  }

  function validFrameMessage(frame, event, message) {
    return active
      && event.origin === SC_ORIGIN
      && event.source === frame.iframe.contentWindow
      && message && typeof message === 'object'
      && message.protocol === PROTOCOL
      && message.type === 'tempo-recording-reply'
      && message.nonce === active.nonce
      && message.trackId === active.trackId
      && message.part === frame.plan.part
      && typeof message.requestId === 'string'
      && message.requestId.length <= 48
      && typeof message.ok === 'boolean';
  }

  function onMessage(event) {
    if (event.origin !== SC_ORIGIN || !event.data || typeof event.data !== 'object') return;
    const frame = Array.from(frames.values()).find(candidate => candidate.iframe.contentWindow === event.source);
    if (!frame || !validFrameMessage(frame, event, event.data)) return;
    const waiter = frame.pending.get(event.data.requestId);
    if (!waiter) return;
    frame.pending.delete(event.data.requestId);
    clearTimeout(waiter.timer);
    if (event.data.ok !== true) {
      const code = typeof event.data.error === 'string' && /^[a-z0-9_-]{1,80}$/i.test(event.data.error)
        ? event.data.error : 'frame-failed';
      waiter.reject(new Error(code));
      return;
    }
    try {
      const serialized = JSON.stringify(event.data.result);
      if (typeof serialized !== 'string' || serialized.length > MAX_PULL_RESPONSE_BYTES) {
        waiter.reject(new Error('frame-response-oversized'));
        return;
      }
      waiter.resolve(event.data.result);
    } catch (_) {
      waiter.reject(new Error('frame-response-invalid'));
    }
  }

  function getWidgetValue(widget, method, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('widget-callback-timeout'));
      }, timeoutMs);
      try {
        widget[method](value => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        });
      } catch (_) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(new Error('widget-callback-failed'));
        }
      }
    });
  }

  function durationMatches(actual, expected) {
    return finite(actual) && actual > 0
      && Math.abs(actual - expected) <= Math.max(2, expected * 0.01);
  }

  async function waitForTrack(frame, expectedDuration) {
    const deadline = Date.now() + 30000;
    let lastId = '';
    while (Date.now() < deadline) {
      if (frame.widgetError) throw new Error('track-access-failed');
      try {
        const sound = await getWidgetValue(frame.widget, 'getCurrentSound', 1800);
        const id = sound && sound.id !== undefined ? String(sound.id) : '';
        if (id) lastId = id;
        if (id === active.trackId) {
          const durationMs = await getWidgetValue(frame.widget, 'getDuration', 1800);
          const soundDuration = finite(sound.duration) ? sound.duration / 1000 : 0;
          const widgetDuration = finite(durationMs) ? durationMs / 1000 : 0;
          if (!durationMatches(soundDuration, expectedDuration)
            || !durationMatches(widgetDuration, expectedDuration)
            || Math.abs(soundDuration - widgetDuration) > Math.max(2, expectedDuration * 0.01)) {
            throw new Error('track-duration-mismatch');
          }
          return { id, duration: widgetDuration };
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'track-duration-mismatch') throw error;
      }
      await delay(250);
    }
    throw new Error(lastId && lastId !== active.trackId ? 'track-id-mismatch' : 'widget-startup-timeout');
  }

  async function initialize(request) {
    if (active) throw new Error('capture-already-initialized');
    if (!numericId(request.trackId)
      || !finite(request.expectedDuration)
      || request.expectedDuration <= 0
      || request.expectedDuration > 86400
      || !Array.isArray(request.plans)
      || request.plans.length < 1 || request.plans.length > MAX_PARTS) {
      throw new Error('invalid-capture-request');
    }
    const plans = request.plans.map((plan, index) => {
      if (!plan || plan.part !== index || typeof plan.last !== 'boolean'
        || !finite(plan.start) || !finite(plan.end)
        || plan.start < 0 || plan.end <= plan.start || plan.end > request.expectedDuration + 0.001) {
        throw new Error('invalid-capture-plan');
      }
      if (plan.last !== (index === request.plans.length - 1)) throw new Error('invalid-capture-plan');
      if (index === 0 && plan.start > 0.01) throw new Error('invalid-capture-plan');
      if (index > 0 && request.plans[index - 1].end - plan.start < 0.05) throw new Error('invalid-capture-plan');
      return { part: index, start: plan.start, end: plan.end, last: plan.last };
    });
    if (Math.abs(plans[plans.length - 1].end - request.expectedDuration) > 0.01) {
      throw new Error('invalid-capture-plan');
    }

    active = {
      trackId: request.trackId,
      expectedDuration: request.expectedDuration,
      plans,
      nonce: makeNonce(),
    };
    try {
      await loadWidgetApi();
      const events = window.SC.Widget.Events;
      if (!events || !events.READY || !events.ERROR || !events.FINISH) throw new Error('widget-api-unavailable');

      for (const plan of plans) {
        const iframe = document.createElement('iframe');
        iframe.title = 'SoundCloud capture part ' + (plan.part + 1);
        iframe.allow = 'autoplay; encrypted-media';
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        const frame = {
          iframe,
          plan,
          widget: null,
          pending: new Map(),
          configured: false,
          widgetError: false,
          loaded: false,
          loadWaiters: [],
        };
        frames.set(plan.part, frame);
        iframe.addEventListener('load', () => {
          frame.loaded = true;
          for (const resolve of frame.loadWaiters.splice(0)) resolve();
        }, { once: true });
        iframe.src = trackWidgetUrl(request.trackId, plan.part);
        root.appendChild(iframe);
        frame.widget = window.SC.Widget(iframe);
        frame.widget.bind(events.ERROR, () => { frame.widgetError = true; });
        if (plan.last) {
          frame.widget.bind(events.FINISH, data => {
            if (!active || !frame.iframe.contentWindow) return;
            const position = data && finite(data.currentPosition)
              ? data.currentPosition / 1000 : active.expectedDuration;
            frame.iframe.contentWindow.postMessage({
              protocol: PROTOCOL,
              type: 'tempo-recording-control',
              command: 'finish',
              nonce: active.nonce,
              trackId: active.trackId,
              part: plan.part,
              position,
            }, SC_ORIGIN);
          });
        }
      }

      await Promise.all(Array.from(frames.values(), async frame => {
        const deadline = Date.now() + 30000;
        if (!frame.loaded) {
          await Promise.race([
            new Promise(resolve => frame.loadWaiters.push(resolve)),
            delay(Math.max(0, deadline - Date.now())),
          ]);
        }
        if (!frame.loaded) throw new Error('frame-load-timeout');
        if (!frame.configured) {
          await requestFrame(frame, 'configure', {
            expectedDuration: active.expectedDuration,
            plan: frame.plan,
          }, 10000);
          frame.configured = true;
        }
        while (Date.now() < deadline) {
          if (frame.widgetError) throw new Error('track-access-failed');
          try {
            const track = await waitForTrack(frame, request.expectedDuration);
            return { part: frame.plan.part, trackId: track.id, duration: track.duration };
          } catch (error) {
            if (error instanceof Error && error.message !== 'widget-callback-timeout') throw error;
            await delay(100);
          }
        }
        throw new Error('widget-startup-timeout');
      }));
      return { ok: true };
    } catch (error) {
      await stopAll();
      active = null;
      throw error;
    }
  }

  function snapshotResult(result) {
    if (!result || typeof result !== 'object' || !result.snapshot || typeof result.snapshot !== 'object') {
      throw new Error('frame-response-invalid');
    }
    const snapshot = result.snapshot;
    if (!Number.isSafeInteger(snapshot.part)
      || !['prepared', 'recording', 'stopping', 'complete', 'failed'].includes(snapshot.state)
      || !finite(snapshot.start) || !finite(snapshot.end)
      || !Number.isSafeInteger(snapshot.totalBytes) || snapshot.totalBytes < 0
      || !Number.isSafeInteger(snapshot.queued) || snapshot.queued < 0
      || !Array.isArray(snapshot.chunks) || snapshot.chunks.length > 512
      || !Array.isArray(snapshot.errors) || snapshot.errors.length > 8) {
      throw new Error('frame-response-invalid');
    }
    let chunkBytes = 0;
    for (const chunk of snapshot.chunks) {
      if (!chunk || !Number.isSafeInteger(chunk.seq) || chunk.seq < 0
        || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > MAX_CHUNK_BYTES
        || typeof chunk.data !== 'string' || chunk.data.length > Math.ceil(MAX_CHUNK_BYTES * 4 / 3) + 8) {
        throw new Error('frame-response-invalid');
      }
      chunkBytes += chunk.bytes;
    }
    if (chunkBytes > MAX_PULL_BYTES || snapshot.queued < snapshot.chunks.length) {
      throw new Error('frame-response-oversized');
    }
    return snapshot;
  }

  async function handle(request) {
    switch (request.op) {
      case 'init':
        return initialize(request);
      case 'prepare': {
        if (!active) throw new Error('capture-not-initialized');
        const parts = await Promise.all(Array.from(frames.values(), async frame => {
          const result = await requestFrame(frame, 'prepare', {
            expectedDuration: active.expectedDuration,
            plan: frame.plan,
            perFrameLimit: 1024 * 1024,
            pullLimit: Math.floor(MAX_PULL_BYTES / frames.size),
          }, PREPARE_FRAME_TIMEOUT_MS);
          return snapshotResult(result);
        }));
        return { ok: true, parts };
      }
      case 'start': {
        if (!active) throw new Error('capture-not-initialized');
        await Promise.all(Array.from(frames.values(), frame =>
          requestFrame(frame, 'arm', {}, ARM_FRAME_TIMEOUT_MS)));
        await Promise.all(Array.from(frames.values(), frame =>
          requestFrame(frame, 'release', {}, RELEASE_FRAME_TIMEOUT_MS)));
        return { ok: true, started: frames.size };
      }
      case 'pull': {
        if (!active) throw new Error('capture-not-initialized');
        if (request.acks !== undefined) {
          if (!Array.isArray(request.acks) || request.acks.length > MAX_PARTS) throw new Error('invalid-capture-ack');
          await Promise.all(request.acks.map(async ack => {
            if (!ack || !Number.isSafeInteger(ack.part) || !Number.isSafeInteger(ack.seq) || ack.seq < 0) throw new Error('invalid-capture-ack');
            const frame = frames.get(ack.part);
            if (!frame) throw new Error('invalid-capture-ack');
            await requestFrame(frame, 'ack', { seq: ack.seq }, 5000);
          }));
        }
        const parts = await Promise.all(Array.from(frames.values(), async frame =>
          snapshotResult(await requestFrame(frame, 'pull', {}, 5000))));
        const bytes = parts.reduce((sum, part) => sum + part.chunks.reduce((n, chunk) => n + chunk.bytes, 0), 0);
        if (bytes > MAX_PULL_BYTES) throw new Error('pull-memory-limit');
        const result = { ok: true, parts };
        if (JSON.stringify(result).length > MAX_PULL_RESPONSE_BYTES) throw new Error('pull-response-limit');
        return result;
      }
      case 'ack': {
        if (!active || !Array.isArray(request.acks) || request.acks.length > MAX_PARTS) {
          throw new Error('invalid-capture-ack');
        }
        const acknowledged = await Promise.all(request.acks.map(async ack => {
          if (!ack || !Number.isSafeInteger(ack.part) || !Number.isSafeInteger(ack.seq) || ack.seq < 0) {
            throw new Error('invalid-capture-ack');
          }
          const frame = frames.get(ack.part);
          if (!frame) throw new Error('invalid-capture-ack');
          await requestFrame(frame, 'ack', { seq: ack.seq }, 5000);
          return ack.part;
        }));
        return { ok: true, acknowledged: acknowledged.length };
      }
      case 'stop':
        await stopAll();
        return { ok: true };
      default:
        throw new Error('unknown-capture-command');
    }
  }

  async function stopAll() {
    const current = Array.from(frames.values());
    await Promise.all(current.map(frame => requestFrame(frame, 'stop', {}, 2000).catch(() => null)));
    for (const frame of current) {
      for (const waiter of frame.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('capture-stopped'));
      }
      frame.pending.clear();
      frame.iframe.remove();
    }
    frames.clear();
  }

  window.addEventListener('message', onMessage);

  window.__tempoRecordingDispatch = request => {
    if (!request || typeof request !== 'object'
      || typeof request.requestId !== 'string'
      || !/^n[0-9a-z]{1,20}$/.test(request.requestId)
      || results.has(request.requestId)) return false;
    if (results.size >= 8) results.delete(results.keys().next().value);
    Promise.resolve()
      .then(() => handle(request))
      .then(value => results.set(request.requestId, value))
      .catch(error => results.set(request.requestId, { ok: false, error: safeError(error) }));
    return true;
  };
  window.__tempoRecordingTakeResult = requestId => {
    if (typeof requestId !== 'string' || !/^n[0-9a-z]{1,20}$/.test(requestId)) return null;
    if (!results.has(requestId)) return null;
    const value = results.get(requestId);
    results.delete(requestId);
    return value;
  };

  window.addEventListener('beforeunload', () => { void stopAll(); });
})();

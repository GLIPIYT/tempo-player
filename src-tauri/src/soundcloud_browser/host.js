(() => {
  'use strict';

  const SC_ORIGIN = 'https://w.soundcloud.com';
  const SC_API_URL = 'https://w.soundcloud.com/player/api.js';
  const FRAME_PARENT_ORIGIN = 'http://tempo-sc-playback.localhost';
  const MAX_PENDING_EVENTS = 16;
  const iframe = document.getElementById('sc-widget');
  const pending = { critical: [], clock: null, spectrum: null };

  let widget = null;
  let active = null;
  let loadingTimer = null;
  let positionTimer = null;
  let latestPosition = 0;
  let lastPositionChangeAt = 0;
  let seekTarget = null;
  let seekStartedAt = 0;
  let finishSent = false;
  let failureSent = false;
  let widgetHasTrack = false;
  let positionRequestPending = false;
  let positionRequestSerial = 0;

  function bounded(value, min, max) {
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

  function settingsFrom(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !hasOnlyKeys(value, ['volume', 'playbackRate', 'preservePitch', 'equalizerEnabled',
        'equalizerGains', 'gainDb', 'spectrumEnabled'])) return null;
    if (!Array.isArray(value.equalizerGains) || value.equalizerGains.length !== 10) return null;
    const values = [value.volume, value.playbackRate, value.gainDb, ...value.equalizerGains];
    if (values.some((item) => !finite(item))) return null;
    if (typeof value.preservePitch !== 'boolean'
      || typeof value.equalizerEnabled !== 'boolean'
      || typeof value.spectrumEnabled !== 'boolean') return null;
    return {
      volume: bounded(value.volume, 0, 1),
      playbackRate: bounded(value.playbackRate, 0.5, 2),
      preservePitch: value.preservePitch,
      equalizerEnabled: value.equalizerEnabled,
      equalizerGains: value.equalizerGains.map((gain) => bounded(gain, -18, 18)),
      gainDb: bounded(value.gainDb, -36, 36),
      spectrumEnabled: value.spectrumEnabled,
    };
  }

  function post(event) {
    if (event.type === 'clock') {
      pending.clock = event;
      return;
    }
    if (event.type === 'spectrum') {
      pending.spectrum = event;
      return;
    }
    if (pending.critical.length >= MAX_PENDING_EVENTS) {
      const replaceable = pending.critical.findIndex((item) => item.type === 'capabilities');
      if (replaceable >= 0) {
        pending.critical.splice(replaceable, 1);
      } else if (event.type === 'failed' || event.type === 'finished' || event.type === 'ready') {
        pending.critical.shift();
      } else {
        return;
      }
    }
    pending.critical.push(event);
  }

  function resetPending() {
    pending.critical.length = 0;
    pending.clock = null;
    pending.spectrum = null;
  }

  function emitFailure(code) {
    if (!active || failureSent) return;
    failureSent = true;
    active.ready = false;
    clearInterval(positionTimer);
    clearTimeout(loadingTimer);
    post({ type: 'failed', code });
  }

  function sendFrameControl(command) {
    if (!active || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({
      protocol: 1,
      type: 'tempo-control',
      command,
      nonce: active.nonce,
      generation: active.generation,
      trackId: active.trackId,
      settings: active.settings,
    }, SC_ORIGIN);
  }

  function trackWidgetUrl(trackId) {
    const trackUrl = 'https://api.soundcloud.com/tracks/' + encodeURIComponent(trackId);
    const params = new URLSearchParams({
      url: trackUrl,
      auto_play: 'false',
      hide_related: 'true',
      show_comments: 'false',
      show_user: 'false',
      show_reposts: 'false',
      visual: 'false',
      single_active: 'false',
      buying: 'false',
      sharing: 'false',
      download: 'false',
    });
    return SC_ORIGIN + '/player/?' + params.toString();
  }

  function durationMatches(actual, expected) {
    const tolerance = Math.max(2, expected * 0.01);
    return finite(actual) && actual > 0 && Math.abs(actual - expected) <= tolerance;
  }

  function sameActive(ticket) {
    return active === ticket && !failureSent;
  }

  function sendCapabilities(message) {
    if (!active || !message || message.type !== 'capabilities') return;
    const equalizer = message.equalizer === true;
    const gain = message.gain === true;
    const spectrum = message.spectrum === true;
    const hasError = message.error === 'audio-processing-unavailable';
    post({
      type: 'capabilities',
      equalizer,
      gain,
      spectrum,
      error: hasError ? 'audio-processing-unavailable' : null,
    });
  }

  function publishClock(position) {
    if (!active || !active.ready || finishSent || !finite(position)) return;
    const now = Date.now();
    const normalized = bounded(position, 0, active.duration);

    if (seekTarget !== null) {
      if (Math.abs(normalized - seekTarget) <= 1.5) {
        seekTarget = null;
      } else if (now - seekStartedAt < 10000) {
        return;
      } else {
        seekTarget = null;
      }
    }

    if (Math.abs(normalized - latestPosition) >= 0.025) {
      latestPosition = normalized;
      lastPositionChangeAt = now;
      active.hasAdvanced = true;
    }
    const buffering = active.playing
      && latestPosition < active.duration
      && (!active.hasAdvanced || now - lastPositionChangeAt > 1500);
    post({
      type: 'clock',
      position: latestPosition,
      duration: active.duration,
      playing: active.playing,
      buffering,
    });
  }

  function verifyLoadedTrack(ticket, deadline, lastId) {
    if (!sameActive(ticket) || ticket.ready) return;
    try {
      widget.getCurrentSound((sound) => {
        if (!sameActive(ticket) || ticket.ready) return;
        const id = sound && sound.id !== undefined ? String(sound.id) : '';
        const nextLastId = id || lastId;
        if (id === ticket.trackId) {
          widget.getDuration((durationMs) => {
            if (!sameActive(ticket) || ticket.ready) return;
            const actualDuration = finite(durationMs) ? durationMs / 1000 : 0;
            if (!finite(actualDuration) || actualDuration <= 0) {
              if (Date.now() >= deadline) emitFailure('widget_startup_timeout');
              else setTimeout(() => verifyLoadedTrack(ticket, deadline, lastId), 250);
              return;
            }
            if (!durationMatches(actualDuration, ticket.expectedDuration)) {
              emitFailure('duration_mismatch');
              return;
            }
            onTrackReady(ticket, actualDuration);
          });
          return;
        }
        if (Date.now() >= deadline) {
          emitFailure(nextLastId && nextLastId !== ticket.trackId
            ? 'track_id_mismatch'
            : 'widget_startup_timeout');
          return;
        }
        setTimeout(() => verifyLoadedTrack(ticket, deadline, nextLastId), 250);
      });
    } catch (_) {
      if (Date.now() >= deadline) emitFailure('widget_startup_timeout');
      else setTimeout(() => verifyLoadedTrack(ticket, deadline, lastId), 250);
    }
  }

  function onTrackReady(ticket, actualDuration) {
    if (!sameActive(ticket) || ticket.ready) return;
    clearTimeout(loadingTimer);
    ticket.ready = true;
    ticket.duration = actualDuration;
    ticket.playing = false;
    latestPosition = ticket.position;
    lastPositionChangeAt = Date.now();
    if (ticket.position > 0) {
      seekTarget = ticket.position;
      seekStartedAt = lastPositionChangeAt;
    }
    finishSent = false;
    failureSent = false;
    try {
      sendFrameControl('activate');
      // A fresh Widget already starts paused at zero. Extra pause/seek commands
      // here can restart its first protected-media request before Play arrives.
      if (ticket.position > 0) widget.seekTo(Math.round(ticket.position * 1000));
      widget.setVolume(Math.round(ticket.settings.volume * 100));
      if (ticket.playingRequested) widget.play();
    } catch (_) {
      emitFailure('widget_startup_timeout');
      return;
    }
    post({ type: 'ready', duration: actualDuration });
    startPositionPolling();
  }

  function startPositionPolling() {
    clearInterval(positionTimer);
    positionTimer = setInterval(() => {
      const ticket = active;
      if (!ticket || !ticket.ready || !widget || finishSent || failureSent
        || positionRequestPending) return;
      const requestSerial = ++positionRequestSerial;
      try {
        positionRequestPending = true;
        widget.getPosition((positionMs) => {
          if (requestSerial === positionRequestSerial) positionRequestPending = false;
          if (!sameActive(ticket) || !ticket.ready || finishSent) return;
          if (finite(positionMs)) publishClock(positionMs / 1000);
        });
      } catch (_) {
        if (requestSerial === positionRequestSerial) positionRequestPending = false;
        // Widget events and the next position read will recover from a transient callback failure.
      }
    }, 100);
  }

  function bindWidgetEvents() {
    const events = window.SC && window.SC.Widget && window.SC.Widget.Events;
    if (!events || !widget) {
      emitFailure('widget_api_unavailable');
      return;
    }
    widget.bind(events.READY, () => {
      const ticket = active;
      if (ticket && !ticket.ready) verifyLoadedTrack(ticket, Date.now() + 10000, '');
    });
    widget.bind(events.PLAY, () => {
      const ticket = active;
      if (!ticket || !ticket.ready || finishSent || failureSent) return;
      ticket.playing = true;
      lastPositionChangeAt = Date.now();
      pending.spectrum = null;
      sendFrameControl('play');
    });
    widget.bind(events.PAUSE, () => {
      const ticket = active;
      if (!ticket || !ticket.ready || finishSent) return;
      ticket.playing = false;
      pending.spectrum = null;
      sendFrameControl('pause');
    });
    widget.bind(events.PLAY_PROGRESS, (data) => {
      const ticket = active;
      if (!ticket || !ticket.ready || finishSent || !data
        || !finite(data.currentPosition)) return;
      publishClock(data.currentPosition / 1000);
    });
    widget.bind(events.FINISH, () => {
      const ticket = active;
      if (!ticket || !ticket.ready || finishSent || failureSent) return;
      finishSent = true;
      ticket.playing = false;
      ticket.position = ticket.duration;
      pending.spectrum = null;
      sendFrameControl('pause');
      post({ type: 'finished' });
    });
    widget.bind(events.ERROR, () => {
      if (active && !active.ready) emitFailure('track_access_failed');
      else if (active && active.ready) emitFailure('track_access_failed');
    });
  }

  function ensureWidget() {
    if (widget) return Promise.resolve(widget);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SC_API_URL;
      script.async = true;
      script.onload = () => {
        if (!window.SC || typeof window.SC.Widget !== 'function') {
          reject(new Error('widget_api_unavailable'));
          return;
        }
        resolve();
      };
      script.onerror = () => reject(new Error('widget_api_unavailable'));
      document.head.appendChild(script);
    });
  }

  function beginLoad(config) {
    if (!config || typeof config !== 'object'
      || !numericId(config.trackId)
      || !finite(config.expectedDuration) || config.expectedDuration <= 0
      || !finite(config.position)
      || !Number.isSafeInteger(config.generation)
      || typeof config.nonce !== 'string' || config.nonce.length > 80) return false;
    const settings = settingsFrom(config.settings);
    if (!settings) return false;

    if (active && widget) {
      try {
        widget.setVolume(0);
        widget.pause();
      } catch (_) {
        // The next load still replaces the iframe source.
      }
    }
    clearTimeout(loadingTimer);
    clearInterval(positionTimer);
    resetPending();
    const ticket = {
      trackId: config.trackId,
      expectedDuration: config.expectedDuration,
      duration: config.expectedDuration,
      generation: config.generation,
      nonce: config.nonce,
      position: bounded(config.position, 0, config.expectedDuration),
      playingRequested: config.playing === true,
      playing: false,
      ready: false,
      hasAdvanced: false,
      settings,
    };
    active = ticket;
    positionRequestSerial += 1;
    positionRequestPending = false;
    finishSent = false;
    failureSent = false;
    seekTarget = null;
    latestPosition = ticket.position;
    lastPositionChangeAt = Date.now();

    // Fetch the player and its small control API concurrently on the first load.
    // SC.Widget must still be constructed after the iframe has its official URL.
    if (!widgetHasTrack) iframe.src = trackWidgetUrl(ticket.trackId);

    ensureWidget().then(() => {
      if (active !== ticket || failureSent) return;
      loadingTimer = setTimeout(() => {
        if (active === ticket && !ticket.ready) emitFailure('widget_startup_timeout');
      }, 12000);
      try {
        const trackUrl = 'https://api.soundcloud.com/tracks/' + encodeURIComponent(ticket.trackId);
        if (widgetHasTrack) {
          widget.load(trackUrl, { auto_play: false, single_active: false });
        } else {
          widget = window.SC.Widget(iframe);
          bindWidgetEvents();
          widgetHasTrack = true;
        }
        verifyLoadedTrack(ticket, Date.now() + 11000, '');
      } catch (_) {
        emitFailure('track_access_failed');
      }
    }).catch(() => emitFailure('widget_api_unavailable'));
    return true;
  }

  function command(value) {
    if (!active || !value || typeof value !== 'object'
      || value.nonce !== active.nonce
      || value.generation !== active.generation
      || value.trackId !== active.trackId) return false;
    if (value.command === 'activate') return beginLoad(value);
    if (!active.ready || !widget) return false;

    if (value.command === 'play') {
      try { widget.play(); return true; } catch (_) { return false; }
    }
    if (value.command === 'pause') {
      try { widget.pause(); return true; } catch (_) { return false; }
    }
    if (value.command === 'seek') {
      if (!finite(value.position)) return false;
        seekTarget = bounded(value.position, 0, active.duration);
        seekStartedAt = Date.now();
        lastPositionChangeAt = seekStartedAt;
      try {
        widget.seekTo(Math.round(seekTarget * 1000));
        return true;
      } catch (_) {
        seekTarget = null;
        return false;
      }
    }
    if (value.command === 'configure') {
      const settings = settingsFrom(value.settings);
      if (!settings) return false;
      active.settings = settings;
      try {
        widget.setVolume(Math.round(settings.volume * 100));
        sendFrameControl('configure');
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function prepareForReplacement() {
    if (!widget) return;
    try {
      widget.setVolume(0);
      widget.pause();
    } catch (_) {
      // The caller will either load the next entry or close this WebView.
    }
  }

  function validFrameMessage(event) {
    const data = event.data;
    return event.origin === SC_ORIGIN
      && event.source === iframe.contentWindow
      && active
      && data && typeof data === 'object'
      && !Array.isArray(data)
      && hasOnlyKeys(data, ['protocol', 'type', 'nonce', 'generation', 'trackId',
        'equalizer', 'gain', 'spectrum', 'error', 'bins'])
      && data.protocol === 1
      && data.nonce === active.nonce
      && data.generation === active.generation
      && data.trackId === active.trackId;
  }

  window.addEventListener('message', (event) => {
    if (!validFrameMessage(event)) return;
    const data = event.data;
    if (data.type === 'capabilities') {
      if (typeof data.equalizer !== 'boolean'
        || typeof data.gain !== 'boolean'
        || typeof data.spectrum !== 'boolean'
        || !(data.error === null || data.error === 'audio-processing-unavailable')
        || !hasOnlyKeys(data, ['protocol', 'type', 'nonce', 'generation', 'trackId',
          'equalizer', 'gain', 'spectrum', 'error'])) return;
      sendCapabilities(data);
      return;
    }
    if (data.type === 'spectrum') {
      if (!active.ready || !active.settings.spectrumEnabled
        || !Array.isArray(data.bins) || data.bins.length !== 64
        || !data.bins.every((value) => finite(value) && value >= 0 && value <= 1)
        || !hasOnlyKeys(data, ['protocol', 'type', 'nonce', 'generation', 'trackId', 'bins'])) return;
      const bins = data.bins.slice();
      post({ type: 'spectrum', bins });
      return;
    }
    if (data.type === 'frame-error') {
      if (!hasOnlyKeys(data, ['protocol', 'type', 'nonce', 'generation', 'trackId'])) return;
      post({
        type: 'capabilities',
        equalizer: false,
        gain: false,
        spectrum: false,
        error: 'audio-processing-unavailable',
      });
    }
  });

  window.__tempoHost = {
    ready: true,
    start: beginLoad,
    command,
    prepareForReplacement,
    drain() {
      const events = pending.critical.splice(0, MAX_PENDING_EVENTS);
      if (pending.clock) {
        events.push(pending.clock);
        pending.clock = null;
      }
      if (pending.spectrum) {
        events.push(pending.spectrum);
        pending.spectrum = null;
      }
      return { events };
    },
  };

  if (window.location.origin !== FRAME_PARENT_ORIGIN) {
    window.__tempoHost.ready = false;
  }
})();

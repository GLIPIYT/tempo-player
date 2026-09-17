const SEEK_SETTLE_MS = 250
const RESYNC_GAP_SEC = 1.5
const BUFFER_DONE_FRAC = 0.999
/** How often the graph's output is sampled, and when to give up on it. */
const SILENCE_CHECK_MS = 500
const SILENCE_GIVE_UP_MS = 3000
/** Peak deviation from silence, on the 0-255 byte scale, treated as audible. */
const SILENCE_PEAK = 1
/**
 * Frequency resolution of the analyser tap: 1024 samples, so 512 bins. Enough
 * to keep the low end of the 64 log-spaced bins the visualiser reads apart.
 */
const FFT_SIZE = 1024
/**
 * dB window the analyser maps onto its 0-255 byte scale. The -100..-30 default
 * pins most musical content at 255, which flattens the spectrum into a wall.
 */
const ANALYSER_MIN_DB = -85
const ANALYSER_MAX_DB = -15

/**
 * Two playback paths, chosen per track.
 *
 * `local` goes through a Web Audio GainNode, which is what allows a gain above
 * 1.0 - needed both for loudness normalisation (lifting quiet tracks) and for
 * crossfade. `stream` is a plain element with no audio graph.
 *
 * The split exists because `createMediaElementSource` routes an element
 * permanently: a cross-origin source without CORS headers comes out as silence
 * once routed. Uncached SoundCloud tracks are exactly that - they play from a
 * remote URL - so they must never be attached to the graph. Cached SoundCloud
 * files and HLS (which goes through MediaSource, i.e. a blob URL) are
 * same-origin and safe on the local path.
 */
export type AudioChannel = 'local' | 'stream'

/**
 * The engine currently playing, published for read-only taps.
 *
 * The spectrum needs a live analyser but must not reach into the controller,
 * so the dependency stays one-way - `spectrum` imports `engine`, never the
 * reverse. There is exactly one engine per app.
 */
let engineInstance: AudioEngine | null = null

export function getEngine(): AudioEngine | null {
  return engineInstance
}

export class AudioEngine {
  private channels: Record<AudioChannel, HTMLAudioElement | null> = { local: null, stream: null }
  private activeChannel: AudioChannel = 'local'
  private hls: unknown = null
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private analyserBuf: Uint8Array<ArrayBuffer> | null = null
  /** Accumulated time the graph has been silent while the element advanced. */
  private silentMs = 0
  private lastSilenceCheck = 0
  /** Set once the graph has been abandoned; it is never rebuilt afterwards. */
  private graphDisabled = false
  private lastLoad: { url: string; format: string | null; channel: AudioChannel } | null = null
  /** The element being faded out, while a crossfade is in flight. */
  private fading: { el: HTMLAudioElement; gain: GainNode | null } | null = null
  private fadeTimer = 0
  /** 0..1 ramp applied on top of the volume, so the fade never fights applyGain. */
  private fadeLevel = 1
  private volumeLevel = 1
  /** Per-track loudness correction, linear. Only meaningful on the local path. */
  private trackGain = 1
  private rafId = 0
  private epoch = 0
  private lastSeekAt = Number.NEGATIVE_INFINITY
  private lastReported = 0
  private pendingSeek: number | null = null
  private lastBufferPct: number | null = null

  constructor() {
    engineInstance = this
  }

  onTime: (time: number, epoch: number) => void = () => {}
  onEnded: () => void = () => {}
  onLoaded: (duration: number) => void = () => {}
  onError: (message: string) => void = () => {}
  onProgress: (pct: number | null) => void = () => {}

  getSeekEpoch(): number {
    return this.epoch
  }

  /**
   * Builds the audio graph even though no gain needs applying yet, so the
   * visualiser has an analyser to read from. Only ever the local channel -
   * routing a cross-origin stream is exactly what silences it.
   */
  enableGraph(): void {
    this.ensureGainGraph()
  }

  /**
   * The live analyser, or null when nothing is routed. Null on the stream
   * channel, and null again once the silence watchdog has given up on the
   * graph - which is how the visualiser ends up idle rather than drawing a
   * frozen frame.
   */
  getAnalyser(): AnalyserNode | null {
    return this.analyser
  }

  /** The element currently producing sound; everything acts on this one. */
  private active(): HTMLAudioElement | null {
    return this.channels[this.activeChannel]
  }

  load(url: string, channel: AudioChannel = 'local'): void {
    void this.loadWithFormat(url, null, channel)
  }

  async loadWithFormat(
    url: string,
    format: string | null,
    channel: AudioChannel = 'local',
  ): Promise<void> {
    this.destroyHls()
    this.silenceOther(channel)
    this.activeChannel = channel
    this.lastLoad = { url, format, channel }
    const el = this.ensure(channel)
    this.epoch += 1
    this.pendingSeek = null
    this.lastReported = 0
    this.resetBuffer()
    this.stopTicker()
    el.removeAttribute('src')
    el.load()
    if (format === 'hls') {
      try {
        const mod = await import('hls.js')
        const Hls = mod.default
        if (Hls.isSupported()) {
          const hlsInstance = new Hls({ maxBufferLength: 30 })
          this.hls = hlsInstance
          hlsInstance.loadSource(url)
          hlsInstance.attachMedia(el)
          return
        }
      } catch {}
    }
    el.src = url
    el.load()
  }

  stop(): void {
    this.destroyHls()
    this.detachFade()
    this.fadeLevel = 1
    const el = this.active()
    if (!el) return
    this.stopTicker()
    this.pendingSeek = null
    this.lastReported = 0
    this.resetBuffer()
    el.pause()
    el.removeAttribute('src')
    el.load()
  }

  play(): void {
    const el = this.ensure(this.activeChannel)
    // autoplay policy: the context starts suspended until a gesture reaches it
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
    void el.play().catch(() => {})
    this.startTicker(el)
  }

  pause(): void {
    this.stopTicker()
    this.active()?.pause()
  }

  getCurrentTime(): number {
    return this.active()?.currentTime ?? 0
  }

  resetBuffer(): void {
    if (this.lastBufferPct !== null) {
      this.lastBufferPct = null
      this.onProgress(null)
    } else {
      this.lastBufferPct = null
    }
  }

  getDuration(): number {
    const el = this.active()
    if (!el) return 0
    const d = el.duration
    return Number.isFinite(d) ? d : 0
  }

  setCurrentTime(sec: number): void {
    const el = this.active()
    if (!el) return
    this.epoch += 1
    const target = Math.max(0, sec)
    if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
      this.pendingSeek = target
      return
    }
    this.applySeek(target)
  }

  setVolume(v: number): void {
    this.volumeLevel = Math.min(1, Math.max(0, v))
    this.applyGain()
  }

  /**
   * Per-track loudness correction as a linear multiplier. Values above 1 lift
   * quiet tracks; only the local path can express them, so the stream path
   * simply ignores anything above unity.
   */
  setTrackGain(linear: number): void {
    this.trackGain = Number.isFinite(linear) && linear > 0 ? linear : 1
    // The graph is only built when there is something to apply. With
    // normalisation off the local path stays unrouted and behaves exactly as it
    // did before, so a context that fails to start cannot silence playback.
    if (this.trackGain !== 1) this.ensureGainGraph()
    this.applyGain()
  }

  private ensureGainGraph(): void {
    if (this.ctx || this.graphDisabled) return
    this.attachGain(this.channels.local ?? this.ensure('local'))
  }

  private applyGain(): void {
    const local = this.channels.local
    const stream = this.channels.stream
    const level = this.fadeLevel
    if (this.gainNode) {
      // the whole local level lives in the graph, so it can exceed 1.0
      if (local) local.volume = 1
      this.gainNode.gain.value = this.volumeLevel * this.trackGain * level
    } else if (local) {
      // graph unavailable: fall back to attenuation only
      local.volume = this.volumeLevel * Math.min(1, this.trackGain) * level
    }
    // never routed, so it carries its own volume
    if (stream) stream.volume = this.volumeLevel * level
  }

  /**
   * Starts the next track while the current one is still playing, ramping one
   * down as the other comes up.
   *
   * The outgoing element cannot be reused - a media element has one source -
   * so it is handed to `fading` and the channel is left empty, which makes
   * `ensure` build a fresh element for the incoming track. The ramp is driven
   * from JS rather than the Web Audio scheduler because the stream channel has
   * no graph, and both channels should fade the same way.
   */
  async crossfadeTo(
    url: string,
    format: string | null,
    channel: AudioChannel,
    seconds: number,
  ): Promise<void> {
    const outgoing = this.active()
    if (!outgoing || outgoing.paused || seconds <= 0) {
      await this.loadWithFormat(url, format, channel)
      return
    }
    this.destroyHls()
    this.detachFade()
    this.fading = { el: outgoing, gain: this.gainNode }
    this.gainNode = null
    this.channels[channel] = null
    this.activeChannel = channel
    this.fadeLevel = 0

    await this.loadWithFormat(url, format, channel)
    const el = this.active()
    if (!el) return
    void el.play().catch(() => {})
    this.startTicker(el)
    this.rampFade(seconds)
  }

  private rampFade(seconds: number): void {
    const started = performance.now()
    const total = Math.max(120, seconds * 1000)
    const step = (): void => {
      const t = Math.min(1, (performance.now() - started) / total)
      this.fadeLevel = t
      this.applyGain()
      const fade = this.fading
      if (fade) {
        const level = 1 - t
        if (fade.gain) fade.gain.gain.value = this.volumeLevel * this.trackGain * level
        else fade.el.volume = Math.max(0, Math.min(1, this.volumeLevel * level))
      }
      if (t < 1) {
        this.fadeTimer = window.setTimeout(step, 40)
      } else {
        this.fadeLevel = 1
        this.applyGain()
        this.detachFade()
      }
    }
    step()
  }

  private detachFade(): void {
    if (this.fadeTimer !== 0) {
      window.clearTimeout(this.fadeTimer)
      this.fadeTimer = 0
    }
    const fade = this.fading
    if (!fade) return
    this.fading = null
    fade.el.pause()
    fade.el.removeAttribute('src')
    fade.el.load()
  }

  private applySeek(sec: number): void {
    const el = this.active()
    if (!el) return
    this.pendingSeek = null
    this.lastSeekAt = performance.now()
    el.currentTime = sec
  }

  private startTicker(el: HTMLAudioElement): void {
    this.stopTicker()
    const tick = (): void => {
      if (this.active() !== el || el.paused || el.ended) {
        this.rafId = 0
        return
      }
      this.reportPosition(el)
      this.checkSilence(el)
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private reportPosition(el: HTMLAudioElement): void {
    const seekInFlight = el.seeking || performance.now() - this.lastSeekAt < SEEK_SETTLE_MS
    const resync = !seekInFlight && Math.abs(el.currentTime - this.lastReported) > RESYNC_GAP_SEC
    if (seekInFlight && !resync) return
    this.lastReported = el.currentTime
    this.onTime(el.currentTime, this.epoch)
  }

  private reportBuffer(el: HTMLAudioElement): void {
    const pct = this.computeBufferPct(el)
    if (pct === this.lastBufferPct) return
    this.lastBufferPct = pct
    this.onProgress(pct)
  }

  private computeBufferPct(el: HTMLAudioElement): number | null {
    if (!el.src && !this.hls) return null
    const d = el.duration
    if (!Number.isFinite(d) || d <= 0) return null
    const ranges = el.buffered
    if (ranges.length === 0) return null
    const end = ranges.end(ranges.length - 1)
    const frac = end / d
    if (!Number.isFinite(frac) || frac <= 0) return null
    if (frac >= BUFFER_DONE_FRAC) return null
    return Math.min(100, Math.max(1, Math.round(frac * 100)))
  }

  private stopTicker(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  private destroyHls(): void {
    const h = this.hls as { destroy?: () => void } | null
    if (h && typeof h.destroy === 'function') {
      try {
        h.destroy()
      } catch {}
    }
    this.hls = null
  }

  /** Keeps the idle element from holding a stream open or playing underneath. */
  private silenceOther(channel: AudioChannel): void {
    const other = channel === 'local' ? 'stream' : 'local'
    const el = this.channels[other]
    if (!el) return
    el.pause()
    el.removeAttribute('src')
    el.load()
  }

  private ensure(channel: AudioChannel): HTMLAudioElement {
    const existing = this.channels[channel]
    if (existing) return existing
    const el = new Audio()
    el.preload = 'auto'
    if (channel === 'local') {
      // Local files come from the asset protocol, which is a different origin
      // from the app itself. Tauri does send Access-Control-Allow-Origin for
      // it, but a media element only gets a non-opaque response if it asks for
      // CORS - and Web Audio silences an opaque one. Without this, enabling
      // normalisation (which is what first builds the audio graph) muted every
      // local track.
      //
      // Deliberately not set on the stream channel: a remote SoundCloud URL
      // without CORS headers would then fail to load at all, and that element
      // is never routed anyway.
      el.crossOrigin = 'anonymous'
    }
    // handlers are bound to this element, so every one checks it is still the
    // active channel - a parked element must not drive the UI
    const isActive = () => this.active() === el
    el.addEventListener('timeupdate', () => {
      if (!isActive()) return
      this.reportPosition(el)
      this.reportBuffer(el)
    })
    el.addEventListener('progress', () => {
      if (isActive()) this.reportBuffer(el)
    })
    el.addEventListener('waiting', () => {
      if (isActive()) this.reportBuffer(el)
    })
    el.addEventListener('playing', () => {
      if (isActive()) this.reportBuffer(el)
    })
    el.addEventListener('canplay', () => {
      if (isActive()) this.reportBuffer(el)
    })
    el.addEventListener('ended', () => {
      if (!isActive()) return
      this.destroyHls()
      this.stopTicker()
      this.onEnded()
    })
    el.addEventListener('loadedmetadata', () => {
      if (!isActive()) return
      const pending = this.pendingSeek
      if (pending !== null) this.applySeek(pending)
      this.onLoaded(Number.isFinite(el.duration) ? el.duration : 0)
      this.reportBuffer(el)
    })
    el.addEventListener('error', () => {
      if (!isActive()) return
      if (!el.src && !this.hls) return
      this.destroyHls()
      this.stopTicker()
      this.onError(this.describeError(el))
    })
    this.channels[channel] = el
    // A crossfade replaces the channel's element while the graph is already
    // running, so the replacement has to be routed as well - otherwise the
    // incoming track would play outside the graph and ignore the fade.
    if (channel === 'local' && (this.ctx !== null || this.trackGain !== 1)) this.attachGain(el)
    this.applyGain()
    return el
  }

  /**
   * Web Audio turns an opaque source - cross-origin, no CORS - into silence,
   * and it does so *quietly*: the element still reports normal progress, no
   * error fires, and the only symptom is that nothing comes out. That is
   * exactly how enabling normalisation muted every local track once.
   *
   * So watch what the graph actually emits. If it stays flat while the element
   * is advancing, give up on the graph permanently and rebuild an unrouted
   * element: normalisation then degrades to plain volume instead of leaving the
   * user with no sound at all.
   */
  private checkSilence(el: HTMLAudioElement): void {
    if (!this.analyser || !this.analyserBuf || this.graphDisabled) return
    // The tap only ever carries the local channel. A stream track plays through
    // an element that is deliberately never routed, so it reads as silence here
    // without meaning anything - and tripping on it kills the graph for the
    // rest of the session, taking the visualiser down with it.
    if (this.activeChannel !== 'local') return
    // Likewise a context that is not running: suspended is not the same as
    // muted, and a graph that has not started cannot be judged on its output.
    if (this.ctx && this.ctx.state !== 'running') return
    const now = performance.now()
    if (now - this.lastSilenceCheck < SILENCE_CHECK_MS) return
    this.lastSilenceCheck = now
    this.analyser.getByteTimeDomainData(this.analyserBuf)
    let peak = 0
    for (let i = 0; i < this.analyserBuf.length; i += 8) {
      const deviation = Math.abs(this.analyserBuf[i] - 128)
      if (deviation > peak) peak = deviation
    }
    // a little tolerance: material can be genuinely quiet for a moment
    if (peak > SILENCE_PEAK || el.currentTime < 1) {
      this.silentMs = 0
      return
    }
    this.silentMs += SILENCE_CHECK_MS
    if (this.silentMs >= SILENCE_GIVE_UP_MS) this.disableGraph()
  }

  private disableGraph(): void {
    this.graphDisabled = true
    this.silentMs = 0
    this.analyser = null
    this.analyserBuf = null
    this.gainNode = null

    const el = this.channels.local
    if (!el) return
    const resumeAt = el.currentTime
    const load = this.lastLoad
    // a routed element can never be un-routed, so it has to be replaced
    this.channels.local = null
    el.pause()
    el.removeAttribute('src')
    el.load()

    if (this.activeChannel !== 'local' || !load) return
    void this.loadWithFormat(load.url, load.format, 'local')
      .then(() => {
        this.setCurrentTime(resumeAt)
        this.play()
      })
      .catch(() => {})
  }

  /**
   * Routes the local element through a GainNode. Called lazily, and only for
   * the same-origin channel, the first time a non-unity gain is requested. If
   * the graph cannot be built the element is left unrouted and `applyGain`
   * falls back to plain volume.
   */
  private attachGain(el: HTMLAudioElement): void {
    // one active gain at a time; during a crossfade the outgoing element keeps
    // its own, held by `fading`
    if (this.gainNode || this.graphDisabled) return
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      const ctx = this.ctx ?? new Ctor()
      // The graph is built from a React effect rather than from the click
      // itself, so the context can come up suspended. Nothing else resumes it
      // until the next play(), which is why the visualiser used to sit blank
      // on the first track and start working after a pause.
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
      const source = ctx.createMediaElementSource(el)
      const gain = ctx.createGain()
      source.connect(gain)
      gain.connect(ctx.destination)
      if (this.analyser) {
        gain.connect(this.analyser)
      } else {
        // A tap on the output, deliberately not connected onward - it feeds
        // both the silence watchdog and the spectrum the visualiser draws.
        // Connecting it to the destination as well would double the signal.
        const analyser = ctx.createAnalyser()
        analyser.fftSize = FFT_SIZE
        analyser.minDecibels = ANALYSER_MIN_DB
        analyser.maxDecibels = ANALYSER_MAX_DB
        gain.connect(analyser)
        this.analyser = analyser
        this.analyserBuf = new Uint8Array(analyser.fftSize)
      }
      this.ctx = ctx
      this.gainNode = gain
      this.silentMs = 0
    } catch {
      this.ctx = null
      this.gainNode = null
      this.analyser = null
      this.analyserBuf = null
    }
  }

  private describeError(el: HTMLAudioElement): string {
    const err = el.error
    if (!err) return 'unknown audio error'
    return err.message ? `audio error ${err.code}: ${err.message}` : `audio error ${err.code}`
  }
}

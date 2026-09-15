const SEEK_SETTLE_MS = 250
const RESYNC_GAP_SEC = 1.5
const BUFFER_DONE_FRAC = 0.999

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

export class AudioEngine {
  private channels: Record<AudioChannel, HTMLAudioElement | null> = { local: null, stream: null }
  private activeChannel: AudioChannel = 'local'
  private hls: unknown = null
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null
  private volumeLevel = 1
  /** Per-track loudness correction, linear. Only meaningful on the local path. */
  private trackGain = 1
  private rafId = 0
  private epoch = 0
  private lastSeekAt = Number.NEGATIVE_INFINITY
  private lastReported = 0
  private pendingSeek: number | null = null
  private lastBufferPct: number | null = null

  onTime: (time: number, epoch: number) => void = () => {}
  onEnded: () => void = () => {}
  onLoaded: (duration: number) => void = () => {}
  onError: (message: string) => void = () => {}
  onProgress: (pct: number | null) => void = () => {}

  getSeekEpoch(): number {
    return this.epoch
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
    if (this.ctx) return
    this.attachGain(this.channels.local ?? this.ensure('local'))
  }

  private applyGain(): void {
    const local = this.channels.local
    const stream = this.channels.stream
    if (this.gainNode) {
      // the whole local level lives in the graph, so it can exceed 1.0
      if (local) local.volume = 1
      this.gainNode.gain.value = this.volumeLevel * this.trackGain
    } else if (local) {
      // graph unavailable: fall back to attenuation only
      local.volume = this.volumeLevel * Math.min(1, this.trackGain)
    }
    // never routed, so it carries its own volume
    if (stream) stream.volume = this.volumeLevel
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
    this.applyGain()
    return el
  }

  /**
   * Routes the local element through a GainNode. Called lazily, and only for
   * the same-origin channel, the first time a non-unity gain is requested. If
   * the graph cannot be built the element is left unrouted and `applyGain`
   * falls back to plain volume.
   */
  private attachGain(el: HTMLAudioElement): void {
    if (this.ctx) return
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      const ctx = new Ctor()
      const source = ctx.createMediaElementSource(el)
      const gain = ctx.createGain()
      source.connect(gain)
      gain.connect(ctx.destination)
      this.ctx = ctx
      this.gainNode = gain
    } catch {
      this.ctx = null
      this.gainNode = null
    }
  }

  private describeError(el: HTMLAudioElement): string {
    const err = el.error
    if (!err) return 'unknown audio error'
    return err.message ? `audio error ${err.code}: ${err.message}` : `audio error ${err.code}`
  }
}

const SEEK_SETTLE_MS = 250
const RESYNC_GAP_SEC = 1.5
const BUFFER_DONE_FRAC = 0.999

export class AudioEngine {
  private audio: HTMLAudioElement | null = null
  private hls: unknown = null
  private volumeLevel = 1
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

  load(url: string): void {
    void this.loadWithFormat(url, null)
  }

  async loadWithFormat(url: string, format: string | null): Promise<void> {
    this.destroyHls()
    const el = this.ensure()
    this.epoch += 1
    this.pendingSeek = null
    this.lastReported = 0
    if (this.lastBufferPct !== null) {
      this.lastBufferPct = null
      this.onProgress(null)
    } else {
      this.lastBufferPct = null
    }
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
    const el = this.audio
    if (!el) return
    this.stopTicker()
    this.pendingSeek = null
    this.lastReported = 0
    if (this.lastBufferPct !== null) {
      this.lastBufferPct = null
      this.onProgress(null)
    } else {
      this.lastBufferPct = null
    }
    el.pause()
    el.removeAttribute('src')
    el.load()
  }

  play(): void {
    const el = this.ensure()
    void el.play().catch(() => {})
    this.startTicker(el)
  }

  pause(): void {
    this.stopTicker()
    if (this.audio) this.audio.pause()
  }

  getCurrentTime(): number {
    return this.audio ? this.audio.currentTime : 0
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
    if (!this.audio) return 0
    const d = this.audio.duration
    return Number.isFinite(d) ? d : 0
  }

  setCurrentTime(sec: number): void {
    const el = this.audio
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
    const clamped = Math.min(1, Math.max(0, v))
    this.volumeLevel = clamped
    if (this.audio) this.audio.volume = clamped
  }

  private applySeek(sec: number): void {
    const el = this.audio
    if (!el) return
    this.pendingSeek = null
    this.lastSeekAt = performance.now()
    el.currentTime = sec
  }

  private startTicker(el: HTMLAudioElement): void {
    this.stopTicker()
    const tick = (): void => {
      if (this.audio !== el || el.paused || el.ended) {
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

  private ensure(): HTMLAudioElement {
    if (this.audio) return this.audio
    const el = new Audio()
    el.preload = 'auto'
    el.volume = this.volumeLevel
    el.addEventListener('timeupdate', () => {
      this.reportPosition(el)
      this.reportBuffer(el)
    })
    el.addEventListener('progress', () => {
      this.reportBuffer(el)
    })
    el.addEventListener('waiting', () => {
      this.reportBuffer(el)
    })
    el.addEventListener('playing', () => {
      this.reportBuffer(el)
    })
    el.addEventListener('canplay', () => {
      this.reportBuffer(el)
    })
    el.addEventListener('ended', () => {
      this.destroyHls()
      this.stopTicker()
      this.onEnded()
    })
    el.addEventListener('loadedmetadata', () => {
      const pending = this.pendingSeek
      if (pending !== null) this.applySeek(pending)
      this.onLoaded(Number.isFinite(el.duration) ? el.duration : 0)
      this.reportBuffer(el)
    })
    el.addEventListener('error', () => {
      if (!el.src && !this.hls) return
      this.destroyHls()
      this.stopTicker()
      this.onError(this.describeError(el))
    })
    this.audio = el
    return el
  }

  private describeError(el: HTMLAudioElement): string {
    const err = el.error
    if (!err) return 'unknown audio error'
    return err.message ? `audio error ${err.code}: ${err.message}` : `audio error ${err.code}`
  }
}

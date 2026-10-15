import { DEFAULT_EQUALIZER_SETTINGS, EQUALIZER_BANDS, type EqualizerSettings } from '../audio/equalizer'
import type { PlaybackSample } from '../features/recommendations/types'

const SEEK_SETTLE_MS = 250
const RESYNC_GAP_SEC = 1.5
const BUFFER_DONE_FRAC = 0.999
/** How often the source is sampled, and when to give up on the graph. */
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
const HEALTH_CHECK_MS = 1000
const CONTEXT_RESUME_TIMEOUT_MS = 2500
const DECODER_STALL_MS = 8000
const RECOVERY_COOLDOWN_MS = 30_000

interface MediaGraph {
  nodes: AudioNode[]
}

/**
 * Two playback paths, chosen per track.
 *
 * `local` goes through the Web Audio EQ and gain graph, which supports
 * equalization, loudness normalisation and crossfade. `stream` is a plain
 * element with no audio graph.
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
  private mediaSessions = new WeakMap<HTMLAudioElement, { id: string; epoch: number; state: PlaybackSample['state'] }>()
  onPlaybackSample: (sample: PlaybackSample) => void = () => {}
  onMediaFinished: (sessionId: string, reason: 'end' | 'error' | 'stop') => void = () => {}
  private sampleTimer: number | null = null

  /** Snapshot the real active and fading media before a controller transition. */
  samplePlayback(): void {
    const active = this.active()
    if (active) this.sampleMedia(active)
    if (this.fading && this.fading.el !== active) this.sampleMedia(this.fading.el)
  }

  private bindSession(el: HTMLAudioElement, id?: string): void {
    if (!id) return
    this.mediaSessions.set(el, { id, epoch: ++this.epoch, state: 'waiting' })
    if (this.sampleTimer === null) this.sampleTimer = window.setInterval(() => this.samplePlayback(), 250)
  }

  private sampleMedia(el: HTMLAudioElement, state?: PlaybackSample['state']): void {
    const session = this.mediaSessions.get(el)
    if (!session) return
    if (state) session.state = state
    const actual = el.seeking ? 'seeking' : el.ended ? 'stopped' : el.paused ? 'paused'
      : el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ? 'waiting' : session.state
    this.onPlaybackSample({ sessionId: session.id, positionSec: el.currentTime, atMs: performance.now(),
      epoch: session.epoch, state: actual, playbackRate: el.playbackRate,
      durationSec: Number.isFinite(el.duration) ? el.duration : undefined })
  }

  private finishMedia(el: HTMLAudioElement, reason: 'end' | 'error' | 'stop'): void {
    const session = this.mediaSessions.get(el)
    if (!session) return
    this.sampleMedia(el, 'stopped')
    this.mediaSessions.delete(el)
    this.onMediaFinished(session.id, reason)
    if (!this.mediaSessions.get(this.active() as HTMLAudioElement) && (!this.fading || !this.mediaSessions.get(this.fading.el))) {
      if (this.sampleTimer !== null) window.clearInterval(this.sampleTimer)
      this.sampleTimer = null
    }
  }

  /** Clear-history starts a new identity without interrupting the actual media. */
  rebindActiveSession(id: string): void {
    const el = this.active()
    if (!el) return
    this.bindSession(el, id)
    this.sampleMedia(el, !el.paused && el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA ? 'playing' : 'paused')
  }
  private channels: Record<AudioChannel, HTMLAudioElement | null> = { local: null, stream: null }
  private activeChannel: AudioChannel = 'local'
  private hls: unknown = null
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null
  private compressorNode: DynamicsCompressorNode | null = null
  private analyser: AnalyserNode | null = null
  /** Monitors the source before volume and EQ, for the graph silence watchdog. */
  private sourceMonitor: AnalyserNode | null = null
  private sourceMonitorBuf: Uint8Array<ArrayBuffer> | null = null
  /** Accumulated time the source has been silent while the element advanced. */
  private silentMs = 0
  private lastSilenceCheck = 0
  /** Set once the graph has been abandoned; it is never rebuilt afterwards. */
  private graphDisabled = false
  private graphRequested = false
  private mediaGraphs = new WeakMap<HTMLAudioElement, MediaGraph>()
  private healthTimer: number | null = null
  private healthPosition = 0
  private healthMovedAt = 0
  private contextHeld = false
  private contextResume: { context: AudioContext; at: number } | null = null
  private lastContextRebuildAt = Number.NEGATIVE_INFINITY
  private lastDecoderRecoveryAt = Number.NEGATIVE_INFINITY
  private lastDecoderRecoveryUrl: string | null = null
  private lastLoad: { url: string; format: string | null; channel: AudioChannel } | null = null
  /** The element being faded out, while a crossfade is in flight. */
  private fading: {
    el: HTMLAudioElement
    gain: GainNode | null
    compressor: DynamicsCompressorNode | null
    eqFilters: BiquadFilterNode[]
  } | null = null
  private fadeTimer = 0
  private fadeDurationMs = 0
  private fadeElapsedMs = 0
  private fadeLastAt: number | null = null
  private playbackPaused = true
  /** 0..1 ramp applied on top of the volume, so the fade never fights applyGain. */
  private fadeLevel = 1
  private volumeLevel = 1
  /** Per-track loudness correction, linear. Only meaningful on the local path. */
  private trackGain = 1
  private playbackRate = 1
  private preservePitch = true
  private equalizer: EqualizerSettings = DEFAULT_EQUALIZER_SETTINGS
  private eqFilters: BiquadFilterNode[] = []
  private eqBoostDb = 0
  private rafId = 0
  private epoch = 0
  private loadGeneration = 0
  private swappingStream = false
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
  onFadeComplete: () => void = () => {}

  getSeekEpoch(): number {
    return this.epoch
  }

  getActiveChannel(): AudioChannel {
    return this.activeChannel
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
    sessionId?: string,
  ): Promise<void> {
    // Invalidate an older async load before touching the channels. In
    // particular, ensure() can fail before the media element exists.
    const generation = ++this.loadGeneration
    this.destroyHls()
    this.silenceOther(channel)
    this.activeChannel = channel
    this.lastLoad = { url, format, channel }
    const el = this.ensure(channel)
    this.bindSession(el, sessionId)
    this.applyPlaybackOptions(el)
    el.muted = false
    this.epoch += 1
    this.pendingSeek = null
    this.lastReported = 0
    this.resetHealthPosition()
    this.resetBuffer()
    this.stopTicker()
    el.removeAttribute('src')
    el.load()
    if (format === 'hls') {
      try {
        const mod = await import('hls.js')
        if (
          generation !== this.loadGeneration ||
          this.activeChannel !== channel ||
          this.channels[channel] !== el
        ) return
        const Hls = mod.default
        if (Hls.isSupported()) {
          const hlsInstance = new Hls({ maxBufferLength: 30 })
          this.hls = hlsInstance
          hlsInstance.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal || generation !== this.loadGeneration || this.hls !== hlsInstance || this.active() !== el) return
            this.finishMedia(el, 'error')
            this.stopTicker()
            this.stopHealthChecks()
            this.destroyHls()
            const message = `HLS audio error: ${data.details}`
            if (this.fading) this.failFade(message)
            else this.onError(message)
          })
          hlsInstance.loadSource(url)
          hlsInstance.attachMedia(el)
          return
        }
      } catch {}
    }
    if (
      generation !== this.loadGeneration ||
      this.activeChannel !== channel ||
      this.channels[channel] !== el
    ) return
    el.src = url
    el.load()
  }

  stop(): void {
    this.samplePlayback()
    this.playbackPaused = true
    this.contextHeld = false
    this.stopHealthChecks()
    this.loadGeneration += 1
    this.destroyHls()
    const wasFading = this.fading !== null
    this.detachFade()
    this.fadeLevel = 1
    if (wasFading) this.onFadeComplete()
    const el = this.active()
    if (!el) return
    this.finishMedia(el, 'stop')
    if (this.swappingStream && this.activeChannel === 'stream') {
      const prepared = this.channels.local
      prepared?.pause()
      prepared?.removeAttribute('src')
      prepared?.load()
      if (prepared) prepared.muted = false
    }
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
    const fade = this.fading
    const generation = this.loadGeneration
    this.playbackPaused = false
    this.startHealthChecks()
    if (this.activeChannel === 'local' && this.ctx && this.ctx.state !== 'running') {
      this.checkContextHealth()
      return
    }
    const plays = [el.play()]
    if (fade && !fade.el.ended) plays.push(fade.el.play())
    void Promise.all(plays).then(() => {
      if (this.active() === el && generation === this.loadGeneration && this.fading === fade && !this.playbackPaused) this.resumeFade()
    }).catch(error => {
      if (this.active() !== el || generation !== this.loadGeneration || this.playbackPaused) return
      if (this.fading === fade && fade) { this.failFade(error instanceof Error ? error.message : 'Could not resume the audio transition'); return }
      this.finishMedia(el, 'error')
      this.onError(error instanceof Error ? error.message : 'Could not play audio')
    })
    this.startTicker(el)
  }

  pause(): void {
    this.samplePlayback()
    this.freezeFade()
    this.playbackPaused = true
    this.contextHeld = false
    this.stopHealthChecks()
    this.stopTicker()
    this.active()?.pause()
    this.fading?.el.pause()
  }

  /** Reuse buffered media for repeat-one without a new provider lookup. */
  replay(sessionId: string): boolean {
    const el = this.active()
    if (!el || el.error || (!el.src && !this.hls) || el.readyState < HTMLMediaElement.HAVE_METADATA) return false
    try { this.setCurrentTime(0) } catch { return false }
    this.bindSession(el, sessionId)
    this.resetHealthPosition()
    this.play()
    return true
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
    this.sampleMedia(el)
    const session = this.mediaSessions.get(el)
    if (session) { session.epoch += 1; this.sampleMedia(el, 'seeking') }
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

  setPlaybackRate(rate: number): void {
    this.samplePlayback()
    const safeRate = Number.isFinite(rate) ? rate : 1
    this.playbackRate = Math.round(Math.min(2, Math.max(0.5, safeRate)) * 20) / 20
    this.applyPlaybackOptions(this.channels.local)
    this.applyPlaybackOptions(this.channels.stream)
    this.applyPlaybackOptions(this.fading?.el ?? null)
    this.samplePlayback()
  }

  setPreservePitch(preserve: boolean): void {
    this.preservePitch = preserve
    this.applyPlaybackOptions(this.channels.local)
    this.applyPlaybackOptions(this.channels.stream)
    this.applyPlaybackOptions(this.fading?.el ?? null)
  }

  setEqualizer(settings: EqualizerSettings): void {
    this.equalizer = settings
    if (settings.enabled) this.ensureGainGraph()
    this.applyEqualizer()
    this.applyGain()
  }

  /**
   * Per-track loudness correction as a linear multiplier. Values above 1 lift
   * quiet tracks; only the local path can express them, so the stream path
   * simply ignores anything above unity.
   */
  setTrackGain(linear: number): void {
    this.trackGain = Number.isFinite(linear) && linear > 0 ? linear : 1
    // The graph is built for normalization, EQ or the visualizer. If it cannot
    // start, the local path falls back to element volume and keeps playing.
    if (this.trackGain !== 1) this.ensureGainGraph()
    this.applyGain()
  }

  private ensureGainGraph(): void {
    this.graphRequested = true
    if (this.ctx || this.graphDisabled) return
    this.attachGain(this.channels.local ?? this.ensure('local'))
    this.checkContextHealth()
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
    sessionId?: string,
  ): Promise<void> {
    const outgoing = this.active()
    if (!outgoing || outgoing.paused || seconds <= 0) {
      const loading = this.loadWithFormat(url, format, channel, sessionId)
      const generation = this.loadGeneration
      try {
        await loading
        if (generation === this.loadGeneration) this.play()
      } catch (error) {
        if (generation === this.loadGeneration) {
          this.onError(error instanceof Error ? error.message : 'Could not load the next track')
        }
      } finally {
        if (generation === this.loadGeneration) this.onFadeComplete()
      }
      return
    }
    this.destroyHls()
    this.detachFade()
    const outgoingChannel = this.activeChannel
    const transition = {
      el: outgoing,
      gain: this.gainNode,
      compressor: this.compressorNode,
      eqFilters: this.eqFilters,
    }
    this.fading = transition
    this.gainNode = null
    this.compressorNode = null
    this.eqFilters = []
    this.channels[outgoingChannel] = null
    const parked = this.channels[channel]
    if (parked && parked !== outgoing) this.disposeMedia(parked)
    this.channels[channel] = null
    this.activeChannel = channel
    this.fadeLevel = 0

    const loading = this.loadWithFormat(url, format, channel, sessionId)
    const generation = this.loadGeneration
    try {
      await loading
      if (generation !== this.loadGeneration || this.fading !== transition) return
      const el = this.active()
      if (!el) {
        this.failFade('Could not load the next track')
        return
      }
      if (!this.playbackPaused) await el.play()
      if (
        generation !== this.loadGeneration ||
        this.active() !== el ||
        this.fading !== transition
      ) return
      if (!this.playbackPaused) this.startTicker(el)
      this.rampFade(seconds)
    } catch (error) {
      // An old load/play promise may reject after a newer track transition
      // replaced this fade. Never tear down the newer transition as cleanup.
      if (generation === this.loadGeneration && this.fading === transition) {
        if (this.playbackPaused) this.rampFade(seconds)
        else this.failFade(error instanceof Error ? error.message : 'Could not start the next track')
      }
    }
  }

  /**
   * Replaces a progressive, cross-origin SoundCloud stream with its completed
   * local cache file. The file is prepared on the local element while the
   * stream remains audible; the handoff keeps the current media position and
   * uses a very short fade to avoid a click.
   */
  async replaceStreamWithCachedFile(url: string): Promise<boolean> {
    const outgoing = this.channels.stream
    if (this.activeChannel !== 'stream' || !outgoing || this.fading || this.swappingStream) return false
    const incoming = this.ensure('local')
    if (incoming === outgoing) return false
    const generation = this.loadGeneration
    this.swappingStream = true

    const discardPrepared = () => {
      // A manual track change may now be using this same element. Never clear
      // that newer source as cleanup for a stale handoff.
      if (this.activeChannel === 'local' && this.channels.local === incoming) return
      incoming.pause()
      incoming.muted = false
      incoming.removeAttribute('src')
      incoming.load()
    }

    try {
      // Reuse the local element because its MediaElementSource may already be
      // connected to the EQ/visualizer graph. A new element would not inherit
      // that one-time Web Audio connection.
      incoming.pause()
      incoming.muted = true
      incoming.removeAttribute('src')
      incoming.load()
      this.applyPlaybackOptions(incoming)
      incoming.src = url
      incoming.load()

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          window.clearTimeout(timeout)
          incoming.removeEventListener('canplay', onReady)
          incoming.removeEventListener('loadeddata', onReady)
          incoming.removeEventListener('error', onError)
          if (error) reject(error)
          else resolve()
        }
        const onReady = () => {
          if (incoming.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) finish()
        }
        const onError = () => finish(new Error('Cached audio file could not be loaded'))
        const timeout = window.setTimeout(
          () => finish(new Error('Timed out waiting for the cached audio file')),
          12_000,
        )
        incoming.addEventListener('canplay', onReady)
        incoming.addEventListener('loadeddata', onReady)
        incoming.addEventListener('error', onError)
        onReady()
      })

      if (
        this.loadGeneration !== generation ||
        this.activeChannel !== 'stream' ||
        this.channels.stream !== outgoing ||
        this.fading
      ) {
        discardPrepared()
        return false
      }

      const targetTime = this.clampMediaTime(incoming, outgoing.currentTime)
      if (!await this.seekElement(incoming, targetTime)) {
        discardPrepared()
        return false
      }
      let shouldPlay = !outgoing.paused && !outgoing.ended
      if (shouldPlay) {
        // Start silently so the local decoder is already running when the
        // active channel changes. The stream stays live until the fade begins.
        await incoming.play()
        if (
          this.loadGeneration !== generation ||
          this.activeChannel !== 'stream' ||
          this.channels.stream !== outgoing ||
          this.fading
        ) {
          discardPrepared()
          return false
        }
        if (!await this.seekElement(incoming, this.clampMediaTime(incoming, outgoing.currentTime))) {
          discardPrepared()
          return false
        }
        if (outgoing.paused || outgoing.ended) {
          incoming.pause()
          shouldPlay = false
        }
      }

      // The overlap is a decoder handoff for the same recording: count once.
      this.sampleMedia(outgoing)
      const session = this.mediaSessions.get(outgoing)
      this.mediaSessions.delete(outgoing)
      if (session) this.bindSession(incoming, session.id)
      this.channels.stream = null
      this.activeChannel = 'local'
      this.lastLoad = { url, format: null, channel: 'local' }
      this.pendingSeek = null
      this.lastReported = incoming.currentTime
      this.lastBufferPct = null
      this.onProgress(null)
      this.onLoaded(Number.isFinite(incoming.duration) ? incoming.duration : 0)
      this.fading = shouldPlay
        ? { el: outgoing, gain: null, compressor: null, eqFilters: [] }
        : null
      this.fadeLevel = shouldPlay ? 0 : 1
      incoming.muted = false
      this.sampleMedia(incoming, shouldPlay ? 'playing' : 'paused')
      this.applyGain()

      if (shouldPlay) {
        this.startTicker(incoming)
        this.rampFade(0.16)
      } else {
        outgoing.pause()
        outgoing.removeAttribute('src')
        outgoing.load()
        this.reportBuffer(incoming)
      }
      return true
    } catch {
      discardPrepared()
      return false
    } finally {
      this.swappingStream = false
    }
  }

  private clampMediaTime(el: HTMLAudioElement, value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0
    if (!Number.isFinite(el.duration) || el.duration <= 0) return value
    return Math.min(value, Math.max(0, el.duration - 0.04))
  }

  private async seekElement(el: HTMLAudioElement, time: number): Promise<boolean> {
    if (Math.abs(el.currentTime - time) < 0.04) return true
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        el.removeEventListener('seeked', finish)
        resolve(Math.abs(el.currentTime - time) <= 0.12)
      }
      const timeout = window.setTimeout(finish, 700)
      el.addEventListener('seeked', finish, { once: true })
      try {
        el.currentTime = time
      } catch {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        el.removeEventListener('seeked', finish)
        resolve(false)
      }
    })
  }

  private rampFade(seconds: number): void {
    this.fadeDurationMs = Math.max(120, seconds * 1000)
    this.fadeElapsedMs = 0
    this.fadeLastAt = null
    this.resumeFade()
  }

  private freezeFade(): void {
    if (this.fadeLastAt !== null) this.fadeElapsedMs = Math.min(this.fadeDurationMs, this.fadeElapsedMs + performance.now() - this.fadeLastAt)
    this.fadeLastAt = null
    if (this.fadeTimer !== 0) window.clearTimeout(this.fadeTimer)
    this.fadeTimer = 0
    if (this.fading && this.fadeDurationMs > 0) this.applyFadeLevel(this.fadeElapsedMs / this.fadeDurationMs)
  }

  private applyFadeLevel(level: number): void {
    this.fadeLevel = level
    this.applyGain()
    const fade = this.fading
    if (fade?.gain) fade.gain.gain.value = this.volumeLevel * this.trackGain * (1 - level)
    else if (fade) fade.el.volume = Math.max(0, Math.min(1, this.volumeLevel * (1 - level)))
  }

  private resumeFade(): void {
    if (!this.fading || this.playbackPaused || this.fadeDurationMs <= 0 || this.fadeLastAt !== null) return
    this.fadeLastAt = performance.now()
    const step = (): void => {
      try {
        this.fadeTimer = 0
        if (!this.fading || this.playbackPaused || this.fadeLastAt === null) return
        const now = performance.now()
        this.fadeElapsedMs = Math.min(this.fadeDurationMs, this.fadeElapsedMs + now - this.fadeLastAt)
        this.fadeLastAt = now
        const t = this.fadeElapsedMs / this.fadeDurationMs
        this.applyFadeLevel(t)
        if (t < 1) {
          this.fadeTimer = window.setTimeout(step, 40)
        } else {
          this.fadeLevel = 1
          this.applyGain()
          try {
            this.detachFade()
          } finally {
            this.onFadeComplete()
          }
        }
      } catch (error) {
        this.failFade(error instanceof Error ? error.message : 'Could not complete the audio transition')
      }
    }
    step()
  }

  private failFade(message: string): void {
    if (!this.fading) return
    if (this.fadeTimer !== 0) {
      window.clearTimeout(this.fadeTimer)
      this.fadeTimer = 0
    }
    this.stopTicker()
    this.fadeLevel = 1
    try {
      this.detachFade()
    } catch {
      // Detach clears the transition reference before touching the media
      // element, so the fade is no longer live even if browser cleanup fails.
    }
    try {
      this.applyGain()
    } catch {
      // Report the original transition failure after restoring logical state.
    }
    try {
      this.onError(message)
    } finally {
      this.onFadeComplete()
    }
  }

  private detachFade(): void {
    if (this.fadeTimer !== 0) {
      window.clearTimeout(this.fadeTimer)
      this.fadeTimer = 0
    }
    const fade = this.fading
    if (!fade) return
    this.fadeLastAt = null
    this.fadeDurationMs = 0
    this.fadeElapsedMs = 0
    this.finishMedia(fade.el, 'end')
    this.fading = null
    this.disposeMedia(fade.el)
  }

  private applySeek(sec: number): void {
    const el = this.active()
    if (!el) return
    this.pendingSeek = null
    this.lastSeekAt = performance.now()
    el.currentTime = sec
    this.resetHealthPosition()
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
    if (el.currentTime === this.lastReported) return
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

  private applyPlaybackOptions(el: HTMLAudioElement | null): void {
    if (!el) return
    // load() resets playbackRate to defaultPlaybackRate. Keep both in sync so
    // a newly loaded track retains the user's selected speed.
    el.defaultPlaybackRate = this.playbackRate
    el.playbackRate = this.playbackRate
    const pitchElement = el as HTMLAudioElement & {
      preservesPitch?: boolean
      webkitPreservesPitch?: boolean
      mozPreservesPitch?: boolean
    }
    pitchElement.preservesPitch = this.preservePitch
    pitchElement.webkitPreservesPitch = this.preservePitch
    pitchElement.mozPreservesPitch = this.preservePitch
  }

  private applyEqualizer(): void {
    const apply = (filters: BiquadFilterNode[]) => {
      filters.forEach((filter, index) => {
        filter.gain.value = this.equalizer.enabled ? this.equalizer.bands[index] ?? 0 : 0
      })
    }
    apply(this.eqFilters)
    if (this.fading) apply(this.fading.eqFilters)

    const filters = this.eqFilters.length > 0 ? this.eqFilters : this.fading?.eqFilters ?? []
    if (!this.equalizer.enabled || filters.length === 0) {
      this.eqBoostDb = 0
      this.updateLimiter()
      return
    }
    const count = 256
    const frequencies = new Float32Array(count)
    const combined = new Float32Array(count)
    const magnitudes = new Float32Array(count)
    const phases = new Float32Array(count)
    const maxFrequency = Math.min(20000, (this.ctx?.sampleRate ?? 48000) * 0.45)
    for (let i = 0; i < count; i += 1) {
      frequencies[i] = 20 * (maxFrequency / 20) ** (i / (count - 1))
      combined[i] = 1
    }
    for (const filter of filters) {
      filter.getFrequencyResponse(frequencies, magnitudes, phases)
      for (let i = 0; i < count; i += 1) combined[i] *= magnitudes[i]
    }
    let peak = 1
    for (const magnitude of combined) peak = Math.max(peak, magnitude)
    this.eqBoostDb = 20 * Math.log10(peak)
    this.updateLimiter()
  }

  /** Catch boosted peaks without turning down the whole EQ curve. */
  private updateLimiter(): void {
    const shouldLimit = this.equalizer.enabled && this.eqBoostDb > 0.25
    const configure = (compressor: DynamicsCompressorNode | null) => {
      if (!compressor) return
      compressor.ratio.setTargetAtTime(shouldLimit ? 20 : 1, compressor.context.currentTime, 0.025)
    }
    configure(this.compressorNode)
    configure(this.fading?.compressor ?? null)
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
      // CORS - and Web Audio silences an opaque one. Without this, routing a
      // local track through the graph for EQ or normalization could mute it.
      //
      // Deliberately not set on the stream channel: a remote SoundCloud URL
      // without CORS headers would then fail to load at all, and that element
      // is never routed anyway.
      el.crossOrigin = 'anonymous'
    }
    this.applyPlaybackOptions(el)
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
      this.sampleMedia(el, 'waiting')
      if (isActive()) this.reportBuffer(el)
    })
    el.addEventListener('playing', () => {
      this.sampleMedia(el, 'playing')
      if (isActive()) this.startTicker(el)
      if (isActive() && !this.playbackPaused) this.startHealthChecks()
      if (isActive()) this.reportBuffer(el)
    })
    el.addEventListener('canplay', () => {
      if (isActive()) this.reportBuffer(el)
    })
    el.addEventListener('ended', () => {
      if (!el.ended) return
      this.finishMedia(el, 'end')
      if (!isActive()) return
      this.stopTicker()
      this.stopHealthChecks()
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
      if (!el.error) return
      if (el.src) this.finishMedia(el, 'error')
      if (!isActive()) return
      if (!el.src && !this.hls) return
      this.destroyHls()
      this.stopTicker()
      const message = this.describeError(el)
      if (this.fading) this.failFade(message)
      else this.onError(message)
    })
    this.channels[channel] = el
    el.addEventListener('pause', () => this.sampleMedia(el, 'paused'))
    el.addEventListener('seeking', () => {
      const session = this.mediaSessions.get(el)
      if (session) session.epoch += 1
      this.sampleMedia(el, 'seeking')
    })
    el.addEventListener('seeked', () => this.sampleMedia(el, el.paused ? 'paused' : el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA ? 'playing' : 'waiting'))
    el.addEventListener('timeupdate', () => this.sampleMedia(el))
    el.addEventListener('stalled', () => this.sampleMedia(el, 'waiting'))
    // A crossfade replaces the channel's element while the graph is already
    // running, so the replacement has to be routed as well - otherwise the
    // incoming track would play outside the graph and ignore the fade.
    if (channel === 'local' && (this.ctx !== null || this.graphRequested || this.trackGain !== 1)) this.attachGain(el)
    this.applyGain()
    return el
  }

  /**
   * Web Audio turns an opaque source - cross-origin, no CORS - into silence,
   * and it does so *quietly*: the element still reports normal progress, no
   * error fires, and the only symptom is that nothing comes out. That is
   * exactly how routing local tracks through Web Audio could mute playback.
   *
   * So watch what the graph actually emits. If it stays flat while the element
   * is advancing, give up on the graph permanently and rebuild an unrouted
   * element: graph effects then fall back to plain volume instead of leaving
   * the user with no sound at all.
   */
  private checkSilence(el: HTMLAudioElement): void {
    if (!this.sourceMonitor || !this.sourceMonitorBuf || this.graphDisabled) return
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
    this.sourceMonitor.getByteTimeDomainData(this.sourceMonitorBuf)
    let peak = 0
    for (let i = 0; i < this.sourceMonitorBuf.length; i += 8) {
      const deviation = Math.abs(this.sourceMonitorBuf[i] - 128)
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
    this.rebuildLocalOutput(true)
  }

  private disconnectMediaGraph(el: HTMLAudioElement): void {
    const graph = this.mediaGraphs.get(el)
    this.mediaGraphs.delete(el)
    for (const node of graph?.nodes ?? []) {
      try { node.disconnect() } catch { /* A closed context has already detached its nodes. */ }
    }
  }

  private disposeMedia(el: HTMLAudioElement): void {
    this.disconnectMediaGraph(el)
    el.pause()
    el.removeAttribute('src')
    el.load()
  }

  private closeGraph(): void {
    const ctx = this.ctx
    this.ctx = null
    ctx?.removeEventListener('statechange', this.handleContextState)
    this.contextResume = null
    this.contextHeld = false
    for (const el of Object.values(this.channels)) if (el) this.disconnectMediaGraph(el)
    if (this.fading) this.disconnectMediaGraph(this.fading.el)
    try { this.analyser?.disconnect(); this.sourceMonitor?.disconnect() } catch { /* Already closed. */ }
    this.silentMs = 0
    this.analyser = null
    this.sourceMonitor = null
    this.sourceMonitorBuf = null
    this.gainNode = null
    this.compressorNode = null
    this.eqFilters = []
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {})
  }

  private rebuildLocalOutput(resetContext: boolean): void {
    const el = this.channels.local
    const load = this.lastLoad
    if (!el || this.activeChannel !== 'local' || !load) return
    const resumeAt = el.currentTime
    this.sampleMedia(el)
    const sessionId = this.mediaSessions.get(el)?.id
    this.mediaSessions.delete(el)
    if (this.fading) { this.detachFade(); this.onFadeComplete() }
    if (resetContext) this.closeGraph()
    else {
      this.disconnectMediaGraph(el)
      this.gainNode = null
      this.compressorNode = null
      this.eqFilters = []
    }
    // a routed element can never be un-routed, so it has to be replaced
    this.channels.local = null
    this.disposeMedia(el)
    const loading = this.loadWithFormat(load.url, load.format, 'local', sessionId)
    const generation = this.loadGeneration
    void loading
      .then(() => {
        if (generation !== this.loadGeneration || this.activeChannel !== 'local') return
        this.setCurrentTime(resumeAt)
        if (!this.playbackPaused) this.play()
      })
      .catch(error => {
        if (generation === this.loadGeneration) this.onError(error instanceof Error ? error.message : 'Could not restore audio output')
      })
  }

  private resetHealthPosition(): void {
    this.healthPosition = this.active()?.currentTime ?? 0
    this.healthMovedAt = performance.now()
  }

  private startHealthChecks(): void {
    if (this.healthTimer !== null) return
    this.resetHealthPosition()
    this.healthTimer = window.setInterval(() => this.checkHealth(), HEALTH_CHECK_MS)
  }

  private stopHealthChecks(): void {
    if (this.healthTimer !== null) window.clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private checkHealth(): void {
    const el = this.active()
    if (this.playbackPaused || !el || el.ended) return
    this.checkContextHealth()
    if (this.active() !== el || this.contextHeld) { this.resetHealthPosition(); return }
    this.reportPosition(el)
    if (!el.paused) this.checkSilence(el)
    if (this.active() !== el) return
    const now = performance.now()
    if (el.seeking || this.fading || this.swappingStream || Math.abs(el.currentTime - this.healthPosition) > 0.02) {
      this.resetHealthPosition()
      return
    }
    // Only local files are bounded by this timeout; an online HLS buffer may
    // legitimately wait longer for the network without a broken decoder.
    if (this.activeChannel !== 'local' || this.lastLoad?.format === 'hls' || now - this.healthMovedAt < DECODER_STALL_MS) return
    this.resetHealthPosition()
    if (this.lastLoad?.url === this.lastDecoderRecoveryUrl && now - this.lastDecoderRecoveryAt < RECOVERY_COOLDOWN_MS) return
    this.lastDecoderRecoveryAt = now
    this.lastDecoderRecoveryUrl = this.lastLoad?.url ?? null
    console.warn('[tempo audio] Reloading stalled local decoder')
    this.rebuildLocalOutput(false)
  }

  private handleContextState = (): void => { this.checkContextHealth() }

  private checkContextHealth(): void {
    const ctx = this.ctx
    if (!ctx || this.activeChannel !== 'local' || this.playbackPaused) return
    if (ctx.state === 'running') {
      this.contextResume = null
      if (this.contextHeld) { this.contextHeld = false; this.play() }
      return
    }
    if (!this.contextHeld) {
      this.contextHeld = true
      this.freezeFade()
      this.active()?.pause()
      this.fading?.el.pause()
    }
    if (ctx.state === 'closed') { this.recoverContext(ctx); return }
    const pending = this.contextResume
    if (pending) {
      if (performance.now() - pending.at >= CONTEXT_RESUME_TIMEOUT_MS) this.recoverContext(ctx)
      return
    }
    const attempt = { context: ctx, at: performance.now() }
    this.contextResume = attempt
    void ctx.resume().then(() => {
      if (this.ctx === ctx && this.contextResume === attempt && ctx.state === 'running') this.checkContextHealth()
    }).catch(() => {
      if (this.ctx === ctx && this.contextResume === attempt && !this.playbackPaused) this.recoverContext(ctx)
    })
  }

  private recoverContext(ctx: AudioContext): void {
    if (this.ctx !== ctx) return
    const now = performance.now()
    // One fresh graph preserves EQ after an output interruption. Repeated
    // failures bypass Web Audio instead of leaving a permanently muted source.
    if (now - this.lastContextRebuildAt < RECOVERY_COOLDOWN_MS) this.graphDisabled = true
    this.lastContextRebuildAt = now
    console.warn('[tempo audio] Restoring audio context', ctx.state)
    this.rebuildLocalOutput(true)
  }

  /**
   * Routes the local element through the EQ and gain graph. Called lazily, and
   * only for the same-origin channel, when the graph is first needed. If
   * the graph cannot be built the element is left unrouted and `applyGain`
   * falls back to plain volume.
   */
  private attachGain(el: HTMLAudioElement): void {
    // one active gain at a time; during a crossfade the outgoing element keeps
    // its own, held by `fading`
    if (this.gainNode || this.graphDisabled) return
    let buildingContext: AudioContext | null = null
    const nodes: AudioNode[] = []
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      const ctx = this.ctx ?? new Ctor({ latencyHint: 'playback' })
      buildingContext = ctx
      const source = ctx.createMediaElementSource(el)
      nodes.push(source)
      // Watch the raw media-element signal: mute and EQ attenuation must not
      // look like a broken or CORS-silenced source to the watchdog.
      if (!this.sourceMonitor) {
        const monitor = ctx.createAnalyser()
        monitor.fftSize = FFT_SIZE
        monitor.minDecibels = ANALYSER_MIN_DB
        monitor.maxDecibels = ANALYSER_MAX_DB
        this.sourceMonitor = monitor
        this.sourceMonitorBuf = new Uint8Array(monitor.fftSize)
      }
      source.connect(this.sourceMonitor)

      let previous: AudioNode = source
      const eqFilters = EQUALIZER_BANDS.map(({ frequency, type }) => {
        const filter = ctx.createBiquadFilter()
        nodes.push(filter)
        filter.type = type
        filter.frequency.value = frequency
        if (type === 'peaking') {
          // Keep the original three filters unchanged for saved five-band curves.
          filter.Q.value = frequency === 250 || frequency === 1000 || frequency === 4000 ? 1 : 1.35
        }
        previous.connect(filter)
        previous = filter
        return filter
      })
      const gain = ctx.createGain()
      const compressor = ctx.createDynamicsCompressor()
      nodes.push(gain, compressor)
      compressor.threshold.value = -1
      compressor.knee.value = 0
      compressor.ratio.value = 1
      compressor.attack.value = 0.003
      compressor.release.value = 0.14
      previous.connect(gain)
      gain.connect(compressor)
      compressor.connect(ctx.destination)
      if (this.analyser) {
        compressor.connect(this.analyser)
      } else {
        // A tap on the output, deliberately not connected onward - it feeds
        // both the silence watchdog and the spectrum the visualiser draws.
        // Connecting it to the destination as well would double the signal.
        const analyser = ctx.createAnalyser()
        analyser.fftSize = FFT_SIZE
        analyser.minDecibels = ANALYSER_MIN_DB
        analyser.maxDecibels = ANALYSER_MAX_DB
        compressor.connect(analyser)
        this.analyser = analyser
      }
      this.ctx = ctx
      ctx.removeEventListener('statechange', this.handleContextState)
      ctx.addEventListener('statechange', this.handleContextState)
      this.mediaGraphs.set(el, { nodes })
      this.gainNode = gain
      this.compressorNode = compressor
      this.eqFilters = eqFilters
      this.applyEqualizer()
      this.silentMs = 0
    } catch {
      for (const node of nodes) { try { node.disconnect() } catch { /* Partial graph. */ } }
      if (buildingContext && buildingContext !== this.ctx) void buildingContext.close().catch(() => {})
      this.closeGraph()
      // Once MediaElementSource exists, the old element cannot play directly.
      // Replace it after the caller finishes assigning the source URL.
      if (buildingContext) {
        this.graphDisabled = true
        queueMicrotask(() => { if (this.channels.local === el) this.rebuildLocalOutput(true) })
      }
    }
  }

  private describeError(el: HTMLAudioElement): string {
    const err = el.error
    if (!err) return 'unknown audio error'
    return err.message ? `audio error ${err.code}: ${err.message}` : `audio error ${err.code}`
  }
}

import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toast } from '../components/common/Toast'
import { DEFAULT_EQUALIZER_SETTINGS, type EqualizerSettings } from '../audio/equalizer'
import { lyricsService } from '../features/lyrics/lyricsService'
import { recommendationService, type RadioReservation } from '../features/recommendations/service'
import { getSettings, loadSettings, type AppSettings } from '../state/settings'
import type { RepeatMode, Track, UnifiedTrack } from '../types/models'
import { trackToUnified } from '../utils/unified'
import type { PlayerSnapshot } from './controller'

const PLAYER_PREFS = {
  volume: 'tempo.volume',
  playbackRate: 'tempo.playbackRate',
  preservePitch: 'tempo.preservePitch',
  repeat: 'tempo.repeat',
  shuffle: 'tempo.shuffle',
  queue: 'tempo.queue.snapshot.v1',
} as const

interface NativePlayerSnapshot extends PlayerSnapshot {
  initialized: boolean
  error?: string | null
  buffering?: boolean
}

interface ContinuationRequest {
  requestId: string
}

interface NativeClock {
  position: number
  duration: number | null
  isPlaying: boolean
  buffering: boolean
  version: number
}

type NativeSettingsValues = {
  volume?: number
  playbackRate?: number
  preservePitch?: boolean
  repeat?: RepeatMode
  shuffle?: boolean
  crossfadeSec?: number
  normalize?: boolean
  equalizer?: { enabled: boolean; bands: number[] }
  cacheBeforePlay?: boolean
  ytdlpPath?: string
}

type AppAudioPreferences = Pick<AppSettings, 'audio' | 'soundcloud' | 'ytdlp'>

type NativeCommand =
  | { op: 'replace'; tracks: UnifiedTrack[]; index: number; play: boolean }
  | { op: 'migrate'; settings: NativeSettingsValues; tracks: UnifiedTrack[]; index: number }
  | { op: 'toggle' | 'play' | 'pause' | 'next' | 'previous' | 'clear' }
  | { op: 'seek'; position: number }
  | ({ op: 'settings' } & NativeSettingsValues)
  | { op: 'append'; track: UnifiedTrack; next?: boolean; requestId?: string }
  | { op: 'remove'; index: number }
  | { op: 'move'; from: number; to: number }
  | { op: 'updateTrack'; track: UnifiedTrack }
  | { op: 'visibility'; visible: boolean }
  | { op: 'spectrum'; enabled: boolean }

interface QueuedCommand {
  command: NativeCommand
  resolve: () => void
  reject: (error: unknown) => void
}

interface PendingReservation {
  reservation: RadioReservation
  accepted: boolean
}

function localStorageValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function parseStoredNumber(key: string, fallback: number, min: number, max: number): number {
  const value = Number.parseFloat(localStorageValue(key) ?? '')
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function parseStoredRepeat(): RepeatMode {
  const value = localStorageValue(PLAYER_PREFS.repeat)
  return value === 'all' || value === 'one' ? value : 'off'
}

function queueKey(track: UnifiedTrack): string {
  return `${track.source}:${track.sourceId}`
}

function isUnifiedTrack(value: unknown): value is UnifiedTrack {
  if (!value || typeof value !== 'object') return false
  const track = value as Partial<UnifiedTrack>
  return (track.source === 'local' || track.source === 'soundcloud' || track.source === 'youtube') &&
    typeof track.sourceId === 'string' && typeof track.title === 'string' && Array.isArray(track.artists)
}

function readLegacyQueue(): { tracks: UnifiedTrack[]; index: number } | null {
  const raw = localStorageValue(PLAYER_PREFS.queue)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { q?: unknown; i?: unknown }
    if (!Array.isArray(parsed.q) || parsed.q.length === 0 || !parsed.q.every(isUnifiedTrack)) return null
    const tracks = parsed.q as UnifiedTrack[]
    const index = typeof parsed.i === 'number' && Number.isFinite(parsed.i)
      ? Math.min(tracks.length - 1, Math.max(0, Math.trunc(parsed.i)))
      : 0
    return { tracks, index }
  } catch {
    return null
  }
}

function appAudioSettings(settings: AppAudioPreferences): NativeSettingsValues {
  const equalizer = settings.audio.equalizer ?? DEFAULT_EQUALIZER_SETTINGS
  return {
    normalize: settings.audio.normalize,
    crossfadeSec: settings.audio.crossfadeSec,
    equalizer: { enabled: equalizer.enabled, bands: [...equalizer.bands] },
    cacheBeforePlay: settings.soundcloud.cacheBeforePlay,
    ytdlpPath: settings.ytdlp.path,
  }
}

function legacySettings(): NativeSettingsValues {
  const settings = loadSettings()
  const current = appAudioSettings(settings)
  return {
    ...current,
    volume: parseStoredNumber(PLAYER_PREFS.volume, 0.8, 0, 1),
    playbackRate: parseStoredNumber(PLAYER_PREFS.playbackRate, 1, 0.5, 2),
    preservePitch: localStorageValue(PLAYER_PREFS.preservePitch) !== '0',
    repeat: parseStoredRepeat(),
    shuffle: localStorageValue(PLAYER_PREFS.shuffle) === '1',
  }
}

function queueSignature(queue: readonly UnifiedTrack[]): string {
  return queue.map(track => [
    track.source,
    track.sourceId,
    track.dbId ?? '',
    track.title,
    track.artists.join(','),
    track.album ?? '',
    track.coverPath ?? '',
  ].join('\u001f')).join('\u001e')
}

function snapshotUiSignature(snapshot: PlayerSnapshot): string {
  const track = snapshot.currentTrack
  return [
    track ? queueSignature([track]) : '',
    queueSignature(snapshot.queue),
    snapshot.queueIndex,
    snapshot.isPlaying ? 1 : 0,
    snapshot.duration,
    snapshot.volume,
    snapshot.playbackRate,
    snapshot.preservePitch ? 1 : 0,
    snapshot.repeat,
    snapshot.shuffle ? 1 : 0,
    snapshot.bufferPct ?? '',
    snapshot.preparing ? 1 : 0,
  ].join('\u001d')
}

/**
 * Renderer-side adapter for the native playback actor. Its snapshot is always
 * authoritative; this class only interpolates the displayed source clock and
 * forwards commands over Tauri IPC.
 */
export class NativePlayerController {
  private listeners = new Set<() => void>()
  private commandQueue: QueuedCommand[] = []
  private attached = false
  private flushing = false
  private latestVersion = -1
  private nativeInitialized = false
  private buffering = false
  private pendingShuffle: boolean | null = null
  private positionTimer: number | null = null
  private basePosition = 0
  private baseAt = 0
  private snapshot: PlayerSnapshot = {
    currentTrack: null,
    queue: [],
    queueIndex: -1,
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 0.8,
    playbackRate: 1,
    preservePitch: true,
    repeat: 'off',
    shuffle: false,
    bufferPct: null,
    preparing: false,
    version: 0,
  }
  private lastUiSignature = snapshotUiSignature(this.snapshot)
  private lastError: string | null = null
  private continuationBusy = new Set<string>()
  private continuationControllers = new Map<string, AbortController>()
  private reservations = new Map<string, PendingReservation>()

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
    void this.attach()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.updatePositionTimer()
    return () => {
      this.listeners.delete(listener)
      this.updatePositionTimer()
    }
  }

  getSnapshot = (): PlayerSnapshot => this.snapshot

  /** Current source-clock time for UI animations without a React snapshot update. */
  getDisplayPosition(): number {
    if (!this.snapshot.isPlaying || this.buffering || this.snapshot.preparing || this.baseAt <= 0) {
      return this.snapshot.position
    }
    const elapsed = Math.max(0, performance.now() - this.baseAt) / 1000
    const limit = this.snapshot.duration > 0 ? this.snapshot.duration : Number.POSITIVE_INFINITY
    return Math.min(limit, Math.max(0, this.basePosition + elapsed * this.snapshot.playbackRate))
  }

  playTracks(tracks: UnifiedTrack[], startIndex = 0): void {
    this.cancelContinuation()
    this.send({ op: 'replace', tracks, index: startIndex, play: true })
  }

  toggle(): Promise<void> {
    return this.enqueue({ op: 'toggle' }).catch(error => {
      console.warn('[tempo native player] toggle failed', error)
    })
  }

  next(): Promise<void> {
    this.cancelContinuation()
    return this.enqueue({ op: 'next' }).catch(error => {
      console.warn('[tempo native player] next failed', error)
    })
  }

  previous(): Promise<void> {
    this.cancelContinuation()
    return this.enqueue({ op: 'previous' }).catch(error => {
      console.warn('[tempo native player] previous failed', error)
    })
  }

  seek(position: number): void {
    if (Number.isFinite(position)) this.send({ op: 'seek', position })
  }

  setVolume(volume: number): void {
    if (Number.isFinite(volume)) this.send({ op: 'settings', volume: Math.max(0, Math.min(1, volume)) })
  }

  setPlaybackRate(playbackRate: number, _persist = true): void {
    if (!Number.isFinite(playbackRate)) return
    const rate = Math.round(Math.max(0.5, Math.min(2, playbackRate)) * 20) / 20
    this.send({ op: 'settings', playbackRate: rate })
  }

  setPreservePitch(preservePitch: boolean): void {
    this.send({ op: 'settings', preservePitch })
  }

  setEqualizer(equalizer: EqualizerSettings): void {
    this.send({ op: 'settings', equalizer: { enabled: equalizer.enabled, bands: [...equalizer.bands] } })
  }

  setRepeat(repeat: RepeatMode): void {
    this.cancelContinuation(false)
    this.send({ op: 'settings', repeat })
  }

  toggleShuffle(): void {
    this.cancelContinuation(false)
    const shuffle = !(this.pendingShuffle ?? this.snapshot.shuffle)
    this.pendingShuffle = shuffle
    void this.enqueue({ op: 'settings', shuffle })
      .catch(error => console.warn('[tempo native player] shuffle failed', error))
  }

  addToQueue(track: UnifiedTrack): void {
    this.cancelContinuation()
    this.send({ op: 'append', track })
  }

  updateTrackMetadata(track: Track): void {
    if (track.source !== 'local') return
    const updated = trackToUnified(track)
    const current = this.snapshot.currentTrack
    if (current?.source === 'local' && current.dbId === track.id) {
      lyricsService.invalidate(updated.sourceId)
      lyricsService.ensure(updated, getSettings().lyrics.cacheOnline)
    }
    this.send({ op: 'updateTrack', track: updated })
  }

  removeFromQueue(index: number): void {
    this.cancelContinuation()
    this.send({ op: 'remove', index })
  }

  moveInQueue(from: number, to: number): void {
    this.cancelContinuation()
    this.send({ op: 'move', from, to })
  }

  clearQueue(): void {
    this.cancelContinuation()
    this.send({ op: 'clear' })
  }

  setSpectrumEnabled(enabled: boolean): void {
    this.send({ op: 'spectrum', enabled })
  }

  syncAudioSettings(settings: AppAudioPreferences): void {
    this.send({ op: 'settings', ...appAudioSettings(settings) })
  }

  private send(command: NativeCommand): void {
    void this.enqueue(command).catch(error => {
      console.warn('[tempo native player] command failed', command.op, error)
    })
  }

  private enqueue(command: NativeCommand): Promise<void> {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ command, resolve, reject })
      void this.flushCommands()
    })
  }

  private async flushCommands(): Promise<void> {
    if (!this.attached || this.flushing) return
    this.flushing = true
    try {
      while (this.attached && this.commandQueue.length > 0) {
        const item = this.commandQueue.shift()!
        try {
          await invoke<void>('native_audio_command', { command: item.command })
          item.resolve()
        } catch (error) {
          item.reject(error)
        }
      }
    } finally {
      this.flushing = false
      if (this.attached && this.commandQueue.length > 0) void this.flushCommands()
    }
  }

  private async attach(): Promise<void> {
    // Register both event streams before querying state. A snapshot taken
    // after the listeners are live closes the reconnect gap without touching
    // the native transport.
    try {
      await listen<NativePlayerSnapshot>('native-audio://state', event => {
        this.applySnapshot(event.payload)
      })
    } catch (error) {
      console.warn('[tempo native player] state listener failed', error)
    }
    try {
      await listen<ContinuationRequest>('native-audio://continuation-needed', event => {
        const requestId = event.payload?.requestId
        if (typeof requestId === 'string' && requestId.length > 0) void this.prefillContinuation(requestId)
      })
    } catch (error) {
      console.warn('[tempo native player] continuation listener failed', error)
    }
    try {
      await listen<NativeClock>('native-audio://clock', event => {
        this.applyClock(event.payload)
      })
    } catch (error) {
      console.warn('[tempo native player] clock listener failed', error)
    }
    try {
      const snapshot = await invoke<NativePlayerSnapshot>('native_audio_snapshot')
      this.applySnapshot(snapshot)
      if (!this.nativeInitialized) await this.migrateLegacyState()
    } catch (error) {
      console.warn('[tempo native player] attach failed', error)
    } finally {
      void this.enqueue({
        op: 'visibility',
        visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
      }).catch(() => {})
      this.attached = true
      void this.flushCommands()
      this.updatePositionTimer()
    }
  }

  private async migrateLegacyState(): Promise<void> {
    // Native state owns playback after the first command. The actor applies
    // this compound migration only if it is still pristine, covering a native
    // command that races the first snapshot request.
    const legacyQueue = readLegacyQueue()
    await invoke<void>('native_audio_command', {
      command: {
        op: 'migrate',
        settings: legacySettings(),
        tracks: legacyQueue?.tracks ?? [],
        index: legacyQueue?.index ?? -1,
      },
    })
  }

  private applySnapshot(payload: NativePlayerSnapshot): void {
    if (!payload || !Number.isFinite(payload.version) || payload.version < this.latestVersion) return
    const previous = this.snapshot
    const previousPosition = previous.position
    const now = performance.now()
    const position = Number.isFinite(payload.position) ? Math.max(0, payload.position) : 0
    const duration = Number.isFinite(payload.duration) ? Math.max(0, payload.duration) : 0
    const buffering = payload.buffering === true
    this.buffering = buffering
    const next: PlayerSnapshot = {
      currentTrack: payload.currentTrack ?? null,
      queue: Array.isArray(payload.queue) ? payload.queue : [],
      queueIndex: Number.isFinite(payload.queueIndex) ? payload.queueIndex : -1,
      isPlaying: payload.isPlaying === true,
      position,
      duration,
      volume: Number.isFinite(payload.volume) ? Math.max(0, Math.min(1, payload.volume)) : previous.volume,
      playbackRate: Number.isFinite(payload.playbackRate) ? payload.playbackRate : 1,
      preservePitch: payload.preservePitch === true,
      repeat: payload.repeat === 'all' || payload.repeat === 'one' ? payload.repeat : 'off',
      shuffle: payload.shuffle === true,
      bufferPct: Number.isFinite(payload.bufferPct)
        ? Math.max(0, Math.min(100, payload.bufferPct as number))
        : buffering ? 0 : null,
      preparing: payload.preparing === true,
      version: payload.version,
    }
    const expectedPosition = this.baseAt > 0
      ? this.basePosition + ((now - this.baseAt) / 1000) * previous.playbackRate
      : previousPosition
    const clockJumped = !next.isPlaying
      ? Math.abs(position - previousPosition) > 0.02
      : Math.abs(position - expectedPosition) > 0.2

    this.latestVersion = payload.version
    this.nativeInitialized = this.nativeInitialized || payload.initialized === true
    this.snapshot = next
    if (this.pendingShuffle !== null && next.shuffle === this.pendingShuffle) this.pendingShuffle = null
    this.basePosition = position
    this.baseAt = now

    const error = typeof payload.error === 'string' && payload.error.trim() ? payload.error : null
    if (error && error !== this.lastError) {
      console.error('[tempo native player]', error)
      toast.show(error, 'error')
    }
    this.lastError = error
    this.reconcileReservations()

    const nextSignature = snapshotUiSignature(next)
    if (nextSignature !== this.lastUiSignature || clockJumped) {
      this.lastUiSignature = nextSignature
      this.emit()
    }
    this.updatePositionTimer()
  }

  private applyClock(payload: NativeClock): void {
    if (!payload || !Number.isFinite(payload.version) || payload.version < this.latestVersion) return
    if (!Number.isFinite(payload.position)) return
    const previous = this.snapshot
    const now = performance.now()
    const position = Math.max(0, payload.position)
    const duration = Number.isFinite(payload.duration) ? Math.max(0, payload.duration as number) : previous.duration
    const isPlaying = payload.isPlaying === true
    const buffering = payload.buffering === true
    const transportChanged = isPlaying !== previous.isPlaying || buffering !== this.buffering
    const durationChanged = duration !== previous.duration
    const positionChanged = Math.abs(position - previous.position) > 0.02

    this.latestVersion = payload.version
    this.buffering = buffering
    this.basePosition = position
    this.baseAt = now
    this.snapshot = {
      ...previous,
      position,
      duration,
      isPlaying,
      bufferPct: buffering ? previous.bufferPct ?? 0 : previous.bufferPct,
      version: payload.version,
    }

    if (transportChanged || durationChanged || (!isPlaying && positionChanged)) this.emit()
    this.updatePositionTimer()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private updatePositionTimer(): void {
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
    const shouldRun = this.listeners.size > 0 && visible && this.snapshot.isPlaying && !this.buffering && !this.snapshot.preparing
    if (!shouldRun) {
      if (this.positionTimer !== null) window.clearInterval(this.positionTimer)
      this.positionTimer = null
      return
    }
    if (this.positionTimer !== null) return
    // Twelve and a half display updates per second are smooth for lyrics and
    // progress while keeping the rest of the React tree below audio-frame rate.
    this.positionTimer = window.setInterval(this.interpolatePosition, 80)
  }

  private interpolatePosition = (): void => {
    if (this.listeners.size === 0 || !this.snapshot.isPlaying || this.snapshot.preparing || this.buffering) return
    const position = this.getDisplayPosition()
    if (Math.abs(position - this.snapshot.position) < 0.035) return
    this.snapshot = { ...this.snapshot, position }
    this.emit()
  }

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.updatePositionTimer()
      void this.enqueue({ op: 'visibility', visible: false }).catch(() => {})
      return
    }
    void this.enqueue({ op: 'visibility', visible: true }).catch(() => {})
    void invoke<NativePlayerSnapshot>('native_audio_snapshot')
      .then(snapshot => this.applySnapshot(snapshot))
      .catch(error => console.warn('[tempo native player] refresh failed', error))
    this.updatePositionTimer()
  }

  private async prefillContinuation(requestId: string): Promise<void> {
    if (this.continuationBusy.has(requestId)) return
    this.continuationBusy.add(requestId)
    const abort = new AbortController()
    this.continuationControllers.set(requestId, abort)
    let reservation: RadioReservation | null = null
    try {
      const current = this.snapshot.currentTrack
      if (!current || abort.signal.aborted) return
      const excludedTrackKeys = this.snapshot.queue.map(queueKey)
      reservation = await recommendationService.takeForAutoplay({
        currentTrack: current,
        excludedTrackKeys,
        signal: abort.signal,
      })
      if (!reservation || abort.signal.aborted) {
        reservation?.release()
        return
      }
      const track: UnifiedTrack = { ...reservation.track, auto: true, selectionReason: 'autoplay' }
      const key = queueKey(track)
      if (this.snapshot.queue.some(item => queueKey(item) === key)) {
        reservation.release()
        return
      }
      this.reservations.set(key, { reservation, accepted: false })
      await this.enqueue({ op: 'append', track, next: false, requestId })
      const pending = this.reservations.get(key)
      if (pending) pending.accepted = true
      // State events normally settle this as soon as the actor applies the
      // append. Keep a short grace period for the command/event delivery race;
      // a stale request id is ignored by native and released here.
      window.setTimeout(() => {
        if (this.snapshot.queue.some(item => queueKey(item) === key) ||
          (this.snapshot.currentTrack && queueKey(this.snapshot.currentTrack) === key)) return
        this.reservations.get(key)?.reservation.release()
        this.reservations.delete(key)
      }, 2000)
    } catch (error) {
      reservation?.release()
      console.warn('[tempo radio] native continuation unavailable', error)
    } finally {
      this.continuationControllers.delete(requestId)
      this.continuationBusy.delete(requestId)
    }
  }

  private reconcileReservations(): void {
    const current = this.snapshot.currentTrack
    const currentKey = current ? queueKey(current) : ''
    const queueKeys = new Set(this.snapshot.queue.map(queueKey))
    const activeRadio = current?.provenance?.origin === 'radio' && current.auto === true
    for (const [key, pending] of this.reservations) {
      if (!pending.accepted) continue
      if (activeRadio && currentKey === key && this.snapshot.position >= 5) {
        pending.reservation.commit()
        this.reservations.delete(key)
      } else if (!queueKeys.has(key) && currentKey !== key) {
        pending.reservation.release()
        this.reservations.delete(key)
      } else if (currentKey !== key && this.snapshot.queueIndex >= 0) {
        const trackIndex = this.snapshot.queue.findIndex(track => queueKey(track) === key)
        if (trackIndex >= 0 && trackIndex < this.snapshot.queueIndex) {
          pending.reservation.release()
          this.reservations.delete(key)
        }
      }
    }
  }

  private cancelContinuation(releaseAccepted = true): void {
    for (const controller of this.continuationControllers.values()) controller.abort()
    this.continuationControllers.clear()
    this.continuationBusy.clear()
    for (const [key, pending] of this.reservations) {
      if (!releaseAccepted && pending.accepted) continue
      pending.reservation.release()
      this.reservations.delete(key)
    }
  }
}

/** Sends a complete merge of the settings owned by the app settings store. */
export function isNativePlayback(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && isTauri()
}

export function syncNativeAudioSettings(settings: AppAudioPreferences): void {
  if (!isNativePlayback()) return
  getNativePlayerController().syncAudioSettings(settings)
}

const NATIVE_CONTROLLER_KEY = '__tempoNativePlayerController'
type NativeControllerGlobal = typeof globalThis & { __tempoNativePlayerController?: NativePlayerController }

export function getNativePlayerController(): NativePlayerController {
  const global = globalThis as NativeControllerGlobal
  if (global[NATIVE_CONTROLLER_KEY]) return global[NATIVE_CONTROLLER_KEY]
  const controller = new NativePlayerController()
  global[NATIVE_CONTROLLER_KEY] = controller
  return controller
}

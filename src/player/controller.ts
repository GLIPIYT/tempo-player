import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from '../api/client'
import { getSettings } from '../state/settings'
import { toast } from '../components/common/Toast'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { lyricsService } from '../features/lyrics/lyricsService'
import { onSoundcloudCacheReady } from '../api/events'
import type { RepeatMode, Track, UnifiedTrack } from '../types/models'
import { trackToUnified } from '../utils/unified'
import { AudioEngine, type AudioChannel } from './engine'
import { dbToLinear } from '../audio/loudness'
import type { EqualizerSettings } from '../audio/equalizer'
import { QueueController } from './queue'

export interface PlayerSnapshot {
  currentTrack: UnifiedTrack | null
  queue: UnifiedTrack[]
  queueIndex: number
  isPlaying: boolean
  position: number
  duration: number
  volume: number
  playbackRate: number
  preservePitch: boolean
  repeat: RepeatMode
  shuffle: boolean
  bufferPct: number | null
  /**
   * True while a track is being fetched before it can start - which with
   * cache-before-play on is a wait of several seconds. Without this the player
   * bar just sits there at 0:00 and looks broken.
   */
  preparing: boolean
  version: number
}

interface ResolvedTrack {
  url: string
  format: string | null
  /**
   * Which engine path to play on. Remote SoundCloud streams must not go
   * through the Web Audio graph - a cross-origin source without CORS headers
   * comes out silent once routed.
   */
  channel: AudioChannel
}

interface ScPlayback {
  url: string
  cached: boolean
  format: string | null
}

interface PrefetchItem {
  key: string
  source: 'soundcloud' | 'youtube'
  track: UnifiedTrack
}

function youtubeDownloadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const attemptedRetry = /after retrying once/i.test(raw)
  const details = raw
    .replace(/^yt-dlp could not download this track(?: after retrying once)?:\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.replace(/^ERROR:\s*/i, '')
  const language = getSettings().lang
  const isRussian = language === 'ru' || (
    language === 'system' && typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('ru')
  )
  const botCheck = /not a bot|sign in to confirm|captcha|cookie/i.test(raw)

  if (isRussian) {
    if (botCheck) {
      return attemptedRetry
        ? 'Не удалось загрузить аудио с YouTube: сервис запросил проверку. Tempo повторил попытку. Попробуй позже; если ошибка повторится, YouTube может потребовать cookies.'
        : 'Не удалось загрузить аудио с YouTube: сервис запросил проверку. Попробуй ещё раз позже; если ошибка повторится, YouTube может потребовать cookies.'
    }
    const prefix = attemptedRetry
      ? 'Не удалось загрузить трек с YouTube после повторной попытки. Попробуй ещё раз.'
      : 'Не удалось загрузить трек с YouTube. Попробуй ещё раз.'
    return details ? `${prefix}\n${details}` : prefix
  }

  if (botCheck) {
    return attemptedRetry
      ? 'Could not load audio from YouTube: it requested a verification check. Tempo retried once. Try again later; if it keeps happening, YouTube may require cookies.'
      : 'Could not load audio from YouTube: it requested a verification check. Try again later; if it keeps happening, YouTube may require cookies.'
  }
  const prefix = attemptedRetry
    ? 'Could not download this YouTube track after one retry. Please try again.'
    : 'Could not download this YouTube track. Please try again.'
  return details ? `${prefix}\n${details}` : prefix
}

const VOLUME_KEY = 'tempo.volume'
const PLAYBACK_RATE_KEY = 'tempo.playbackRate'
const PRESERVE_PITCH_KEY = 'tempo.preservePitch'
const REPEAT_KEY = 'tempo.repeat'
const SHUFFLE_KEY = 'tempo.shuffle'
const QUEUE_SNAPSHOT_KEY = 'tempo.queue.snapshot.v1'
const SHORT_CLIP_CROSSFADE_LIMIT_SEC = 8
const CROSSFADE_TRACK_FRACTION = 0.2

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {}
}

/**
 * The controller is a module singleton with no access to React context, so it
 * reads the one setting it needs straight out of the persisted settings blob -
 * the same way it already does for volume.
 */
function normalizationEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem('tempo.settings.v1')
    if (!raw) return false
    const parsed = JSON.parse(raw) as { audio?: { normalize?: boolean } }
    return parsed.audio?.normalize === true
  } catch {
    return false
  }
}

/** Crossfade length in seconds; 0 disables it. */
function crossfadeSeconds(): number {
  try {
    const raw = window.localStorage.getItem('tempo.settings.v1')
    if (!raw) return 0
    const parsed = JSON.parse(raw) as { audio?: { crossfadeSec?: number } }
    const value = parsed.audio?.crossfadeSec
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0
    return Math.min(12, Math.max(0, value))
  } catch {
    return 0
  }
}

function clampUnit(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function artworkSrc(path: string): string {
  return /^https?:\/\//.test(path) ? path : convertFileSrc(path)
}

/**
 * How long a resolution that is not a file on disk stays good for.
 *
 * A cached file is the same file next time, so that answer holds for the whole
 * session. Everything else is either a signed stream URL that expires, or a
 * track that is still downloading and may well be on disk by the next play.
 * Remembering those forever is why a SoundCloud track that had finished
 * caching still played through the unrouted stream channel - and so showed no
 * visualiser - until the app was restarted.
 */
const SC_PLAYBACK_TTL_MS = 30_000

type ScPlaybackEntry = { playback: ScPlayback | null; at: number }

const scPlaybackCache = new Map<string, ScPlaybackEntry>()

function toScPlayback(res: { url: string | null; cachedPath: string | null; format: string | null }): ScPlayback | null {
  if (res.cachedPath) return { url: convertFileSrc(res.cachedPath), cached: true, format: res.format }
  if (res.url) return { url: res.url, cached: false, format: res.format }
  return null
}

async function fetchScPlayback(sourceId: string, waitForCache: boolean): Promise<ScPlayback | null> {
  // The flag changes the answer, so it is part of the key: flipping the setting
  // must not keep serving the other mode's resolution.
  const key = `${sourceId}|${waitForCache ? 'cache' : 'stream'}`
  const hit = scPlaybackCache.get(key)
  if (hit && (hit.playback?.cached === true || Date.now() - hit.at < SC_PLAYBACK_TTL_MS)) {
    return hit.playback
  }
  // one retry: the first call can lose a cold connection
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const playback = toScPlayback(await api.scGetPlayback(sourceId, waitForCache))
      scPlaybackCache.set(key, { playback, at: Date.now() })
      return playback
    } catch {
      scPlaybackCache.delete(key)
    }
  }
  return null
}

/**
 * Whether SoundCloud tracks should be downloaded in full before they start.
 *
 * Read straight from the persisted settings blob, the same way the controller
 * already reads volume and normalisation: it is a module singleton with no
 * access to React context.
 */
function cacheScBeforePlay(): boolean {
  try {
    const raw = window.localStorage.getItem('tempo.settings.v1')
    if (!raw) return false
    const parsed = JSON.parse(raw) as { soundcloud?: { cacheBeforePlay?: boolean } }
    return parsed.soundcloud?.cacheBeforePlay === true
  } catch {
    return false
  }
}

function readStoredVolume(): number {
  const parsed = Number.parseFloat(readPref(VOLUME_KEY) ?? '')
  if (Number.isFinite(parsed)) return clampUnit(parsed)
  return 0.8
}

function readStoredPlaybackRate(): number {
  const parsed = Number.parseFloat(readPref(PLAYBACK_RATE_KEY) ?? '')
  return Number.isFinite(parsed)
    ? Math.round(Math.min(2, Math.max(0.5, parsed)) * 20) / 20
    : 1
}

function readStoredPreservePitch(): boolean {
  return readPref(PRESERVE_PITCH_KEY) !== '0'
}

function readStoredRepeat(): RepeatMode {
  const stored = readPref(REPEAT_KEY)
  if (stored === 'all' || stored === 'one' || stored === 'off') return stored
  return 'off'
}

export class PlayerController {
  private queueCtl = new QueueController()
  private engine = new AudioEngine()
  private listeners = new Set<() => void>()
  private isPlaying = false
  private position = 0
  private duration = 0
  private volume = readStoredVolume()
  private playbackRate = readStoredPlaybackRate()
  private preservePitch = readStoredPreservePitch()
  private repeat: RepeatMode = readStoredRepeat()
  private shuffle = readPref(SHUFFLE_KEY) === '1'
  private loadedSourceId: string | null = null
  private metadataSourceId: string | null | undefined = undefined
  private bufferPct: number | null = null
  /** Set while a track is being resolved and fetched, before it can start. */
  private preparing = false
  private playedSourceIds = new Set<string>()
  private autoPickBusy = false
  private saveTimer: number | null = null
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

  constructor() {
    this.loadSnapshot()
    this.engine.setPlaybackRate(this.playbackRate)
    this.engine.setPreservePitch(this.preservePitch)
    this.engine.setEqualizer(getSettings().audio.equalizer)
    this.engine.onFadeComplete = () => {
      this.crossfading = false
    }
    this.engine.onTime = t => {
      this.position = t
      this.maybeCrossfade()
      this.emit()
    }
    this.engine.onLoaded = d => {
      if (d > 0) {
        this.duration = d
        this.emit()
      }
    }
    this.engine.onProgress = pct => {
      this.bufferPct = pct
      this.emit()
    }
    this.engine.onEnded = () => this.handleEnded()
    this.engine.onError = msg => {
      console.error('[tempo player]', msg)
      this.crossfading = false
      this.engine.pause()
      this.isPlaying = false
      this.emit()
    }
    void onSoundcloudCacheReady(sourceId => {
      void this.handleSoundcloudCacheReady(sourceId)
    }).catch(() => {})
    this.setupMediaSession()
    this.emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): PlayerSnapshot => this.snapshot

  playTracks(tracks: UnifiedTrack[], startIndex = 0): void {
    // switching tracks manually counts as a skip for the track that was playing
    this.recordSkip()
    this.startSeq += 1
    this.crossfading = false
    this.engine.stop()
    this.playedSourceIds.clear()
    this.queueCtl.setQueue(tracks, startIndex)
    this.preloadNext()
    void this.startPlayableFromCurrent()
  }

  async toggle(): Promise<void> {
    const cur = this.queueCtl.current()
    if (!cur) {
      if (this.queueCtl.getItems().length > 0) await this.startPlayableFromCurrent()
      return
    }
    if (this.isPlaying) {
      this.engine.pause()
      this.isPlaying = false
      this.emit()
      return
    }
    if (this.loadedSourceId !== cur.sourceId) {
      this.engine.stop()
      this.beginTransition(cur)
      const seq = ++this.startSeq
      this.crossfading = false
      const resolved = await this.resolveTrackUrl(cur)
      if (seq !== this.startSeq) return
      if (!resolved) return
      this.startTrack(cur, resolved)
    }
    this.engine.play()
    this.isPlaying = true
    this.emit()
  }

  async next(): Promise<void> {
    this.startSeq += 1
    this.crossfading = false
    this.engine.stop()
    this.recordSkip()
    const advanced = this.queueCtl.next(this.repeat)
    if (!advanced) {
      const picked = await this.autoPick()
      if (!picked) {
        this.stop()
        return
      }
      await this.startPlayableFromCurrent()
      return
    }
    await this.startPlayableFromCurrent()
  }

  async previous(): Promise<void> {
    const cur = this.queueCtl.current()
    if (cur && this.position > 3) {
      this.seek(0)
      return
    }
    this.startSeq += 1
    this.crossfading = false
    this.engine.stop()
    this.recordSkip()
    const prev = this.queueCtl.previous(this.repeat)
    if (!prev) return
    this.preloadNext()
    if (prev.sourceId !== this.loadedSourceId) this.beginTransition(prev)
    const seq = ++this.startSeq
    const resolved = await this.resolveTrackUrl(prev)
    if (seq !== this.startSeq) return
    if (!resolved) {
      this.emit()
      return
    }
    this.startTrack(prev, resolved)
  }

  seek(sec: number): void {
    if (!Number.isFinite(sec)) return
    const max = this.duration > 0 ? this.duration : Number.POSITIVE_INFINITY
    const clamped = Math.min(Math.max(0, sec), max)
    this.position = clamped
    this.engine.setCurrentTime(clamped)
    this.emit()
  }

  setVolume(v: number): void {
    this.volume = clampUnit(v)
    writePref(VOLUME_KEY, String(this.volume))
    this.engine.setVolume(this.volume)
    this.emit()
  }

  setPlaybackRate(rate: number): void {
    const safeRate = Number.isFinite(rate) ? rate : 1
    const next = Math.round(Math.min(2, Math.max(0.5, safeRate)) * 20) / 20
    if (next === this.playbackRate) return
    this.playbackRate = next
    writePref(PLAYBACK_RATE_KEY, String(next))
    this.engine.setPlaybackRate(next)
    this.emit()
  }

  setPreservePitch(preserve: boolean): void {
    if (preserve === this.preservePitch) return
    this.preservePitch = preserve
    writePref(PRESERVE_PITCH_KEY, preserve ? '1' : '0')
    this.engine.setPreservePitch(preserve)
    this.emit()
  }

  setEqualizer(settings: EqualizerSettings): void {
    this.engine.setEqualizer(settings)
  }

  setRepeat(m: RepeatMode): void {
    this.repeat = m
    writePref(REPEAT_KEY, m)
    this.preloadNext()
    this.emit()
  }

  toggleShuffle(): void {
    this.shuffle = !this.shuffle
    this.queueCtl.setShuffled(this.shuffle)
    writePref(SHUFFLE_KEY, this.shuffle ? '1' : '0')
    this.preloadNext()
    this.emit()
  }

  addToQueue(t: UnifiedTrack): void {
    this.queueCtl.append(t)
    this.preloadNext()
    this.emit()
  }

  updateTrackMetadata(track: Track): void {
    if (track.source !== 'local') return
    const updated = trackToUnified(track)
    const current = this.queueCtl.current()
    const isCurrentTrack = current?.source === 'local' && current.dbId === track.id
    if (!this.queueCtl.replaceLocalTrack(updated)) return
    if (isCurrentTrack) {
      lyricsService.invalidate(updated.sourceId)
      lyricsService.ensure(updated, getSettings().lyrics.cacheOnline)
    }
    // The source id stays stable for a local track, so invalidate MediaSession's
    // short-circuit to refresh the title, artist, album and artwork immediately.
    this.metadataSourceId = undefined
    this.emit()
  }

  removeFromQueue(index: number): void {
    this.queueCtl.removeAt(index)
    this.preloadNext()
    this.emit()
  }

  moveInQueue(from: number, to: number): void {
    this.queueCtl.move(from, to)
    this.preloadNext()
    this.emit()
  }

  clearQueue(): void {
    this.startSeq += 1
    this.crossfading = false
    this.queueCtl.clear()
    this.preloadNext()
    this.engine.stop()
    this.loadedSourceId = null
    this.isPlaying = false
    this.position = 0
    this.duration = 0
    this.bufferPct = null
    try {
      localStorage.removeItem(QUEUE_SNAPSHOT_KEY)
    } catch {}
    this.emit()
  }

  /** Persists the queue (throttled) so it survives an app restart. */
  private saveSnapshot(): void {
    if (this.saveTimer !== null) return
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      const q = this.queueCtl.getItems().map(({ auto: _auto, ...rest }) => rest)
      try {
        localStorage.setItem(QUEUE_SNAPSHOT_KEY, JSON.stringify({ q, i: this.queueCtl.getIndex() }))
      } catch {}
    }, 1200)
  }

  private loadSnapshot(): void {
    try {
      const raw = localStorage.getItem(QUEUE_SNAPSHOT_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { q?: UnifiedTrack[]; i?: number }
      if (!Array.isArray(parsed.q) || parsed.q.length === 0) return
      this.queueCtl.setQueue(parsed.q, Math.min(Math.max(parsed.i ?? 0, 0), parsed.q.length - 1))
    } catch {}
  }

  private startSeq = 0

  private prefetchPending: PrefetchItem[] = []
  private prefetchActiveKey: string | null = null
  private prefetchRunning = false

  private async resolveTrackUrl(t: UnifiedTrack): Promise<ResolvedTrack | null> {
    if (t.localPath) return { url: convertFileSrc(t.localPath), format: null, channel: 'local' }
    if (t.source === 'soundcloud') {
      if (t.dbId === null) {
        // tracks started from search have no library row yet - create one so the
        // track can be liked, counted and show up once its download finishes
        try {
          t.dbId = await api.upsertScTrack({
            id: t.sourceId,
            title: t.title,
            artist: t.artists[0] ?? '',
            durationMs: Math.round((t.durationSec ?? 0) * 1000),
            artworkUrl: /^https?:\/\//.test(t.coverPath ?? '') ? t.coverPath : null,
          })
        } catch {}
      }
      const playback = await fetchScPlayback(t.sourceId, cacheScBeforePlay())
      if (!playback) return null
      // Cached files are local; HLS reaches the element through MediaSource,
      // i.e. a blob URL, which is same-origin too. Only a progressive remote
      // stream has to stay off the graph.
      const channel: AudioChannel = playback.cached || playback.format === 'hls' ? 'local' : 'stream'
      return { url: playback.url, format: playback.format, channel }
    }
    if (t.source === 'youtube') {
      // A googlevideo URL cannot simply be handed to an audio element: it wants
      // a matching User-Agent, and an element cannot send one. So the track is
      // fetched to disk first and played from there - which also puts it inside
      // the audio graph, so the visualiser works on it.
      try {
        const file = await api.ytdlpCache(
          getSettings().ytdlp.path,
          t.externalUrl ?? `https://www.youtube.com/watch?v=${t.sourceId}`,
          t.sourceId,
        )
        // The search enriches its list in order, so a track can be played long
        // before its turn comes - and then it has no artist to be filed under.
        // Asking for this one directly costs an extraction and a half, which is
        // less than the download that just happened.
        let artist = t.artists[0] ?? ''
        let album = t.album ?? ''
        let durationSec = t.durationSec
        if (!artist || !album) {
          // Said out loud, so the player can show that it is looking rather
          // than claim there is no artist.
          t.resolving = true
          this.emit()
          try {
            const extra = await api.ytdlpResolveOne(getSettings().ytdlp.path, t.sourceId)
            if (extra) {
              artist = extra.artist ?? artist
              album = extra.album ?? album
              durationSec = extra.durationMs != null ? extra.durationMs / 1000 : durationSec
              // Written back so the queue, the player and anything else looking
              // at this track see the names too.
              t.artists = artist ? [artist] : t.artists
              t.album = album || t.album
              t.durationSec = durationSec
            }
          } catch {
            // filing without them is better than not filing at all
          }
          t.resolving = false
          // The track was changed in place, and React does not see that on its
          // own - the subscription is what makes the new names appear without
          // the track being restarted.
          this.emit()
        }
        // Filed now rather than at download time, so a track that is played is
        // a track that exists - under its artist and in its album, the same way
        // a SoundCloud track is.
        try {
          t.dbId = await api.upsertYtTrack({
            videoId: t.sourceId,
            title: t.title,
            artist,
            album,
            durationMs: Math.round((durationSec ?? 0) * 1000),
            artworkUrl: /^https?:\/\//.test(t.coverPath ?? '') ? t.coverPath : null,
            // Its presence is what puts the track in the library at all.
            cachedPath: file,
          })
          bumpLibraryVersion()
        } catch {
          // playing matters more than filing; the track still plays
        }
        return { url: convertFileSrc(file), format: null, channel: 'local' }
      } catch (e) {
        // Silent here would mean a track that simply never plays, with nothing
        // anywhere to say why.
        toast.show(youtubeDownloadError(e), 'error')
        return null
      }
    }
    return null
  }

  private beginTransition(track: UnifiedTrack): void {
    this.position = 0
    this.duration = track.durationSec ?? 0
    this.bufferPct = null
    this.engine.resetBuffer()
    this.emit()
  }

  private async startPlayableFromCurrent(): Promise<void> {
    const seq = ++this.startSeq
    this.crossfading = false
    this.preloadNext()
    this.engine.stop()
    // Resolving can take seconds with cache-before-play on, so the bar is told
    // something is happening instead of sitting at 0:00 looking broken.
    this.preparing = true
    this.emit()
    let guard = this.queueCtl.getItems().length + 1
    while (guard > 0) {
      guard -= 1
      if (seq !== this.startSeq) return
      const cur = this.queueCtl.current()
      if (!cur) break
      if (cur.sourceId !== this.loadedSourceId) this.beginTransition(cur)
      const resolved = await this.resolveTrackUrl(cur)
      if (seq !== this.startSeq) return
      if (resolved) {
        this.startTrack(cur, resolved)
        return
      }
      if (!this.queueCtl.next(this.repeat)) break
      this.preloadNext()
    }
    if (seq !== this.startSeq) return
    this.stop()
  }

  private startTrack(track: UnifiedTrack, resolved: ResolvedTrack, fadeSec = 0): void {
    this.loadedSourceId = track.sourceId
    this.playedSourceIds.add(track.sourceId)
    this.position = 0
    this.duration = track.durationSec ?? 0
    this.bufferPct = null
    this.preparing = false
    this.engine.setVolume(this.volume)
    // Level this track. Unmeasured tracks and streamed sources pass 1, which
    // leaves the audio path exactly as it was.
    this.engine.setTrackGain(
      normalizationEnabled() && track.gainDb !== null ? dbToLinear(track.gainDb) : 1,
    )
    if (fadeSec > 0) {
      // starts the incoming track without stopping the outgoing one; the engine
      // ramps between them
      void this.engine
        .crossfadeTo(resolved.url, resolved.format, resolved.channel, fadeSec)
        .catch(() => {})
    } else {
      void this.engine
        .loadWithFormat(resolved.url, resolved.format, resolved.channel)
        .catch(() => {})
      this.engine.play()
    }
    this.isPlaying = true
    if (track.dbId !== null) {
      api.bumpPlayCount(track.dbId).catch(() => {})
    }
    this.emit()
    this.preloadNext()
  }

  /** Warm the next four remote queue entries while the current track plays. */
  private preloadNext(): void {
    const items = this.queueCtl.getItems()
    const currentIndex = this.queueCtl.getIndex()
    const wanted = new Map<string, PrefetchItem>()
    if (this.repeat !== 'one' && currentIndex >= 0 && items.length > 1) {
      const currentTrack = items[currentIndex]
      const currentKey = currentTrack ? `${currentTrack.source}:${currentTrack.sourceId}` : null
      let index = currentIndex
      let visited = 0
      const lookAheadSlots = Math.min(4, items.length - 1)
      while (wanted.size < 4 && visited < lookAheadSlots) {
        index += 1
        if (index >= items.length) {
          if (this.repeat !== 'all') break
          index = 0
        }
        if (index === currentIndex) break
        visited += 1
        const track = items[index]
        if (track.source !== 'soundcloud' && track.source !== 'youtube') continue
        const key = `${track.source}:${track.sourceId}`
        if (key === currentKey || wanted.has(key)) continue
        wanted.set(key, { key, source: track.source, track })
      }
    }

    // Downloads already in flight finish naturally; queued downloads that are
    // no longer ahead of the playhead are discarded before they start.
    const pendingKeys = new Set(this.prefetchPending.map(item => item.key))
    this.prefetchPending = [...wanted.values()].filter(
      item => item.key !== this.prefetchActiveKey && pendingKeys.has(item.key),
    )
    const queuedKeys = new Set(this.prefetchPending.map(item => item.key))

    for (const [key, item] of wanted) {
      if (key === this.prefetchActiveKey || queuedKeys.has(key)) continue
      queuedKeys.add(key)
      this.prefetchPending.push(item)
    }
    void this.drainPrefetchQueue()
  }

  private async drainPrefetchQueue(): Promise<void> {
    if (this.prefetchRunning) return
    this.prefetchRunning = true
    try {
      // Keep the queue sequential to bound network and yt-dlp load. Backend
      // path locks also cover concurrent playback/collection cache requests.
      while (this.prefetchPending.length > 0) {
        const item = this.prefetchPending.shift()
        if (!item || item.key === this.prefetchActiveKey) continue
        this.prefetchActiveKey = item.key
        try {
          if (item.source === 'soundcloud') {
            await api.scPrecache(item.track.sourceId)
          } else {
            await api.ytdlpCache(
              getSettings().ytdlp.path,
              item.track.externalUrl ?? `https://www.youtube.com/watch?v=${item.track.sourceId}`,
              item.track.sourceId,
            )
          }
        } catch {
          // A later queue or repeat change may ask for this ID again.
        } finally {
          if (this.prefetchActiveKey === item.key) this.prefetchActiveKey = null
        }
      }
    } finally {
      this.prefetchRunning = false
      if (this.prefetchPending.length > 0) void this.drainPrefetchQueue()
    }
  }

  private async handleSoundcloudCacheReady(sourceId: string): Promise<void> {
    // The download may finish while this ID is still later in the queue. Drop
    // its signed-stream answer now so playback resolves the local copy later.
    scPlaybackCache.delete(`${sourceId}|stream`)
    const current = this.queueCtl.current()
    if (
      !current ||
      current.source !== 'soundcloud' ||
      current.sourceId !== sourceId ||
      this.loadedSourceId !== sourceId ||
      this.engine.getActiveChannel() !== 'stream'
    ) return

    const playback = await fetchScPlayback(sourceId, false)
    if (!playback?.cached) return

    const stillCurrent = this.queueCtl.current()
    if (
      !stillCurrent ||
      stillCurrent.source !== 'soundcloud' ||
      stillCurrent.sourceId !== sourceId ||
      this.loadedSourceId !== sourceId ||
      this.engine.getActiveChannel() !== 'stream'
    ) return

    if (await this.engine.replaceStreamWithCachedFile(playback.url)) this.emit()
  }

  /**
   * Starts the next track early, so it overlaps the tail of the current one.
   *
   * Called from the position ticker once the remaining time drops below the
   * configured fade. The queue is advanced here rather than by `handleEnded`,
   * and the outgoing element's own `ended` event is ignored by the engine's
   * active-channel check, so the advance cannot happen twice.
   */
  private maybeCrossfade(): void {
    if (this.crossfading || !this.isPlaying) return
    const seconds = crossfadeSeconds()
    if (seconds <= 0) return
    const current = this.queueCtl.current()
    const incoming = this.queueCtl.peekNext(this.repeat)
    if (!current || !incoming) return
    const duration = this.duration > 0 ? this.duration : current.durationSec ?? 0
    const incomingDuration = incoming.durationSec ?? 0

    // Tiny clips are usually sound effects. Crossfading them can cut off most
    // of the sound or start resolving the next track before the clip plays.
    if (
      duration <= SHORT_CLIP_CROSSFADE_LIMIT_SEC ||
      incomingDuration <= SHORT_CLIP_CROSSFADE_LIMIT_SEC
    ) return

    const safeFade = Math.min(
      seconds,
      (duration * CROSSFADE_TRACK_FRACTION) / this.playbackRate,
      (incomingDuration * CROSSFADE_TRACK_FRACTION) / this.playbackRate,
    )
    if (safeFade < 0.2) return
    const remainingWallSeconds = (duration - this.position) / this.playbackRate
    if (!Number.isFinite(remainingWallSeconds) || remainingWallSeconds <= 0 || remainingWallSeconds > safeFade) return
    void this.beginCrossfade(safeFade)
  }

  private async beginCrossfade(seconds: number): Promise<void> {
    if (this.crossfading) return
    this.crossfading = true
    const startSeq = this.startSeq
    const transitionRepeat = this.repeat
    const outgoing = this.queueCtl.current()
    const incoming = this.repeat === 'one' ? outgoing : this.queueCtl.peekNext(this.repeat)
    let rampStarted = false
    try {
      if (!outgoing || !incoming) return
      const resolved = await this.resolveTrackUrl(incoming)
      if (!resolved) return

      // Resolution may take long enough for a manual action or a seek to make
      // this transition stale. Leave the queue and current source untouched.
      if (
        startSeq !== this.startSeq ||
        transitionRepeat !== this.repeat ||
        !this.isPlaying ||
        this.queueCtl.current()?.sourceId !== outgoing.sourceId
      ) return
      if (this.repeat !== 'one' && this.queueCtl.peekNext(this.repeat)?.sourceId !== incoming.sourceId) return

      const duration = this.duration > 0 ? this.duration : outgoing.durationSec ?? 0
      const incomingDuration = incoming.durationSec ?? 0
      if (
        duration <= SHORT_CLIP_CROSSFADE_LIMIT_SEC ||
        incomingDuration <= SHORT_CLIP_CROSSFADE_LIMIT_SEC
      ) return
      const safeFade = Math.min(
        seconds,
        (duration * CROSSFADE_TRACK_FRACTION) / this.playbackRate,
        (incomingDuration * CROSSFADE_TRACK_FRACTION) / this.playbackRate,
      )
      const remainingWallSeconds = (duration - this.engine.getCurrentTime()) / this.playbackRate
      if (safeFade < 0.2 || remainingWallSeconds > safeFade + 0.3 || !this.isPlaying) return

      if (outgoing.dbId !== null) {
        const listened = this.duration > 0 ? this.position : duration
        api.recordHistory(
          outgoing.dbId,
          Math.max(0, Math.round(listened)),
          duration > 0 && listened / duration >= 0.9,
          false,
        ).catch(() => {})
      }
      if (this.repeat !== 'one') {
        const advanced = this.queueCtl.next(this.repeat)
        if (!advanced || advanced.sourceId !== incoming.sourceId) return
      }
      this.beginTransition(incoming)
      this.startTrack(incoming, resolved, safeFade)
      rampStarted = true
    } finally {
      if (!rampStarted) this.crossfading = false
    }
  }

  private crossfading = false

  /**
   * Auto-extend: when the queue runs dry, continue with the rest of the same
   * album, then with tracks by the same artists. Returns null when nothing is
   * left and playback should stop.
   */
  private async autoPick(): Promise<UnifiedTrack | null> {
    if (this.autoPickBusy) return null
    this.autoPickBusy = true
    try {
      const cur = this.queueCtl.current()
      const inQueue = new Set(this.queueCtl.getItems().map((t) => t.sourceId))
      const skip = (t: UnifiedTrack) =>
        inQueue.has(t.sourceId) ||
        this.playedSourceIds.has(t.sourceId) ||
        (cur !== null && t.sourceId === cur.sourceId)
      if (cur?.album) {
        try {
          const albums = await api.listAlbums(cur.album)
          const exact = albums.find((a) => a.title.toLowerCase() === cur.album!.toLowerCase())
          if (exact) {
            const detail = await api.getAlbum(exact.id)
            const pick = detail.tracks.map(trackToUnified).find((t) => !skip(t))
            if (pick) return this.appendAuto(pick)
          }
        } catch {}
      }
      if (cur) {
        for (const artistName of cur.artists) {
          if (!artistName.trim()) continue
          try {
            const artists = await api.listArtists(artistName)
            const exact = artists.find((a) => a.name.toLowerCase() === artistName.toLowerCase())
            if (!exact) continue
            const rows = await api.getArtistTracks(exact.id)
            const pick = rows.map(trackToUnified).find((t) => !skip(t))
            if (pick) return this.appendAuto(pick)
          } catch {}
        }
      }
      return null
    } finally {
      this.autoPickBusy = false
    }
  }

  private appendAuto(t: UnifiedTrack): UnifiedTrack {
    const marked: UnifiedTrack = { ...t, auto: true }
    this.queueCtl.append(marked)
    // move playback to the newly appended track; otherwise current() still
    // points at the track that just ended and it would simply replay
    this.queueCtl.goToLast()
    this.preloadNext()
    this.emit()
    return marked
  }

  private async handleEnded(): Promise<void> {
    const cur = this.queueCtl.current()
    if (cur && cur.dbId !== null) {
      const dur = this.duration > 0 ? this.duration : cur.durationSec ?? 0
      api.recordHistory(cur.dbId, Math.round(dur), true, false).catch(() => {})
    }
    if (this.repeat === 'one' && cur) {
      this.engine.stop()
      const seq = ++this.startSeq
      const resolved = await this.resolveTrackUrl(cur)
      if (seq !== this.startSeq) return
      if (resolved) {
        this.startTrack(cur, resolved)
        return
      }
    }
    const advanced = this.queueCtl.next(this.repeat)
    if (!advanced) {
      const picked = await this.autoPick()
      if (!picked) {
        this.stop()
        return
      }
      await this.startPlayableFromCurrent()
      return
    }
    this.engine.stop()
    await this.startPlayableFromCurrent()
  }

  private recordSkip(): void {
    const cur = this.queueCtl.current()
    if (!cur || cur.dbId === null) return
    if (this.position >= 10) {
      api.recordHistory(cur.dbId, Math.round(this.position), false, true).catch(() => {})
    }
  }

  private stop(): void {
    this.startSeq += 1
    this.crossfading = false
    this.engine.stop()
    this.loadedSourceId = null
    this.isPlaying = false
    this.bufferPct = null
    this.preparing = false
    this.emit()
  }

  private emit(): void {
    const cur = this.queueCtl.current()
    this.snapshot = {
      currentTrack: cur,
      queue: this.queueCtl.getItems(),
      queueIndex: this.queueCtl.getIndex(),
      isPlaying: this.isPlaying,
      position: this.position,
      duration: this.duration,
      volume: this.volume,
      playbackRate: this.playbackRate,
      preservePitch: this.preservePitch,
      repeat: this.repeat,
      shuffle: this.shuffle,
      bufferPct: this.bufferPct,
      preparing: this.preparing,
      version: this.snapshot.version + 1,
    }
    this.updateMediaMetadata(cur)
    this.syncMediaSessionState()
    this.saveSnapshot()
    for (const listener of this.listeners) listener()
  }

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    try {
      ms.playbackState = 'paused'
    } catch {}
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => this.toggle()],
      ['pause', () => this.toggle()],
      ['previoustrack', () => this.previous()],
      ['nexttrack', () => this.next()],
      [
        'seekto',
        details => {
          if (typeof details.seekTime === 'number') this.seek(details.seekTime)
        },
      ],
      ['seekbackward', () => this.seek(this.position - 10)],
      ['seekforward', () => this.seek(this.position + 10)],
    ]
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler)
      } catch {}
    }
  }

  private updateMediaMetadata(track: UnifiedTrack | null): void {
    if (!('mediaSession' in navigator)) return
    const key = track ? track.sourceId : null
    if (key === this.metadataSourceId) return
    this.metadataSourceId = key
    try {
      navigator.mediaSession.metadata = track
        ? new MediaMetadata({
            title: track.title,
            artist: track.artists.join(', '),
            album: track.album ?? '',
            artwork: track.coverPath ? [{ src: artworkSrc(track.coverPath), sizes: '512x512' }] : [],
          })
        : null
    } catch {}
  }

  private syncMediaSessionState(): void {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused'
    } catch {}
  }
}

export const playerController = new PlayerController()

import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from '../api/client'
import type { RepeatMode, UnifiedTrack } from '../types/models'
import { trackToUnified } from '../utils/unified'
import { AudioEngine } from './engine'
import { QueueController } from './queue'

export interface PlayerSnapshot {
  currentTrack: UnifiedTrack | null
  queue: UnifiedTrack[]
  queueIndex: number
  isPlaying: boolean
  position: number
  duration: number
  volume: number
  repeat: RepeatMode
  shuffle: boolean
  bufferPct: number | null
  version: number
}

interface ResolvedTrack {
  url: string
  format: string | null
}

interface ScPlayback {
  url: string
  cached: boolean
  format: string | null
}

const VOLUME_KEY = 'tempo.volume'
const REPEAT_KEY = 'tempo.repeat'
const SHUFFLE_KEY = 'tempo.shuffle'
const QUEUE_SNAPSHOT_KEY = 'tempo.queue.snapshot.v1'

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

function clampUnit(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function artworkSrc(path: string): string {
  return /^https?:\/\//.test(path) ? path : convertFileSrc(path)
}

const scPlaybackCache = new Map<string, ScPlayback | null>()

function toScPlayback(res: { url: string | null; cachedPath: string | null; format: string | null }): ScPlayback | null {
  if (res.cachedPath) return { url: convertFileSrc(res.cachedPath), cached: true, format: res.format }
  if (res.url) return { url: res.url, cached: false, format: res.format }
  return null
}

async function fetchScPlayback(sourceId: string): Promise<ScPlayback | null> {
  const cached = scPlaybackCache.get(sourceId)
  if (cached !== undefined) return cached
  try {
    const playback = toScPlayback(await api.scGetPlayback(sourceId))
    scPlaybackCache.set(sourceId, playback)
    return playback
  } catch {
    scPlaybackCache.delete(sourceId)
  }
  try {
    const playback = toScPlayback(await api.scGetPlayback(sourceId))
    scPlaybackCache.set(sourceId, playback)
    return playback
  } catch {
    scPlaybackCache.delete(sourceId)
    return null
  }
}

function readStoredVolume(): number {
  const parsed = Number.parseFloat(readPref(VOLUME_KEY) ?? '')
  if (Number.isFinite(parsed)) return clampUnit(parsed)
  return 0.8
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
  private repeat: RepeatMode = readStoredRepeat()
  private shuffle = readPref(SHUFFLE_KEY) === '1'
  private loadedSourceId: string | null = null
  private metadataSourceId: string | null | undefined = undefined
  private bufferPct: number | null = null
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
    repeat: 'off',
    shuffle: false,
    bufferPct: null,
    version: 0,
  }

  constructor() {
    this.loadSnapshot()
    this.engine.onTime = t => {
      this.position = t
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
      this.engine.pause()
      this.isPlaying = false
      this.emit()
    }
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
    this.engine.stop()
    this.playedSourceIds.clear()
    this.queueCtl.setQueue(tracks, startIndex)
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
    this.engine.stop()
    this.recordSkip()
    const prev = this.queueCtl.previous(this.repeat)
    if (!prev) return
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

  setRepeat(m: RepeatMode): void {
    this.repeat = m
    writePref(REPEAT_KEY, m)
    this.emit()
  }

  toggleShuffle(): void {
    this.shuffle = !this.shuffle
    this.queueCtl.setShuffled(this.shuffle)
    writePref(SHUFFLE_KEY, this.shuffle ? '1' : '0')
    this.emit()
  }

  addToQueue(t: UnifiedTrack): void {
    this.queueCtl.append(t)
    this.emit()
  }

  removeFromQueue(index: number): void {
    this.queueCtl.removeAt(index)
    this.emit()
  }

  moveInQueue(from: number, to: number): void {
    this.queueCtl.move(from, to)
    this.emit()
  }

  clearQueue(): void {
    this.queueCtl.clear()
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

  private async resolveTrackUrl(t: UnifiedTrack): Promise<ResolvedTrack | null> {
    if (t.localPath) return { url: convertFileSrc(t.localPath), format: null }
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
      const playback = await fetchScPlayback(t.sourceId)
      if (!playback) return null
      return { url: playback.url, format: playback.format }
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
    this.engine.stop()
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
    }
    if (seq !== this.startSeq) return
    this.stop()
  }

  private startTrack(track: UnifiedTrack, resolved: ResolvedTrack): void {
    this.loadedSourceId = track.sourceId
    this.playedSourceIds.add(track.sourceId)
    this.position = 0
    this.duration = track.durationSec ?? 0
    this.bufferPct = null
    this.engine.setVolume(this.volume)
    void this.engine.loadWithFormat(resolved.url, resolved.format).catch(() => {})
    this.engine.play()
    this.isPlaying = true
    if (track.dbId !== null) {
      api.bumpPlayCount(track.dbId).catch(() => {})
    }
    this.emit()
  }

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
    this.engine.stop()
    this.isPlaying = false
    this.bufferPct = null
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
      repeat: this.repeat,
      shuffle: this.shuffle,
      bufferPct: this.bufferPct,
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

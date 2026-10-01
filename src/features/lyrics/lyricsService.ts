import { api } from '../../api/client'
import { parseLrc, shiftLyricsLines } from './lrc'
import { overridePlaybackResult } from './playbackDocument'
import { createPlaybackTiming } from './playbackTiming'
import { sha256Hex } from './sha256'
import { lyricTimingAt, resolveLyricTiming, type LyricTimingAnalysis, type ResolvedLyricsTiming } from './timingResolver'
import type { LyricsResult } from './types'

export interface CurrentLyrics {
  trackId: string
  result: LyricsResult | null
  sourceResult: LyricsResult | null
  lyricKey: string
  sourceLyricKey: string
  offsetMs: number
  durationSec: number | null
  generation: number
  timing: ResolvedLyricsTiming
}
export interface LyricsTrack {
  sourceId: string; source?: string; title: string; artists: string[]; dbId: number | null
  album?: string | null; durationSec?: number | null
}
interface Candidate { result: LyricsResult | null; provider: string; offsetMs: number }
export function lyricSourceKey(result: LyricsResult | null, provider: string): string {
  const canonical = JSON.stringify([provider, result])
  // Existing short keys continue to find saved matches; longer sources use a bounded full-content identity.
  return new TextEncoder().encode(canonical).length <= 512 ? canonical : `v2:sha256:${sha256Hex(canonical)}`
}

let current: CurrentLyrics | null = null
let currentKey = ''
let requestedId = ''
let generation = 0
let version = 0
let position = 0
let mediaDurationSec: number | null = null
let latestAnalysis: LyricTimingAnalysis | null = null
let resolved: ResolvedLyricsTiming = { lines: [], segments: [] }
let pass = createPlaybackTiming()
const listeners = new Set<() => void>()
function emit(): void { version++; listeners.forEach(listener => listener()) }
function activate(trackId: string, sourceResult: LyricsResult | null, durationSec: number | null,
  sourceLyricKey: string, offsetMs: number): void {
  durationSec = mediaDurationSec ?? durationSec
  const lyricKey = JSON.stringify([sourceLyricKey, offsetMs])
  if (current?.trackId === trackId && current.lyricKey === lyricKey && current.durationSec === durationSec) return
  generation++
  latestAnalysis = null
  const result: LyricsResult | null = sourceResult?.kind === 'synced'
    ? { kind: 'synced', lines: shiftLyricsLines(sourceResult.lines, offsetMs) } : sourceResult
  resolved = resolveLyricTiming(result?.kind === 'synced' ? result.lines : [], durationSec)
  pass = createPlaybackTiming()
  current = { trackId, result, sourceResult, sourceLyricKey, lyricKey, offsetMs, durationSec, generation,
    timing: pass.update(resolved, position, durationSec) }
  emit()
}

export const lyricsService = {
  subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  getVersion: (): number => version,
  getCurrent: (): CurrentLyrics | null => current,
  /** Actual loaded media wins over metadata and preserves candidate/pass identity. */
  setMediaDuration(trackId: string, durationSec: number): void {
    if (requestedId !== trackId || !Number.isFinite(durationSec) || durationSec <= 0) return
    mediaDurationSec = durationSec
    if (!current || current.durationSec === durationSec) return
    resolved = resolveLyricTiming(current.result?.kind === 'synced' ? current.result.lines : [], durationSec, latestAnalysis)
    current = { ...current, durationSec, timing: pass.update(resolved, position, durationSec) }
    emit()
  },
  /** Only the controller's actual media clock advances the shared playback pass. */
  setPosition(positionSec: number): void {
    position = Number.isFinite(positionSec) ? positionSec : 0
    if (!current) return
    const timing = pass.update(resolved, position, current.durationSec)
    if (timing !== current.timing) { current = { ...current, timing }; emit() }
  },
  setActiveCandidate(trackId: string, result: LyricsResult | null, durationSec: number | null,
    sourceLyricKey: string, offsetMs = 0): void {
    if (requestedId !== trackId) return
    activate(trackId, result, durationSec, sourceLyricKey, offsetMs)
  },
  publishAnalysis(trackId: string, lyricKey: string, expectedGeneration: number, analysis: LyricTimingAnalysis): boolean {
    if (!current || current.trackId !== trackId || current.lyricKey !== lyricKey || generation !== expectedGeneration) return false
    latestAnalysis = analysis
    resolved = resolveLyricTiming(current.result?.kind === 'synced' ? current.result.lines : [], current.durationSec, analysis)
    current = { ...current, timing: pass.update(resolved, position, current.durationSec) }
    emit()
    return true
  },
  ensure(track: LyricsTrack, cacheOnline: boolean): void {
    const key = JSON.stringify([track.source, track.sourceId, track.dbId, track.title, track.artists])
    if (currentKey === key) return
    const job = ++generation
    currentKey = key; requestedId = track.sourceId; current = null
    mediaDurationSec = null; latestAnalysis = null
    pass = createPlaybackTiming()
    emit()
    void fetchLyrics(track, cacheOnline).then(candidate => {
      if (job !== generation || key !== currentKey) return
      activate(track.sourceId, candidate.result, track.durationSec ?? null,
        lyricSourceKey(candidate.result, candidate.provider), candidate.offsetMs)
    }).catch(() => {})
  },
  invalidate(sourceId?: string): void {
    if (sourceId !== undefined && requestedId !== sourceId) return
    if (!currentKey && !current) return
    generation++; currentKey = ''; current = null; requestedId = ''
    mediaDurationSec = null; latestAnalysis = null
    emit()
  },
}

async function fetchLyrics(track: LyricsTrack, cacheOnline: boolean): Promise<Candidate> {
  if (track.dbId != null) {
    try {
      const pinned = await api.getLyricsOverride(track.dbId)
      if (pinned && pinned.isActive !== false && pinned.lrc.trim()) {
        return { result: overridePlaybackResult(pinned), provider: pinned.provider, offsetMs: pinned.offsetMs }
      }
    } catch { /* Continue to embedded or online lyrics. */ }
    try {
      const raw = await api.getTrackLyrics(track.dbId)
      if (raw?.trim()) {
        const lines = parseLrc(raw)
        return { result: lines?.length ? { kind: 'synced', lines } : { kind: 'plain', text: raw.trim() }, provider: 'embedded', offsetMs: 0 }
      }
    } catch { /* Continue to online lyrics. */ }
  }
  if (track.title.trim()) {
    try {
      const data = await api.fetchOnlineLyrics(track.artists[0] ?? '', track.title, track.album ?? null, track.durationSec ?? null)
      if (data) {
        const lines = data.syncedLrc ? parseLrc(data.syncedLrc) : null
        const result: LyricsResult | null = lines?.length ? { kind: 'synced', lines }
          : data.plain?.trim() ? { kind: 'plain', text: data.plain.trim() } : null
        const raw = data.syncedLrc ?? data.plain
        if (result && cacheOnline && track.dbId != null && raw?.trim()) void api.setTrackLyrics(track.dbId, raw).catch(() => {})
        return { result, provider: 'online', offsetMs: 0 }
      }
    } catch { /* Unavailable providers leave the cheap empty baseline. */ }
  }
  return { result: null, provider: '', offsetMs: 0 }
}

export interface LyricSlice { text: string | null; nextText: string | null; gapSec: number }
const NO_SLICE: LyricSlice = { text: null, nextText: null, gapSec: Infinity }

/** Overlay and Discord use the same resolved, pass-stabilized intervals. */
export function lyricSliceAt(result: LyricsResult | ResolvedLyricsTiming | null, positionSec: number): LyricSlice {
  if (!result || ('kind' in result && result.kind !== 'synced')) return NO_SLICE
  const timing = 'segments' in result ? result : resolveLyricTiming(result.lines, null)
  const { segmentIndex } = lyricTimingAt(timing, positionSec)
  const segment = timing.segments[segmentIndex]
  if (!segment || segment.kind !== 'line') return NO_SLICE
  const next = timing.segments[segmentIndex + 1]
  return { text: segment.text, nextText: next?.kind === 'line' ? next.text : null,
    gapSec: next?.kind === 'line' ? next.timeSec - segment.timeSec : Infinity }
}

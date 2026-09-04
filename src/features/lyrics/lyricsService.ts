import { api } from '../../api/client'
import { parseLrc } from './lrc'
import type { LyricsResult } from './types'

export interface CurrentLyrics {
  trackId: string
  result: LyricsResult | null
}

let current: CurrentLyrics | null = null
let currentKey = ''
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version += 1
  listeners.forEach((l) => l())
}

export const lyricsService = {
  subscribe: (l: () => void): (() => void) => {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  getVersion: (): number => version,
  getCurrent: (): CurrentLyrics | null => current,
  /** Fetches (embedded -> online) lyrics for the track once per track change. */
  ensure: (
    track: { sourceId: string; title: string; artists: string[]; dbId: number | null },
    cacheOnline: boolean,
  ): void => {
    if (currentKey === track.sourceId) return
    currentKey = track.sourceId
    current = null
    emit()
    const run = async () => {
      const res = await fetchLyrics(track, cacheOnline)
      current = { trackId: track.sourceId, result: res }
      emit()
    }
    void run().catch(() => {})
  },
  /**
   * Drops the per-track guard so the next `ensure` refetches. Called when the user
   * pins other lyrics or nudges the offset: without this the presence would keep
   * the old lines until the track changed.
   */
  invalidate: (sourceId?: string): void => {
    if (sourceId !== undefined && currentKey !== sourceId) return
    currentKey = ''
  },
}

async function fetchLyrics(
  track: { sourceId: string; title: string; artists: string[]; dbId: number | null },
  cacheOnline: boolean,
): Promise<LyricsResult | null> {
  // What the user pinned outranks everything, including embedded tags, so the
  // overlay and the Discord presence can never show different words.
  if (track.dbId != null) {
    try {
      const pinned = await api.getLyricsOverride(track.dbId)
      if (pinned && pinned.lrc.trim()) {
        const lines = parseLrc(pinned.lrc, pinned.offsetMs)
        if (lines && lines.length > 0) return { kind: 'synced', lines }
        return { kind: 'plain', text: pinned.lrc.trim() }
      }
    } catch {}
  }
  if (track.dbId != null) {
    try {
      const raw = await api.getTrackLyrics(track.dbId)
      if (raw && raw.trim()) {
        const lines = parseLrc(raw)
        if (lines && lines.length > 0) return { kind: 'synced', lines }
        return { kind: 'plain', text: raw.trim() }
      }
    } catch {}
  }
  if (!track.title.trim()) return null
  try {
    const data = await api.fetchOnlineLyrics(track.artists[0] ?? '', track.title)
    if (!data) return null
    let res: LyricsResult | null = null
    if (data.syncedLrc) {
      const lines = parseLrc(data.syncedLrc)
      if (lines && lines.length > 0) res = { kind: 'synced', lines }
    }
    if (!res && data.plain && data.plain.trim()) res = { kind: 'plain', text: data.plain.trim() }
    if (res && cacheOnline && track.dbId != null) {
      const rawToStore = data.syncedLrc ?? data.plain
      if (rawToStore && rawToStore.trim()) {
        void api.setTrackLyrics(track.dbId, rawToStore).catch(() => {})
      }
    }
    return res
  } catch {
    return null
  }
}

/** The active line plus the one after it, for the paired-lines presence. */
export interface LyricSlice {
  /** active line, or null on an instrumental marker / no synced lyrics */
  text: string | null
  /** the line after the active one, or null when there is none to show */
  nextText: string | null
  /** seconds between the two; Infinity when there is no next line */
  gapSec: number
}

const NO_SLICE: LyricSlice = { text: null, nextText: null, gapSec: Infinity }

/**
 * Active synced line and its successor at the given position.
 *
 * `gapSec` is what decides pairing: two lines a second apart cannot each get
 * their own Discord update, since Discord accepts about five per 20s, so the
 * caller sends them together as two rows of one activity. An instrumental marker
 * (a timecode with no text) yields null in either slot on purpose, so a caller
 * like the Discord presence falls back to the artist rather than leaving the last
 * sung line frozen on screen through the whole break.
 */
export function lyricSliceAt(result: LyricsResult | null, positionSec: number): LyricSlice {
  if (!result || result.kind !== 'synced') return NO_SLICE
  let i = -1
  for (let k = 0; k < result.lines.length; k += 1) {
    if (result.lines[k].timeSec <= positionSec + 0.3) i = k
    else break
  }
  if (i < 0) return NO_SLICE
  const cur = result.lines[i]
  const next = i + 1 < result.lines.length ? result.lines[i + 1] : null
  const text = cur.text.trim() ? cur.text : null
  return {
    text,
    // pairing only runs forward from a real line: with no current line there is
    // nothing for the second row to sit under
    nextText: text && next && next.text.trim() ? next.text : null,
    gapSec: next ? Math.max(0, next.timeSec - cur.timeSec) : Infinity,
  }
}

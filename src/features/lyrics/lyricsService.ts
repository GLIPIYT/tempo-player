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
}

async function fetchLyrics(
  track: { sourceId: string; title: string; artists: string[]; dbId: number | null },
  cacheOnline: boolean,
): Promise<LyricsResult | null> {
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

/** Active synced line at the given position, or null. */
export function lyricLineAt(result: LyricsResult | null, positionSec: number): string | null {
  if (!result || result.kind !== 'synced') return null
  let line: string | null = null
  for (const l of result.lines) {
    if (l.timeSec <= positionSec + 0.3) line = l.text
    else break
  }
  return line
}

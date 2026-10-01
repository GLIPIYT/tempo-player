import type { UnifiedTrack } from '../../types/models'

export const LYRICS_RATE_MIN = 0.5
export const LYRICS_RATE_MAX = 2
export const LYRICS_RATE_STEP = 0.02

export function normalizeLyricsRate(value: number): number {
  if (!Number.isFinite(value)) return 1
  const clamped = Math.min(LYRICS_RATE_MAX, Math.max(LYRICS_RATE_MIN, value))
  const stepIndex = Math.round((clamped - LYRICS_RATE_MIN) / LYRICS_RATE_STEP)
  return Number((LYRICS_RATE_MIN + stepIndex * LYRICS_RATE_STEP).toFixed(2))
}

export function lyricsRateStorageKey(
  track: Pick<UnifiedTrack, 'source' | 'sourceId'> | null,
  sourceLyricKey: string | undefined,
): string {
  if (!track || !sourceLyricKey) return ''
  return `tempo.lyrics-speed.v1:${JSON.stringify([track.source, track.sourceId, sourceLyricKey])}`
}

export function readLyricsRate(key: string): number {
  if (!key || typeof window === 'undefined') return 1
  try {
    const stored = window.localStorage.getItem(key)
    return stored === null ? 1 : normalizeLyricsRate(Number(stored))
  } catch {
    return 1
  }
}

export function writeLyricsRate(key: string, value: number): void {
  if (!key || typeof window === 'undefined') return
  try {
    const rate = normalizeLyricsRate(value)
    if (rate === 1) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, String(rate))
  } catch {
    // Keep the slider usable for this session when browser storage is unavailable.
  }
}

/** Map the media clock to lyric time while keeping the user offset in seconds. */
export function lyricTimeAtMediaPosition(positionSec: number, rate: number, offsetMs: number): number {
  const offsetSec = offsetMs / 1000
  return (positionSec - offsetSec) * normalizeLyricsRate(rate) + offsetSec
}

/** Map a lyric cue back to the media clock, the inverse of lyricTimeAtMediaPosition. */
export function mediaPositionAtLyricTime(timeSec: number, rate: number, offsetMs: number): number {
  const offsetSec = offsetMs / 1000
  return (timeSec - offsetSec) / normalizeLyricsRate(rate) + offsetSec
}

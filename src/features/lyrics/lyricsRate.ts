import type { UnifiedTrack } from '../../types/models'

export const LYRICS_RATE_MIN = 0.5
export const LYRICS_RATE_MAX = 2
export const LYRICS_RATE_STEP = 0.02
export const LYRICS_RATE_INPUT_STEP = 0.01

const LYRICS_RATE_MIN_CENTS = Math.round(LYRICS_RATE_MIN * 100)
const LYRICS_RATE_MAX_CENTS = Math.round(LYRICS_RATE_MAX * 100)
const LYRICS_RATE_STEP_CENTS = Math.round(LYRICS_RATE_STEP * 100)
const POPULAR_RATE_STEP_CENTS = 5

/**
 * Keep the original 0.02 increments and add the common 0.05 increments.
 * Integer hundredths avoid accumulating binary floating-point error.
 */
export const LYRICS_RATE_POINTS: readonly number[] = (() => {
  const points = new Set<number>()
  for (let cents = LYRICS_RATE_MIN_CENTS; cents <= LYRICS_RATE_MAX_CENTS; cents += LYRICS_RATE_STEP_CENTS) {
    points.add(cents)
  }
  for (let cents = LYRICS_RATE_MIN_CENTS; cents <= LYRICS_RATE_MAX_CENTS; cents += POPULAR_RATE_STEP_CENTS) {
    points.add(cents)
  }
  return [...points].sort((left, right) => left - right).map(cents => cents / 100)
})()

export function normalizeLyricsRate(value: number): number {
  if (!Number.isFinite(value)) return 1
  const clampedCents = Math.min(
    LYRICS_RATE_MAX_CENTS,
    Math.max(LYRICS_RATE_MIN_CENTS, Math.round(value * 100)),
  )
  let nearestCents = LYRICS_RATE_MIN_CENTS
  let nearestDistance = Number.POSITIVE_INFINITY

  for (const rate of LYRICS_RATE_POINTS) {
    const cents = Math.round(rate * 100)
    const distance = Math.abs(cents - clampedCents)
    if (distance < nearestDistance) {
      nearestCents = cents
      nearestDistance = distance
    }
  }

  return nearestCents / 100
}

/** Return the adjacent supported rate in the requested direction. */
export function stepLyricsRate(value: number, direction: -1 | 1): number {
  const current = normalizeLyricsRate(value)
  const currentIndex = LYRICS_RATE_POINTS.indexOf(current)
  const nextIndex = Math.min(LYRICS_RATE_POINTS.length - 1, Math.max(0, currentIndex + direction))
  return LYRICS_RATE_POINTS[nextIndex]
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

import type { LyricSegment } from './timingResolver'

/** Finish movement within the cue's wall-clock window, even in rapid passages. */
export function lyricTransitionDuration(
  segments: readonly LyricSegment[],
  index: number,
  positionSec: number,
  playbackRate = 1,
): number {
  const segment = segments[index]
  if (!segment) return 420
  const previous = segments[index - 1]
  const end = segment.displayEndTimeSec ?? segment.endTimeSec
  const previousSpan = previous ? (previous.displayEndTimeSec ?? previous.endTimeSec) - previous.timeSec : Infinity
  const windowSec = Math.min(
    end - segment.timeSec,
    end - positionSec,
    previousSpan > 0 ? previousSpan : Infinity,
  )
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1
  const duration = Number.isFinite(windowSec) ? windowSec / rate * 600 : 420
  return Math.round(Math.min(420, Math.max(70, duration)))
}

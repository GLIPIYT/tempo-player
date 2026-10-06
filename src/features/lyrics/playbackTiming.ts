import type { ResolvedLyricsTiming } from './timingResolver'

export function createPlaybackTiming() {
  let latest: ResolvedLyricsTiming | null = null
  let stable: ResolvedLyricsTiming | null = null
  let position = -1
  return {
    update(timing: ResolvedLyricsTiming, positionSec: number, durationSec?: number | null): ResolvedLyricsTiming {
      const backwards = positionSec < position
      if (!stable || backwards) stable = timing
      else if (timing !== latest) {
        // Freeze every segment already reached in this pass, including notes:
        // a longer recognized phrase must not pull an instrumental view back.
        const prefix = stable.segments.filter(segment => segment.timeSec <= position)
        const lastPrefix = prefix.at(-1)
        const boundary = lastPrefix?.displayEndTimeSec ?? lastPrefix?.endTimeSec ?? -Infinity
        const fixedLines = new Set(prefix.flatMap(segment => segment.lineIndices))
        const tail = timing.segments.filter(segment => segment.endTimeSec > boundary
          && !segment.lineIndices.some(index => fixedLines.has(index)))
          .map(segment => segment.timeSec < boundary ? { ...segment, timeSec: boundary } : segment)
        if (Number.isFinite(boundary) && tail[0]?.timeSec > boundary) {
          const gap = tail[0].timeSec - boundary
          const lastPrefixIndex = prefix.length - 1
          const lastPrefix = prefix[lastPrefixIndex]
          if (lastPrefix?.kind === 'line' && gap < 3.5) {
            prefix[lastPrefixIndex] = { ...lastPrefix,
              displayEndTimeSec: Math.max(lastPrefix.displayEndTimeSec ?? lastPrefix.endTimeSec, tail[0].timeSec) }
          } else if (tail[0].kind === 'notes') tail[0] = { ...tail[0], timeSec: boundary }
          else tail.unshift({ kind: 'notes', timeSec: boundary, endTimeSec: tail[0].timeSec,
            seekToSec: tail[0].seekToSec, text: '', lineIndices: [] })
        }
        stable = { segments: [...prefix, ...tail], lines: timing.lines.map(line =>
          fixedLines.has(line.lineIndex) ? stable!.lines.find(old => old.lineIndex === line.lineIndex) ?? line : line) }
      }
      // A newly known file boundary is authoritative even for a begun segment.
      // Shortening only advances fill; expansions still respect the pass latch.
      if (durationSec != null && Number.isFinite(durationSec) && durationSec > 0
        && (stable.segments.some(segment => segment.endTimeSec > durationSec)
          || stable.lines.some(line => line.endTimeSec > durationSec))) {
        stable = {
          segments: stable.segments.filter(segment => segment.timeSec < durationSec)
            .map(segment => ({ ...segment, endTimeSec: Math.min(segment.endTimeSec, durationSec),
              ...(segment.displayEndTimeSec == null ? {} : {
                displayEndTimeSec: Math.min(segment.displayEndTimeSec, durationSec),
              }) })),
          lines: stable.lines.filter(line => line.timeSec < durationSec)
            .map(line => ({ ...line, endTimeSec: Math.min(line.endTimeSec, durationSec) })),
        }
      }
      latest = timing
      position = positionSec
      return stable
    },
  }
}

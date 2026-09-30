import type { ResolvedLyricsTiming } from './timingResolver'

export function createPlaybackTiming() {
  let latest: ResolvedLyricsTiming | null = null
  let stable: ResolvedLyricsTiming | null = null
  let position = -1
  return {
    update(timing: ResolvedLyricsTiming, positionSec: number): ResolvedLyricsTiming {
      const backwards = positionSec < position
      if (!stable || backwards) stable = timing
      else if (timing !== latest) {
        // Freeze every segment already reached in this pass, including notes:
        // a longer recognized phrase must not pull an instrumental view back.
        const prefix = stable.segments.filter(segment => segment.timeSec <= position)
        const boundary = prefix.at(-1)?.endTimeSec ?? -Infinity
        const fixedLines = new Set(prefix.flatMap(segment => segment.lineIndices))
        const tail = timing.segments.filter(segment => segment.endTimeSec > boundary
          && !segment.lineIndices.some(index => fixedLines.has(index)))
          .map(segment => segment.timeSec < boundary ? { ...segment, timeSec: boundary } : segment)
        if (Number.isFinite(boundary) && tail[0]?.timeSec > boundary) {
          if (tail[0].kind === 'notes') tail[0] = { ...tail[0], timeSec: boundary }
          else tail.unshift({ kind: 'notes', timeSec: boundary, endTimeSec: tail[0].timeSec,
            seekToSec: tail[0].seekToSec, text: '', lineIndices: [] })
        }
        stable = { segments: [...prefix, ...tail], lines: timing.lines.map(line =>
          fixedLines.has(line.lineIndex) ? stable!.lines.find(old => old.lineIndex === line.lineIndex) ?? line : line) }
      }
      latest = timing
      position = positionSec
      return stable
    },
  }
}

import type { SyncedLyricsDocument, SyncedLyricsLine } from './editorDocument'

/**
 * Replace the text of a synced document with separately supplied plain lyrics.
 * Line starts are reused or estimated from the available timing windows. This
 * does not align the new words to the audio, so source word timings are always
 * discarded and callers should describe the result as an approximation.
 *
 * When there are more lyric rows than timing rows, timing windows are split in
 * proportion to the new rows' text lengths. When there are fewer rows, they are
 * placed monotonically across the existing timeline using those same weights.
 */
export function stitchLyrics(
  timed: SyncedLyricsDocument,
  plainText: string,
  durationMs?: number | null,
): SyncedLyricsDocument {
  if (!timed || timed.mode !== 'synced' || !Array.isArray(timed.lines)) {
    throw new TypeError('Stitching requires a synced lyrics document.')
  }
  if (typeof plainText !== 'string' || plainText.trim().length === 0) {
    throw new TypeError('Plain lyrics must contain at least one non-whitespace character.')
  }

  const duration = validateDuration(durationMs)
  validateTimedLines(timed.lines, duration)

  if (timed.lines.length === 0) {
    throw new RangeError('Cannot stitch lyrics because the synced document has no timing rows.')
  }

  const textLines = plainText.split(/\r\n|\n|\r/)
  const timingRows = timed.lines.map((line, sourceIndex) => ({ line, sourceIndex }))
  const pausesAreAlreadyMatched = textLines.length === timed.lines.length
    && timingRows.every(({ line }, index) => line.explicitPause !== true || textLines[index]!.trim().length === 0)
  if (pausesAreAlreadyMatched) {
    return {
      mode: 'synced',
      lines: textLines.map((text, index) => withTiming(timed.lines[index]!, text)),
    }
  }

  const activeRows = timingRows.filter(({ line }) => line.explicitPause !== true)
  if (activeRows.length === 0) {
    throw new RangeError('Cannot stitch lyrics because the synced document contains only explicit pauses.')
  }

  const sourceLines = activeRows.map(({ line }) => line)
  const sourceIndexes = activeRows.map(({ sourceIndex }) => sourceIndex)
  const nextTimingStarts = sourceIndexes.map((sourceIndex) => timed.lines[sourceIndex + 1]?.startMs)
  const mappedRows = textLines.length === sourceLines.length
    ? textLines.map((text, index) => ({ line: withTiming(sourceLines[index]!, text), sourceIndex: sourceIndexes[index]!, order: index }))
    : textLines.length > sourceLines.length
      ? splitTimingRows(sourceLines, sourceIndexes, nextTimingStarts, textLines, duration)
      : mapTextRows(sourceLines, sourceIndexes, textLines)

  const pauses = timingRows
    .filter(({ line }) => line.explicitPause === true)
    .map(({ line, sourceIndex }) => ({ line: withTiming(line, ''), sourceIndex, order: 0 }))
  const lines = [...mappedRows, ...pauses]
    .sort((left, right) => left.sourceIndex - right.sourceIndex || left.order - right.order)
    .map(({ line }) => line)

  return { mode: 'synced', lines }
}

interface MappedTextRow {
  line: SyncedLyricsLine
  sourceIndex: number
  order: number
}

function validateDuration(durationMs?: number | null): number | null {
  if (durationMs === undefined || durationMs === null) return null
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new RangeError('Track duration must be a nonnegative safe integer in milliseconds.')
  }
  return durationMs
}

function validateTimedLines(lines: readonly SyncedLyricsLine[], duration: number | null): void {
  let previousStart = -1
  lines.forEach((line, index) => {
    if (!line || typeof line.text !== 'string') {
      throw new TypeError(`Synced timing row ${index + 1} has no text value.`)
    }
    if (!Number.isSafeInteger(line.startMs) || line.startMs < 0) {
      throw new RangeError(`Synced timing row ${index + 1} has an invalid start time.`)
    }
    if (line.startMs < previousStart) {
      throw new RangeError('Synced timing rows must be ordered by start time.')
    }
    previousStart = line.startMs
    if (line.endMs !== null && (!Number.isSafeInteger(line.endMs) || line.endMs <= line.startMs)) {
      throw new RangeError(`Synced timing row ${index + 1} has an invalid end time.`)
    }
    if (duration !== null && line.startMs > duration) {
      throw new RangeError(`Synced timing row ${index + 1} starts after the track duration.`)
    }
    if (duration !== null && line.endMs !== null && line.endMs > duration) {
      throw new RangeError(`Synced timing row ${index + 1} ends after the track duration.`)
    }
  })
}

function withTiming(source: SyncedLyricsLine, text: string, startMs = source.startMs): SyncedLyricsLine {
  return {
    text,
    startMs,
    endMs: source.endMs,
    ...(text.trim().length === 0 ? { explicitPause: true } : {}),
    ...(source.endOrigin === undefined ? {} : { endOrigin: source.endOrigin }),
  }
}

function splitTimingRows(
  sourceLines: readonly SyncedLyricsLine[],
  sourceIndexes: readonly number[],
  nextTimingStarts: readonly (number | undefined)[],
  textLines: readonly string[],
  duration: number | null,
): MappedTextRow[] {
  const groupSizes = allocateRows(sourceLines, textLines.length, duration, nextTimingStarts)
  const result: MappedTextRow[] = []
  let textIndex = 0

  sourceLines.forEach((source, sourceIndex) => {
    const count = groupSizes[sourceIndex]!
    const group = textLines.slice(textIndex, textIndex + count)
    textIndex += count
    const nextStart = nextTimingStarts[sourceIndex]
    const splitEnd = timingWindowEnd(source, nextStart, duration)
    const weights = group.map(textWeight)
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    let elapsedWeight = 0

    group.forEach((text, index) => {
      const startMs = index === 0 || splitEnd <= source.startMs
        ? source.startMs
        : Math.min(splitEnd, source.startMs + Math.round((elapsedWeight / totalWeight) * (splitEnd - source.startMs)))
      elapsedWeight += weights[index]!

      if (index === group.length - 1) {
        result.push({ line: withTiming(source, text, startMs), sourceIndex: sourceIndexes[sourceIndex]!, order: textIndex - count + index })
      } else {
        result.push({
          line: {
            text,
            startMs,
            endMs: null,
            ...(text.trim().length === 0 ? { explicitPause: true } : {}),
          },
          sourceIndex: sourceIndexes[sourceIndex]!,
          order: textIndex - count + index,
        })
      }
    })
  })

  return result
}

function allocateRows(
  sourceLines: readonly SyncedLyricsLine[],
  targetCount: number,
  duration: number | null,
  nextTimingStarts: readonly (number | undefined)[],
): number[] {
  const allocations = sourceLines.map(() => 1)
  const extras = targetCount - sourceLines.length
  if (extras <= 0) return allocations

  const weights = sourceLines.map((line, index) => {
    const end = timingWindowEnd(line, nextTimingStarts[index], duration)
    return Math.max(0, end - line.startMs)
  })
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const safeWeights = totalWeight > 0 ? weights : weights.map(() => 1)
  const safeTotal = safeWeights.reduce((sum, weight) => sum + weight, 0)
  const remainders = safeWeights.map((weight, index) => {
    const exact = (extras * weight) / safeTotal
    const whole = Math.floor(exact)
    allocations[index]! += whole
    return { index, fractional: exact - whole }
  })
  let remaining = targetCount - allocations.reduce((sum, allocation) => sum + allocation, 0)
  remainders.sort((left, right) => right.fractional - left.fractional || left.index - right.index)
  for (let index = 0; remaining > 0; index += 1, remaining -= 1) {
    allocations[remainders[index % remainders.length]!.index]! += 1
  }
  return allocations
}

function timingWindowEnd(line: SyncedLyricsLine, nextStart: number | undefined, duration: number | null): number {
  const usableEnd = line.endMs !== null && line.endOrigin !== 'auto' ? line.endMs : null
  if (usableEnd !== null) {
    // Keep an overlap on the source endpoint, but never use it to place a new
    // line after the next source row.
    return nextStart === undefined ? usableEnd : Math.min(usableEnd, nextStart)
  }
  if (nextStart !== undefined) return nextStart
  if (duration !== null) return Math.max(line.startMs, duration)
  return line.startMs
}

function mapTextRows(
  sourceLines: readonly SyncedLyricsLine[],
  sourceIndexes: readonly number[],
  textLines: readonly string[],
): MappedTextRow[] {
  const sourceStart = sourceLines[0]!.startMs
  const knownEnd = sourceLines.reduce((max, line) => {
    const end = line.endMs !== null && line.endOrigin !== 'auto' ? line.endMs : line.startMs
    return Math.max(max, end)
  }, sourceLines[sourceLines.length - 1]!.startMs)
  // Duration is a validation ceiling, not a lyric timing anchor. A long
  // instrumental intro/outro must not pull replacement lines away from the
  // source's actual lyric window.
  const timelineEnd = knownEnd
  const timelineLength = Math.max(0, timelineEnd - sourceStart)
  const weights = textLines.map(textWeight)
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const result: MappedTextRow[] = []
  let elapsedWeight = 0
  let previousSourceIndex = 0

  textLines.forEach((text, textIndex) => {
    let sourceIndex = previousSourceIndex
    if (textIndex === textLines.length - 1 && textLines.length > 1) {
      sourceIndex = sourceLines.length - 1
    } else if (textIndex > 0) {
      const desiredTime = sourceStart + (elapsedWeight / totalWeight) * timelineLength
      let nearestDistance = Number.POSITIVE_INFINITY
      for (let index = previousSourceIndex; index < sourceLines.length; index += 1) {
        const distance = Math.abs(sourceLines[index]!.startMs - desiredTime)
        if (distance < nearestDistance) {
          sourceIndex = index
          nearestDistance = distance
        }
      }
    }

    previousSourceIndex = sourceIndex
    result.push({ line: withTiming(sourceLines[sourceIndex]!, text), sourceIndex: sourceIndexes[sourceIndex]!, order: textIndex })
    elapsedWeight += weights[textIndex]!
  })
  return result
}

function textWeight(text: string): number {
  // Count Unicode code points so emoji and other surrogate pairs weigh as one.
  return Math.max(1, Array.from(text.trim()).length)
}

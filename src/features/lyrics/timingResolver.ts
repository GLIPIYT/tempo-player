import type { LyricsLine, LyricsWord } from './types'
import { mapLyricWordTimings, type LyricWordTiming } from './wordTiming'

export interface LyricTimingAnalysis {
  bpm: { value: number; confidence: number } | null
  matchedEnds: readonly { lineIndex: number; endTimeSec: number; confidence: number }[]
  matchedWords?: readonly { lineIndex: number; words: readonly LyricsWord[]; confidence: number }[]
}

export interface ResolvedLyricsLine extends Omit<LyricsLine, 'endSource' | 'endTimeSec'> {
  lineIndex: number
  endTimeSec: number
  endSource: 'manual' | 'source' | 'recognized' | 'text'
  confidence: number
  wordTimings?: readonly (LyricWordTiming | null)[]
}

export interface LyricSegment {
  kind: 'line' | 'notes'
  timeSec: number
  endTimeSec: number
  /** Display may continue through a short gap while phrase timing stays exact. */
  displayEndTimeSec?: number
  text: string
  seekToSec: number
  lineIndices: number[]
  /** Aligned with non-whitespace tokens in text, including simultaneous lines. */
  wordTimings?: readonly (LyricWordTiming | null)[]
  /** Keep author-marked blank rows at their full visual height. */
  explicitPause?: boolean
  skipPool?: boolean
}

export interface ResolvedLyricsTiming {
  lines: ResolvedLyricsLine[]
  segments: LyricSegment[]
}

export interface LyricTimingPosition {
  segmentIndex: number
  lineIndices: number[]
  progress: number
  underlineProgress: number
}

/** Compact pauses retain the preceding line's scroll anchor. */
export function lyricAnchorIndex(segments: readonly LyricSegment[], index: number): number {
  const segment = segments[index]
  return segment?.kind === 'notes' && segment.skipPool && segments[index - 1]?.kind === 'line'
    ? index - 1 : index
}

interface PhraseWork {
  units: number
  pause: number
  confidence: number
}

interface LineGroup {
  timeSec: number
  entries: { line: LyricsLine; lineIndex: number; work: PhraseWork }[]
}

const CONFIDENT = 0.8
const MIN_PRECISE_INTERLINE_PAUSE_SEC = 0.5
const NO_POSITION: LyricTimingPosition = { segmentIndex: -1, lineIndices: [], progress: 0, underlineProgress: 0 }

function phraseWork(text: string): PhraseWork {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? []
  let syllables = 0
  let supported = 0
  for (const word of words) {
    if (/^[а-яё]+$/iu.test(word)) {
      syllables += Math.max(1, (word.match(/[аеёиоуыэюя]/giu) ?? []).length)
      supported += 1
    } else if (/^[a-zà-ž]+$/iu.test(word)) {
      syllables += Math.max(1, (word.match(/[aeiouyà-æè-ïò-öù-ü]+/giu) ?? []).length)
      supported += 1
    } else {
      syllables += Math.max(1, Array.from(word).length / 2)
    }
  }
  const pauses = (text.match(/[,;:!?…]|\.{2,}|[—–]/gu) ?? []).length
  const stretch = /(?:\p{L}\s*[-~]\s*){2,}\p{L}|(\p{L})\1{2,}/iu.test(text) ? 0.45 : 0
  return {
    units: Math.max(1, words.length * 0.45 + syllables * 0.55),
    pause: Math.min(1.2, pauses * 0.16 + stretch),
    confidence: words.length > 0 && supported / words.length > 0.7 ? 0.55 : 0.3,
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const trim = Math.floor(sorted.length * 0.2)
  const trimmed = sorted.slice(trim, sorted.length - trim)
  const mid = Math.floor(trimmed.length / 2)
  return trimmed.length % 2 ? trimmed[mid] : (trimmed[mid - 1] + trimmed[mid]) / 2
}

function secondsPerUnit(groups: LineGroup[], groupIndex: number, work: PhraseWork): number | null {
  const samples: number[] = []
  for (let i = Math.max(0, groupIndex - 6); i < Math.min(groups.length - 1, groupIndex + 7); i += 1) {
    const group = groups[i]
    const next = groups[i + 1]
    if (i === groupIndex || group.entries.length !== 1 || next.entries.length !== 1) continue
    const entry = group.entries[0]
    if (!entry.line.text.trim() || !next.entries[0].line.text.trim()) continue
    const gap = next.timeSec - group.timeSec
    const ratio = entry.work.units / work.units
    // Large breaks and intervals with wildly different text volumes cannot
    // establish a local singing rate. Duplicate and blank groups are excluded.
    if (gap <= 0 || gap > 8 || ratio < 0.5 || ratio > 2) continue
    const value = gap / entry.work.units
    if (value >= 0.16 && value <= 1.5) samples.push(value)
  }
  return samples.length >= 3 ? median(samples) : null
}

function validEnd(end: number | null | undefined, start: number): end is number {
  return end != null && Number.isFinite(end) && end > start
}

/** All input endpoints already include the same current lyric offset. */
export function resolveLyricTiming(
  lines: readonly LyricsLine[],
  durationSec: number | null,
  analysis?: LyricTimingAnalysis | null,
): ResolvedLyricsTiming {
  const duration = durationSec != null && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null
  const wordMatches = new Map<number, NonNullable<LyricTimingAnalysis['matchedWords']>[number][]>()
  for (const match of analysis?.matchedWords ?? []) {
    if (!Number.isFinite(match.confidence) || match.confidence < CONFIDENT) continue
    const candidates = wordMatches.get(match.lineIndex) ?? []
    candidates.push(match)
    wordMatches.set(match.lineIndex, candidates)
  }
  for (const candidates of wordMatches.values()) candidates.sort((a, b) => b.confidence - a.confidence)
  const sorted = lines.map((line, lineIndex) => ({ line, lineIndex, work: phraseWork(typeof line.text === 'string' ? line.text : '') }))
    .filter(({ line }) => Number.isFinite(line.timeSec) && line.timeSec >= 0 && typeof line.text === 'string'
      && (line.text.trim().length > 0 || line.explicitPause === true)
      && (duration === null || line.timeSec < duration))
    .sort((a, b) => a.line.timeSec - b.line.timeSec || a.lineIndex - b.lineIndex)
  const groups: LineGroup[] = []
  for (const entry of sorted) {
    const last = groups.at(-1)
    if (last && last.timeSec === entry.line.timeSec) last.entries.push(entry)
    else groups.push({ timeSec: entry.line.timeSec, entries: [entry] })
  }

  const resolved: ResolvedLyricsLine[] = []
  const segments: LyricSegment[] = []
  const addSegment = (segment: LyricSegment): void => {
    if (segment.endTimeSec <= segment.timeSec) return
    const previous = segments.at(-1)
    if (segment.kind === 'notes' && previous?.kind === 'notes' && previous.endTimeSec >= segment.timeSec) {
      previous.endTimeSec = segment.endTimeSec
      previous.seekToSec = segment.seekToSec
      previous.explicitPause = previous.explicitPause === true || segment.explicitPause === true
    } else segments.push(segment)
  }
  if (groups.length > 0 && groups[0].timeSec > 0) {
    addSegment({ kind: 'notes', timeSec: 0, endTimeSec: groups[0].timeSec, text: '', seekToSec: groups[0].timeSec, lineIndices: [] })
  }
  for (let gi = 0; gi < groups.length; gi += 1) {
    const group = groups[gi]
    const nextStart = groups[gi + 1]?.timeSec
    const limit = Math.min(nextStart ?? Infinity, duration ?? Infinity)
    const groupLines: ResolvedLyricsLine[] = group.entries.map(({ line, lineIndex, work }) => {
      let endTimeSec: number
      let endSource: ResolvedLyricsLine['endSource']
      let confidence: number
      const lastWord = line.words?.at(-1)
      // A known word start is not an exact phrase end, but an automatic estimate
      // cannot finish before that word has begun. Leave a small inferred tail.
      const sourceWordStart = line.words?.reduce((floor, word) => {
        const usable = Number.isFinite(word.timeSec) && word.timeSec >= line.timeSec && word.timeSec < limit
          && word.text.trim() && (word.endTimeSec == null || validEnd(word.endTimeSec, word.timeSec))
        return usable ? Math.max(floor, word.timeSec) : floor
      }, line.timeSec) ?? line.timeSec
      const hasExplicitEnd = validEnd(line.endTimeSec, line.timeSec)
      const explicit = hasExplicitEnd ? line.endTimeSec : lastWord?.endTimeSec
      const recognizedWords = wordMatches.get(lineIndex)
        ?.find(match => mapLyricWordTimings(line.text, match.words, line.timeSec,
          Number.isFinite(limit) ? limit : Math.max(line.timeSec + 1, ...match.words.map(word => word.endTimeSec ?? word.timeSec)), 'analysis'))
      const recognizedEnd = analysis?.matchedEnds.filter((e) => e.lineIndex === lineIndex && Number.isFinite(e.confidence)
        && e.confidence >= CONFIDENT && validEnd(e.endTimeSec, sourceWordStart))
        .sort((a, b) => b.confidence - a.confidence)[0]
      const recognizedWordEnd = recognizedWords?.words.at(-1)?.endTimeSec
      // A previously cached endpoint cannot cut off a newly matched complete word.
      const recognized = recognizedWords && validEnd(recognizedWordEnd, sourceWordStart)
        ? { endTimeSec: Math.max(recognizedWordEnd, recognizedEnd?.endTimeSec ?? 0), confidence: recognizedWords.confidence }
        : recognizedEnd
      if (validEnd(explicit, line.timeSec)) {
        endSource = hasExplicitEnd ? line.endSource ?? 'source' : 'source'
        endTimeSec = endSource === 'manual' ? Math.min(explicit, duration ?? Infinity) : Math.min(explicit, limit)
        confidence = 1
      } else if (recognized) {
        endTimeSec = Math.min(recognized.endTimeSec, limit)
        endSource = 'recognized'
        confidence = recognized.confidence
      } else {
        const calibration = secondsPerUnit(groups, gi, work)
        let rate = calibration ?? 1 / 2.6
        const bpm = analysis?.bpm
        if (calibration === null && bpm && Number.isFinite(bpm.value) && bpm.value >= 40 && bpm.value <= 240
          && Number.isFinite(bpm.confidence) && bpm.confidence >= CONFIDENT) {
          // A weak prior only: BPM does not imply a fixed syllable count per beat.
          rate *= 1 + Math.max(-0.15, Math.min(0.15, (120 - bpm.value) / 120)) * 0.1
        }
        const estimated = Math.max(1.2, Math.min(30, work.units * rate + 0.45 + work.pause))
        endTimeSec = Math.min(Math.max(line.timeSec + estimated, sourceWordStart + 0.2), limit)
        endSource = 'text'
        confidence = calibration === null ? work.confidence : Math.min(0.7, work.confidence + 0.1)
        const gap = limit - endTimeSec
        if (Number.isFinite(limit) && (gap < 0.75 || gap < (limit - line.timeSec) * 0.2)) endTimeSec = limit
      }
      return { ...line, lineIndex, endTimeSec, endSource, confidence }
    })
    const singing = groupLines.filter((line) => line.text.trim())
    if (singing.length > 1) {
      // Automatically inferred simultaneous phrases share a positive interval;
      // an author's explicit per-line end remains attached to its own line.
      const commonEnd = Math.max(...singing.map((line) => line.endTimeSec))
      for (const line of singing) if (line.endSource === 'text') line.endTimeSec = Math.min(commonEnd, limit)
    }
    for (const line of singing) {
      const wordLimit = Math.min(line.endTimeSec, limit)
      const sourceWords = mapLyricWordTimings(line.text, line.words, line.timeSec, wordLimit, 'source')
      const recognizedWords = sourceWords ? undefined : wordMatches.get(line.lineIndex)
        ?.map(match => mapLyricWordTimings(line.text, match.words, line.timeSec, wordLimit, 'analysis')).find(Boolean)
      if (sourceWords || recognizedWords) line.wordTimings = sourceWords ?? recognizedWords
    }
    resolved.push(...groupLines)
    if (singing.length === 0) {
      addSegment({ kind: 'notes', timeSec: group.timeSec, endTimeSec: limit, text: '',
        seekToSec: nextStart ?? group.timeSec, lineIndices: [], explicitPause: true })
      continue
    }
    const phraseEnd = Math.min(Math.max(...singing.map((line) => line.endTimeSec)), limit)
    const remainingGap = limit - phraseEnd
    const nextGroup = groups[gi + 1]
    const nextIsExplicitPause = nextGroup !== undefined && nextGroup.entries.every(({ line }) => !line.text.trim())
    const shortInterLineGap = nextStart !== undefined && !nextIsExplicitPause
      && remainingGap < 3.5
    const hasPreciseEnd = singing.some((line) => line.endSource === 'manual' || line.endSource === 'source' || line.endSource === 'recognized')
    const showShortPause = shortInterLineGap && (hasPreciseEnd
      ? remainingGap >= MIN_PRECISE_INTERLINE_PAUSE_SEC
      : remainingGap >= 0.75)
    const pauseBeforeExplicit = nextIsExplicitPause && remainingGap > 0
    const longInterLineBreak = nextStart !== undefined && !nextIsExplicitPause
      && remainingGap >= 3.5 && remainingGap >= (limit - group.timeSec) * 0.2
    // Inferred ends need a larger gap than precise endpoints to show a breath.
    const displayEnd = shortInterLineGap && !showShortPause ? limit : phraseEnd
    addSegment({ kind: 'line', timeSec: group.timeSec, endTimeSec: phraseEnd,
      ...(displayEnd > phraseEnd ? { displayEndTimeSec: displayEnd } : {}),
      text: singing.map((line) => line.text).join('\n'), seekToSec: group.timeSec,
      lineIndices: singing.map((line) => line.lineIndex),
      ...(singing.some(line => line.wordTimings) ? {
        wordTimings: singing.flatMap(line => line.wordTimings ?? (line.text.match(/\S+/gu) ?? []).map(() => null)),
      } : {}) })
    const outroBreak = nextStart === undefined && remainingGap >= 0.75
      && (!Number.isFinite(limit) || remainingGap >= (limit - group.timeSec) * 0.2)
    if (showShortPause || pauseBeforeExplicit || longInterLineBreak || outroBreak) {
      addSegment({ kind: 'notes', timeSec: phraseEnd, endTimeSec: limit, text: '',
        seekToSec: nextStart ?? group.timeSec, lineIndices: [],
        ...(showShortPause ? { skipPool: true } : {}),
        ...(nextIsExplicitPause ? { explicitPause: true } : {}) })
    }
  }
  // Only pauses surrounded by sung lines establish the local short-gap pool.
  // Intro, outro, and pauses adjacent to another notes segment retain their
  // full height regardless of their duration.
  const internalNotes = segments.filter((segment, index) =>
    segment.kind === 'notes' && segments[index - 1]?.kind === 'line' && segments[index + 1]?.kind === 'line'
      && Number.isFinite(segment.endTimeSec - segment.timeSec) && segment.endTimeSec > segment.timeSec)
  if (internalNotes.length >= 4) {
    const durations = internalNotes.map(segment => segment.endTimeSec - segment.timeSec).sort((a, b) => a - b)
    const quartileIndex = (durations.length - 1) * 0.25
    const lower = Math.floor(quartileIndex)
    const q1 = durations[lower] + (durations[Math.ceil(quartileIndex)] - durations[lower]) * (quartileIndex - lower)
    const cutoff = Math.min(3.5, q1 * 1.1)
    for (const segment of internalNotes) {
      if (!segment.explicitPause && segment.endTimeSec - segment.timeSec <= cutoff) segment.skipPool = true
    }
  }
  return { lines: resolved, segments }
}

export function lyricTimingAt(timing: ResolvedLyricsTiming, positionSec: number): LyricTimingPosition {
  if (!Number.isFinite(positionSec)) return NO_POSITION
  let lo = 0
  let hi = timing.segments.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (timing.segments[mid].timeSec <= positionSec) { found = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  if (found < 0) return NO_POSITION
  const segment = timing.segments[found]
  if (positionSec >= (segment.displayEndTimeSec ?? segment.endTimeSec)) return NO_POSITION
  const span = segment.endTimeSec - segment.timeSec
  const progress = segment.kind === 'line' && Number.isFinite(span) && span > 0
    ? Math.max(0, Math.min(1, (positionSec - segment.timeSec) / span)) : 0
  return { segmentIndex: found, lineIndices: segment.lineIndices,
    progress,
    // A displayed line can remain on screen after its phrase ends. Keep its
    // text filled, but clear the progress underline at the actual phrase end.
    underlineProgress: segment.kind === 'line' && positionSec < segment.endTimeSec ? progress : 0 }
}

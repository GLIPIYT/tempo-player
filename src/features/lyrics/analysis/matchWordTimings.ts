import type { LyricsLine, LyricsWord } from '../types'
import type { AnalysisWord, CompletedFragment } from './contract'
import { mapLyricWordTimings } from '../wordTiming'
import { lyricLanguage } from './matchWords'

export interface MatchedLyricWords {
  lineIndex: number
  words: LyricsWord[]
  confidence: number
}

interface ExpectedToken { text: string; normalized: string }
interface TimedToken { normalized: string; word: AnalysisWord }
interface FragmentMatch extends MatchedLyricWords { startSec: number; endSec: number; edgeMarginSec: number }
interface PreparedLine { lineIndex: number; line: LyricsLine; expected: ExpectedToken[]; previous?: number; next?: number;
  duplicate: boolean; supported: boolean; reliableSourceWords: boolean }

const EDGE_MARGIN_SEC = 0.18
const MATCH_START_AFTER_SEC = 4
const MAX_LINE_SPAN_SEC = 10
const DEDUPE_TOLERANCE_SEC = 0.25

function normalize(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е')
}

function lyricTokens(text: string): ExpectedToken[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map(([token]) => ({ text: token, normalized: normalize(token) }))
}

export function canMatchLyricWordTimings(text: string): boolean {
  return lyricLanguage(text) !== null && lyricTokens(text).length >= 2
}

/** A word list is authoritative only when every lyric token has one valid source timestamp. */
export function hasReliableSourceWordTimings(line: LyricsLine, durationSec?: number, nextLineStartSec?: number): boolean {
  if (!line.words?.length || !Number.isFinite(line.timeSec) || line.timeSec < 0) return false
  const durationLimit = durationSec != null && Number.isFinite(durationSec) && durationSec > line.timeSec ? durationSec : Infinity
  const nextStart = Number.isFinite(nextLineStartSec) && nextLineStartSec! > line.timeSec ? nextLineStartSec! : Infinity
  const authoredEnd = Number.isFinite(line.endTimeSec) && line.endTimeSec! > line.timeSec ? line.endTimeSec! : Infinity
  const lastWordEnd = line.words.at(-1)?.endTimeSec
  const finiteLimit = Math.min(durationLimit, nextStart, authoredEnd,
    Number.isFinite(lastWordEnd) && lastWordEnd! > line.timeSec ? lastWordEnd! : Infinity)
  const limit = Number.isFinite(finiteLimit) ? finiteLimit : line.timeSec + 120
  if (limit <= line.timeSec) return false
  return Boolean(mapLyricWordTimings(line.text, line.words, line.timeSec, limit, 'source')?.some(Boolean))
}

function validateFragment(fragment: CompletedFragment, durationSec: number): TimedToken[] | null {
  if (fragment.status !== 'completed' || !Number.isFinite(fragment.startSec) || !Number.isFinite(fragment.endSec)
    || fragment.startSec < 0 || fragment.endSec <= fragment.startSec || fragment.endSec > durationSec
    || !Array.isArray(fragment.words) || fragment.words.length === 0) return null
  let previousEnd = fragment.startSec
  const result: TimedToken[] = []
  for (const word of fragment.words) {
    if (typeof word.text !== 'string' || !Number.isFinite(word.startSec) || !Number.isFinite(word.endSec)
      || word.startSec < fragment.startSec || word.endSec > fragment.endSec || word.endSec > durationSec
      || word.startSec < previousEnd || word.endSec <= word.startSec) return null
    const normalized = lyricTokens(word.text)
    // One ASR chunk must represent one complete lyric token. Splitting or merging
    // chunks would give multiple lyric words the same timestamp and is not reliable.
    if (normalized.length !== 1) return null
    result.push({ normalized: normalized[0].normalized, word })
    previousEnd = word.endSec
  }
  return result
}

function prepareLines(lines: readonly LyricsLine[], durationSec: number): PreparedLine[] {
  const ordered = lines.map((line, lineIndex) => ({ line, lineIndex }))
    .filter(item => typeof item.line.text === 'string' && item.line.text.trim() && Number.isFinite(item.line.timeSec))
    .sort((left, right) => left.line.timeSec - right.line.timeSec || left.lineIndex - right.lineIndex)
  const prepared: PreparedLine[] = []
  for (let start = 0; start < ordered.length;) {
    let end = start + 1
    while (end < ordered.length && ordered[end].line.timeSec === ordered[start].line.timeSec) end += 1
    const previous = start > 0 ? ordered[start - 1].line.timeSec : undefined
    const next = end < ordered.length ? ordered[end].line.timeSec : undefined
    for (let index = start; index < end; index += 1) {
      const { line, lineIndex } = ordered[index]
      const expected = lyricTokens(line.text)
      prepared.push({ lineIndex, line, expected, previous, next, duplicate: end - start > 1,
        supported: canMatchLyricWordTimings(line.text),
        reliableSourceWords: hasReliableSourceWordTimings(line, durationSec, next) })
    }
    start = end
  }
  return prepared
}

function matchesInFragment(lines: readonly PreparedLine[], fragment: CompletedFragment, tokens: readonly TimedToken[],
  durationSec: number): FragmentMatch[] {
  const matches: FragmentMatch[] = []
  for (const prepared of lines) {
    const { line, lineIndex, expected, previous, next, duplicate } = prepared
    if (line.timeSec < 0 || line.timeSec >= durationSec || !prepared.supported) continue
    if (expected.length < 2 || expected.length > tokens.length) continue
    if (duplicate || prepared.reliableSourceWords) continue
    const startLower = Math.max(line.timeSec,
      previous === undefined ? 0 : (previous + line.timeSec) / 2)
    const startUpper = Math.min(line.timeSec + MATCH_START_AFTER_SEC,
      next === undefined ? durationSec : (line.timeSec + next) / 2)
    const phraseEndUpper = Math.min(durationSec, line.timeSec + MAX_LINE_SPAN_SEC, next ?? durationSec)
    if (startUpper <= startLower) continue

    const occurrences: FragmentMatch[] = []
    for (let start = 0; start <= tokens.length - expected.length; start += 1) {
      if (tokens[start].word.startSec < startLower || tokens[start].word.startSec >= startUpper) continue
      let equal = true
      for (let tokenIndex = 0; tokenIndex < expected.length; tokenIndex += 1) {
        if (tokens[start + tokenIndex].normalized !== expected[tokenIndex].normalized) { equal = false; break }
      }
      if (!equal) continue
      const first = tokens[start].word
      const last = tokens[start + expected.length - 1].word
      if (last.endSec > phraseEndUpper || first.startSec < fragment.startSec + EDGE_MARGIN_SEC
        || last.endSec > fragment.endSec - EDGE_MARGIN_SEC) continue
      const words = expected.map((token, tokenIndex) => ({ text: token.text,
        timeSec: tokens[start + tokenIndex].word.startSec, endTimeSec: tokens[start + tokenIndex].word.endSec }))
      occurrences.push({ lineIndex, words, confidence: 1, startSec: first.startSec, endSec: last.endSec,
        edgeMarginSec: Math.min(first.startSec - fragment.startSec, fragment.endSec - last.endSec) })
    }
    // Repetitions inside the line's local window make the source-to-audio match ambiguous.
    if (occurrences.length === 1) matches.push(occurrences[0])
  }
  return matches
}

/**
 * Finds exact, complete lyric lines in independently completed ASR fragments.
 * Fragments are never stitched; duplicate chorus text is resolved by each line's
 * canonical local time window.
 */
export function matchLyricWordTimings(lines: readonly LyricsLine[], fragments: readonly CompletedFragment[],
  durationSec: number): MatchedLyricWords[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || lines.length === 0 || fragments.length === 0) return []
  const preparedLines = prepareLines(lines, durationSec)
  if (!preparedLines.length) return []
  const candidatesByLine = new Map<number, FragmentMatch[]>()
  for (const fragment of fragments) {
    const tokens = validateFragment(fragment, durationSec)
    if (!tokens) continue
    for (const match of matchesInFragment(preparedLines, fragment, tokens, durationSec)) {
      const candidates = candidatesByLine.get(match.lineIndex) ?? []
      candidates.push(match)
      candidatesByLine.set(match.lineIndex, candidates)
    }
  }

  const selected: FragmentMatch[] = []
  for (const candidates of candidatesByLine.values()) {
    // Overlapping analysis windows can recognize one occurrence more than once.
    // Collapse only near-identical timing results, keeping the result furthest from
    // either fragment edge. Distinct occurrences remain ambiguous and are rejected.
    const occurrences: FragmentMatch[] = []
    for (const candidate of candidates) {
      const same = occurrences.find(existing => Math.abs(existing.startSec - candidate.startSec) <= DEDUPE_TOLERANCE_SEC
        && Math.abs(existing.endSec - candidate.endSec) <= DEDUPE_TOLERANCE_SEC)
      if (!same) occurrences.push(candidate)
      else if (candidate.edgeMarginSec > same.edgeMarginSec) occurrences[occurrences.indexOf(same)] = candidate
    }
    if (occurrences.length === 1) selected.push(occurrences[0])
  }

  // Two independent lyric lines cannot claim overlapping ASR words.
  const overlapping = new Set<number>()
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      if (selected[left].startSec < selected[right].endSec && selected[right].startSec < selected[left].endSec) {
        overlapping.add(selected[left].lineIndex)
        overlapping.add(selected[right].lineIndex)
      }
    }
  }
  return selected.filter(match => !overlapping.has(match.lineIndex))
    .sort((left, right) => left.lineIndex - right.lineIndex)
    .map(({ lineIndex, words, confidence }) => ({ lineIndex, words, confidence }))
}

/** Apply the current display offset once, matching shiftLyricsLines' zero clamp. */
export function projectLyricWordTimings(matches: readonly MatchedLyricWords[], offsetMs: number): MatchedLyricWords[] {
  const offsetSec = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0
  return matches.map(match => ({ ...match, words: match.words.map(word => {
    const timeSec = Math.max(0, word.timeSec + offsetSec)
    if (word.endTimeSec == null || !Number.isFinite(word.endTimeSec)) return { ...word, timeSec, endTimeSec: word.endTimeSec }
    const endTimeSec = Math.max(0, word.endTimeSec + offsetSec)
    return { ...word, timeSec, endTimeSec: endTimeSec > timeSec ? endTimeSec : null }
  }) }))
}

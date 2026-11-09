import type { LyricsLine, LyricsWord } from '../types'
import type { AnalysisWord, CachedAlignedSourceLine } from './contract'
import type { MatchedLyricWords } from './matchWordTimings'

export const MAX_KNOWN_TEXT_WINDOW_SEC = 12
export const MAX_KNOWN_TEXT_WORDS = 48
export const MAX_KNOWN_TEXT_TOKENS = 160
export const WHISPER_TIME_PRECISION_SEC = 0.02

const LEXICAL_WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu

export interface KnownTextWordSpan {
  text: string
  start: number
  end: number
}

export interface KnownTextAlignment {
  words: AnalysisWord[]
  confidence: number
}

function normalizeWord(text: string): string {
  return text.normalize('NFKC').toLowerCase().replaceAll('ё', 'е').replace(/[’‘]/gu, "'")
}

export function knownTextWords(text: string): KnownTextWordSpan[] {
  return [...text.matchAll(LEXICAL_WORD)].map(match => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}

export function knownTextLineWindow(lines: readonly LyricsLine[], lineIndex: number, durationSec: number): { startSec: number; endSec: number } | null {
  const line = lines[lineIndex]
  if (!line || !Number.isFinite(line.timeSec) || line.timeSec < 0 || line.timeSec >= durationSec
    || !Number.isFinite(durationSec) || durationSec <= 0) return null

  const sameStart = lines.some((other, index) => index !== lineIndex && other.timeSec === line.timeSec)
  if (sameStart) return null

  let nextStart = Infinity
  for (const other of lines) {
    if (Number.isFinite(other.timeSec) && other.timeSec > line.timeSec) nextStart = Math.min(nextStart, other.timeSec)
  }
  const explicitEnd = line.endTimeSec
  const endSec = Number.isFinite(explicitEnd) && explicitEnd! > line.timeSec
    ? explicitEnd!
    : Number.isFinite(nextStart) ? nextStart : Math.min(durationSec, line.timeSec + MAX_KNOWN_TEXT_WINDOW_SEC)
  if (!Number.isFinite(endSec) || endSec <= line.timeSec || endSec > durationSec
    || endSec - line.timeSec > MAX_KNOWN_TEXT_WINDOW_SEC) return null
  return { startSec: line.timeSec, endSec }
}

export function knownTextAlignmentKey(sourceLyricKey: string, lineIndex: number, sourceText: string,
  sourceStartSec: number, sourceEndSec: number): string {
  return JSON.stringify([sourceLyricKey, lineIndex, sourceText, sourceStartSec, sourceEndSec])
}

/** Maps each target token to one supplied lyric word using cumulative tokenizer decode output. */
export function mapDecodedTokensToWords(sourceText: string, decodedPrefixes: readonly string[]): number[][] | null {
  const sourceWords = knownTextWords(sourceText)
  if (sourceWords.length < 2 || sourceWords.length > MAX_KNOWN_TEXT_WORDS || decodedPrefixes.length === 0
    || decodedPrefixes.length > MAX_KNOWN_TEXT_TOKENS) return null

  const decodedText = decodedPrefixes.at(-1) ?? ''
  const decodedWords = knownTextWords(decodedText)
  if (decodedWords.length !== sourceWords.length
    || decodedWords.some((word, index) => normalizeWord(word.text) !== normalizeWord(sourceWords[index].text))) return null

  const groups = sourceWords.map(() => [] as number[])
  let previousText = ''
  let currentWord = -1
  let pendingTokens: number[] = []

  for (let tokenIndex = 0; tokenIndex < decodedPrefixes.length; tokenIndex += 1) {
    const currentText = decodedPrefixes[tokenIndex]
    if (!currentText.startsWith(previousText)) return null
    pendingTokens.push(tokenIndex)
    if (currentText.length === previousText.length) {
      previousText = currentText
      continue
    }

    const changedStart = previousText.length
    const changedEnd = currentText.length
    const touchedWords = decodedWords.flatMap((word, index) => word.start < changedEnd && word.end > changedStart ? [index] : [])
    if (touchedWords.length > 1) return null
    const targetWord = touchedWords[0] ?? Math.max(0, currentWord)
    if (targetWord < currentWord || (currentWord >= 0 && targetWord > currentWord + 1)) return null
    for (const pending of pendingTokens) groups[targetWord].push(pending)
    pendingTokens = []
    if (touchedWords.length) currentWord = targetWord
    previousText = currentText
  }

  if (pendingTokens.length) {
    if (currentWord < 0) return null
    groups[currentWord].push(...pendingTokens)
  }
  return groups.every(group => group.length > 0) ? groups : null
}

function median(values: number[]): number {
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)]
}

function reflectedIndex(index: number, length: number): number {
  if (length <= 1) return 0
  const period = (length - 1) * 2
  const wrapped = ((index % period) + period) % period
  return wrapped < length ? wrapped : period - wrapped
}

function medianFilterRows(rows: number[][], width = 7): void {
  const radius = Math.floor(width / 2)
  for (const row of rows) {
    const filtered = row.map((_, frame) => median(Array.from({ length: width }, (_value, offset) =>
      row[reflectedIndex(frame + offset - radius, row.length)])))
    row.splice(0, row.length, ...filtered)
  }
}

/** Whisper cross-attention DTW. `headRows` is one row-major [token, frame] matrix per alignment head. */
export function attentionTokenBoundaries(headRows: readonly Float32Array[], tokenRows: number, frameCount: number): number[] | null {
  if (!Number.isInteger(tokenRows) || tokenRows < 3 || tokenRows > MAX_KNOWN_TEXT_TOKENS + 1
    || !Number.isInteger(frameCount) || frameCount < tokenRows || frameCount > 1500
    || headRows.length < 1 || headRows.length > 12
    || headRows.some(data => data.length !== tokenRows * frameCount || data.some(value => !Number.isFinite(value)))) return null
  if (headRows.some(data => {
    let minimum = Infinity, maximum = -Infinity
    for (const value of data) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value) }
    return maximum - minimum <= 1e-9
  })) return null

  const meanAttention = Array.from({ length: tokenRows }, () => Array<number>(frameCount).fill(0))
  for (const head of headRows) {
    const rows = Array.from({ length: tokenRows }, (_, token) =>
      Array.from({ length: frameCount }, (_frame, frame) => head[token * frameCount + frame]))

    // Match Whisper's token-axis normalization, then smooth local attention noise.
    for (let frame = 0; frame < frameCount; frame += 1) {
      let mean = 0
      for (let token = 0; token < tokenRows; token += 1) mean += rows[token][frame]
      mean /= tokenRows
      let variance = 0
      for (let token = 0; token < tokenRows; token += 1) variance += (rows[token][frame] - mean) ** 2
      const standardDeviation = Math.sqrt(variance / tokenRows)
      for (let token = 0; token < tokenRows; token += 1) {
        rows[token][frame] = standardDeviation > 1e-9 ? (rows[token][frame] - mean) / standardDeviation : 0
      }
    }
    medianFilterRows(rows)
    for (let token = 0; token < tokenRows; token += 1) {
      for (let frame = 0; frame < frameCount; frame += 1) meanAttention[token][frame] += rows[token][frame] / headRows.length
    }
  }

  // Equivalent to Whisper's DTW over the negative attention score matrix.
  const costs = Array.from({ length: tokenRows + 1 }, () => Array<number>(frameCount + 1).fill(Infinity))
  const trace = Array.from({ length: tokenRows + 1 }, () => new Uint8Array(frameCount + 1))
  costs[0][0] = 0
  for (let frame = 1; frame <= frameCount; frame += 1) {
    for (let token = 1; token <= tokenRows; token += 1) {
      const diagonal = costs[token - 1][frame - 1]
      const vertical = costs[token - 1][frame]
      const horizontal = costs[token][frame - 1]
      let previous: number
      let direction: number
      if (diagonal < vertical && diagonal < horizontal) { previous = diagonal; direction = 0 }
      else if (vertical < diagonal && vertical < horizontal) { previous = vertical; direction = 1 }
      else { previous = horizontal; direction = 2 }
      costs[token][frame] = -meanAttention[token - 1][frame - 1] + previous
      trace[token][frame] = direction
    }
  }

  let token = tokenRows, frame = frameCount
  const path: { token: number; frame: number }[] = []
  while (token > 0 || frame > 0) {
    path.push({ token: token - 1, frame: frame - 1 })
    const direction = trace[token][frame]
    if (direction === 0) { token -= 1; frame -= 1 }
    else if (direction === 1) token -= 1
    else if (direction === 2) frame -= 1
    else return null
  }
  path.reverse()
  const boundaries: number[] = []
  for (let index = 0; index < path.length; index += 1) {
    if (index === 0 || path[index].token !== path[index - 1].token) boundaries.push(path[index].frame)
  }
  return boundaries.length === tokenRows ? boundaries : null
}

/** Converts token boundary frames into all-or-nothing timings for the original lyric words. */
export function knownTextWordsFromBoundaries(sourceText: string, tokenGroups: readonly number[][],
  boundaries: readonly number[], tokenProbabilities: readonly number[], startSec: number, endSec: number): KnownTextAlignment | null {
  const words = knownTextWords(sourceText)
  if (words.length < 2 || words.length > MAX_KNOWN_TEXT_WORDS || tokenGroups.length !== words.length
    || boundaries.length !== tokenProbabilities.length + 1 || tokenProbabilities.some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || !Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec
    || endSec - startSec > MAX_KNOWN_TEXT_WINDOW_SEC) return null

  let tokenCursor = 0
  const timedWords: AnalysisWord[] = []
  let probabilitySum = 0
  let previousEnd = startSec
  for (let index = 0; index < words.length; index += 1) {
    const group = tokenGroups[index]
    if (group.length === 0 || group.some((token, groupIndex) => token !== tokenCursor + groupIndex)) return null
    const nextCursor = tokenCursor + group.length
    if (nextCursor >= boundaries.length) return null
    const startWord = startSec + boundaries[tokenCursor] * WHISPER_TIME_PRECISION_SEC
    const endWord = startSec + boundaries[nextCursor] * WHISPER_TIME_PRECISION_SEC
    if (!Number.isFinite(startWord) || !Number.isFinite(endWord) || startWord < previousEnd - 1e-6
      || endWord <= startWord || endWord > endSec + 1e-6) return null

    const wordConfidence = Math.exp(group.reduce((sum, token) => sum + Math.log(Math.max(tokenProbabilities[token], 1e-12)), 0) / group.length)
    if (!Number.isFinite(wordConfidence)) return null
    probabilitySum += wordConfidence
    timedWords.push({ text: words[index].text, startSec: Math.max(startSec, startWord), endSec: Math.min(endSec, endWord) })
    previousEnd = endWord
    tokenCursor = nextCursor
  }
  if (tokenCursor !== tokenProbabilities.length || timedWords.some(word => word.endSec <= word.startSec)) return null

  const confidence = probabilitySum / words.length
  if (confidence < 0.001 || timedWords.some((_, index) => {
    const group = tokenGroups[index]
    return Math.exp(group.reduce((sum, token) => sum + Math.log(Math.max(tokenProbabilities[token], 1e-12)), 0) / group.length) < 0.00000001
  })) return null
  return { words: timedWords, confidence }
}

/** Reuses cached forced alignments only while every canonical line identity still matches. */
export function matchCachedKnownText(lines: readonly LyricsLine[], alignedSources: readonly CachedAlignedSourceLine[],
  sourceLyricKey: string, durationSec: number): MatchedLyricWords[] {
  const matches: MatchedLyricWords[] = []
  for (const source of alignedSources) {
    if (source.sourceLyricKey !== sourceLyricKey || !Number.isInteger(source.lineIndex)) continue
    const line = lines[source.lineIndex]
    const window = knownTextLineWindow(lines, source.lineIndex, durationSec)
    const expected = line ? knownTextWords(line.text) : []
    if (!line || !window || source.sourceText !== line.text || source.sourceStartSec !== window.startSec
      || source.sourceEndSec !== window.endSec || line.words?.length || expected.length !== source.words.length
      || !Number.isFinite(source.confidence) || source.confidence < 0.001 || source.confidence > 1) continue
    let previousEnd = window.startSec
    const mapped: LyricsWord[] = []
    let valid = true
    for (let index = 0; index < expected.length; index += 1) {
      const word = source.words[index]
      if (!word || word.text !== expected[index].text || !Number.isFinite(word.startSec) || !Number.isFinite(word.endSec)
        || word.startSec < previousEnd || word.startSec < window.startSec || word.endSec <= word.startSec || word.endSec > window.endSec) {
        valid = false
        break
      }
      mapped.push({ text: expected[index].text, timeSec: word.startSec, endTimeSec: word.endSec })
      previousEnd = word.endSec
    }
    if (valid) matches.push({ lineIndex: source.lineIndex, words: mapped, confidence: source.confidence })
  }
  return matches.sort((left, right) => left.lineIndex - right.lineIndex)
}

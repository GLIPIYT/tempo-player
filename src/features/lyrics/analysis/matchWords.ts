import type { LyricsLine } from '../types'
import type { AnalysisWord, MatchedSourceEnd } from './contract'
export interface LyricEndEstimate { lineIndex: number; endTimeSec: number; confidence: number }
const common = new Set('the and for with that this you your are was were have has had not but from into she him her our their love baby yeah oh hey la на не по из за от как что это его она они для или мне мой тебя любовь да'.split(' '))
const tokens = (text: string): string[] => text.toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\p{N}]+/gu) ?? []
const meaningful = (token: string): boolean => token.length >= 3 && !common.has(token)

/** Text heuristic, NOT audio language detection; ambiguous/unsupported scripts keep baseline timing. */
export function lyricLanguage(text: string): 'en' | 'ru' | null {
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length < 10 || tokens(text).filter(meaningful).length < 2) return null
  if (letters.every((letter) => /^[a-z]$/i.test(letter))) return 'en'
  if (letters.every((letter) => /^[а-яё]$/iu.test(letter))) return 'ru'
  return null
}

export function matchLyricEnds(lines: readonly LyricsLine[], words: readonly AnalysisWord[], durationSec: number,
  window?: { startSec: number; endSec: number }): LyricEndEstimate[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return []
  let previous = -1
  for (const word of words) {
    if (!Number.isFinite(word.startSec) || !Number.isFinite(word.endSec) || word.startSec < previous
      || word.startSec < 0 || word.endSec <= word.startSec || word.endSec > durationSec) return []
    previous = word.endSec
  }
  const normalized = lines.map((line) => tokens(line.text))
  const recognized = words.flatMap((word) => tokens(word.text).map((token) => ({ token, word })))
  const result: LyricEndEstimate[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex], expected = normalized[lineIndex]
    if (!Number.isFinite(line.timeSec) || expected.length < 2 || !lyricLanguage(line.text)) continue
    if (normalized.filter((other) => other.join(' ') === expected.join(' ')).length > 1) continue
    const next = lines.filter((other) => other.timeSec > line.timeSec).reduce((min, other) => Math.min(min, other.timeSec), durationSec)
    const upper = Math.min(next, line.timeSec + 10, durationSec)
    const nearby = recognized.filter(({ word }) => word.startSec >= line.timeSec - 0.5 && word.endSec <= upper)
    const candidates: LyricEndEstimate[] = []
    for (let end = 0; end < nearby.length; end++) {
      let matched = 0
      while (matched < expected.length && end - matched >= 0 && nearby[end - matched].token === expected[expected.length - 1 - matched]) matched++
      const confidence = matched / Math.max(expected.length, nearby.length)
      if (confidence < 0.8 || expected.slice(-matched).filter(meaningful).length < 2) continue
      const first = nearby[end - matched + 1].word, last = nearby[end].word
      if (window && (first.startSec < window.startSec + 0.18 || last.endSec > window.endSec - 0.18)) continue
      // Duplicate suffix tokens and generated repetitions cannot establish a unique endpoint.
      const suffix = expected.slice(-matched)
      if (new Set(suffix).size < suffix.length) continue
      candidates.push({ lineIndex, endTimeSec: last.endSec, confidence })
    }
    if (candidates.length === 1) result.push(candidates[0])
  }
  return result
}

export function projectSourceEnds(ends: readonly MatchedSourceEnd[], offsetMs: number, duration: number): LyricEndEstimate[] {
  return ends.filter((end) => Number.isFinite(end.sourceEndSec) && end.confidence >= 0.8)
    .map((end) => ({ lineIndex: end.lineIndex, endTimeSec: Math.max(0, Math.min(duration, end.sourceEndSec + offsetMs / 1000)), confidence: end.confidence }))
}

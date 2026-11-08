import type { LyricsWord } from './types'

export interface LyricWordTiming {
  timeSec: number
  endTimeSec: number
  source: 'source' | 'analysis'
}

const lexical = (text: string) => text.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]/gu, '')

/** One cue per rendered non-whitespace token. Null tokens retain proportional fill. */
export function mapLyricWordTimings(
  text: string,
  words: readonly LyricsWord[] | undefined,
  startSec: number,
  endSec: number,
  source: LyricWordTiming['source'],
): (LyricWordTiming | null)[] | undefined {
  if (!words?.length || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return undefined
  const tokens = text.match(/\S+/gu) ?? []
  const normalized = tokens.map(lexical)
  const expected = normalized.join('')
  if (!expected || words.map(word => lexical(word.text)).join('') !== expected) return undefined
  const spans: { start: number; end: number }[] = []
  let advance = 0
  for (const token of normalized) {
    spans.push({ start: advance, end: advance + token.length })
    advance += token.length
  }
  const result: (LyricWordTiming | null)[] = tokens.map(() => null)
  let cursor = 0
  let previousStart = -Infinity
  let previousEnd = -Infinity
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const content = lexical(word.text)
    const nextStart = words[index + 1]?.timeSec ?? endSec
    const wordEnd = word.endTimeSec ?? nextStart
    if (!Number.isFinite(word.timeSec) || !Number.isFinite(wordEnd)
      || word.timeSec < startSec || word.timeSec >= endSec || wordEnd <= word.timeSec
      || word.timeSec < previousStart || word.timeSec < previousEnd - 0.001) return undefined
    previousStart = word.timeSec
    previousEnd = wordEnd
    if (!content) continue
    // Enhanced LRC fragments may split a word into syllables. A fragment that
    // spans several displayed words cannot tell us their individual onsets.
    const tokenIndex = spans.findIndex(span => span.start <= cursor && span.end >= cursor + content.length && span.end > span.start)
    if (tokenIndex < 0) return undefined
    const existing = result[tokenIndex]
    result[tokenIndex] = {
      timeSec: existing?.timeSec ?? word.timeSec,
      endTimeSec: Math.min(wordEnd, endSec),
      source,
    }
    cursor += content.length
  }
  return result.some(Boolean) ? result : undefined
}

/** Duration discovery can shorten even an already latched playback pass. */
export function clipLyricWordTimings(
  words: readonly (LyricWordTiming | null)[] | undefined,
  endSec: number,
): readonly (LyricWordTiming | null)[] | undefined {
  return words?.map(word => !word || word.timeSec >= endSec ? null
    : { ...word, endTimeSec: Math.min(word.endTimeSec, endSec) })
}

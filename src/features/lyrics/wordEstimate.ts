import type { LyricsLine } from './types'
import type { LyricTimingAnalysis, ResolvedLyricsTiming } from './timingResolver'
import type { LyricWordTiming } from './wordTiming'

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е')
const lexical = (text: string) => normalize(text).replace(/[^\p{L}\p{N}]/gu, '')
const shortWords = new Set('а и но да ни не же ли бы б в во на по к ко с со у о об от до за из без для над под при про через или что чтоб как the a an and or but as at by for from in into of on to with is are was were be am it its if so'.split(' '))
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Singing-time prior, not an audio measurement or an exact vowel-hold rule. */
export function lyricWordWeight(text: string, final: boolean): number {
  const token = lexical(text)
  if (!token) return 0
  if (shortWords.has(token)) return .42
  let syllables: number
  if (/^[а-я]+$/u.test(token)) syllables = (token.match(/[аеёиоуыэюя]/gu) ?? []).length
  else if (/^[a-z]+$/u.test(token)) {
    syllables = (token.match(/[aeiouy]+/gu) ?? []).length
    if (/[^aeiou]e$/u.test(token) && !/le$/u.test(token)) syllables -= 1
  } else syllables = Math.max(1, token.length / 3)
  let weight = .28 + Math.max(1, syllables)
  // Content words may hold a final vowel. Keep the prior weak; an ASR/source
  // interval always wins and a conjunction such as "и" stays short.
  if (token.length >= 3 && /[аеёиоуыэюяaeiouy]$/u.test(token)) weight *= 1.1
  if (/(\p{L})\1{2,}/u.test(token)) weight *= 1.35
  if (final) weight *= 1.16
  if (/[,;:!?…]$|\.{2,}$/u.test(text)) weight += .18
  return weight
}

export function repeatedPhraseKey(text: string): string | null {
  const words = normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []
  return words.length >= 3 && new Set(words).size >= 2 && words.join('').length >= 12 ? words.join(' ') : null
}

/** Two agreeing precise occurrences can calibrate an otherwise inferred end. */
export function repeatedPhraseDurations(lines: readonly LyricsLine[], duration: number | null, analysis?: LyricTimingAnalysis | null): Map<string, number> {
  const sorted = lines.map((line, index) => ({ line, index })).filter(item => Number.isFinite(item.line.timeSec) && item.line.timeSec >= 0)
    .sort((a, b) => a.line.timeSec - b.line.timeSec)
  const recognized = new Map((analysis?.matchedEnds ?? []).filter(end => Number.isFinite(end.confidence) && end.confidence >= .8)
    .map(end => [end.lineIndex, end.endTimeSec]))
  const samples = new Map<string, number[]>()
  for (let start = 0; start < sorted.length;) {
    let next = start + 1
    while (next < sorted.length && sorted[next].line.timeSec === sorted[start].line.timeSec) next += 1
    if (next === start + 1) {
      const { line, index } = sorted[start]
      const key = repeatedPhraseKey(line.text)
      const end = line.endTimeSec ?? line.words?.at(-1)?.endTimeSec ?? recognized.get(index)
      const limit = Math.min(sorted[next]?.line.timeSec ?? Infinity, duration ?? Infinity)
      if (key && end != null && Number.isFinite(end) && end > line.timeSec && end <= limit && end - line.timeSec <= 30) {
        const values = samples.get(key) ?? []
        values.push(end - line.timeSec)
        samples.set(key, values)
      }
    }
    start = next
  }
  return new Map([...samples].flatMap(([key, values]) => values.length >= 2 && Math.max(...values) / Math.min(...values) <= 1.2
    ? [[key, median(values)] as const] : []))
}

export function estimateLyricWords(text: string, timeSec: number, endTimeSec: number): (LyricWordTiming | null)[] {
  const tokens = text.match(/\S+/gu) ?? []
  if (!Number.isFinite(timeSec) || !Number.isFinite(endTimeSec) || endTimeSec <= timeSec) return tokens.map(() => null)
  let lastWord = tokens.length - 1
  while (lastWord >= 0 && !lexical(tokens[lastWord])) lastWord -= 1
  const weights = tokens.map((token, index) => lyricWordWeight(token, index === lastWord))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let advance = timeSec
  return weights.map(weight => {
    if (!weight || !total || endTimeSec <= timeSec) return null
    const start = advance
    advance += (endTimeSec - timeSec) * weight / total
    return { timeSec: start, endTimeSec: Math.min(advance, endTimeSec), source: 'estimated' }
  })
}

/** Run once per resolved timing revision, never from the animation frame loop. */
export function addEstimatedWordTimings(timing: ResolvedLyricsTiming): void {
  const byIndex = new Map(timing.lines.map(line => [line.lineIndex, line]))
  const limits = new Map<number, number>()
  for (const segment of timing.segments) if (segment.kind === 'line') {
    for (const index of segment.lineIndices) limits.set(index, segment.endTimeSec)
  }
  const profiles = new Map<string, { duration: number; cues: (LyricWordTiming | null)[] }[]>()
  for (const line of timing.lines) {
    const key = repeatedPhraseKey(line.text)
    const end = Math.min(line.endTimeSec, limits.get(line.lineIndex) ?? line.endTimeSec)
    const span = end - line.timeSec
    const tokens = line.text.match(/\S+/gu) ?? []
    if (!key || !line.wordTimings || span <= 0 || tokens.some((token, index) => lexical(token) && !line.wordTimings?.[index])) continue
    const values = profiles.get(key) ?? []
    values.push({ duration: span, cues: line.wordTimings.map(cue => cue ? {
      ...cue, timeSec: (cue.timeSec - line.timeSec) / span, endTimeSec: (cue.endTimeSec - line.timeSec) / span,
    } : null) })
    profiles.set(key, values)
  }
  for (const line of timing.lines) {
    if (line.wordTimings || !line.text.trim()) continue
    const end = Math.min(line.endTimeSec, limits.get(line.lineIndex) ?? line.endTimeSec)
    const span = end - line.timeSec
    const key = repeatedPhraseKey(line.text)
    const references = key ? profiles.get(key)?.filter(reference => span / reference.duration >= .65 && span / reference.duration <= 1.5) : undefined
    const tokens = line.text.match(/\S+/gu) ?? []
    // Disagreeing renditions (spoken bridge vs sung chorus) must not impose a
    // shared pattern. Require matching token slots and similar relative onsets.
    const agrees = references?.length && references.every(reference => reference.cues.length === tokens.length)
      && tokens.every((_, index) => {
        const starts = references.flatMap(reference => reference.cues[index] ? [reference.cues[index]!.timeSec] : [])
        return !starts.length || Math.max(...starts) - Math.min(...starts) <= .12
      })
    line.wordTimings = agrees ? tokens.map((_, index) => {
      const cues = references.flatMap(reference => reference.cues[index] ? [reference.cues[index]!] : [])
      return cues.length ? { timeSec: line.timeSec + median(cues.map(cue => cue.timeSec)) * span,
        endTimeSec: line.timeSec + median(cues.map(cue => cue.endTimeSec)) * span, source: 'estimated' as const } : null
    }) : estimateLyricWords(line.text, line.timeSec, end)
  }
  for (const segment of timing.segments) if (segment.kind === 'line') {
    segment.wordTimings = segment.lineIndices.flatMap(index => byIndex.get(index)?.wordTimings ?? [])
  }
}

import { expect, it } from 'vitest'
import type { AnalysisWord, CompletedFragment } from './contract'
import { hasReliableSourceWordTimings, matchLyricWordTimings, projectLyricWordTimings } from './matchWordTimings'

function words(texts: string[], start: number, step = 0.45): AnalysisWord[] {
  return texts.map((text, index) => ({ text, startSec: start + index * step, endSec: start + index * step + 0.3 }))
}
function fragment(startSec: number, endSec: number, asrWords: AnalysisWord[]): CompletedFragment {
  return { startSec, endSec, status: 'completed', words: asrWords }
}
function sourceWords(texts: string[], start: number, step = 0.45) {
  return words(texts, start, step).map(word => ({ text: word.text, timeSec: word.startSec, endTimeSec: word.endSec }))
}

it('matches a complete ordered line with case, ё and punctuation normalization', () => {
  const line = { timeSec: 10, text: 'Тёплый ветер, над рекой!' }
  const result = matchLyricWordTimings([line], [fragment(8, 14, words(['теплый', 'ВЕТЕР', 'над', 'рекой,'], 10.2))], 30)
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ lineIndex: 0, confidence: 1 })
  expect(result[0].words.map(word => word.text)).toEqual(['Тёплый', 'ветер', 'над', 'рекой'])
  result[0].words.forEach((word, index) => {
    expect(word.timeSec).toBeCloseTo([10.2, 10.65, 11.1, 11.55][index])
    expect(word.endTimeSec).toBeCloseTo([10.5, 10.95, 11.4, 11.85][index])
  })
})

it('clips only a tiny early ASR onset to the authored line start', () => {
  const line = [{ timeSec: 10, text: 'Silver rivers carry dreams' }]
  const result = matchLyricWordTimings(line, [fragment(8, 15, words(['silver', 'rivers', 'carry', 'dreams'], 9.92))], 30)
  expect(result[0]?.words[0].timeSec).toBe(10)
  expect(result[0]?.words[0].endTimeSec).toBeCloseTo(10.22)
  expect(matchLyricWordTimings(line, [fragment(8, 15, words(['silver', 'rivers', 'carry', 'dreams'], 9.7))], 30)).toEqual([])
  const endedBeforeLine = words(['silver', 'rivers', 'carry', 'dreams'], 9.92)
  endedBeforeLine[0].endSec = 9.99
  expect(matchLyricWordTimings(line, [fragment(8, 15, endedBeforeLine)], 30)).toEqual([])
})

it('accepts a timestamped contraction without splitting it into fictitious words', () => {
  const result = matchLyricWordTimings([{ timeSec: 10, text: 'Don’t leave tonight,please' }],
    [fragment(8, 15, words(["don't", 'leave', 'tonight', 'please'], 10.1))], 30)
  expect(result).toHaveLength(1)
  expect(result[0].words.map(word => word.text)).toEqual(['Don’t', 'leave', 'tonight', 'please'])
  expect(result[0].words[0].timeSec).toBeCloseTo(10.1)
})

it('rejects partial, reordered, merged, ambiguous and distant matches', () => {
  const line = [{ timeSec: 10, text: 'Silver rivers carry dreams' }]
  const incomplete = words(['silver', 'rivers', 'dreams'], 10.2)
  const reversed = words(['rivers', 'silver', 'carry', 'dreams'], 10.2)
  const merged = words(['silver', 'rivers', 'carry dreams'], 10.2)
  const repeated = [...words(['silver', 'rivers', 'carry', 'dreams'], 10.2), ...words(['silver', 'rivers', 'carry', 'dreams'], 12.2)]
  for (const asrWords of [incomplete, reversed, merged, repeated]) {
    expect(matchLyricWordTimings(line, [fragment(8, 16, asrWords)], 30)).toEqual([])
  }
  // An offset is only projected after a canonical match; it cannot move this
  // canonical source line's search window to the audio occurrence at 12 seconds.
  expect(matchLyricWordTimings([{ timeSec: 17, text: 'Silver rivers carry dreams' }],
    [fragment(10, 15, words(['silver', 'rivers', 'carry', 'dreams'], 12.2))], 30)).toEqual([])
})

it('keeps repeated chorus matches scoped to their local source times', () => {
  const chorus = { text: 'Silver rivers carry dreams' }
  const sourceLines = [{ ...chorus, timeSec: 5 }, { ...chorus, timeSec: 8.5 }]
  const asrWords = [...words(['silver', 'rivers', 'carry', 'dreams'], 5.2), ...words(['silver', 'rivers', 'carry', 'dreams'], 8.7)]
  const result = matchLyricWordTimings(sourceLines, [fragment(0, 30, asrWords)], 30)
  expect(result.map(match => match.lineIndex)).toEqual([0, 1])
  expect(result.map(match => match.words[0].timeSec)).toEqual([5.2, 8.7])
})

it('rejects overlapping line assignments and words cut by fragment edges', () => {
  const overlappingLines = [
    { timeSec: 10, text: 'Silver rivers carry dreams' },
    { timeSec: 11.4, text: 'Rivers carry dreams again' },
  ]
  const overlappingWords = words(['silver', 'rivers', 'carry', 'dreams', 'again'], 10.2, 0.4)
  expect(matchLyricWordTimings(overlappingLines, [fragment(8, 16, overlappingWords)], 30)).toEqual([])

  const line = [{ timeSec: 10, text: 'Silver rivers carry dreams' }]
  expect(matchLyricWordTimings(line, [fragment(10.2, 14, words(['silver', 'rivers', 'carry', 'dreams'], 10.2))], 30)).toEqual([])
  expect(matchLyricWordTimings(line, [fragment(8, 11.85, words(['silver', 'rivers', 'carry', 'dreams'], 10.2))], 30)).toEqual([])
  expect(matchLyricWordTimings(line, [fragment(8, 16, [
    ...words(['silver', 'rivers'], 10.2), { text: 'carry', startSec: 10.7, endSec: 11 },
    { text: 'dreams', startSec: 10.9, endSec: 11.2 },
  ])], 30)).toEqual([])
})

it('prefers complete source word timings and projects analysis offset exactly once', () => {
  const sourceLine = { timeSec: 10, text: 'Silver rivers carry dreams', words: sourceWords(['Silver', 'rivers', 'carry', 'dreams'], 10.2) }
  expect(hasReliableSourceWordTimings(sourceLine, 30)).toBe(true)
  expect(matchLyricWordTimings([sourceLine], [fragment(8, 16, words(['silver', 'rivers', 'carry', 'dreams'], 10.2))], 30)).toEqual([])

  const canonical = matchLyricWordTimings([{ timeSec: 10, text: 'Silver rivers carry dreams' }],
    [fragment(8, 16, words(['silver', 'rivers', 'carry', 'dreams'], 10.2))], 30)
  expect(projectLyricWordTimings(canonical, -5000)[0].words[0].timeSec).toBeCloseTo(5.2)
  expect(projectLyricWordTimings(canonical, -5000)[0].words[0].endTimeSec).toBeCloseTo(5.5)
  expect(projectLyricWordTimings(canonical, -12000)[0].words[0]).toMatchObject({ timeSec: 0, endTimeSec: null })
  expect(projectLyricWordTimings(canonical, -4000)[0].words[0].timeSec).toBeCloseTo(6.2)
  expect(projectLyricWordTimings(canonical, -4000)[0].words[0].endTimeSec).toBeCloseTo(6.5)
})

it('does not stitch a line across separate fragments or accept invalid timestamps', () => {
  const line = [{ timeSec: 10, text: 'Silver rivers carry dreams' }]
  const first = fragment(8, 11.9, words(['silver', 'rivers'], 10.2))
  const second = fragment(11.9, 15, words(['carry', 'dreams'], 12.2))
  expect(matchLyricWordTimings(line, [first, second], 30)).toEqual([])
  expect(matchLyricWordTimings(line, [fragment(8, 16, [
    ...words(['silver', 'rivers', 'carry'], 10.2), { text: 'dreams', startSec: 11.55, endSec: Number.NaN },
  ])], 30)).toEqual([])
})

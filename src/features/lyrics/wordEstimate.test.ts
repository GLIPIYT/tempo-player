import { expect, it } from 'vitest'
import { estimateLyricWords, lyricWordWeight, repeatedPhraseDurations, repeatedPhraseKey } from './wordEstimate'
import { resolveLyricTiming } from './timingResolver'

it('gives short function words less time than multisyllabic content, independently of font width', () => {
  const cues = estimateLyricWords('И на небосклоне города', 10, 16)
  const duration = (index: number) => cues[index]!.endTimeSec - cues[index]!.timeSec
  expect(duration(0)).toBeCloseTo(duration(1))
  expect(duration(2)).toBeGreaterThan(duration(0) * 4)
  expect(cues[0]?.timeSec).toBe(10)
  expect(cues.at(-1)?.endTimeSec).toBeCloseTo(16)
  expect(lyricWordWeight('the', false)).toBeLessThan(lyricWordWeight('unforgettable', false))
})

it('uses weak vowel and phrase-tail priors but never stretches the conjunction и', () => {
  expect(lyricWordWeight('пою', false)).toBeGreaterThan(lyricWordWeight('поют', false))
  expect(lyricWordWeight('пою', true)).toBeGreaterThan(lyricWordWeight('пою', false))
  expect(lyricWordWeight('и', true)).toBe(lyricWordWeight('и', false))
  expect(lyricWordWeight('оооо', false)).toBeGreaterThan(lyricWordWeight('о', false))
})

it('keeps punctuation token slots and guards malformed intervals', () => {
  const cues = estimateLyricWords('Я — человек', 1, 4)
  expect(cues).toHaveLength(3)
  expect(cues[1]).toBeNull()
  expect(cues[2]?.endTimeSec).toBe(4)
  expect(estimateLyricWords('один два', 1, Infinity)).toEqual([null, null])
  expect(estimateLyricWords('один два', 3, 1)).toEqual([null, null])
})

it('transfers a precise repeated phrase pattern as an estimate without rewriting its source', () => {
  const text = 'Длинные ночи города'
  const sourceWords = [{ text: 'Длинные', timeSec: 1.2, endTimeSec: 1.8 },
    { text: 'ночи', timeSec: 2, endTimeSec: 4 }, { text: 'города', timeSec: 4.6, endTimeSec: 5 }]
  const timing = resolveLyricTiming([
    { timeSec: 1, text, endTimeSec: 5, words: sourceWords }, { timeSec: 10, text, endTimeSec: 14 },
  ], 16)
  expect(timing.lines[0].wordTimings?.map(cue => cue?.source)).toEqual(['source', 'source', 'source'])
  expect(timing.lines[1].wordTimings?.map(cue => cue?.source)).toEqual(['estimated', 'estimated', 'estimated'])
  expect(timing.lines[1].wordTimings?.[0]?.timeSec).toBeCloseTo(10.2)
  expect(timing.lines[1].wordTimings?.[2]?.timeSec).toBeCloseTo(13.6)
  expect(timing.lines[1].wordTimings?.[2]?.endTimeSec).toBeCloseTo(14)
})

it('does not transfer a chorus pattern across incompatible durations', () => {
  const text = 'Длинные ночи города'
  const timing = resolveLyricTiming([
    { timeSec: 1, text, endTimeSec: 5, words: [{ text: 'Длинные', timeSec: 1.5, endTimeSec: 2 },
      { text: 'ночи', timeSec: 2, endTimeSec: 3 }, { text: 'города', timeSec: 4, endTimeSec: 5 }] },
    { timeSec: 10, text, endTimeSec: 11 },
  ], 16)
  expect(timing.lines[1].wordTimings?.[0]?.timeSec).toBe(10)
  expect(timing.lines[1].wordTimings?.at(-1)?.endTimeSec).toBe(11)
})

it('rejects disagreeing word patterns in differently sung repeats', () => {
  const text = 'Длинные ночи города'
  const timing = resolveLyricTiming([
    { timeSec: 1, text, endTimeSec: 5, words: [{ text: 'Длинные', timeSec: 1.2, endTimeSec: 1.8 },
      { text: 'ночи', timeSec: 2, endTimeSec: 4 }, { text: 'города', timeSec: 4.6, endTimeSec: 5 }] },
    { timeSec: 10, text, endTimeSec: 14, words: [{ text: 'Длинные', timeSec: 10.2, endTimeSec: 11.8 },
      { text: 'ночи', timeSec: 12, endTimeSec: 13 }, { text: 'города', timeSec: 13.6, endTimeSec: 14 }] },
    { timeSec: 20, text, endTimeSec: 24 },
  ], 30)
  expect(timing.lines[2].wordTimings?.[0]?.timeSec).toBe(20)
})

it('uses two agreeing precise repeat durations only for an unconfirmed ending', () => {
  const text = 'Длинные ночи города'
  const timing = resolveLyricTiming([
    { timeSec: 1, text, endTimeSec: 5 }, { timeSec: 10, text, endTimeSec: 14.2 },
    { timeSec: 20, text }, { timeSec: 40, text: 'Следующая фраза' },
  ], 50)
  expect(timing.lines[0].endTimeSec).toBe(5)
  expect(timing.lines[1].endTimeSec).toBe(14.2)
  expect(timing.lines[2].endTimeSec).toBeCloseTo(24.1)
  expect(timing.lines[2].endSource).toBe('text')
})

it('rejects disagreeing repeated durations, short chants and single exemplars for phrase ends', () => {
  const text = 'Длинные ночи города'
  expect(repeatedPhraseDurations([{ timeSec: 1, text, endTimeSec: 3 }, { timeSec: 5, text, endTimeSec: 12 }], 20).size).toBe(0)
  expect(repeatedPhraseDurations([{ timeSec: 1, text, endTimeSec: 3 }, { timeSec: 5, text }], 20).size).toBe(0)
  expect(repeatedPhraseKey('ла ла ла')).toBeNull()
  expect(repeatedPhraseKey('ДЛИННЫЕ, ночи города!')).toBe(repeatedPhraseKey(text))
})

it('keeps simultaneous voices and manual boundaries independent while estimating missing words', () => {
  const timing = resolveLyricTiming([
    { timeSec: 1, text: 'И на небосклоне города', endTimeSec: 3, endSource: 'manual' },
    { timeSec: 1, text: 'Где то далеко', endTimeSec: 4, endSource: 'manual' },
    { timeSec: 5, text: 'следующая' },
  ], 10)
  const segment = timing.segments.find(segment => segment.kind === 'line')!
  expect(segment.wordTimings).toHaveLength(7)
  expect(segment.wordTimings?.[3]?.endTimeSec).toBeCloseTo(3)
  expect(segment.wordTimings?.[6]?.endTimeSec).toBeCloseTo(4)
  expect(timing.lines[0].endTimeSec).toBe(3)
})

import { expect, it } from 'vitest'
import { lyricDisplayText, lyricDisplayTokens, lyricWordTokens } from './lyricTokens'
import { mapLyricWordTimings } from './wordTiming'
import { resolveLyricTiming } from './timingResolver'

it('normalizes imported horizontal spacing without removing line boundaries or changing the source', () => {
  const original = '  Только\t не домой,только не \u00a0  домой\r\n  Следующая   строка '
  expect(lyricDisplayText(original)).toBe('Только не домой, только не домой\nСледующая строка')
  expect(original).toContain('\t')
  expect(lyricDisplayTokens('домой,только')).toEqual(['домой,', ' ', 'только'])
  expect(lyricWordTokens('домой,только')).toEqual(['домой,', 'только'])
})

it('keeps decimals, clocks, contractions and hyphenated words intact', () => {
  expect(lyricDisplayText("3,14 12:30 don't по-прежнему https://example.com")).toBe("3,14 12:30 don't по-прежнему https://example.com")
  expect(lyricWordTokens('Hello,world!Да;нет:всё…потом')).toEqual(['Hello,', 'world!', 'Да;', 'нет:', 'всё…', 'потом'])
})

it('uses the same comma word boundaries for source cues, estimates, repeats and simultaneous voices', () => {
  const words = [{ text: 'домой,', timeSec: 1, endTimeSec: 2 }, { text: 'только', timeSec: 2, endTimeSec: 3 }]
  const mapped = mapLyricWordTimings('домой,только', words, 1, 3, 'source')!
  expect(mapped.map(cue => cue?.timeSec)).toEqual([1, 2])
  const timing = resolveLyricTiming([
    { timeSec: 1, text: 'домой,только', words, endTimeSec: 3 },
    { timeSec: 1, text: 'а ты,останься', endTimeSec: 3 },
  ], 5)
  const line = timing.segments.find(segment => segment.kind === 'line')!
  expect(line.wordTimings).toHaveLength(5)
  expect(line.wordTimings?.slice(0, 2).map(cue => cue?.source)).toEqual(['source', 'source'])
  expect(line.wordTimings?.slice(2).every(cue => cue?.source === 'estimated')).toBe(true)
  // A single source fragment across two words cannot invent an internal onset.
  expect(mapLyricWordTimings('домой,только', [{ text: 'домой,только', timeSec: 1, endTimeSec: 3 }], 1, 3, 'source')).toBeUndefined()
})

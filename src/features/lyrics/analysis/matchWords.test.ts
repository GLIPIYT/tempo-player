import { expect, it } from 'vitest'
import { matchLyricEnds, lyricLanguage, projectSourceEnds } from './matchWords'
import type { AnalysisWord } from './contract'
const words: AnalysisWord[] = [{ text: 'Silver', startSec: 12.2, endSec: 12.7 }, { text: 'rivers!', startSec: 13, endSec: 14 }]
it('accepts two meaningful ordered words and normalizes punctuation, case and ё', () => {
  expect(matchLyricEnds([{ timeSec: 12, text: 'silver rivers' }], words, 30, { startSec: 11, endSec: 16 }))
    .toEqual([{ lineIndex: 0, endTimeSec: 14, confidence: 1 }])
  expect(matchLyricEnds([{ timeSec: 12, text: 'Тёплый ветер' }], words.map((w, i) => ({ ...w, text: ['теплый', 'ветер'][i] })), 30)).toHaveLength(1)
})
it('refuses common words, repeated chorus, reversed words, invented suffix and clipped edge', () => {
  for (const text of ['and the', 'rivers silver', 'silver mountains rivers', 'silver rivers dream']) {
    expect(matchLyricEnds([{ timeSec: 12, text }], words, 30)).toEqual([])
  }
  expect(matchLyricEnds([{ timeSec: 12, text: 'silver rivers' }, { timeSec: 22, text: 'silver rivers' }], words, 30)).toEqual([])
  expect(matchLyricEnds([{ timeSec: 12, text: 'silver rivers' }], words, 30, { startSec: 11, endSec: 14.1 })).toEqual([])
})
it('rejects repeated ASR tokens, remote phrase times and invalid endpoints', () => {
  expect(matchLyricEnds([{ timeSec: 12, text: 'silver rivers' }], [{ text: 'silver', startSec: 12, endSec: 12.1 }, ...words], 30)).toEqual([])
  expect(matchLyricEnds([{ timeSec: 12, text: 'silver rivers' }], [{ text: 'invented', startSec: 12, endSec: 12.1 }, ...words], 30)).toEqual([])
  expect(matchLyricEnds([{ timeSec: 12, text: 'silver rivers' }], [...words, ...words.map(w => ({ ...w, startSec: w.startSec + 3, endSec: w.endSec + 3 }))], 30)).toEqual([])
  expect(matchLyricEnds([{ timeSec: 0, text: 'silver rivers' }], words, 30)).toEqual([])
  expect(matchLyricEnds([{ timeSec: 12, text: 'silver rivers' }], words.map(w => ({ ...w, endSec: NaN })), 30)).toEqual([])
})
it('rejects an invented or repeated prefix on a five-word line, while allowing preceding context and a clean partial suffix', () => {
  const line = [{ timeSec: 12, text: 'Silver rivers carry golden dreams' }]
  const phrase: AnalysisWord[] = ['silver', 'rivers', 'carry', 'golden', 'dreams'].map((text, index) =>
    ({ text, startSec: 12.3 + index * 0.5, endSec: 12.7 + index * 0.5 }))
  for (const extra of ['invented', 'silver']) {
    expect(matchLyricEnds(line, [{ text: extra, startSec: 12.05, endSec: 12.2 }, ...phrase], 30)).toEqual([])
  }
  const context = { text: 'previous', startSec: 11.7, endSec: 11.9 }
  expect(matchLyricEnds(line, [context, ...phrase], 30)).toEqual([
    { lineIndex: 0, endTimeSec: 14.7, confidence: 5 / 6 },
  ])
  expect(matchLyricEnds(line, phrase.slice(1), 30)).toEqual([
    { lineIndex: 0, endTimeSec: 14.7, confidence: 0.8 },
  ])
})
it('projects persisted source endpoints with current offset once and clamps duration', () => {
  const ends = [{ lineIndex: 0, sourceEndSec: 19, matchedMediaEndSec: 14, offsetAtMatchMs: -5000, confidence: 1 }]
  expect(projectSourceEnds(ends, -5000, 30)[0].endTimeSec).toBe(14)
  expect(projectSourceEnds(ends, -4000, 30)[0].endTimeSec).toBe(15)
  expect(projectSourceEnds([{ ...ends[0], sourceEndSec: 12, offsetAtMatchMs: 2000 }], 3000, 30)[0].endTimeSec).toBe(15)
  expect(projectSourceEnds(ends, 20000, 30)[0].endTimeSec).toBe(30)
})
it('uses an explicit conservative EN/RU text heuristic and rejects ambiguity', () => {
  expect(lyricLanguage('Silver rivers flow through the valley')).toBe('en')
  expect(lyricLanguage('Тёплый ветер летит над рекой')).toBe('ru')
  for (const text of ['hi', 'Silver ветер', '暖かい風が吹く', 'Теплий вітер над рікою', 'été déjà']) expect(lyricLanguage(text)).toBeNull()
})

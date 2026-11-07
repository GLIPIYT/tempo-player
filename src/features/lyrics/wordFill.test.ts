import { expect, it } from 'vitest'
import { wordIndexAtProgress, wordStartsFromWidths } from './wordFill'

it('fills a whole word when its measured beginning is reached, including spaces', () => {
  const starts = wordStartsFromWidths([{ width: 30, word: true }, { width: 10, word: false }, { width: 60, word: true }])
  expect(starts).toEqual([0, 0.4])
  expect(wordIndexAtProgress(starts, 0)).toBe(0)
  expect(wordIndexAtProgress(starts, 0.399)).toBe(0)
  expect(wordIndexAtProgress(starts, 0.4)).toBe(1)
  expect(wordIndexAtProgress(starts, 1)).toBe(1)
  expect(wordIndexAtProgress([], 0.5)).toBe(-1)
})

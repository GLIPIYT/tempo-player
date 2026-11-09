import { expect, it } from 'vitest'
import type { CachedAlignedSourceLine } from './contract'
import { attentionTokenBoundaries, knownTextLineWindow, knownTextWordsFromBoundaries, mapDecodedTokensToWords, matchCachedKnownText } from './knownTextAlignment'

it('maps cumulative Whisper token decoding to exact supplied words and preserves source spelling', () => {
  const groups = mapDecodedTokensToWords('Don’t leave tonight, please', [
    'Don', "Don't", "Don't leave", "Don't leave tonight", "Don't leave tonight,", "Don't leave tonight, please",
  ])
  expect(groups).toEqual([[0, 1], [2], [3, 4], [5]])
  const aligned = knownTextWordsFromBoundaries('Don’t leave tonight, please', groups!, [0, 4, 9, 15, 20, 27, 34],
    [0.9, 0.8, 0.75, 0.9, 0.8, 0.7], 10, 11)
  expect(aligned?.words.map(word => word.text)).toEqual(['Don’t', 'leave', 'tonight', 'please'])
  expect(aligned?.words[0].startSec).toBe(10)
  expect(aligned?.words.at(-1)?.endSec).toBeCloseTo(10.68)
  expect(mapDecodedTokensToWords('hello world', ['hello there'])).toBeNull()
  expect(mapDecodedTokensToWords('hello world', ['hello world outside'])).toBeNull()
})

it('finds monotonic boundaries from cross-attention and rejects constant or malformed inputs', () => {
  const tokenRows = 5, frameCount = 60
  const head = new Float32Array(tokenRows * frameCount)
  const centers = [3, 12, 23, 37, 51]
  for (let token = 0; token < tokenRows; token += 1) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      head[token * frameCount + frame] = Math.exp(-((frame - centers[token]) ** 2) / 12)
    }
  }
  const boundaries = attentionTokenBoundaries([head, head.slice()], tokenRows, frameCount)
  expect(boundaries).toHaveLength(tokenRows)
  expect(boundaries?.every(Number.isInteger)).toBe(true)
  expect(boundaries?.every((frame, index) => index === 0 || frame > boundaries![index - 1])).toBe(true)
  expect(attentionTokenBoundaries([new Float32Array(tokenRows * frameCount)], tokenRows, frameCount)).toBeNull()
  expect(attentionTokenBoundaries([head], tokenRows, tokenRows - 1)).toBeNull()
  expect(attentionTokenBoundaries([new Float32Array([Number.NaN])], tokenRows, frameCount)).toBeNull()
})

it('rejects zero-duration, out-of-window, low-confidence, and excessive line timing results', () => {
  const groups = [[0], [1]]
  expect(knownTextWordsFromBoundaries('hello world', groups, [0, 0, 10], [0.9, 0.9], 2, 4)).toBeNull()
  expect(knownTextWordsFromBoundaries('hello world', groups, [0, 3, 5], [0.9, 0.9], 2, 2.09)).toBeNull()
  expect(knownTextWordsFromBoundaries('hello world', groups, [0, 3, 5], [1e-8, 1e-8], 2, 4)).toBeNull()
  expect(knownTextWordsFromBoundaries('hello world', groups, [0, 3, 5], [0.9, 0.9], 2, 14.01)).toBeNull()
  expect(knownTextWordsFromBoundaries('hello world', groups, [0, 3, 5], [0.9, 0.9], 2, 4)?.confidence).toBeCloseTo(0.9)
})

it('accepts a weak individual token only when the line remains credible and rejects near-zero tokens', () => {
  const text = 'one two three four five six'
  const groups = [[0], [1], [2], [3], [4], [5]]
  const boundaries = [0, 1, 2, 3, 4, 5, 6]
  const credible = knownTextWordsFromBoundaries(text, groups, boundaries, [1e-7, 1, 1, 1, 1, 1], 0, 1)
  expect(credible?.words).toHaveLength(6)
  expect(knownTextWordsFromBoundaries(text, groups, boundaries, [1e-9, 1, 1, 1, 1, 1], 0, 1)).toBeNull()
})

it('builds bounded source windows and reuses only the exact canonical lyric line', () => {
  const lines = [{ timeSec: 10, endTimeSec: 12, text: 'Hello world' }, { timeSec: 12, text: 'Next line' }]
  expect(knownTextLineWindow(lines, 0, 20)).toEqual({ startSec: 10, endSec: 12 })
  expect(knownTextLineWindow([{ timeSec: 1, text: 'too long' }, { timeSec: 14, text: 'next' }], 0, 20)).toBeNull()
  expect(knownTextLineWindow([{ timeSec: 1, text: 'same' }, { timeSec: 1, text: 'start' }], 0, 20)).toBeNull()

  const source: CachedAlignedSourceLine = {
    sourceLyricKey: 'source-a', lineIndex: 0, sourceText: 'Hello world', sourceStartSec: 10, sourceEndSec: 12,
    confidence: 0.8, words: [
      { text: 'Hello', startSec: 10.2, endSec: 10.7 },
      { text: 'world', startSec: 11, endSec: 11.7 },
    ],
  }
  expect(matchCachedKnownText(lines, [source], 'source-a', 20)).toHaveLength(1)
  expect(matchCachedKnownText([{ ...lines[0], text: 'Changed words' }, lines[1]], [source], 'source-a', 20)).toEqual([])
  expect(matchCachedKnownText([{ ...lines[0], words: [{ text: 'Hello', timeSec: 10.2, endTimeSec: 10.7 }] }, lines[1]], [source], 'source-a', 20)).toEqual([])
})

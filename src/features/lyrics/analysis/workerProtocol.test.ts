import { expect, it } from 'vitest'
import { artifactMap, absoluteWords } from './workerProtocol'
import { LYRIC_MODEL_ID, LYRIC_MODEL_REVISION } from './contract'
it('maps only a complete current pinned bundle to exact local keys', () => {
  expect(() => artifactMap({ modelId: LYRIC_MODEL_ID, revision: 'other', files: [] }, {})).toThrow()
  expect(() => artifactMap({ modelId: LYRIC_MODEL_ID, revision: LYRIC_MODEL_REVISION, files: [] }, {})).toThrow()
})
it('converts genuine finite word times once and rejects null, out of window and unordered times', () => {
  expect(absoluteWords([{ text: 'River', timestamp: [0.2, 0.8] }], 12, 3)).toEqual([{ text: 'River', startSec: 12.2, endSec: 12.8 }])
  for (const chunks of [[{ text: 'a', timestamp: [0, null] }], [{ text: 'a', timestamp: [0, 4] }],
    [{ text: 'a', timestamp: [1, 2] }, { text: 'b', timestamp: [0.1, 0.3] }]]) expect(absoluteWords(chunks, 12, 3)).toEqual([])
})

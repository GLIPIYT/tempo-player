import { describe, expect, it } from 'vitest'
import { VOCAL_ALGORITHM_VERSION, VOCAL_MODEL_REVISION, type VocalTimingEvidence } from './analysis/vocalContract'
import { vocalPhraseEnd, refineEstimatedWords } from './vocalTiming'
import { resolveLyricTiming } from './timingResolver'
import { estimateLyricWords } from './wordEstimate'

function evidence(voice: (time: number) => number, offsetMs = 0): VocalTimingEvidence {
  return { offsetMs, analysis: { fingerprint: 'test', durationSec: 20, hopSec: .02,
    modelRevision: VOCAL_MODEL_REVISION, algorithmVersion: VOCAL_ALGORITHM_VERSION,
    chunks: [{ startSec: 0, endSec: 20, voice: Array.from({ length: 1000 }, (_, index) => Math.round(voice(index * .02) * 255)),
      energy: Array(1000).fill(180), flux: Array(1000).fill(30) }] } }
}

describe('vocal evidence timing', () => {
  it('finds a sustained vocal exit near the text estimate, preserving a natural pause', () => {
    const vocal = evidence(time => time >= 1 && time < 3 ? .95 : .05)
    expect(vocalPhraseEnd(vocal, 1, 3.2, 7, 1)).toBeCloseTo(3, 1)
    const result = resolveLyricTiming([{ timeSec: 1, text: 'Stay here' }, { timeSec: 7, text: 'Next line' }], 20,
      { bpm: null, matchedEnds: [], vocal })
    expect(result.lines[0].endSource).toBe('vocal')
    expect(result.lines[0].endTimeSec).toBeCloseTo(3, 1)
    expect(result.segments.some(segment => segment.kind === 'notes' && segment.timeSec < 3.1 && segment.endTimeSec === 7)).toBe(true)
  })

  it('projects positive and negative lyric offsets exactly once without changing cached media times', () => {
    for (const offset of [-.5, .5]) {
      const vocal = evidence(time => time >= 1 && time < 3 ? .95 : .05, offset * 1000)
      expect(vocalPhraseEnd(vocal, 1 + offset, 3.2 + offset, 7 + offset, 1 + offset)).toBeCloseTo(3 + offset, 1)
      expect(vocal.analysis.chunks[0].startSec).toBe(0)
      expect(vocal.analysis.chunks[0].endSec).toBe(20)
    }
  })

  it('ignores short dips, legato and unknown cache coverage instead of inventing silence', () => {
    expect(vocalPhraseEnd(evidence(() => .9), 1, 3.2, 7, 1)).toBeNull()
    expect(vocalPhraseEnd(evidence(time => time > 3 && time < 3.12 ? .05 : .9), 1, 3.2, 7, 1)).toBeNull()
    const partial = evidence(time => time < 3 ? .95 : .05)
    partial.analysis.chunks[0].endSec = 2.8
    expect(vocalPhraseEnd(partial, 1, 3.2, 7, 1)).toBeNull()
  })

  it('cannot move manual, enhanced-LRC or recognized ends and words', () => {
    const vocal = evidence(time => time < 3 ? .95 : .05)
    const lines = [{ timeSec: 1, text: 'Stay here', endTimeSec: 4, endSource: 'manual' as const,
      words: [{ text: 'Stay', timeSec: 1, endTimeSec: 2 }, { text: 'here', timeSec: 2, endTimeSec: 4 }] }]
    for (const endSource of ['manual', 'source'] as const) {
      const result = resolveLyricTiming([{ ...lines[0], endSource }], 10, { bpm: null, matchedEnds: [], vocal })
      expect(result.lines[0].endTimeSec).toBe(4)
      expect(result.lines[0].wordTimings?.map(cue => cue?.timeSec)).toEqual([1, 2])
      expect(result.lines[0].wordTimings?.every(cue => cue?.source === 'source')).toBe(true)
    }
    const recognized = resolveLyricTiming([{ timeSec: 1, text: 'Stay here' }], 10, {
      bpm: null, matchedEnds: [{ lineIndex: 0, endTimeSec: 4, confidence: .95 }], vocal,
    })
    expect(recognized.lines[0]).toMatchObject({ endTimeSec: 4, endSource: 'recognized' })
  })

  it('softly redistributes estimated words toward vocal time with bounded monotone boundaries', () => {
    const source = estimateLyricWords('Снова не домой, только не домой', 1, 5)
    const vocal = evidence(time => time > 2.1 && time < 2.7 ? .05 : .95)
    const shifted = refineEstimatedWords(source, vocal)
    expect(shifted).not.toEqual(source)
    expect(shifted[0]?.timeSec).toBe(1)
    expect(shifted.at(-1)?.endTimeSec).toBe(5)
    shifted.forEach((cue, index) => {
      expect(cue?.source).toBe('estimated')
      expect(cue!.endTimeSec).toBeGreaterThan(cue!.timeSec)
      expect(Math.abs(cue!.timeSec - source[index]!.timeSec)).toBeLessThanOrEqual(.251)
      if (index) expect(cue?.timeSec).toBe(shifted[index - 1]?.endTimeSec)
    })
  })

  it('leaves exact cues and missing/instrumental evidence unchanged', () => {
    const source = estimateLyricWords('Stay here with me', 1, 5)
    const exact = source.map(cue => cue ? { ...cue, source: 'source' as const } : null)
    expect(refineEstimatedWords(exact, evidence(() => .9))).toEqual(exact)
    expect(refineEstimatedWords(source, evidence(() => .05))).toEqual(source)
    const partial = evidence(() => .9); partial.analysis.chunks = []
    expect(refineEstimatedWords(source, partial)).toEqual(source)
  })

  it('uses the same word adjustments across chunk boundaries and lyric offsets', () => {
    const voice = (time: number) => time > 2.1 && time < 2.7 ? .05 : .95
    const source = estimateLyricWords('Stay here with me', 1, 5)
    const full = evidence(voice)
    const expected = refineEstimatedWords(source, full)
    const split = evidence(voice), chunk = split.analysis.chunks[0]
    split.analysis.chunks = [
      { startSec: 0, endSec: 3, voice: chunk.voice.slice(0, 150), energy: chunk.energy.slice(0, 150), flux: chunk.flux.slice(0, 150) },
      { startSec: 3, endSec: 20, voice: chunk.voice.slice(150), energy: chunk.energy.slice(150), flux: chunk.flux.slice(150) },
    ]
    expect(refineEstimatedWords(source, split)).toEqual(expected)
    for (const offset of [-.5, .5]) {
      const shifted = refineEstimatedWords(estimateLyricWords('Stay here with me', 1 + offset, 5 + offset), evidence(voice, offset * 1000))
      shifted.forEach((cue, index) => expect(cue!.timeSec - offset).toBeCloseTo(expected[index]!.timeSec, 5))
    }
  })

  it('keeps known repeat word patterns above approximate audio cues', () => {
    const lines = [
      { timeSec: 1, endTimeSec: 5, text: 'Stay here with me', words: [
        { text: 'Stay', timeSec: 1, endTimeSec: 1.5 }, { text: 'here', timeSec: 1.5, endTimeSec: 2 },
        { text: 'with', timeSec: 2, endTimeSec: 3 }, { text: 'me', timeSec: 3, endTimeSec: 5 },
      ] }, { timeSec: 10, endTimeSec: 14, text: 'Stay here with me' },
    ]
    const result = resolveLyricTiming(lines, 20, { bpm: null, matchedEnds: [], vocal: evidence(time => time < 12 ? .95 : .05) })
    expect(result.lines[1].wordTimings?.map(cue => cue?.timeSec)).toEqual([10, 10.5, 11, 12])
  })
})

import { describe, expect, it } from 'vitest'
import { parseLrc, shiftLyricsLines } from './lrc'
import { mapLyricWordTimings } from './wordTiming'
import { resolveLyricTiming } from './timingResolver'
import { createPlaybackTiming } from './playbackTiming'
import { lyricTimeAtMediaPosition } from './lyricsRate'
import { wordFillState } from './wordFill'

describe('actual lyric word cues', () => {
  it('maps syllable fragments and punctuation onto displayed words without inventing onsets', () => {
    const lines = parseLrc('[00:01]<00:01>За<00:01.30>помни, <00:02.70>ещё!<00:03.50>')!
    const timing = resolveLyricTiming(lines, 8)
    expect(timing.segments.find(segment => segment.kind === 'line')?.wordTimings).toEqual([
      { timeSec: 1, endTimeSec: 2.7, source: 'source' },
      { timeSec: 2.7, endTimeSec: 3.5, source: 'source' },
    ])
  })

  it('uses a last known word onset with an inferred end and keeps a real gap unhighlighted', () => {
    const mapped = mapLyricWordTimings('Stay here', [
      { text: 'Stay', timeSec: 1, endTimeSec: 1.4 },
      { text: 'here', timeSec: 2.8 },
    ], 1, 4, 'source')!
    expect(mapped[1]).toEqual({ timeSec: 2.8, endTimeSec: 4, source: 'source' })
    expect(wordFillState(0, 1, .5, .9, mapped[0])).toBe(0)
    expect(wordFillState(0, 1, .5, 1.2, mapped[0])).toBe(2)
    expect(wordFillState(0, 1, .5, 2, mapped[0])).toBe(1)
    expect(wordFillState(1, 1, .5, 2, mapped[1])).toBe(0)
    expect(wordFillState(1, 0, .1, 2.9, mapped[1])).toBe(2)
    expect(wordFillState(1, 1, 1, 4, mapped[1])).toBe(1)
  })

  it('rejects partial, mismatched, multiword or temporally invalid fragments', () => {
    const map = (words: Parameters<typeof mapLyricWordTimings>[1]) => mapLyricWordTimings('one two', words, 1, 4, 'source')
    expect(map([{ text: 'two', timeSec: 2, endTimeSec: 3 }])).toBeUndefined()
    expect(map([{ text: 'one two', timeSec: 1, endTimeSec: 3 }])).toBeUndefined()
    for (const invalid of [NaN, Infinity, .5, 4]) {
      expect(map([{ text: 'one', timeSec: invalid, endTimeSec: 2 }, { text: 'two', timeSec: 2, endTimeSec: 3 }])).toBeUndefined()
    }
    expect(map([{ text: 'one', timeSec: 2, endTimeSec: 3 }, { text: 'two', timeSec: 1, endTimeSec: 2 }])).toBeUndefined()
    expect(map([{ text: 'one', timeSec: 1, endTimeSec: 2.5 }, { text: 'two', timeSec: 2, endTimeSec: 3 }])).toBeUndefined()
    expect(map([{ text: 'ONE,', timeSec: 1, endTimeSec: 2 }, { text: 'two!', timeSec: 2, endTimeSec: 5 }])?.[1]?.endTimeSec).toBe(4)
  })

  it('handles punctuation-only tokens without changing the displayed token indices', () => {
    const map = mapLyricWordTimings('Я — человек', [
      { text: 'я', timeSec: 1, endTimeSec: 1.4 }, { text: 'человек', timeSec: 2, endTimeSec: 3 },
    ], 1, 4, 'analysis')!
    expect(map).toHaveLength(3)
    expect(map[1]).toBeNull()
    expect(map[2]?.timeSec).toBe(2)
  })

  it('keeps simultaneous lines independent and source cues ahead of ASR', () => {
    const lines = parseLrc('[00:01]<00:01>first <00:02>voice<00:03>\n[00:01]second voice\n[00:05]next')!
    const timing = resolveLyricTiming(lines, 8, { bpm: null, matchedEnds: [], matchedWords: [
      { lineIndex: 0, confidence: .99, words: [{ text: 'first', timeSec: 1.5, endTimeSec: 2 }, { text: 'voice', timeSec: 2, endTimeSec: 3 }] },
      { lineIndex: 1, confidence: .99, words: [{ text: 'second', timeSec: 1.3, endTimeSec: 2.5 }, { text: 'voice', timeSec: 2.6, endTimeSec: 4 }] },
    ] })
    const segment = timing.segments.find(segment => segment.kind === 'line')!
    expect(segment.wordTimings).toEqual([
      { timeSec: 1, endTimeSec: 2, source: 'source' }, { timeSec: 2, endTimeSec: 3, source: 'source' },
      { timeSec: 1.3, endTimeSec: 2.5, source: 'analysis' }, { timeSec: 2.6, endTimeSec: 4, source: 'analysis' },
    ])
    expect(wordFillState(0, 0, .1, 1.4, segment.wordTimings?.[0])).toBe(2)
    expect(wordFillState(2, 0, .1, 1.4, segment.wordTimings?.[2])).toBe(2)
  })

  it('rejects low confidence ASR or words outside manual phrase boundaries', () => {
    const words = [{ text: 'one', timeSec: 1, endTimeSec: 2 }, { text: 'two', timeSec: 3, endTimeSec: 4 }]
    const source = [{ timeSec: 1, text: 'one two', endTimeSec: 2.5, endSource: 'manual' as const }]
    expect(resolveLyricTiming(source, 8, { bpm: null, matchedEnds: [], matchedWords: [{ lineIndex: 0, words, confidence: 1 }] }).lines[0].wordTimings?.every(cue => cue?.source === 'estimated')).toBe(true)
    expect(resolveLyricTiming([{ timeSec: 1, text: 'one two' }], 8, {
      bpm: null, matchedEnds: [], matchedWords: [{ lineIndex: 0, words, confidence: .7 }],
    }).lines[0].wordTimings?.every(cue => cue?.source === 'estimated')).toBe(true)
  })

  it('does not let a cached ASR ending cut off a newly matched complete word', () => {
    const timing = resolveLyricTiming([{ timeSec: 1, text: 'one two' }], 8, {
      bpm: null, matchedEnds: [{ lineIndex: 0, endTimeSec: 2, confidence: 1 }],
      matchedWords: [{ lineIndex: 0, confidence: 1, words: [
        { text: 'one', timeSec: 1.2, endTimeSec: 1.8 }, { text: 'two', timeSec: 3, endTimeSec: 4 },
      ] }],
    })
    expect(timing.lines[0].endTimeSec).toBe(4)
    expect(timing.lines[0].wordTimings?.[1]?.endTimeSec).toBe(4)
  })

  it('applies source offsets once, preserves backward seeks and uses the lyric-speed clock', () => {
    const source = parseLrc('[00:01]<00:01>one <00:02.50>two<00:04>')!
    const timing = resolveLyricTiming(shiftLyricsLines(source, 500), 8)
    const words = timing.segments.find(segment => segment.kind === 'line')!.wordTimings!
    expect(words[0]?.timeSec).toBe(1.5)
    expect(words[1]?.timeSec).toBe(3)
    expect(wordFillState(1, 0, .1, lyricTimeAtMediaPosition(1.8, 2, 500), words[1])).toBe(2)
    expect(wordFillState(1, 1, .8, 2.5, words[1])).toBe(0)
    const negative = resolveLyricTiming(shiftLyricsLines(source, -500), 8)
    expect(negative.segments.find(segment => segment.kind === 'line')?.wordTimings?.[0]?.timeSec).toBe(.5)
  })

  it('latches already begun word cues, refines future cues and adopts changes on replay', () => {
    const lines = [{ timeSec: 1, text: 'one two', endTimeSec: 4 }, { timeSec: 5, text: 'three four', endTimeSec: 8 }]
    const before = resolveLyricTiming(lines, 10)
    const analyzed = resolveLyricTiming(lines, 10, { bpm: null, matchedEnds: [], matchedWords: [
      { lineIndex: 0, confidence: 1, words: [{ text: 'one', timeSec: 1, endTimeSec: 2 }, { text: 'two', timeSec: 2.5, endTimeSec: 4 }] },
      { lineIndex: 1, confidence: 1, words: [{ text: 'three', timeSec: 5, endTimeSec: 6 }, { text: 'four', timeSec: 7, endTimeSec: 8 }] },
    ] })
    const pass = createPlaybackTiming()
    pass.update(before, 2)
    const late = pass.update(analyzed, 2.1)
    expect(late.segments.find(segment => segment.timeSec === 1)?.wordTimings).toEqual(before.segments.find(segment => segment.timeSec === 1)?.wordTimings)
    expect(late.segments.find(segment => segment.timeSec === 5)?.wordTimings?.[1]?.timeSec).toBe(7)
    const replay = pass.update(analyzed, 1.1)
    expect(replay.segments.find(segment => segment.timeSec === 1)?.wordTimings?.[1]?.timeSec).toBe(2.5)
    const shorter = pass.update(analyzed, 1.2, 3)
    expect(shorter.segments.find(segment => segment.timeSec === 1)?.wordTimings?.[1]?.endTimeSec).toBe(3)
  })
})

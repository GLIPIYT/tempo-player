import { describe, expect, it } from 'vitest'
import { lyricTimingAt, lyricAnchorIndex, resolveLyricTiming } from './timingResolver'
import type { LyricsLine } from './types'
import { parseLrc } from './lrc'

describe('resolveLyricTiming', () => {
  it('keeps a phrase active when its final source word starts late without an exact end', () => {
    const lines = parseLrc('[00:01]<00:01>Stay <00:09>here\n[00:20]next')!
    const timing = resolveLyricTiming(lines, 30)
    expect(lines[0].endTimeSec).toBeUndefined()
    expect(timing.lines[0].endSource).toBe('text')
    expect(timing.lines[0].endTimeSec).toBeGreaterThan(9)
    expect(timing.lines[0].endTimeSec).toBeLessThanOrEqual(20)
    expect(lyricTimingAt(timing, 9).lineIndices).toEqual([0])
  })

  it('rejects an ASR ending before a known source word and keeps manual priority and interval bounds', () => {
    const line: LyricsLine = { timeSec: 1, text: 'Stay here', words: [
      { text: 'Stay ', timeSec: 1, endTimeSec: 9 }, { text: 'here', timeSec: 9, endTimeSec: null },
    ] }
    const analysis = { bpm: null, matchedEnds: [{ lineIndex: 0, endTimeSec: 3, confidence: 0.95 }] }
    expect(resolveLyricTiming([line, { timeSec: 20, text: 'next' }], 30, analysis).lines[0].endTimeSec).toBeGreaterThan(9)
    expect(resolveLyricTiming([{ ...line, endTimeSec: 3, endSource: 'manual' }], 30, analysis).lines[0].endTimeSec).toBe(3)
    expect(resolveLyricTiming([line, { timeSec: 8, text: 'next' }], 30, analysis).lines[0].endTimeSec).toBeLessThanOrEqual(8)
    expect(resolveLyricTiming([line], 8, analysis).lines[0].endTimeSec).toBeLessThanOrEqual(8)
    const validShortEnd = { bpm: null, matchedEnds: [{ lineIndex: 0, endTimeSec: 9.1, confidence: 0.95 }] }
    const recognized = resolveLyricTiming([line], 30, validShortEnd).lines[0]
    expect(recognized.endSource).toBe('recognized')
    expect(recognized.endTimeSec).toBe(9.1)
  })

  it('ends a short phrase before a long instrumental break', () => {
    const timing = resolveLyricTiming([{ timeSec: 10, text: 'Stay here' }, { timeSec: 50, text: 'Come home' }], 60)
    expect(timing.lines[0].endTimeSec).toBeLessThan(20)
    expect(timing.segments.some((s) => s.kind === 'notes' && s.timeSec < 20 && s.endTimeSec === 50)).toBe(true)
    expect(lyricTimingAt(timing, 35).lineIndices).toEqual([])
  })

  it('gives a long phrase enough time in a six second interval', () => {
    const timing = resolveLyricTiming([
      { timeSec: 10, text: 'Every single word we sing will carry all our dreams back home' },
      { timeSec: 16, text: 'Home' },
    ], 30)
    expect(timing.lines[0].endTimeSec).toBeGreaterThanOrEqual(15)
    expect(timing.lines[0].endTimeSec).toBeLessThanOrEqual(16)
  })

  it('does not stretch dense rap starts over the next line', () => {
    const timing = resolveLyricTiming([
      { timeSec: 1, text: 'many words arrive here quickly' },
      { timeSec: 1.25, text: 'the next phrase' },
      { timeSec: 1.5, text: 'again' },
    ], 10)
    expect(timing.lines[0].endTimeSec).toBe(1.25)
    expect(lyricTimingAt(timing, 1.3).lineIndices).toEqual([1])
  })

  it('groups duplicate starts without dropping any words', () => {
    const timing = resolveLyricTiming([
      { timeSec: 4, text: 'first voice' }, { timeSec: 4, text: 'second voice' }, { timeSec: 8, text: 'next' },
    ], 20)
    expect(timing.lines).toHaveLength(3)
    expect(timing.lines[0].endTimeSec).toBe(timing.lines[1].endTimeSec)
    expect(timing.lines[0].endTimeSec).toBeGreaterThan(4)
    expect(timing.segments.find((s) => s.kind === 'line')?.text).toBe('first voice\nsecond voice')
    expect(lyricTimingAt(timing, 4.1).lineIndices).toEqual([0, 1])
  })

  it('merges explicit adjacent blank markers into an instrumental segment', () => {
    const timing = resolveLyricTiming([
      { timeSec: 1, text: 'sing' }, { timeSec: 3, text: '', explicitPause: true },
      { timeSec: 5, text: '', explicitPause: true }, { timeSec: 8, text: 'again' },
    ], 12)
    const notes = timing.segments.filter((s) => s.kind === 'notes' && s.timeSec <= 3 && s.endTimeSec === 8)
    expect(notes).toHaveLength(1)
    expect(notes[0].seekToSec).toBe(8)
    expect(lyricTimingAt(timing, 6).lineIndices).toEqual([])
  })

  it('clears the underline after a phrase while preserving the displayed line through a small gap', () => {
    const timing = resolveLyricTiming([
      { timeSec: 0, text: 'one', endTimeSec: 2.5, endSource: 'source' },
      { timeSec: 2.9, text: 'two', endTimeSec: 5, endSource: 'source' },
    ], 10)
    const beforePhraseEnd = lyricTimingAt(timing, 2.49)
    const displayedGap = lyricTimingAt(timing, 2.75)

    expect(beforePhraseEnd.underlineProgress).toBeCloseTo(beforePhraseEnd.progress)
    expect(displayedGap.lineIndices).toEqual([0])
    expect(displayedGap.progress).toBe(1)
    expect(displayedGap.underlineProgress).toBe(0)
  })

  it('keeps short inferred pauses compact and leaves authored pauses full height', () => {
    const inferred = resolveLyricTiming([
      { timeSec: 0, text: 'one', endTimeSec: 2.2, endSource: 'source' },
      { timeSec: 3, text: 'two', endTimeSec: 5.2, endSource: 'source' },
      { timeSec: 6, text: 'three', endTimeSec: 8.2, endSource: 'source' },
      { timeSec: 9, text: 'four', endTimeSec: 11.2, endSource: 'source' },
      { timeSec: 12, text: 'five', endTimeSec: 14.2, endSource: 'source' },
      { timeSec: 15, text: 'six', endTimeSec: 17, endSource: 'source' },
    ], 18)
    const inferredPauses = inferred.segments.filter(segment => segment.kind === 'notes'
      && segment.timeSec < 15 && segment.endTimeSec <= 15)
    expect(inferredPauses).toHaveLength(5)
    expect(inferredPauses.every(segment => segment.skipPool)).toBe(true)

    const authored = resolveLyricTiming([
      { timeSec: 0, text: 'one', endTimeSec: 0.8, endSource: 'source' },
      { timeSec: 1, text: '', explicitPause: true },
      { timeSec: 3, text: 'two', endTimeSec: 3.8, endSource: 'source' },
      { timeSec: 4, text: '', explicitPause: true },
      { timeSec: 6, text: 'three', endTimeSec: 6.8, endSource: 'source' },
      { timeSec: 7, text: '', explicitPause: true },
      { timeSec: 9, text: 'four', endTimeSec: 9.8, endSource: 'source' },
      { timeSec: 10, text: '', explicitPause: true },
      { timeSec: 12, text: 'five', endTimeSec: 12.8, endSource: 'source' },
      { timeSec: 13, text: '', explicitPause: true },
      { timeSec: 15, text: 'six', endTimeSec: 17, endSource: 'source' },
    ], 18)
    const authoredPauses = authored.segments.filter(segment => segment.kind === 'notes'
      && segment.timeSec >= 0.8 && segment.timeSec < 15)
    expect(authoredPauses).toHaveLength(5)
    expect(authoredPauses.every(segment => segment.explicitPause && !segment.skipPool)).toBe(true)
  })

  it('ends the last phrase and treats the remaining file as instrumental', () => {
    const timing = resolveLyricTiming([{ timeSec: 5, text: 'Good night' }], 40)
    expect(timing.lines[0].endTimeSec).toBeLessThan(15)
    expect(lyricTimingAt(timing, timing.lines[0].endTimeSec).lineIndices).toEqual([])
    expect(lyricTimingAt(timing, 40).segmentIndex).toBe(-1)
  })

  it('respects manual, source, recognized, then text priority', () => {
    const lines: LyricsLine[] = [
      { timeSec: 0, text: 'one', endTimeSec: 2, endSource: 'manual' },
      { timeSec: 5, text: 'two', endTimeSec: 7, endSource: 'source' },
      { timeSec: 10, text: 'three' }, { timeSec: 15, text: 'four' },
    ]
    const timing = resolveLyricTiming(lines, 30, { bpm: null, matchedEnds: [
      { lineIndex: 0, endTimeSec: 3, confidence: 0.95 },
      { lineIndex: 1, endTimeSec: 8, confidence: 0.95 },
      { lineIndex: 2, endTimeSec: 12, confidence: 0.95 },
    ] })
    expect(timing.lines.map((l) => l.endSource)).toEqual(['manual', 'source', 'recognized', 'text'])
    expect(timing.lines.slice(0, 3).map((l) => l.endTimeSec)).toEqual([2, 7, 12])
  })

  it('uses the final word end as source data, without treating an unknown word end as exact', () => {
    const timing = resolveLyricTiming([
      { timeSec: 1, text: 'one', endTimeSec: Number.NaN, endSource: 'manual', words: [{ text: 'one', timeSec: 1, endTimeSec: 2 }] },
      { timeSec: 5, text: 'two', words: [{ text: 'two', timeSec: 5, endTimeSec: null }] },
    ], 20)
    expect(timing.lines[0].endSource).toBe('source')
    expect(timing.lines[0].endTimeSec).toBe(2)
    expect(timing.lines[1].endSource).toBe('text')
  })

  it('does not insert notes and keeps the previous phrase visible across an insignificant gap', () => {
    const timing = resolveLyricTiming([
      { timeSec: 0, text: 'one', endTimeSec: 4.7, endSource: 'source' },
      { timeSec: 5, text: 'two', endTimeSec: 10, endSource: 'source' },
    ], 10)
    expect(timing.segments.filter((s) => s.kind === 'notes')).toEqual([])
    expect(lyricTimingAt(timing, 4.8).lineIndices).toEqual([0])
  })

  it('shows a compact pause after a precise phrase with a 0.6 second gap, even for a long line', () => {
    const timing = resolveLyricTiming([
      { timeSec: 0, text: 'a long line', endTimeSec: 9.4, endSource: 'source' },
      { timeSec: 10, text: 'next line' },
    ], 20)
    const pause = timing.segments.find(segment => segment.kind === 'notes' && segment.timeSec === 9.4)
    expect(pause).toMatchObject({ endTimeSec: 10, skipPool: true })
    const pauseIndex = lyricTimingAt(timing, 9.6).segmentIndex
    expect(timing.segments[pauseIndex]?.kind).toBe('notes')
    expect(lyricAnchorIndex(timing.segments, pauseIndex)).toBe(pauseIndex - 1)
  })

  it('shows a compact short pause when a confident vocal analysis provides the endpoint', () => {
    const timing = resolveLyricTiming([
      { timeSec: 0, text: 'first line' }, { timeSec: 5, text: 'next line' },
    ], 10, { bpm: null, matchedEnds: [{ lineIndex: 0, endTimeSec: 4.4, confidence: 0.95 }] })
    expect(timing.segments.find(segment => segment.kind === 'notes' && segment.timeSec === 4.4))
      .toMatchObject({ endTimeSec: 5, skipPool: true })
  })

  it('shows a compact pause for a clearly inferred break in start-only lyrics', () => {
    const timing = resolveLyricTiming([
      { timeSec: 0, text: 'one' }, { timeSec: 4.5, text: 'a rather longer following lyric' },
    ], 10)
    const phrase = timing.lines[0]
    expect(phrase.endSource).toBe('text')
    expect(4.5 - phrase.endTimeSec).toBeGreaterThanOrEqual(0.75)
    expect(timing.segments.find(segment => segment.kind === 'notes' && segment.timeSec === phrase.endTimeSec))
      .toMatchObject({ endTimeSec: 4.5, skipPool: true })
  })

  it('retains a manual overlap while the next started group wins display', () => {
    const timing = resolveLyricTiming([
      { timeSec: 1, text: 'first', endTimeSec: 10, endSource: 'manual' }, { timeSec: 5, text: 'second' },
    ], 20)
    expect(timing.lines[0].endTimeSec).toBe(10)
    expect(timing.segments.find((s) => s.kind === 'line')?.endTimeSec).toBe(5)
    expect(lyricTimingAt(timing, 5).lineIndices).toEqual([1])
  })

  it('ignores low confidence ASR and ambiguous BPM', () => {
    const lines = [{ timeSec: 1, text: 'Stay here' }, { timeSec: 20, text: 'Come home' }]
    const base = resolveLyricTiming(lines, 40)
    const uncertain = resolveLyricTiming(lines, 40, { bpm: { value: 180, confidence: 0.4 }, matchedEnds: [
      { lineIndex: 0, endTimeSec: 18, confidence: 0.4 },
    ] })
    expect(uncertain).toEqual(base)
  })

  it('uses stable similar neighbors for calibration and excludes a long break', () => {
    const timing = resolveLyricTiming([
      { timeSec: 0, text: 'we come home' }, { timeSec: 3, text: 'we go far' },
      { timeSec: 6, text: 'we sing loud' }, { timeSec: 9, text: 'we stay here' },
      { timeSec: 49, text: 'we come back' },
    ], 60)
    expect(timing.lines[3].endTimeSec - 9).toBeGreaterThan(2)
    expect(timing.lines[3].endTimeSec - 9).toBeLessThan(5)
  })

  it('falls back safely for other scripts and malformed numeric values', () => {
    const timing = resolveLyricTiming([
      { timeSec: Number.NaN, text: 'bad' }, { timeSec: 2, text: '你好世界', endTimeSec: Number.POSITIVE_INFINITY },
      { timeSec: 6, text: 'next' },
    ], Number.NaN, { bpm: { value: Number.NaN, confidence: 1 }, matchedEnds: [
      { lineIndex: 1, endTimeSec: Number.NaN, confidence: 1 },
    ] })
    expect(timing.lines).toHaveLength(2)
    expect(timing.lines.every((l) => Number.isFinite(l.endTimeSec) && l.endTimeSec > l.timeSec)).toBe(true)
    for (const pos of [0, 2, 5, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Number.isFinite(lyricTimingAt(timing, pos).progress)).toBe(true)
    }
  })
})

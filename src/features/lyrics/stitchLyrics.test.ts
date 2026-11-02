import { describe, expect, it } from 'vitest'
import { stitchLyrics } from './stitchLyrics'
import type { SyncedLyricsDocument } from './editorDocument'

describe('stitchLyrics', () => {
  it('ignores formatting blanks in plain lyrics when the timed source has no pauses', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'first', startMs: 1000, endMs: null },
      { text: 'second', startMs: 3000, endMs: null },
      { text: 'third', startMs: 5000, endMs: null },
    ] }

    const result = stitchLyrics(timed, '\r\none\r\n  \r\ntwo\r\nthree\r\n')

    expect(result.lines.map(({ text, startMs }) => [text, startMs])).toEqual([
      ['one', 1000], ['two', 3000], ['three', 5000],
    ])
    expect(result.lines.every((line) => !line.explicitPause)).toBe(true)
  })

  it('uses only source pause positions even when plain verse breaks are elsewhere', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'first', startMs: 0, endMs: null },
      { text: 'second', startMs: 2000, endMs: null },
      { text: '', startMs: 4000, endMs: null, explicitPause: true },
      { text: 'third', startMs: 6000, endMs: null },
    ] }

    const result = stitchLyrics(timed, 'one\n\ntwo\nthree\n\n')

    expect(result.lines.map(({ text, startMs, explicitPause }) => [text, startMs, explicitPause === true])).toEqual([
      ['one', 0, false], ['two', 2000, false], ['', 4000, true], ['three', 6000, false],
    ])
  })

  it('does not assign text to non-pause empty timecodes from external LRC', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'first', startMs: 1000, endMs: null },
      { text: '', startMs: 3000, endMs: null },
      { text: 'second', startMs: 7000, endMs: null },
    ] }

    const result = stitchLyrics(timed, 'one\n\ntwo')

    expect(result.lines.map(({ text, startMs }) => [text, startMs])).toEqual([
      ['one', 1000], ['two', 7000],
    ])
  })

  it('replaces text positionally and drops word timings without mutating the source', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'old first', startMs: 1000, endMs: 2400, endOrigin: 'source', words: [
        { text: 'old ', startMs: 1000, endMs: 1500 }, { text: 'first', startMs: 1500, endMs: 2400 },
      ] },
      { text: '', startMs: 5000, endMs: null, explicitPause: true },
      { text: 'old last', startMs: 7000, endMs: 9000, endOrigin: 'manual', words: [
        { text: 'old last', startMs: 7000, endMs: 9000 },
      ] },
    ] }

    const result = stitchLyrics(timed, 'new first\n\nnew last')

    expect(result).toEqual({ mode: 'synced', lines: [
      { text: 'new first', startMs: 1000, endMs: 2400, endOrigin: 'source' },
      { text: '', startMs: 5000, endMs: null, explicitPause: true },
      { text: 'new last', startMs: 7000, endMs: 9000, endOrigin: 'manual' },
    ] })
    expect(timed.lines[0]?.words).toHaveLength(2)
  })

  it('splits a known timing window by the new line lengths and keeps only its authored final end', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'old phrase', startMs: 0, endMs: 10_000, endOrigin: 'source', words: [
        { text: 'old phrase', startMs: 0, endMs: 10_000 },
      ] },
    ] }

    const result = stitchLyrics(timed, 'abcdef\nab\ncdefgh', 10_000)

    expect(result.lines.map(({ text, startMs }) => [text, startMs])).toEqual([
      ['abcdef', 0], ['ab', 4286], ['cdefgh', 5714],
    ])
    expect(result.lines.map((line) => line.endMs)).toEqual([null, null, 10_000])
    expect(result.lines[2]?.endOrigin).toBe('source')
    expect(result.lines.every((line) => line.words === undefined)).toBe(true)
  })

  it('splits intervals without filling an explicit gap between source rows', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'first source', startMs: 0, endMs: 2000, endOrigin: 'manual' },
      { text: 'second source', startMs: 5000, endMs: 7000, endOrigin: 'source' },
    ] }

    const result = stitchLyrics(timed, 'first\nsecond\nthird\nfourth')

    expect(result.lines.map((line) => line.startMs)).toEqual([0, 909, 5000, 5909])
    expect(result.lines[1]).toMatchObject({ text: 'second', endMs: 2000, endOrigin: 'manual' })
    expect(result.lines[2]).toMatchObject({ text: 'third', startMs: 5000 })
    expect(result.lines[3]).toMatchObject({ text: 'fourth', endMs: 7000, endOrigin: 'source' })
    expect(result.lines[1]!.endMs!).toBeLessThan(result.lines[2]!.startMs)
  })

  it('maps fewer text rows monotonically across the source timeline and retains mapped ends', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'source one', startMs: 0, endMs: 900, endOrigin: 'source' },
      { text: 'source two', startMs: 1000, endMs: 1900, endOrigin: 'source' },
      { text: 'source three', startMs: 9000, endMs: 10_000, endOrigin: 'manual' },
    ] }

    const result = stitchLyrics(timed, 'short\na substantially longer line', 10_000)

    expect(result.lines.map((line) => line.text)).toEqual(['short', 'a substantially longer line'])
    expect(result.lines.map((line) => line.startMs)).toEqual([0, 9000])
    expect(result.lines.map((line) => line.endMs)).toEqual([900, 10_000])
    expect(result.lines.every((line, index, lines) => index === 0 || line.startMs >= lines[index - 1]!.startMs)).toBe(true)
  })

  it('does not use a long track duration as the lyric window when reducing text rows', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'source one', startMs: 0, endMs: null },
      { text: 'source two', startMs: 3000, endMs: null },
      { text: 'source three', startMs: 6000, endMs: null },
      { text: 'source four', startMs: 9000, endMs: null },
    ] }

    const result = stitchLyrics(timed, 'one\ntwo\nthree', 600_000)

    expect(result.lines.map((line) => line.startMs)).toEqual([0, 3000, 9000])
    expect(result.lines.map((line) => line.text)).toEqual(['one', 'two', 'three'])
  })

  it('preserves timed pauses when fewer replacement rows are supplied', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'source one', startMs: 0, endMs: 2000, endOrigin: 'source' },
      { text: '', startMs: 3000, endMs: 4000, endOrigin: 'manual', explicitPause: true },
      { text: 'source two', startMs: 5000, endMs: 7000, endOrigin: 'source' },
    ] }

    const result = stitchLyrics(timed, 'replacement')

    expect(result.lines).toEqual([
      { text: 'replacement', startMs: 0, endMs: 2000, endOrigin: 'source' },
      { text: '', startMs: 3000, endMs: 4000, endOrigin: 'manual', explicitPause: true },
    ])
    expect(result.lines.filter((line) => line.text.trim()).map((line) => line.text)).toEqual(['replacement'])
  })

  it('allows duplicate source timestamps and does not invent an end for the final row', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'first', startMs: 0, endMs: null },
      { text: 'second', startMs: 0, endMs: null },
    ] }

    const result = stitchLyrics(timed, 'one\ntwo\nthree', 5000)

    expect(result.lines.map((line) => line.startMs)).toEqual([0, 0, 1875])
    expect(result.lines[2]?.endMs).toBeNull()
    expect(result.lines.every((line) => line.words === undefined)).toBe(true)
  })

  it('uses a supplied duration to split a final row without turning it into an authored end', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'last source row', startMs: 2000, endMs: null },
    ] }

    const result = stitchLyrics(timed, 'one\ntwo', 8000)

    expect(result.lines.map((line) => line.startMs)).toEqual([2000, 5000])
    expect(result.lines[1]).toMatchObject({ endMs: null })
    expect(result.lines[1]?.endOrigin).toBeUndefined()
  })

  it('rejects empty text and timings outside the track instead of silently dropping content', () => {
    const timed: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'source', startMs: 0, endMs: null },
      { text: 'late source', startMs: 12_000, endMs: null },
    ] }

    expect(() => stitchLyrics(timed, '')).toThrow('Plain lyrics must contain')
    expect(() => stitchLyrics(timed, 'new text', 10_000)).toThrow('starts after the track duration')
    expect(() => stitchLyrics({ mode: 'synced', lines: [] }, 'new text')).toThrow('no timing rows')
  })

  it('rejects malformed or unsorted timing instead of returning a misleading document', () => {
    expect(() => stitchLyrics({ mode: 'synced', lines: [
      { text: 'late', startMs: 2000, endMs: null },
      { text: 'early', startMs: 1000, endMs: null },
    ] }, 'new one\nnew two')).toThrow('ordered by start time')

    expect(() => stitchLyrics({ mode: 'synced', lines: [
      { text: 'invalid end', startMs: 1000, endMs: 1000 },
    ] }, 'new text')).toThrow('invalid end time')
  })
})

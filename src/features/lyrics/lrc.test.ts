import { describe, expect, it } from 'vitest'
import { formatLrc, normalizeLyricText, parseLrc, shiftLyricsLines } from './lrc'

describe('parseLrc', () => {
  it('reads a plain line', () => {
    expect(parseLrc('[00:12.34]hello')).toEqual([{ timeSec: 12.34, text: 'hello' }])
  })

  it('expands several timecodes on one line into several lines', () => {
    expect(parseLrc('[00:01][00:05]la')).toEqual([
      { timeSec: 1, text: 'la' },
      { timeSec: 5, text: 'la' },
    ])
  })

  it('scales the fraction by its own width, so .5 and .500 both mean half a second', () => {
    const times = ['[00:01.5]a', '[00:01.50]a', '[00:01.500]a'].map(
      (line) => parseLrc(line)?.[0].timeSec,
    )
    expect(times).toEqual([1.5, 1.5, 1.5])
  })

  it('accepts a colon before the fraction', () => {
    expect(parseLrc('[00:01:50]a')?.[0].timeSec).toBe(1.5)
  })

  it('applies an offset tag and the caller nudge, in that order', () => {
    expect(parseLrc('[offset:+500]\n[00:10.00]a')?.[0].timeSec).toBe(9.5)
    expect(parseLrc('[00:10.00]a', 500)?.[0].timeSec).toBe(10.5)
    expect(parseLrc('[offset:-1000]\n[00:10.00]a', 500)?.[0].timeSec).toBe(11.5)
  })

  it('never lets a nudge drag a line before the start of the track', () => {
    expect(parseLrc('[offset:+20000]\n[00:05.00]a')?.[0].timeSec).toBe(0)
    expect(parseLrc('[00:05.00]a', -60000)?.[0].timeSec).toBe(0)
  })

  it('keeps a timecode with no words, because that is how an instrumental break is marked', () => {
    expect(parseLrc('[00:01]sing\n[00:05]\n[00:09]again')).toEqual([
      { timeSec: 1, text: 'sing' },
      { timeSec: 5, text: '' },
      { timeSec: 9, text: 'again' },
    ])
  })

  it('strips per-word time tags', () => {
    expect(parseLrc('[00:01]<00:01.00>la<00:02.00>la')?.[0].text).toBe('lala')
  })

  it('keeps word starts and only treats a trailing timestamp as an exact end', () => {
    expect(parseLrc('[00:01]<00:01>Stay <00:02>here<00:03>')).toEqual([{
      timeSec: 1, text: 'Stay here', endTimeSec: 3, endSource: 'source',
      words: [{ text: 'Stay ', timeSec: 1, endTimeSec: 2 }, { text: 'here', timeSec: 2, endTimeSec: 3 }],
    }])
    const unknown = parseLrc('[00:01]<00:01>Stay <00:02>here')![0]
    expect(unknown.endTimeSec).toBeUndefined()
    expect(unknown.words?.[1].endTimeSec).toBeNull()
  })

  it('shifts enhanced timestamps for each repeated line occurrence and offset', () => {
    const lines = parseLrc('[offset:500]\n[00:01][00:11]<00:01>Stay <00:02>here<00:03>', 1000)!
    expect(lines.map((l) => l.timeSec)).toEqual([1.5, 11.5])
    expect(lines.map((l) => l.endTimeSec)).toEqual([3.5, 13.5])
    expect(lines[1].words?.map((w) => w.timeSec)).toEqual([11.5, 12.5])
  })

  it('retains text but removes exact durations collapsed by crossing the track start', () => {
    const line = parseLrc('[offset:2000]\n[00:01]<00:01>one <00:02>two<00:03>')![0]
    expect(line).toEqual({ timeSec: 0, text: 'one two', endTimeSec: 1, endSource: 'source', words: [
      { text: 'one ', timeSec: 0, endTimeSec: null }, { text: 'two', timeSec: 0, endTimeSec: 1 },
    ] })
    const malformed = shiftLyricsLines([{ timeSec: 1, text: 'bad', words: [{ text: 'bad', timeSec: 1, endTimeSec: 1 }] }], 0)
    expect(malformed[0].words?.[0].endTimeSec).toBe(1)
  })

  it('keeps the text of a word that elapsed entirely before track zero', () => {
    const line = parseLrc('[offset:2500]\n[00:01]<00:01>one <00:02>two<00:03>')![0]
    expect(line.text).toBe('one two')
    expect(line.endTimeSec).toBe(0.5)
    expect(line.words).toEqual([
      { text: 'one ', timeSec: 0, endTimeSec: null }, { text: 'two', timeSec: 0, endTimeSec: 0.5 },
    ])
  })

  it('shifts both endpoints and words without mutating the source', () => {
    const source = [{ timeSec: 2, text: 'word', endTimeSec: 4, endSource: 'source' as const,
      words: [{ text: 'word', timeSec: 2, endTimeSec: 4 }],
    }]
    expect(shiftLyricsLines(source, -1000)[0]).toEqual({
      timeSec: 1, text: 'word', endTimeSec: 3, endSource: 'source',
      words: [{ text: 'word', timeSec: 1, endTimeSec: 3 }],
    })
    expect(shiftLyricsLines(source, 1000)[0].endTimeSec).toBe(5)
    expect(source[0].words[0].timeSec).toBe(2)
  })

  it('sorts by time', () => {
    expect(parseLrc('[00:09]c\n[00:01]a\n[00:05]b')?.map((l) => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('treats windows and bare-carriage-return breaks as line endings', () => {
    expect(parseLrc('[00:01]a\r\n[00:02]b')?.map((l) => l.text)).toEqual(['a', 'b'])
    expect(parseLrc('[00:01]a\r[00:02]b')?.map((l) => l.text)).toEqual(['a', 'b'])
  })

  it('drops a trailing break instead of inventing an empty line', () => {
    expect(parseLrc('[00:01]a\r\n')).toEqual([{ timeSec: 1, text: 'a' }])
  })

  it('rejects anything that is not lyrics', () => {
    expect(parseLrc('')).toBeNull()
    expect(parseLrc('[ar:Someone]\n[ti:A song]')).toBeNull()
    expect(parseLrc('[00:01]\n[00:02]')).toBeNull()
  })
})

describe('formatLrc', () => {
  it('keeps enhanced word timestamps and final endpoints when pinning parsed lyrics', () => {
    const source = '[00:01.00]<00:01.00>Stay <00:02.00>here<00:03.00>'
    expect(formatLrc(parseLrc(source)!)).toBe(source)
  })

  it('keeps word timestamps when a line begins with an untimed prefix', () => {
    const source = '[00:01.00]Before <00:02.00>timed <00:03.00>words<00:04.00>'
    expect(formatLrc(parseLrc(source)!)).toBe(source)
  })

  it('pads minutes, seconds and hundredths', () => {
    expect(formatLrc([{ timeSec: 0, text: 'a' }])).toBe('[00:00.00]a')
    expect(formatLrc([{ timeSec: 5.5, text: 'a' }])).toBe('[00:05.50]a')
    expect(formatLrc([{ timeSec: 65.25, text: 'a' }])).toBe('[01:05.25]a')
  })

  it('clamps the hundredths rather than rounding into the next second', () => {
    expect(formatLrc([{ timeSec: 1.999, text: 'a' }])).toBe('[00:01.99]a')
  })

  it('lets the minutes field grow past two digits', () => {
    expect(formatLrc([{ timeSec: 6000, text: 'a' }])).toBe('[100:00.00]a')
  })

  it('round-trips through parseLrc', () => {
    const lines = [
      { timeSec: 1.5, text: 'first' },
      { timeSec: 62.25, text: 'second' },
      { timeSec: 63.75, text: '' },
    ]
    expect(parseLrc(formatLrc(lines))).toEqual(lines)
  })
})

describe('normalizeLyricText', () => {
  it('folds case and repeated whitespace', () => {
    expect(normalizeLyricText('ЛА   ла')).toBe(normalizeLyricText('ла ла'))
  })

  it('drops trailing punctuation, which is the only difference between many repeats', () => {
    const forms = ['Ла ла ла', 'Ла ла ла.', 'Ла ла ла!', 'Ла ла ла...', 'Ла ла ла —', 'Ла ла ла)']
    const normalized = forms.map(normalizeLyricText)
    expect(new Set(normalized).size).toBe(1)
  })

  it('keeps punctuation that is inside the line', () => {
    expect(normalizeLyricText('Ла, ла')).toBe('ла, ла')
  })

  it('treats a missing line as empty', () => {
    expect(normalizeLyricText(null)).toBe('')
    expect(normalizeLyricText(undefined)).toBe('')
    expect(normalizeLyricText('')).toBe('')
  })
})

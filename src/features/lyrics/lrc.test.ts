import { describe, expect, it } from 'vitest'
import { formatLrc, normalizeLyricText, parseLrc } from './lrc'

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

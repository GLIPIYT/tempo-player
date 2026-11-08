import { describe, expect, it } from 'vitest'
import { lyricPaintRange } from './paintRange'

describe('lyric paint viewport', () => {
  it('includes partially visible wrapped lines and handles collapsed pause rows', () => {
    const tops = [0, 100, 100, 260, 260, 320]
    expect(lyricPaintRange(tops.length, 80, 280, i => tops[i])).toEqual({ start: 0, end: 6 })
    expect(lyricPaintRange(tops.length, 120, 250, i => tops[i])).toEqual({ start: 2, end: 4 })
  })
  it('bounds DOM reads for a long song and distant seeks', () => {
    let reads = 0
    const range = lyricPaintRange(10000, 500000, 501000, i => { reads++; return i * 70 })
    expect(range.start).toBe(7142)
    expect(range.end).toBe(7159)
    expect(reads).toBeLessThan(30)
    expect(lyricPaintRange(0, 0, 800, () => 0)).toEqual({ start: 0, end: 0 })
  })
})

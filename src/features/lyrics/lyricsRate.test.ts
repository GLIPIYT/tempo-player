import { describe, expect, it } from 'vitest'
import {
  LYRICS_RATE_MAX,
  LYRICS_RATE_MIN,
  LYRICS_RATE_POINTS,
  lyricTimeAtMediaPosition,
  mediaPositionAtLyricTime,
  normalizeLyricsRate,
  stepLyricsRate,
} from './lyricsRate'

describe('lyrics playback rate points', () => {
  it('keeps both the existing 0.02 grid and every 0.05 rate', () => {
    const cents = LYRICS_RATE_POINTS.map(rate => Math.round(rate * 100))

    expect(cents).toHaveLength(91)
    expect(new Set(cents).size).toBe(cents.length)
    expect(cents).toEqual([...cents].sort((left, right) => left - right))
    expect(cents.filter(value => (value - 50) % 2 === 0)).toHaveLength(76)
    expect(cents.filter(value => value % 5 === 0)).toHaveLength(31)
    expect(LYRICS_RATE_POINTS[0]).toBe(LYRICS_RATE_MIN)
    expect(LYRICS_RATE_POINTS.at(-1)).toBe(LYRICS_RATE_MAX)
  })

  it('preserves popular rates and normalizes floating-point input to the nearest supported point', () => {
    for (const rate of [0.85, 0.95, 1.05, 1.15, 1.25]) {
      expect(normalizeLyricsRate(rate)).toBe(rate)
    }

    expect(normalizeLyricsRate(1.049999999)).toBe(1.05)
    expect(normalizeLyricsRate(1.050000001)).toBe(1.05)
    expect(normalizeLyricsRate(1.03)).toBe(1.02)
    expect(normalizeLyricsRate(Number.NaN)).toBe(1)
    expect(normalizeLyricsRate(0)).toBe(LYRICS_RATE_MIN)
    expect(normalizeLyricsRate(3)).toBe(LYRICS_RATE_MAX)
  })

  it('visits every supported rate in order in both directions', () => {
    let rate = LYRICS_RATE_MIN
    const ascending = [rate]
    while (rate < LYRICS_RATE_MAX) {
      rate = stepLyricsRate(rate, 1)
      ascending.push(rate)
    }
    expect(ascending).toEqual(LYRICS_RATE_POINTS)

    const descending = [rate]
    while (rate > LYRICS_RATE_MIN) {
      rate = stepLyricsRate(rate, -1)
      descending.push(rate)
    }
    expect(descending).toEqual([...LYRICS_RATE_POINTS].reverse())
  })

  it('steps through popular values without skipping or drifting', () => {
    expect(stepLyricsRate(1.04, 1)).toBe(1.05)
    expect(stepLyricsRate(1.05, 1)).toBe(1.06)
    expect(stepLyricsRate(1.06, -1)).toBe(1.05)
    expect(stepLyricsRate(1.05, -1)).toBe(1.04)
    expect(stepLyricsRate(0.94, 1)).toBe(0.95)
    expect(stepLyricsRate(0.96, -1)).toBe(0.95)
    expect(stepLyricsRate(1, -1)).toBe(0.98)
    expect(stepLyricsRate(1, 1)).toBe(1.02)
    expect(stepLyricsRate(LYRICS_RATE_MIN, -1)).toBe(LYRICS_RATE_MIN)
    expect(stepLyricsRate(LYRICS_RATE_MAX, 1)).toBe(LYRICS_RATE_MAX)
  })

  it('keeps lyric and media time mappings inverse at popular rates with an offset', () => {
    const mediaPosition = 83.275
    const offsetMs = -650

    for (const rate of [0.85, 0.95, 1.05, 1.15]) {
      const lyricTime = lyricTimeAtMediaPosition(mediaPosition, rate, offsetMs)
      expect(mediaPositionAtLyricTime(lyricTime, rate, offsetMs)).toBeCloseTo(mediaPosition, 12)
    }
  })
})

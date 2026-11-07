import { describe, expect, it } from 'vitest'
import { lyricTransitionDuration } from './lyricsMotion'
import type { LyricSegment } from './timingResolver'

const line = (timeSec: number, endTimeSec: number): LyricSegment => ({
  kind: 'line', timeSec, endTimeSec, text: 'Line', seekToSec: timeSec, lineIndices: [],
})

describe('lyric transition motion', () => {
  it('keeps the accelerated movement shorter, including rapid cues', () => {
    const segments = [line(0, 3), line(3, 3.25)]
    expect(lyricTransitionDuration(segments, 0, 0, 1, 'accelerated')).toBe(294)
    expect(lyricTransitionDuration(segments, 1, 3, 1, 'accelerated')).toBe(105)
    expect(lyricTransitionDuration(segments, 1, 3.24, 1, 'accelerated')).toBeGreaterThan(0)
  })
  it('uses a smooth normal transition and shortens rapid cues without snapping', () => {
    const segments = [line(0, 3), line(3, 3.25), line(3.25, 6)]
    expect(lyricTransitionDuration(segments, 0, 0)).toBe(420)
    expect(lyricTransitionDuration(segments, 1, 3)).toBe(150)
    expect(lyricTransitionDuration(segments, 2, 3.25)).toBe(150)
    expect(lyricTransitionDuration(segments, 1, 3.24)).toBe(70)
  })

  it('accounts for playback speed and the displayed cue window', () => {
    const segments = [{ ...line(0, 0.2), displayEndTimeSec: 0.5 }]
    expect(lyricTransitionDuration(segments, 0, 0, 1)).toBe(300)
    expect(lyricTransitionDuration(segments, 0, 0, 2)).toBe(150)
    expect(lyricTransitionDuration(segments, 0, 0, Number.NaN)).toBe(300)
  })
})

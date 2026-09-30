import { describe, expect, it } from 'vitest'
import { createPlaybackTiming } from './playbackTiming'
import { lyricTimingAt, resolveLyricTiming } from './timingResolver'

const lines = [{ timeSec: 10, text: 'one' }, { timeSec: 20, text: 'two' }]
const timing = (first: number, second: number) => resolveLyricTiming(lines, 40, { bpm: null, matchedEnds: [
  { lineIndex: 0, endTimeSec: first, confidence: 1 }, { lineIndex: 1, endTimeSec: second, confidence: 1 },
] })
describe('playback timing pass', () => {
  it('keeps begun fill and scroll stable but refines future intervals', () => {
    const pass = createPlaybackTiming()
    pass.update(timing(14, 24), 12)
    const late = pass.update(timing(18, 27), 12)
    expect(lyricTimingAt(late, 12).progress).toBe(.5)
    expect(late.segments.find(s => s.timeSec === 20)?.endTimeSec).toBe(27)
    pass.update(timing(18, 27), 15)
    expect(pass.update(timing(19, 28), 15).segments[2].kind).toBe('notes')
    expect(lyricTimingAt(pass.update(timing(19, 28), 15), 15).segmentIndex).toBe(2)
  })
  it('backward seek starts a fresh pass with the newest timing', () => {
    const pass = createPlaybackTiming()
    pass.update(timing(14, 24), 12)
    pass.update(timing(18, 27), 15)
    const replay = pass.update(timing(18, 27), 11)
    expect(lyricTimingAt(replay, 12).progress).toBe(.25)
    expect(replay.segments.find(s => s.timeSec === 10)?.endTimeSec).toBe(18)
  })
  it('a small backward seek also accepts the new interval', () => {
    const pass = createPlaybackTiming()
    pass.update(timing(14, 24), 12)
    pass.update(timing(18, 27), 12)
    expect(pass.update(timing(18, 27), 11.999).segments[1].endTimeSec).toBe(18)
  })
})

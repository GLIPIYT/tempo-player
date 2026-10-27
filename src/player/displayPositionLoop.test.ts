import { describe, expect, it } from 'vitest'
import { startDisplayPositionLoop } from './displayPositionLoop'

describe('display position animation', () => {
  it('samples the audio clock on every frame and cancels the pending frame on stop', () => {
    let nextId = 0
    const frames = new Map<number, FrameRequestCallback>()
    const request = (callback: FrameRequestCallback) => { const id = ++nextId; frames.set(id, callback); return id }
    const cancel = (id: number) => { frames.delete(id) }
    const advance = () => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(0) }
    let clock = 4
    const positions: number[] = []
    const stop = startDisplayPositionLoop(() => clock, value => positions.push(value), request, cancel)
    clock = 4.016; advance()
    clock = 4.032; advance()
    expect(positions).toEqual([4, 4.016, 4.032])
    expect(frames.size).toBe(1)
    stop()
    expect(frames.size).toBe(0)
  })
})

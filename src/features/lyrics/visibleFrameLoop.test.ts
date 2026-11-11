import { describe, expect, it, vi } from 'vitest'
import { startVisibleFrameLoop, type FrameScheduler, type VisibilitySource } from './visibleFrameLoop'

function setup(hidden = false) {
  const listeners = new Set<() => void>()
  const target: VisibilitySource = {
    hidden,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  }
  let nextId = 1
  const frames = new Map<number, FrameRequestCallback>()
  const scheduler: FrameScheduler = {
    request: callback => { const id = nextId++; frames.set(id, callback); return id },
    cancel: id => { frames.delete(id) },
  }
  const notifyVisibility = () => listeners.forEach(listener => listener())
  const runFrame = () => {
    const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined
    if (!next) return false
    frames.delete(next[0])
    next[1](0)
    return true
  }
  return { target, frames, notifyVisibility, runFrame, listenerCount: () => listeners.size, scheduler }
}

describe('visible lyric animation loop', () => {
  it('suspends frame work while hidden and resumes it on return', () => {
    const state = setup()
    const update = vi.fn()
    const stop = startVisibleFrameLoop(update, state.target, state.scheduler)

    expect(state.frames.size).toBe(1)
    expect(state.runFrame()).toBe(true)
    expect(update).toHaveBeenCalledTimes(1)
    expect(state.frames.size).toBe(1)

    state.target.hidden = true
    state.notifyVisibility()
    expect(state.frames.size).toBe(0)
    expect(state.runFrame()).toBe(false)

    state.target.hidden = false
    state.notifyVisibility()
    expect(state.frames.size).toBe(1)
    expect(state.runFrame()).toBe(true)
    expect(update).toHaveBeenCalledTimes(2)

    stop()
    expect(state.frames.size).toBe(0)
    expect(state.listenerCount()).toBe(0)
  })

  it('does not schedule until a hidden document becomes visible', () => {
    const state = setup(true)
    const update = vi.fn()
    const stop = startVisibleFrameLoop(update, state.target, state.scheduler)
    expect(state.frames.size).toBe(0)

    state.target.hidden = false
    state.notifyVisibility()
    expect(state.frames.size).toBe(1)
    expect(state.runFrame()).toBe(true)
    expect(update).toHaveBeenCalledOnce()
    stop()
  })
})

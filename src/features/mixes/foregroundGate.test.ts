import { describe, expect, it, vi } from 'vitest'
import {
  createMixForegroundGate,
  updateMixForegroundGate,
  waitForMixForegroundReady,
} from './foregroundGate'

describe('custom mix foreground gate', () => {
  it('holds a candidate load until the foreground database requests finish', async () => {
    const gate = createMixForegroundGate(4)
    const wait = waitForMixForegroundReady(gate)
    let finished = false
    void wait.promise.then(() => { finished = true })

    updateMixForegroundGate(gate, false)
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(gate.waiters.size).toBe(1)

    updateMixForegroundGate(gate, true)
    await wait.promise
    expect(finished).toBe(true)
    expect(gate.waiters.size).toBe(0)
  })

  it('requires the new library version to observe loading before accepting stale ready state', () => {
    const gate = createMixForegroundGate(5, true)
    const wait = waitForMixForegroundReady(gate)
    const onReady = vi.fn()
    void wait.promise.then(onReady)

    updateMixForegroundGate(gate, true)
    expect(gate.ready).toBe(false)
    expect(onReady).not.toHaveBeenCalled()

    updateMixForegroundGate(gate, false)
    updateMixForegroundGate(gate, true)
    expect(gate.ready).toBe(true)
    return wait.promise.then(() => expect(onReady).toHaveBeenCalledOnce())
  })

  it('accepts initially hydrated state and explicit editor intent', async () => {
    const initiallyReady = createMixForegroundGate(6)
    const initialWait = waitForMixForegroundReady(initiallyReady)
    updateMixForegroundGate(initiallyReady, true)
    await expect(initialWait.promise).resolves.toBeUndefined()

    const afterVersionChange = createMixForegroundGate(7, true)
    const editorWait = waitForMixForegroundReady(afterVersionChange)
    updateMixForegroundGate(afterVersionChange, false, true)
    await expect(editorWait.promise).resolves.toBeUndefined()
  })

  it('cancels and removes an abandoned wait', async () => {
    const gate = createMixForegroundGate(8)
    const wait = waitForMixForegroundReady(gate)
    wait.cancel()

    await expect(wait.promise).resolves.toBeUndefined()
    expect(gate.waiters.size).toBe(0)
  })
})

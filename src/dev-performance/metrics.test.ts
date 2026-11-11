import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getDevPerfLogBatch,
  getDevPerfSnapshot,
  getPendingDevPerfLogIds,
  recordReactCommit,
  startDevPerfCapture,
  stopDevPerfCapture,
} from './metrics'

const removeVisibilityListener = vi.fn()
const cancelFrame = vi.fn()
const disconnectObserver = vi.fn()

class MockPerformanceObserver {
  observe = vi.fn()
  disconnect = disconnectObserver
  takeRecords = vi.fn(() => [] as PerformanceEntryList)

  constructor(_callback: PerformanceObserverCallback) {}
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    requestAnimationFrame: vi.fn(() => 7),
    cancelAnimationFrame: cancelFrame,
    localStorage: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() },
  } as unknown as Window)
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: removeVisibilityListener,
  } as unknown as Document)
  vi.stubGlobal('PerformanceObserver', MockPerformanceObserver)
  removeVisibilityListener.mockClear()
  cancelFrame.mockClear()
  disconnectObserver.mockClear()
})

afterEach(() => {
  stopDevPerfCapture()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('dev performance metrics', () => {
  it('keeps static React labels, bounds samples and log queue, and disconnects watchers', () => {
    startDevPerfCapture()
    recordReactCommit('lyrics', 'mount', 18.25, 40, 100, 123.5)
    recordReactCommit('page:/private/track/123', 'update', 900, 900, 123, 999)
    for (let index = 0; index < 512; index += 1) {
      recordReactCommit('updates', 'update', 6, 12, 200, 200 + index)
    }
    vi.advanceTimersByTime(250)

    const snapshot = getDevPerfSnapshot()
    expect(snapshot.capturing).toBe(true)
    expect(snapshot.entries).toHaveLength(300)
    expect(snapshot.entries.some(entry => entry.label.includes('private'))).toBe(false)
    expect(snapshot.queuedEntries).toBe(512)
    expect(snapshot.droppedLogEntries).toBe(1)
    const ids = getPendingDevPerfLogIds()
    expect(ids).toHaveLength(512)
    expect(getDevPerfLogBatch(ids.slice(0, 1))).toEqual([
      { kind: 'react', label: 'updates', durationMs: 6, atMs: 200 },
    ])

    stopDevPerfCapture()
    expect(getDevPerfSnapshot().capturing).toBe(false)
    expect(disconnectObserver).toHaveBeenCalledOnce()
    expect(cancelFrame).toHaveBeenCalledWith(7)
    expect(removeVisibilityListener).toHaveBeenCalledOnce()
  })
})

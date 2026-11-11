import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeDevPerfLogBatch,
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
const observers: MockPerformanceObserver[] = []

class MockPerformanceObserver {
  static supportedEntryTypes = ['longtask', 'long-animation-frame']

  observe = vi.fn()
  disconnect = disconnectObserver
  takeRecords = vi.fn(() => [] as PerformanceEntryList)

  constructor(private readonly callback: PerformanceObserverCallback) {
    observers.push(this)
  }

  emit(entries: PerformanceEntry[]): void {
    this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver)
  }
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
    location: { href: 'http://localhost:1420/', origin: 'http://localhost:1420' },
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
  observers.length = 0
  MockPerformanceObserver.supportedEntryTypes = ['longtask', 'long-animation-frame']
})

afterEach(() => {
  stopDevPerfCapture()
  acknowledgeDevPerfLogBatch(getPendingDevPerfLogIds())
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
    expect(disconnectObserver).toHaveBeenCalledTimes(2)
    expect(cancelFrame).toHaveBeenCalledWith(7)
    expect(removeVisibilityListener).toHaveBeenCalledOnce()
  })

  it('records bounded LoAF attribution only for same-origin local modules', () => {
    startDevPerfCapture()
    const frameObserver = observers.find(observer => observer.observe.mock.calls.some(([options]) => (
      typeof options === 'object' && options !== null && 'type' in options && options.type === 'long-animation-frame'
    )))
    expect(frameObserver).toBeDefined()

    const longPath = `/src/${'long-module-name-'.repeat(24)}.tsx?track=private#source`
    const localScripts = [
      { sourceURL: 'http://localhost:1420/src/slow.ts?track=private#fragment', sourceFunctionName: 's'.repeat(120), duration: 900, forcedStyleAndLayoutDuration: 18, sourceCharPosition: 203 },
      { sourceURL: `http://localhost:1420${longPath}`, sourceFunctionName: 'loadHome', duration: 700, forcedStyleAndLayoutDuration: 2, sourceCharPosition: 91 },
      { sourceURL: 'http://localhost:1420/node_modules/.vite/deps/react.js?cache=private', sourceFunctionName: 'renderWithHooks', duration: 400, forcedStyleDuration: 1, forcedLayoutDuration: 3, sourceCharPosition: 45 },
      { sourceURL: 'http://localhost:1420/@vite/client?session=private', sourceFunctionName: 'viteClient', duration: 300, forcedStyleAndLayoutDuration: 0, sourceCharPosition: 5 },
      { sourceURL: 'http://localhost:1420/@react-refresh?session=private#hot', sourceFunctionName: 'refresh', duration: 200, forcedStyleAndLayoutDuration: 0, sourceCharPosition: 7 },
      { sourceURL: 'http://localhost:1420/src/lowest.ts', sourceFunctionName: 'slow', duration: 100, forcedStyleAndLayoutDuration: 0, sourceCharPosition: 1 },
      { sourceURL: 'https://remote.example/src/remote.ts?track=private', sourceFunctionName: 'remote', duration: 2_000, forcedStyleAndLayoutDuration: 0, sourceCharPosition: 0 },
      { sourceURL: 'file:///C:/Users/User/project/src/local.ts', sourceFunctionName: 'localFile', duration: 1_900, forcedStyleAndLayoutDuration: 0, sourceCharPosition: 0 },
      { sourceURL: 'http://localhost:1420/settings/song-123?track=private', sourceFunctionName: 'route', duration: 1_800, forcedStyleAndLayoutDuration: 0, sourceCharPosition: 0 },
    ]
    const frame = {
      name: 'long-animation-frame',
      entryType: 'long-animation-frame',
      startTime: 100,
      duration: 3_300,
      blockingDuration: 3_240,
      renderStart: 3_000,
      styleAndLayoutStart: 3_200,
      scripts: localScripts,
      toJSON: () => ({}),
    } as unknown as PerformanceEntry

    frameObserver?.emit([frame])
    vi.advanceTimersByTime(250)

    const entry = getDevPerfSnapshot().entries.at(-1)
    expect(entry).toMatchObject({
      kind: 'long-frame',
      label: 'long animation frame',
      durationMs: 3_300,
      atMs: 100,
      blockingMs: 3_240,
      renderMs: 400,
      styleAndLayoutMs: 200,
    })
    expect(entry?.scripts).toHaveLength(5)
    expect(entry?.scripts?.map(script => script.durationMs)).toEqual([900, 700, 400, 300, 200])
    expect(entry?.scripts?.[0]).toMatchObject({
      source: '/src/slow.ts',
      functionName: 's'.repeat(96),
      forcedStyleAndLayoutMs: 18,
      sourceCharPosition: 203,
    })
    expect(entry?.scripts?.[2].forcedStyleAndLayoutMs).toBe(4)
    expect(entry?.scripts?.[1].source).toHaveLength(256)
    expect(entry?.scripts?.map(script => script.source)).toEqual([
      '/src/slow.ts',
      `/src/${'long-module-name-'.repeat(24)}.tsx`.slice(0, 256),
      '/node_modules/.vite/deps/react.js',
      '/@vite/client',
      '/@react-refresh',
    ])
    expect(JSON.stringify(entry)).not.toMatch(/track|private|remote\.example|file:\/\//i)

    const splitTimingFrame = {
      ...frame,
      startTime: 4_000,
      duration: 1_000,
      styleAndLayoutStart: 4_900,
      styleDuration: 30,
      layoutDuration: 55,
      scripts: [],
    } as unknown as PerformanceEntry
    frameObserver?.emit([splitTimingFrame])
    vi.advanceTimersByTime(250)
    expect(getDevPerfSnapshot().entries.at(-1)?.styleAndLayoutMs).toBe(85)
  })

  it('skips LoAF observation when the browser does not advertise support', () => {
    MockPerformanceObserver.supportedEntryTypes = ['longtask']
    startDevPerfCapture()

    expect(observers).toHaveLength(1)
    expect(observers[0].observe).toHaveBeenCalledWith({ entryTypes: ['longtask'] })
    observers[0].emit([{
      name: 'self',
      entryType: 'longtask',
      startTime: 42,
      duration: 900,
      toJSON: () => ({}),
    } as PerformanceEntry])
    vi.advanceTimersByTime(250)
    expect(getDevPerfSnapshot().entries.at(-1)).toMatchObject({
      kind: 'longtask',
      label: 'main-thread long task',
      durationMs: 900,
      atMs: 42,
    })

    stopDevPerfCapture()
    expect(disconnectObserver).toHaveBeenCalledOnce()
  })
})

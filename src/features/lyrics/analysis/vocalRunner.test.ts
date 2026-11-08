import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisPcm } from '../../../audio/decodeForAnalysis'
import type { AudioIdentity } from './contract'
import { createVocalAnalysisRunner, type VocalRunnerDependencies } from './vocalRunner'
import { VOCAL_ALGORITHM_VERSION, VOCAL_CONTEXT_SEC, VOCAL_CORE_SEC, VOCAL_HOP_SEC, VOCAL_MODEL_REVISION,
  type VocalAnalysis, type VocalChunk, type VocalRequest, type VocalResponse } from './vocalContract'
import type { AnalysisTrackInput } from './runner'

const durationSec = 50
const track = { dbId: 1, source: 'local' as const, sourceId: 'track-1' }
const input: AnalysisTrackInput = { track, sourceLines: [{ timeSec: 2, text: 'Silver rivers' }], durationSec,
  offsetMs: 375, lyricKey: 'lyrics@375', sourceLyricKey: 'lyrics' }

function makeIdentity(sourceId = 'track-1', fingerprint = 'audio-1', duration = durationSec): AudioIdentity {
  return { fingerprint, absolutePath: `/${sourceId}.wav`, fileSize: 1000, durationSec: duration, sampleRate: 16000, channels: 1 }
}

function makeChunk(startSec = 0, endSec = 20): VocalChunk {
  return { startSec, endSec, voice: [128], energy: [100], flux: [24] }
}

function makeAnalysis(overrides: Partial<VocalAnalysis> = {}): VocalAnalysis {
  return { fingerprint: 'audio-1', modelRevision: VOCAL_MODEL_REVISION, algorithmVersion: VOCAL_ALGORITHM_VERSION,
    durationSec, hopSec: VOCAL_HOP_SEC, chunks: [], ...overrides }
}

function makeResponse(request: VocalRequest): VocalResponse {
  return request.type === 'init'
    ? { type: 'ready', jobId: request.jobId }
    : { type: 'result', jobId: request.jobId, chunkId: request.chunkId,
      chunk: makeChunk(request.startSec, request.endSec), elapsedMs: 1 }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

async function advanceUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 8 && !predicate(); index += 1) {
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
  }
  expect(predicate()).toBe(true)
}

const cleanups: (() => void)[] = []
function setup(saved: VocalAnalysis | null = null, pcm?: Float32Array) {
  let stored = saved ? structuredClone(saved) : null
  const identity = makeIdentity()
  const requests: VocalRequest[] = []
  const workerInstance = {
    request: vi.fn(async (message: VocalRequest): Promise<VocalResponse> => {
      requests.push(message)
      return makeResponse(message)
    }),
    dispose: vi.fn(),
  }
  const deps: VocalRunnerDependencies = {
    native: {
      identity: vi.fn(async () => identity),
      get: vi.fn(async () => stored),
      merge: vi.fn(async (analysis: VocalAnalysis) => { stored = structuredClone(analysis); return structuredClone(analysis) }),
    },
    decode: vi.fn(async (): Promise<AnalysisPcm> => ({ pcm: pcm ?? new Float32Array(durationSec * 16000),
      sampleRate: 16000, durationSec })),
    worker: vi.fn(() => workerInstance),
    now: () => Date.now(),
    modelBaseUrl: () => 'http://localhost/vocal-model/',
    wasmBaseUrl: () => 'http://localhost/asr-runtime/',
  }
  const runner = createVocalAnalysisRunner(deps)
  cleanups.push(() => runner.stop())
  return { runner, deps, requests, workerInstance, saved: () => stored, identity }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => {
  cleanups.splice(0).forEach(stop => stop())
  vi.useRealTimers()
})

describe('vocal analysis runner', () => {
  it('stays disabled without native reads and restores only a fresh cached payload when enabled', async () => {
    const saved = makeAnalysis({ chunks: [makeChunk(0, durationSec)] })
    const { runner, deps, requests } = setup(saved)
    runner.setTrack(input)
    runner.setPosition(25, false)
    await flushMicrotasks()

    expect(deps.native.identity).not.toHaveBeenCalled()
    expect(deps.native.get).not.toHaveBeenCalled()
    expect(deps.decode).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)

    runner.setEnabled(true)
    await flushMicrotasks()

    expect(deps.native.identity).toHaveBeenCalledWith(track)
    expect(deps.native.get).toHaveBeenCalledWith('audio-1')
    expect(runner.getSnapshot().analysis).toEqual({ analysis: saved, offsetMs: input.offsetMs })
    expect(deps.decode).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)

    runner.setEnabled(false)
    expect(runner.getSnapshot().analysis).toBeNull()
    expect(deps.decode).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
  })

  it.each([
    ['algorithm version', { algorithmVersion: 'older-algorithm' }],
    ['model revision', { modelRevision: 'older-model' }],
    ['hop size', { hopSec: 0.01 }],
    ['duration', { durationSec: durationSec + 0.2 }],
  ] as const)('drops a cache with stale %s metadata', async (_field, change) => {
    const stale = makeAnalysis({ chunks: [makeChunk(0, durationSec)], ...change })
    const { runner, deps } = setup(stale)
    runner.setEnabled(true)
    runner.setTrack(input)
    await flushMicrotasks()

    expect(deps.native.get).toHaveBeenCalledWith('audio-1')
    expect(runner.getSnapshot().analysis).toBeNull()
    expect(deps.decode).not.toHaveBeenCalled()
    expect(deps.native.merge).not.toHaveBeenCalled()
  })

  it('prioritizes the playing 20-second core and sends its four-second context', async () => {
    const pcm = new Float32Array(durationSec * 16000)
    pcm[16 * 16000] = 0.16
    pcm[44 * 16000 - 1] = 0.44
    const { runner, requests } = setup(null, pcm)
    runner.setEnabled(true)
    runner.setTrack(input)
    await flushMicrotasks()
    runner.setPosition(25, true)
    await advanceUntil(() => requests.some(request => request.type === 'analyze'))

    const request = requests.find((value): value is Extract<VocalRequest, { type: 'analyze' }> => value.type === 'analyze')!
    expect(request).toMatchObject({ chunkId: '20:40', windowStartSec: 20 - VOCAL_CONTEXT_SEC,
      startSec: 20, endSec: 20 + VOCAL_CORE_SEC })
    expect(request.pcm).toHaveLength((VOCAL_CORE_SEC + 2 * VOCAL_CONTEXT_SEC) * 16000)
    expect(request.pcm[0]).toBeCloseTo(0.16, 6)
    expect(request.pcm.at(-1)).toBeCloseTo(0.44, 6)
  })

  it('ignores a worker result that arrives after the job was cancelled', async () => {
    const pending = deferred<VocalResponse>()
    const { runner, deps, workerInstance } = setup()
    const requests: VocalRequest[] = []
    const worker = { request: vi.fn((message: VocalRequest) => {
      requests.push(message)
      return message.type === 'init' ? Promise.resolve(makeResponse(message)) : pending.promise
    }), dispose: vi.fn() }
    deps.worker = vi.fn(() => worker)
    runner.setEnabled(true)
    runner.setTrack(input)
    await flushMicrotasks()
    runner.setPosition(25, true)
    await advanceUntil(() => requests.some(request => request.type === 'analyze'))

    runner.setEnabled(false)
    pending.resolve(makeResponse(requests.find(request => request.type === 'analyze')!))
    await flushMicrotasks()

    expect(worker.dispose).toHaveBeenCalledTimes(1)
    expect(deps.native.merge).not.toHaveBeenCalled()
    expect(runner.getSnapshot().analysis).toBeNull()
    expect(workerInstance.request).not.toHaveBeenCalled()
  })

  it('charges five times elapsed CPU work before the next model window starts', async () => {
    const { runner, deps, requests } = setup()
    deps.decode = vi.fn(async (): Promise<AnalysisPcm> => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return { pcm: new Float32Array(durationSec * 16000), sampleRate: 16000, durationSec }
    })
    deps.worker = vi.fn(() => ({
      request: vi.fn(async (message: VocalRequest): Promise<VocalResponse> => {
        requests.push(message)
        if (message.type === 'analyze') await new Promise(resolve => setTimeout(resolve, 5))
        return makeResponse(message)
      }),
      dispose: vi.fn(),
    }))
    runner.setEnabled(true)
    runner.setTrack(input)
    await flushMicrotasks()
    runner.setPosition(25, true)

    await vi.advanceTimersByTimeAsync(10)
    expect(requests.filter(request => request.type === 'analyze')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(39)
    expect(requests.filter(request => request.type === 'analyze')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(requests.filter(request => request.type === 'analyze')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5)
    await vi.advanceTimersByTimeAsync(18)
    expect(requests.filter(request => request.type === 'analyze')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(requests.filter(request => request.type === 'analyze')).toHaveLength(2)
    expect(requests.filter(request => request.type === 'analyze').at(-1)).toMatchObject({ startSec: 40, endSec: 50 })
  })

  it('does not publish a snapshot solely because wall-clock timers elapse while paused', async () => {
    const { runner } = setup()
    runner.setEnabled(true)
    runner.setTrack(input)
    await flushMicrotasks()
    const listener = vi.fn()
    runner.subscribe(listener)

    runner.setPosition(18, false)
    await vi.advanceTimersByTimeAsync(60001)

    expect(listener).not.toHaveBeenCalled()
    expect(runner.getSnapshot().phase).toBe('idle')
  })

  it('ignores a late audio identity from the previous source generation', async () => {
    const { runner, deps } = setup()
    const oldIdentity = deferred<AudioIdentity | null>()
    const nextIdentity = makeIdentity('track-2', 'audio-2')
    deps.native.identity = vi.fn(async value => value.sourceId === 'track-1' ? oldIdentity.promise : nextIdentity)
    runner.setEnabled(true)
    runner.setTrack(input)
    await flushMicrotasks()
    runner.setTrack({ ...input, track: { dbId: 2, source: 'local' as const, sourceId: 'track-2' }, lyricKey: 'new-source' })
    await flushMicrotasks()

    oldIdentity.resolve(makeIdentity('track-1', 'audio-1'))
    await flushMicrotasks()

    expect(deps.native.get).toHaveBeenCalledTimes(1)
    expect(deps.native.get).toHaveBeenCalledWith('audio-2')
    expect(runner.getSnapshot().lyricKey).toBe('new-source')
    expect(runner.getSnapshot().analysis).toBeNull()
  })
})

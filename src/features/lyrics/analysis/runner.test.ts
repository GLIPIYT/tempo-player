import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLyricsAnalysisRunner, type RunnerDependencies, type AnalysisTrackInput } from './runner'
import { LYRIC_ANALYSIS_ALGORITHM_VERSION, LYRIC_MODEL_ID, LYRIC_MODEL_REVISION, type AudioAnalysis, type AnalysisMerge } from './contract'
import type { AsrRequest, AsrResponse } from './workerProtocol'

const input: AnalysisTrackInput = { track: { dbId: 1, source: 'local', sourceId: '1' }, durationSec: 30, offsetMs: 0,
  lyricKey: 'lyrics@0', sourceLyricKey: 'lyrics', sourceLines: [{ timeSec: 2, text: 'Silver rivers' }, { timeSec: 18, text: 'Golden mountains' }] }
function setup(saved?: AudioAnalysis) {
  let stored = saved ?? null
  const calls: { time: number; request: AsrRequest }[] = []
  let decodes = 0, ensures = 0, disposed = 0
  const writes: AnalysisMerge[] = []
  const deps: RunnerDependencies = {
    now: () => Date.now(), wasmBaseUrl: () => 'http://localhost/asr-runtime/',
    native: {
      identity: async () => ({ fingerprint: 'audio', absolutePath: '/audio.wav', fileSize: 1000, durationSec: 30, sampleRate: 16000, channels: 1 }),
      get: async () => stored,
      merge: async (update) => {
        writes.push(update)
        stored ??= { fingerprint: 'audio', algorithmVersion: LYRIC_ANALYSIS_ALGORITHM_VERSION, modelRevision: LYRIC_MODEL_REVISION, durationSec: 30, bpm: null, bpmConfidence: 0, fragments: [], lyricMatches: [] }
        if (update.completedFragment) stored.fragments.push(update.completedFragment)
        if (update.acceptedMatches) stored.lyricMatches = [update.acceptedMatches]
        return structuredClone(stored)
      },
      ensureModel: async () => { ensures++; return { modelId: LYRIC_MODEL_ID, revision: LYRIC_MODEL_REVISION, files: [] } }, assetUrl: path => path,
    },
    decode: async () => { decodes++; await new Promise(r => setTimeout(r, 10)); return { pcm: new Float32Array(480000), sampleRate: 16000, durationSec: 30 } },
    worker: () => ({
      request: async (request, signal) => {
        calls.push({ time: Date.now(), request })
        return new Promise<AsrResponse>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
          setTimeout(() => resolve(request.type === 'init' ? { type: 'ready', jobId: request.jobId } :
            { type: 'result', jobId: request.jobId, fragmentId: request.fragmentId, words: [], elapsedMs: 100 }), request.type === 'init' ? 20 : 100)
        })
      }, dispose: () => { disposed++ },
    }),
  }
  const runner = createLyricsAnalysisRunner(deps)
  return { runner, deps, calls, writes, saved: () => stored, counts: () => ({ decodes, ensures, disposed }) }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.useRealTimers() })
it('serializes work, checkpoints empty windows and enforces 9x measured work pause across seek/provider change', async () => {
  const { runner, calls, writes } = setup()
  runner.setEnabled(true); runner.setTrack(input); runner.setPosition(2, true)
  await vi.advanceTimersByTimeAsync(250)
  expect(calls.filter(c => c.request.type === 'transcribe')).toHaveLength(1)
  expect(writes.filter(w => w.completedFragment)).toHaveLength(1)
  runner.setPosition(20, true)
  runner.setTrack({ ...input, lyricKey: 'other', sourceLyricKey: 'other' })
  await vi.advanceTimersByTimeAsync(929)
  expect(calls.filter(c => c.request.type === 'transcribe')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1000)
  const inference = calls.filter(c => c.request.type === 'transcribe')
  expect(inference).toHaveLength(2)
  expect(inference[1].time - (inference[0].time + 100)).toBeGreaterThanOrEqual(1080)
  await vi.advanceTimersByTimeAsync(5000)
  expect(calls.filter(c => c.request.type === 'transcribe')).toHaveLength(2)
  expect(runner.getSnapshot().phase).toBe('complete')
  runner.stop()
})
it('reads cached accepted endpoints while disabled without decode, model, worker and reprojects offset changes', async () => {
  const stored: AudioAnalysis = { fingerprint: 'audio', algorithmVersion: LYRIC_ANALYSIS_ALGORITHM_VERSION, modelRevision: LYRIC_MODEL_REVISION,
    durationSec: 30, bpm: 120, bpmConfidence: 0.9, fragments: [], lyricMatches: [{ sourceLyricKey: 'lyrics',
      ends: [{ lineIndex: 0, sourceEndSec: 19, matchedMediaEndSec: 14, offsetAtMatchMs: -5000, confidence: 1 }] }] }
  const { runner, counts } = setup(stored)
  runner.setTrack({ ...input, sourceLines: [{ timeSec: 17, text: 'Silver rivers' }], offsetMs: -5000 })
  await vi.advanceTimersByTimeAsync(0)
  expect(runner.getSnapshot().analysis.matchedEnds[0]?.endTimeSec).toBe(14)
  runner.setTrack({ ...input, sourceLines: [{ timeSec: 17, text: 'Silver rivers' }], offsetMs: -4000, lyricKey: 'lyrics@-4' })
  expect(runner.getSnapshot().analysis.matchedEnds[0]?.endTimeSec).toBe(15)
  expect(counts()).toEqual({ decodes: 0, ensures: 0, disposed: 0 })
  runner.stop()
})
it('disabling during cached restore still publishes saved endpoints without starting analysis', async () => {
  const stored: AudioAnalysis = { fingerprint: 'audio', algorithmVersion: LYRIC_ANALYSIS_ALGORITHM_VERSION, modelRevision: LYRIC_MODEL_REVISION,
    durationSec: 30, bpm: null, bpmConfidence: 0, fragments: [], lyricMatches: [{ sourceLyricKey: 'lyrics',
      ends: [{ lineIndex: 0, sourceEndSec: 4, matchedMediaEndSec: 4, offsetAtMatchMs: 0, confidence: 1 }] }] }
  const { runner, counts } = setup(stored)
  runner.setEnabled(true); runner.setTrack(input)
  await Promise.resolve() // identity has resolved; cache read is still queued
  runner.setEnabled(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(runner.getSnapshot().analysis.matchedEnds[0]?.endTimeSec).toBe(4)
  expect(counts().ensures).toBe(0)
  runner.stop()
})
it('track change/disable cancels inference and retains cancelled work debt', async () => {
  const { runner, calls, writes, counts } = setup()
  runner.setEnabled(true); runner.setTrack(input); runner.setPosition(2, true)
  await vi.advanceTimersByTimeAsync(180)
  expect(calls.some(c => c.request.type === 'transcribe')).toBe(true)
  runner.setEnabled(false)
  runner.setTrack({ ...input, track: { ...input.track, dbId: 2 } })
  runner.setEnabled(true)
  await vi.advanceTimersByTimeAsync(400)
  expect(calls.filter(c => c.request.type === 'transcribe')).toHaveLength(1)
  expect(writes.filter(w => w.completedFragment)).toHaveLength(0)
  expect(counts().disposed).toBeGreaterThan(0)
  runner.stop()
})
it('releases the worker after 60s paused and resumes saved fragments without repeating them', async () => {
  const { runner, counts, calls } = setup()
  runner.setEnabled(true); runner.setTrack(input); runner.setPosition(2, true)
  await vi.advanceTimersByTimeAsync(300)
  runner.setPosition(3, false)
  await vi.advanceTimersByTimeAsync(60001)
  expect(counts().disposed).toBeGreaterThan(0)
  runner.setPosition(19, true)
  await vi.advanceTimersByTimeAsync(3000)
  expect(calls.filter(c => c.request.type === 'transcribe')).toHaveLength(2)
  runner.stop()
})
it('accounts an uncancellable old decode before allowing the new track to start work', async () => {
  const { runner, deps } = setup()
  const starts: number[] = []
  deps.decode = async () => { starts.push(Date.now()); await new Promise(resolve => setTimeout(resolve, 100)); return { pcm: new Float32Array(480000), sampleRate: 16000, durationSec: 30 } }
  runner.setEnabled(true); runner.setTrack(input); runner.setPosition(2, true)
  await vi.advanceTimersByTimeAsync(20)
  runner.setTrack({ ...input, track: { ...input.track, dbId: 2 } })
  await vi.advanceTimersByTimeAsync(979)
  expect(starts).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(10)
  expect(starts).toHaveLength(2)
  expect(starts[1] - (starts[0] + 100)).toBeGreaterThanOrEqual(900)
  runner.stop()
  await vi.advanceTimersByTimeAsync(100)
})
it('pays the combined decode and BPM work debt before model initialization', async () => {
  const { runner, deps, calls } = setup()
  let bpmCalls = 0
  deps.estimateBpm = () => {
    bpmCalls++
    vi.setSystemTime(Date.now() + 10)
    return { value: null, confidence: 0 }
  }
  try {
    runner.setEnabled(true); runner.setTrack(input); runner.setPosition(2, true)
    await vi.advanceTimersByTimeAsync(150)
    expect(bpmCalls).toBe(1)
    expect(calls.filter(call => call.request.type === 'init')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls.filter(call => call.request.type === 'init')).toHaveLength(1)
    expect(calls.find(call => call.request.type === 'init')?.time).toBeGreaterThanOrEqual(200)
  } finally { runner.stop() }
})
it('reopens completed empty checkpoints without decoding or initializing another model', async () => {
  const first = setup()
  first.runner.setEnabled(true); first.runner.setTrack(input); first.runner.setPosition(2, true)
  await vi.advanceTimersByTimeAsync(4000)
  expect(first.counts().decodes).toBe(1)
  expect(first.counts().ensures).toBe(1) // both windows share one initialized worker
  first.runner.stop()
  const resumed = setup(first.saved()!)
  resumed.runner.setEnabled(true); resumed.runner.setTrack(input); resumed.runner.setPosition(18, true)
  await vi.advanceTimersByTimeAsync(4000)
  expect(resumed.runner.getSnapshot().phase).toBe('complete')
  expect(resumed.counts()).toEqual({ decodes: 0, ensures: 0, disposed: 0 })
  resumed.runner.stop()
})
it('persists a newly matched media endpoint as canonical source time and replays changed offset', async () => {
  const { runner, deps, writes } = setup()
  deps.worker = () => ({ dispose() {}, request: async (request) => request.type === 'init'
    ? { type: 'ready', jobId: request.jobId }
    : { type: 'result', jobId: request.jobId, fragmentId: request.fragmentId, elapsedMs: 1,
      words: [{ text: 'silver', startSec: 12.2, endSec: 12.7 }, { text: 'rivers', startSec: 13, endSec: 14 }] } })
  const song = { ...input, sourceLines: [{ timeSec: 17, text: 'Silver rivers' }], offsetMs: -5000 }
  runner.setEnabled(true); runner.setTrack(song); runner.setPosition(12, true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(writes.find(w => w.completedFragment)?.acceptedMatches?.ends).toEqual([
    { lineIndex: 0, sourceEndSec: 19, matchedMediaEndSec: 14, offsetAtMatchMs: -5000, confidence: 1 },
  ])
  expect(runner.getSnapshot().analysis.matchedEnds[0]?.endTimeSec).toBe(14)
  runner.setTrack({ ...song, offsetMs: -4000, lyricKey: 'lyrics@-4' })
  expect(runner.getSnapshot().analysis.matchedEnds[0]?.endTimeSec).toBe(15)
  runner.stop()
})
it('waits for a slow cache restore before position updates can start decoding', async () => {
  const { runner, deps, counts } = setup()
  deps.native.get = async () => { await new Promise(resolve => setTimeout(resolve, 1000)); return null }
  runner.setEnabled(true); runner.setTrack(input)
  await vi.advanceTimersByTimeAsync(20)
  runner.setPosition(2, true)
  await vi.advanceTimersByTimeAsync(500)
  expect(counts().decodes).toBe(0)
  runner.stop()
  await vi.advanceTimersByTimeAsync(500)
})

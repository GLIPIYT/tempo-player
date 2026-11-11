import { decodeForAnalysis, type AnalysisPcm } from '../../../audio/decodeForAnalysis'
import { withAnalysisLane } from '../../../audio/analysisLane'
import type { AudioIdentity } from './contract'
import type { AnalysisTrackInput } from './runner'
import { vocalNativeClient, type VocalNativeClient } from './vocalNativeClient'
import { createVocalWorker } from './vocalWorkerClient'
import { acquireAnalysisPcm, type AnalysisPcmLease } from './sharedPcm'
import { VOCAL_ALGORITHM_VERSION, VOCAL_MODEL_REVISION, VOCAL_HOP_SEC, VOCAL_CORE_SEC, VOCAL_CONTEXT_SEC,
  type VocalAnalysis, type VocalTimingEvidence, type VocalRequest, type VocalResponse } from './vocalContract'

export interface VocalSnapshot {
  lyricKey: string | null
  phase: 'idle' | 'loading' | 'analyzing' | 'waiting' | 'complete' | 'unavailable' | 'error'
  analysis: VocalTimingEvidence | null
  error: string | null
}
export interface VocalRunnerDependencies {
  native: VocalNativeClient
  decode: (identity: AudioIdentity, signal: AbortSignal) => Promise<AnalysisPcm | null>
  worker: () => { request(message: VocalRequest, signal: AbortSignal): Promise<VocalResponse>; dispose(): void }
  now: () => number
  modelBaseUrl: () => string
  wasmBaseUrl: () => string
}
const defaults: VocalRunnerDependencies = {
  native: vocalNativeClient, decode: decodeForAnalysis, worker: createVocalWorker, now: () => performance.now(),
  modelBaseUrl: () => new URL('/vocal-model/', location.href).href,
  wasmBaseUrl: () => new URL('/asr-runtime/', location.href).href,
}

export function createVocalAnalysisRunner(deps: VocalRunnerDependencies = defaults) {
  let enabled = false, playing = false, position = 0, generation = 0, busy = false, restoring = false
  let readyAt = 0
  let input: AnalysisTrackInput | null = null, identity: AudioIdentity | null = null
  let cache: VocalAnalysis | null = null, pcm: AnalysisPcm | null = null
  let pcmLease: AnalysisPcmLease | null = null
  let worker: ReturnType<VocalRunnerDependencies['worker']> | null = null
  let controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined
  let refreshPending = false
  let evidenceMemo: { cache: VocalAnalysis; offsetMs: number; value: VocalTimingEvidence } | null = null
  let snapshot: VocalSnapshot = { lyricKey: null, phase: 'idle', analysis: null, error: null }
  const listeners = new Set<() => void>()
  const release = () => {
    worker?.dispose(); worker = null
    const lease = pcmLease
    pcmLease = null; pcm = null
    lease?.release()
    clearTimeout(idleTimer)
  }
  const cancel = () => { generation++; controller.abort(); controller = new AbortController(); restoring = false; refreshPending = false; clearTimeout(timer); release() }
  const touchIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!busy) release(); else touchIdle() }, 60000) }
  function publish(phase = snapshot.phase, error: string | null = null) {
    let analysis: VocalTimingEvidence | null = null
    if (enabled && input && cache?.chunks.length) {
      if (evidenceMemo?.cache !== cache || evidenceMemo.offsetMs !== input.offsetMs) evidenceMemo = {
        cache, offsetMs: input.offsetMs, value: { analysis: cache, offsetMs: input.offsetMs },
      }
      analysis = evidenceMemo.value
    }
    const lyricKey = input?.lyricKey ?? null
    if (snapshot.phase === phase && snapshot.error === error && snapshot.analysis === analysis && snapshot.lyricKey === lyricKey) return
    snapshot = { phase, error, analysis, lyricKey }
    listeners.forEach(listener => listener())
  }
  async function charged<T>(work: () => Promise<T>): Promise<T> {
    const start = deps.now()
    try { return await work() }
    finally { readyAt = Math.max(readyAt, start) + Math.max(0, deps.now() - start) * 5 }
  }
  function nextWindow() {
    if (!identity || !cache) return null
    const count = Math.ceil(identity.durationSec / VOCAL_CORE_SEC)
    let best: { startSec: number; endSec: number; priority: number } | null = null
    for (let index = 0; index < count; index++) {
      const startSec = index * VOCAL_CORE_SEC, endSec = Math.min(identity.durationSec, startSec + VOCAL_CORE_SEC)
      if (cache.chunks.some(chunk => chunk.startSec <= startSec + .001 && chunk.endSec >= endSec - .001)) continue
      const priority = position >= startSec && position < endSec ? 0 : Math.abs(position - startSec) + 1
      if (!best || priority < best.priority) best = { startSec, endSec, priority }
    }
    return best
  }
  async function restore(job: number) {
    if (!input || !enabled) return
    restoring = true; publish('loading')
    try {
      const found = await deps.native.identity(input.track)
      if (job !== generation) return
      identity = found
      if (!found) { publish('unavailable'); return }
      const saved = await deps.native.get(found.fingerprint)
      if (job !== generation) return
      cache = saved?.algorithmVersion === VOCAL_ALGORITHM_VERSION && saved.modelRevision === VOCAL_MODEL_REVISION
        && saved.hopSec === VOCAL_HOP_SEC && Math.abs(saved.durationSec - found.durationSec) < .1 ? saved : {
          fingerprint: found.fingerprint, modelRevision: VOCAL_MODEL_REVISION, algorithmVersion: VOCAL_ALGORITHM_VERSION,
          durationSec: found.durationSec, hopSec: VOCAL_HOP_SEC, chunks: [],
        }
      publish('idle')
    } catch (error) { if (job === generation) publish('error', String(error)) }
    finally {
      if (job === generation) {
        restoring = false
        if (refreshPending && !identity) { refreshPending = false; void restore(generation) }
        else schedule()
      }
    }
  }
  function schedule() {
    clearTimeout(timer)
    if (!enabled || !playing || !input || !identity || !cache || restoring || busy || snapshot.phase === 'error' || snapshot.phase === 'unavailable') return
    if (!nextWindow()) { publish('complete'); release(); return }
    const delay = Math.max(0, readyAt - deps.now())
    publish(delay ? 'waiting' : 'idle')
    timer = setTimeout(() => { void run() }, delay)
  }
  async function run() {
    if (!enabled || !playing || !input || !identity || !cache || busy) return
    const job = generation, signal = controller.signal
    busy = true
    try {
      if (!pcm) {
        publish('analyzing')
        const lease = await charged(() => acquireAnalysisPcm(identity!, signal, deps.decode))
        if (signal.aborted) { lease?.release(); signal.throwIfAborted() }
        if (!lease) { publish('unavailable'); return }
        pcmLease = lease
        pcm = lease.pcm
        return // Pay decoding debt before allocating an inference session.
      }
      const core = nextWindow()
      if (!core) { publish('complete'); release(); return }
      const windowStartSec = Math.max(0, core.startSec - VOCAL_CONTEXT_SEC)
      const windowEndSec = Math.min(pcm.durationSec, core.endSec + VOCAL_CONTEXT_SEC)
      const samples = pcm.pcm.slice(Math.round(windowStartSec * 16000), Math.round(windowEndSec * 16000))
      await withAnalysisLane(signal, () => charged(async () => {
        publish('analyzing')
        if (!worker) {
          worker = deps.worker()
          await worker.request({ type: 'init', jobId: job, modelBaseUrl: deps.modelBaseUrl(), wasmBaseUrl: deps.wasmBaseUrl() }, signal)
        }
        signal.throwIfAborted()
        const response = await worker.request({ type: 'analyze', jobId: job, chunkId: `${core.startSec}:${core.endSec}`,
          windowStartSec, startSec: core.startSec, endSec: core.endSec, pcm: samples }, signal)
        signal.throwIfAborted()
        if (response.type !== 'result') throw new Error('Unexpected vocal analysis response')
        const saved = await deps.native.merge({ ...cache!, chunks: [response.chunk] })
        if (job === generation) { cache = saved; publish('idle') }
      }))
      touchIdle()
    } catch (error) {
      if (job === generation && !signal.aborted) { release(); publish('error', error instanceof Error ? error.message : String(error)) }
    } finally { busy = false; schedule() }
  }
  return {
    setEnabled(value: boolean) {
      if (enabled === value) return
      enabled = value
      if (!value) { cancel(); identity = null; cache = null; publish('idle') }
      else if (input) void restore(generation)
    },
    setTrack(value: AnalysisTrackInput | null) {
      const same = input && value && input.track.dbId === value.track.dbId && input.track.source === value.track.source && input.track.sourceId === value.track.sourceId
      if (same) { input = value; publish(); schedule(); return }
      cancel(); input = value; identity = null; cache = null; evidenceMemo = null
      publish(value && enabled ? 'loading' : 'idle')
      if (value && enabled) void restore(generation)
    },
    setPosition(value: number, isPlaying: boolean) {
      const wasPlaying = playing
      position = Number.isFinite(value) ? Math.max(0, value) : 0; playing = isPlaying
      if (!playing) { clearTimeout(timer); if (wasPlaying) touchIdle() } else schedule()
    },
    refreshAudioIdentity() {
      if (!input || !enabled || identity) return
      if (restoring) refreshPending = true
      else void restore(generation)
    },
    retry() {
      if ((snapshot.phase === 'error' || snapshot.phase === 'unavailable') && input && enabled) {
        cancel(); identity = null; cache = null; publish('loading'); void restore(generation)
      }
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    stop() { enabled = false; cancel(); input = null; identity = null; cache = null; evidenceMemo = null; publish('idle') },
  }
}
export const vocalAnalysisRunner = createVocalAnalysisRunner()

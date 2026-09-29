import type { LyricsLine } from '../types'
import { resolveLyricTiming, type LyricTimingAnalysis } from '../timingResolver'
import { analysisNativeClient, type AnalysisNativeClient, type AnalysisTrack } from './nativeClient'
import { LYRIC_ANALYSIS_ALGORITHM_VERSION, LYRIC_MODEL_REVISION, type AudioIdentity, type AudioAnalysis, type AnalysisMerge, type MatchedSourceEnd, type CompletedFragment } from './contract'
import { decodeForAnalysis, type AnalysisPcm } from '../../../audio/decodeForAnalysis'
import { withAnalysisLane } from '../../../audio/analysisLane'
import { estimateBpm } from '../../../audio/bpm'
import { lyricLanguage, matchLyricEnds, projectSourceEnds } from './matchWords'
import { createAsrWorker } from './workerClient'
import type { AsrRequest, AsrResponse } from './workerProtocol'
export interface AnalysisTrackInput { track: AnalysisTrack; sourceLines: readonly LyricsLine[]; durationSec: number; offsetMs: number; lyricKey: string; sourceLyricKey: string }
export interface AnalysisSnapshot { lyricKey: string | null; phase: 'idle' | 'loading' | 'analyzing' | 'waiting' | 'complete' | 'unavailable' | 'error'; analysis: LyricTimingAnalysis; error: string | null }
export interface RunnerDependencies {
  native: AnalysisNativeClient
  decode: (identity: AudioIdentity, signal: AbortSignal) => Promise<AnalysisPcm | null>
  worker: () => { request(message: AsrRequest, signal: AbortSignal): Promise<AsrResponse>; dispose(): void }
  now: () => number
  wasmBaseUrl: () => string
}
const defaults: RunnerDependencies = {
  native: analysisNativeClient, decode: decodeForAnalysis, worker: createAsrWorker,
  now: () => performance.now(), wasmBaseUrl: () => new URL('/asr-runtime/', location.href).href,
}

export function createLyricsAnalysisRunner(deps: RunnerDependencies = defaults) {
  let enabled = false, playing = false, position = 0, generation = 0, busy = false
  // Debt is a lifetime property of the runner, never of a track/provider/playback pass.
  let readyAt = 0
  let restoring: number | null = null
  let input: AnalysisTrackInput | null = null
  let identity: AudioIdentity | null = null, cache: AudioAnalysis | null = null, pcm: AnalysisPcm | null = null
  let worker: ReturnType<RunnerDependencies['worker']> | null = null
  let controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined
  let snapshot: AnalysisSnapshot = { lyricKey: null, phase: 'idle', analysis: { bpm: null, matchedEnds: [] }, error: null }
  const listeners = new Set<() => void>()

  const sourceEnds = (): MatchedSourceEnd[] => cache?.lyricMatches.find(m => m.sourceLyricKey === input?.sourceLyricKey)?.ends ?? []
  function publish(phase = snapshot.phase, error: string | null = null): void {
    snapshot = { lyricKey: input?.lyricKey ?? null, phase, error, analysis: {
      bpm: cache?.bpm != null ? { value: cache.bpm, confidence: cache.bpmConfidence } : null,
      matchedEnds: input ? projectSourceEnds(sourceEnds(), input.offsetMs, input.durationSec) : [],
    } }
    for (const listener of listeners) listener()
  }
  function release(): void { worker?.dispose(); worker = null; pcm = null; clearTimeout(idleTimer) }
  function cancel(): void {
    generation++; controller.abort(); controller = new AbortController()
    restoring = null
    clearTimeout(timer); release()
  }
  function touchIdle(): void {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { if (!busy) release(); else touchIdle() }, 60000)
  }
  function charged<T>(work: () => Promise<T>): Promise<T> {
    const start = deps.now()
    return work().finally(() => { const elapsed = Math.max(0, deps.now() - start); readyAt = Math.max(readyAt, deps.now() + elapsed * 9) })
  }
  function shiftedLines(): LyricsLine[] {
    return input?.sourceLines.map(line => ({ ...line, timeSec: line.timeSec + input!.offsetMs / 1000,
      endTimeSec: line.endTimeSec == null ? undefined : line.endTimeSec + input!.offsetMs / 1000,
      words: line.words?.map(word => ({ ...word, timeSec: word.timeSec + input!.offsetMs / 1000,
        endTimeSec: word.endTimeSec == null ? word.endTimeSec : word.endTimeSec + input!.offsetMs / 1000 })) })) ?? []
  }
  function matches(fragment: CompletedFragment): MatchedSourceEnd[] {
    if (!input) return []
    return matchLyricEnds(shiftedLines(), fragment.words, input.durationSec, fragment)
      .map(end => ({ lineIndex: end.lineIndex, sourceEndSec: end.endTimeSec - input!.offsetMs / 1000,
        matchedMediaEndSec: end.endTimeSec, offsetAtMatchMs: input!.offsetMs, confidence: end.confidence }))
  }
  function combineEnds(extra: MatchedSourceEnd[]): MatchedSourceEnd[] {
    const ends = new Map(sourceEnds().map(end => [end.lineIndex, end]))
    // Once accepted for this source, an offset change only projects the saved source end.
    for (const end of extra) if (!ends.has(end.lineIndex)) ends.set(end.lineIndex, end)
    return [...ends.values()]
  }
  async function checkpoint(update: Omit<AnalysisMerge, 'fingerprint' | 'algorithmVersion' | 'modelRevision'>, job: number): Promise<void> {
    if (!identity) return
    const saved = await deps.native.merge({ fingerprint: identity.fingerprint, algorithmVersion: LYRIC_ANALYSIS_ALGORITHM_VERSION,
      modelRevision: LYRIC_MODEL_REVISION, ...update })
    if (job === generation) { cache = saved; publish() }
  }
  async function restore(job: number, track: AnalysisTrack): Promise<void> {
    restoring = job
    try {
      const found = await deps.native.identity(track)
      if (job !== generation) return
      identity = found
      if (!found) { publish('unavailable'); return }
      const saved = await deps.native.get(found.fingerprint)
      if (job !== generation) return
      cache = saved
      // Reuse original words for a different provider even when recognition is disabled.
      const extra = (cache?.fragments ?? []).flatMap(matches)
      if (extra.length && combineEnds(extra).length > sourceEnds().length) {
        await checkpoint({ acceptedMatches: { sourceLyricKey: input!.sourceLyricKey, ends: combineEnds(extra) } }, job)
      }
      if (job !== generation) return
      publish('idle')
    } catch (error) { if (job === generation) publish('error', String(error)) }
    finally { if (restoring === job) { restoring = null; schedule() } }
  }
  function nextWindow() {
    if (!input) return null
    const accepted = new Set(sourceEnds().map(end => end.lineIndex))
    const lines = shiftedLines()
    const resolved = resolveLyricTiming(lines, input.durationSec, snapshot.analysis).lines
    const candidates = resolved.flatMap(line => {
      const language = lyricLanguage(line.text)
      if (!language || accepted.has(line.lineIndex) || line.endSource === 'manual' || line.endSource === 'source') return []
      const startSec = Math.max(0, Math.floor((line.endTimeSec - 6) * 50) / 50)
      const endSec = Math.min(input!.durationSec, Math.ceil((line.endTimeSec + 1) * 50) / 50)
      if (endSec <= startSec || (cache?.fragments ?? []).some(fragment => fragment.startSec <= startSec && fragment.endSec >= endSec)) return []
      const priority = position >= line.timeSec && position <= line.endTimeSec ? 0 : Math.abs(line.timeSec - position) + 1
      return [{ startSec, endSec, language, priority }]
    })
    return candidates.sort((a, b) => a.priority - b.priority)[0] ?? null
  }
  function schedule(): void {
    clearTimeout(timer)
    if (!enabled || !playing || !input || !identity || busy || restoring !== null || snapshot.phase === 'error' || snapshot.phase === 'unavailable') return
    if (!nextWindow()) { publish('complete'); release(); return }
    const delay = Math.max(0, readyAt - deps.now())
    publish(delay ? 'waiting' : 'idle')
    timer = setTimeout(() => { void run() }, delay)
  }
  async function run(): Promise<void> {
    if (busy || !enabled || !playing || !input || !identity) return
    const job = generation, signal = controller.signal
    busy = true
    try {
      if (!pcm) {
        publish('analyzing')
        // decodeForAnalysis owns the lane itself. Keep cancelled decode in it until it settles.
        const decoded = await charged(() => deps.decode(identity!, signal))
        signal.throwIfAborted()
        if (!decoded) { publish('unavailable'); return }
        pcm = decoded
        if (cache?.bpm == null) {
          const bpm = await withAnalysisLane(signal, () => charged(async () => estimateBpm(decoded.pcm, decoded.sampleRate)))
          if (bpm.value != null) await checkpoint({ bpm: { bpm: bpm.value, confidence: bpm.confidence } }, job)
        }
        return // Pay preprocessing debt before model initialization or inference.
      }
      const window = nextWindow()
      if (!window) { publish('complete'); release(); return }
      const bundle = worker ? null : await deps.native.ensureModel()
      signal.throwIfAborted()
      const audio = pcm
      await withAnalysisLane(signal, () => charged(async () => {
        if (!worker) {
          if (!bundle) throw new Error('Local model unavailable')
          worker = deps.worker()
          await worker.request({ type: 'init', jobId: job, bundle,
            artifactUrls: Object.fromEntries(bundle.files.map(file => [file.relativePath, deps.native.assetUrl(file.absolutePath)])), wasmBaseUrl: deps.wasmBaseUrl() }, signal)
        }
        signal.throwIfAborted()
        publish('analyzing')
        const fragmentId = `${window.startSec}:${window.endSec}`
        const fragmentPcm = audio.pcm.slice(Math.floor(window.startSec * 16000), Math.floor(window.endSec * 16000))
        const response = await worker.request({ type: 'transcribe', jobId: job, fragmentId,
          trackStartSec: window.startSec, sampleRate: 16000, pcm: fragmentPcm, language: window.language }, signal)
        signal.throwIfAborted()
        if (response.type !== 'result') throw new Error('Unexpected recognition response')
        const fragment: CompletedFragment = { startSec: window.startSec, endSec: window.endSec, status: 'completed', words: response.words }
        await checkpoint({ completedFragment: fragment,
          acceptedMatches: { sourceLyricKey: input!.sourceLyricKey, ends: combineEnds(matches(fragment)) } }, job)
      }))
      touchIdle()
    } catch (error) {
      if (job === generation && !signal.aborted) { release(); publish('error', error instanceof Error ? error.message : String(error)) }
    } finally { busy = false; schedule() }
  }
  return {
    setEnabled(value: boolean): void {
      if (enabled === value) return
      enabled = value
      if (!value) { cancel(); publish('idle'); if (input && !cache) void restore(generation, input.track) }
      else { publish('idle'); if (input && !identity) void restore(generation, input.track); else schedule() }
    },
    setTrack(value: AnalysisTrackInput | null): void {
      const sameTrack = input && value && input.track.dbId === value.track.dbId && input.track.source === value.track.source && input.track.sourceId === value.track.sourceId
      if (sameTrack) {
        const changedSource = input!.sourceLyricKey !== value!.sourceLyricKey
        input = value; publish()
        if (changedSource) {
          const ends = combineEnds((cache?.fragments ?? []).flatMap(matches))
          if (ends.length && input) void checkpoint({ acceptedMatches: { sourceLyricKey: input.sourceLyricKey, ends } }, generation).catch(error => publish('error', String(error)))
        }
        schedule(); return
      }
      cancel(); input = value; identity = null; cache = null
      publish(value ? 'loading' : 'idle')
      if (value) void restore(generation, value.track)
    },
    setPosition(value: number, isPlaying: boolean): void {
      position = Number.isFinite(value) ? Math.max(0, value) : 0; playing = isPlaying
      if (!playing) { clearTimeout(timer); touchIdle() } else schedule()
    },
    getSnapshot: (): AnalysisSnapshot => snapshot,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
    stop(): void { enabled = false; cancel(); input = null; identity = null; cache = null; publish('idle') },
  }
}

/** Constructing the singleton does no native calls, decoding, downloads or Worker allocation. */
export const lyricsAnalysisRunner = createLyricsAnalysisRunner()

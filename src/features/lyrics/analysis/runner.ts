import type { LyricsLine } from '../types'
import { resolveLyricTiming, type LyricTimingAnalysis, type ResolvedLyricsLine } from '../timingResolver'
import { analysisNativeClient, type AnalysisNativeClient, type AnalysisTrack } from './nativeClient'
import { LYRIC_ANALYSIS_ALGORITHM_VERSION, LYRIC_MODEL_REVISION, type AudioIdentity, type AudioAnalysis, type AnalysisMerge,
  type MatchedSourceEnd, type CompletedFragment, type CachedAlignedSourceLine } from './contract'
import { decodeForAnalysis, type AnalysisPcm } from '../../../audio/decodeForAnalysis'
import { withAnalysisLane } from '../../../audio/analysisLane'
import { estimateBpm } from '../../../audio/bpm'
import { lyricLanguage, matchLyricEnds, projectSourceEnds } from './matchWords'
import { canMatchLyricWordTimings, hasReliableSourceWordTimings, matchLyricWordTimings, projectLyricWordTimings, type MatchedLyricWords } from './matchWordTimings'
import { knownTextAlignmentKey, knownTextLineWindow, knownTextWords, matchCachedKnownText } from './knownTextAlignment'
import { createAsrWorker } from './workerClient'
import { acquireAnalysisPcm, type AnalysisPcmLease } from './sharedPcm'
import type { AsrRequest, AsrResponse } from './workerProtocol'
export interface AnalysisTrackInput { track: AnalysisTrack; sourceLines: readonly LyricsLine[]; durationSec: number; offsetMs: number; lyricKey: string; sourceLyricKey: string }
export interface AnalysisSnapshot {
  lyricKey: string | null
  phase: 'idle' | 'loading' | 'analyzing' | 'waiting' | 'paused' | 'complete' | 'unavailable' | 'error'
  analysis: LyricTimingAnalysis
  error: string | null
  unavailableReason: 'missing-file' | 'unreadable-file' | null
}
export interface RunnerDependencies {
  native: AnalysisNativeClient
  decode: (identity: AudioIdentity, signal: AbortSignal) => Promise<AnalysisPcm | null>
  estimateBpm?: typeof estimateBpm
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
  let identityRefreshPending = false
  let input: AnalysisTrackInput | null = null
  let identity: AudioIdentity | null = null, cache: AudioAnalysis | null = null, pcm: AnalysisPcm | null = null
  let pcmLease: AnalysisPcmLease | null = null
  let wordTimingsEnabled = false
  const attemptedAlignments = new Set<string>()
  let wordMatchMemo: { fragments: readonly CompletedFragment[]; alignedSources: readonly CachedAlignedSourceLine[];
    lines: readonly LyricsLine[]; sourceLyricKey: string;
    durationSec: number; matches: MatchedLyricWords[]; matchedWordLineIndices: Set<number>;
    sourceWordLineIndices: Set<number> } | null = null
  let analysisMemo: { cache: AudioAnalysis | null; lines: readonly LyricsLine[] | null; sourceLyricKey: string | null;
    offsetMs: number; durationSec: number; wordTimingsEnabled: boolean; value: LyricTimingAnalysis } | null = null
  let resolvedMemo: { sourceLines: readonly LyricsLine[]; offsetMs: number; durationSec: number;
    analysis: LyricTimingAnalysis; lines: ResolvedLyricsLine[] } | null = null
  let worker: ReturnType<RunnerDependencies['worker']> | null = null
  let controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined
  let snapshot: AnalysisSnapshot = { lyricKey: null, phase: 'idle', analysis: { bpm: null, matchedEnds: [] }, error: null, unavailableReason: null }
  const listeners = new Set<() => void>()

  const sourceEnds = (): MatchedSourceEnd[] => cache?.lyricMatches.find(m => m.sourceLyricKey === input?.sourceLyricKey)?.ends ?? EMPTY_SOURCE_ENDS
  function sourceWordMatches(): MatchedLyricWords[] {
    if (!input) return []
    const fragments = cache?.fragments ?? EMPTY_FRAGMENTS
    const alignedSources = cache?.alignedSources ?? EMPTY_ALIGNED_SOURCES
    if (wordMatchMemo?.fragments === fragments && wordMatchMemo.alignedSources === alignedSources && wordMatchMemo.lines === input.sourceLines
      && wordMatchMemo.sourceLyricKey === input.sourceLyricKey && wordMatchMemo.durationSec === input.durationSec) return wordMatchMemo.matches
    const byLine = new Map(matchLyricWordTimings(input.sourceLines, fragments, input.durationSec).map(match => [match.lineIndex, match]))
    for (const match of matchCachedKnownText(input.sourceLines, alignedSources, input.sourceLyricKey, input.durationSec)) byLine.set(match.lineIndex, match)
    const matches = [...byLine.values()].sort((left, right) => left.lineIndex - right.lineIndex)
    const matchedWordLineIndices = new Set(matches.map(match => match.lineIndex))
    const ordered = input.sourceLines.map((line, lineIndex) => ({ line, lineIndex }))
      .filter(item => Number.isFinite(item.line.timeSec)).sort((a, b) => a.line.timeSec - b.line.timeSec || a.lineIndex - b.lineIndex)
    const nextStarts = new Map<number, number>()
    let nextStart: number | undefined
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const line = ordered[index]
      if (nextStart !== undefined && nextStart > line.line.timeSec) nextStarts.set(line.lineIndex, nextStart)
      if (index === 0 || ordered[index - 1].line.timeSec !== line.line.timeSec) nextStart = line.line.timeSec
    }
    const sourceWordLineIndices = new Set<number>()
    input.sourceLines.forEach((line, lineIndex) => {
      if (hasReliableSourceWordTimings(line, input!.durationSec, nextStarts.get(lineIndex))) sourceWordLineIndices.add(lineIndex)
    })
    wordMatchMemo = { fragments, alignedSources, lines: input.sourceLines, sourceLyricKey: input.sourceLyricKey,
      durationSec: input.durationSec, matches, matchedWordLineIndices, sourceWordLineIndices }
    return matches
  }
  function currentAnalysis(): LyricTimingAnalysis {
    const lines = input?.sourceLines ?? null
    const sourceLyricKey = input?.sourceLyricKey ?? null
    const offsetMs = input?.offsetMs ?? 0
    const durationSec = input?.durationSec ?? 0
    if (analysisMemo?.cache === cache && analysisMemo.lines === lines && analysisMemo.sourceLyricKey === sourceLyricKey
      && analysisMemo.offsetMs === offsetMs && analysisMemo.durationSec === durationSec
      && analysisMemo.wordTimingsEnabled === wordTimingsEnabled) return analysisMemo.value
    const value: LyricTimingAnalysis = {
      bpm: cache?.bpm != null ? { value: cache.bpm, confidence: cache.bpmConfidence } : null,
      matchedEnds: input ? projectSourceEnds(sourceEnds(), offsetMs, durationSec) : [],
      ...(input && wordTimingsEnabled ? { matchedWords: projectLyricWordTimings(sourceWordMatches(), offsetMs) } : {}),
    }
    analysisMemo = { cache, lines, sourceLyricKey, offsetMs, durationSec, wordTimingsEnabled, value }
    return value
  }
  function resolvedSourceLines(): ResolvedLyricsLine[] {
    if (!input) return []
    const analysis = currentAnalysis()
    if (resolvedMemo?.sourceLines === input.sourceLines && resolvedMemo.offsetMs === input.offsetMs
      && resolvedMemo.durationSec === input.durationSec && resolvedMemo.analysis === analysis) return resolvedMemo.lines
    const lines = resolveLyricTiming(shiftedLines(), input.durationSec, analysis).lines
    resolvedMemo = { sourceLines: input.sourceLines, offsetMs: input.offsetMs, durationSec: input.durationSec, analysis, lines }
    return lines
  }
  function publish(phase = snapshot.phase, error: string | null = null,
    unavailableReason?: AnalysisSnapshot['unavailableReason']): void {
    snapshot = { lyricKey: input?.lyricKey ?? null, phase, error, analysis: currentAnalysis(),
      unavailableReason: phase === 'unavailable' ? unavailableReason ?? snapshot.unavailableReason : null }
    for (const listener of listeners) listener()
  }
  function release(): void {
    worker?.dispose(); worker = null
    const lease = pcmLease
    pcmLease = null; pcm = null
    lease?.release()
    clearTimeout(idleTimer)
  }
  function cancel(): void {
    generation++; controller.abort(); controller = new AbortController()
    restoring = null
    identityRefreshPending = false
    clearTimeout(timer); release()
  }
  function touchIdle(): void {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { if (!busy) release(); else touchIdle() }, 60000)
  }
  function charged<T>(work: () => Promise<T>): Promise<T> {
    const start = deps.now()
    return work().finally(() => {
      const elapsed = Math.max(0, deps.now() - start)
      // Unpaid earlier work accumulates even when preprocessing stages run back-to-back.
      readyAt = Math.max(readyAt, start) + elapsed * 10
    })
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
      .filter(end => {
        const sourceLine = input!.sourceLines[end.lineIndex]
        const explicitEnd = sourceLine?.endTimeSec ?? sourceLine?.words?.at(-1)?.endTimeSec
        // Word-only recognition must never replace or persist an endpoint for a
        // line whose source already provides one; the source endpoint stays exact.
        return !(explicitEnd != null && Number.isFinite(explicitEnd) && explicitEnd > sourceLine.timeSec)
      })
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
      if (!found) { publish('unavailable', null, 'missing-file'); return }
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
    finally {
      if (restoring === job) {
        restoring = null
        const retry = identityRefreshPending && !identity && input !== null
        identityRefreshPending = false
        if (retry) { publish('loading'); void restore(generation, input!.track) }
        else schedule()
      }
    }
  }
  type AnalysisWindow =
    | { kind: 'transcribe'; startSec: number; endSec: number; language: 'en' | 'ru'; priority: number }
    | { kind: 'align'; alignmentId: string; cacheKey: string; lineIndex: number; text: string;
        sourceLyricKey: string; startSec: number; endSec: number; language: 'en' | 'ru'; priority: number }
  function nextWindow(): AnalysisWindow | null {
    if (!input) return null
    const accepted = new Set(sourceEnds().map(end => end.lineIndex))
    const sourceWordLineIndices = wordTimingsEnabled ? wordMatchMemo?.sourceWordLineIndices ?? EMPTY_LINE_INDICES : EMPTY_LINE_INDICES
    const candidates = resolvedSourceLines().flatMap(line => {
      const language = lyricLanguage(line.text)
      if (!language) return []
      const sourceLine = input!.sourceLines[line.lineIndex]
      const needsEnd = !accepted.has(line.lineIndex) && line.endSource !== 'manual' && line.endSource !== 'source'
      const needsWords = wordTimingsEnabled && canMatchLyricWordTimings(line.text) && !sourceWordLineIndices.has(line.lineIndex)
        && !sourceLine.words?.length
      if (!needsEnd && !needsWords) return []
      const startSec = Math.max(0, Math.floor((line.endTimeSec - 6) * 50) / 50)
      const endSec = Math.min(input!.durationSec, Math.ceil((line.endTimeSec + 1) * 50) / 50)
      const priority = position >= line.timeSec && position <= line.endTimeSec ? 0 : Math.abs(line.timeSec - position) + 1
      const result: AnalysisWindow[] = []
      if (needsEnd && endSec > startSec && !(cache?.fragments ?? []).some(fragment => fragment.startSec <= startSec && fragment.endSec >= endSec)) {
        result.push({ kind: 'transcribe', startSec, endSec, language, priority })
      }
      if (needsWords) {
        const window = knownTextLineWindow(input!.sourceLines, line.lineIndex, input!.durationSec)
        if (window) {
          const cacheKey = knownTextAlignmentKey(input!.sourceLyricKey, line.lineIndex, sourceLine.text, window.startSec, window.endSec)
          const exists = (cache?.alignedSources ?? EMPTY_ALIGNED_SOURCES).some(source => source.sourceLyricKey === input!.sourceLyricKey
            && source.lineIndex === line.lineIndex && source.sourceText === sourceLine.text
            && source.sourceStartSec === window.startSec && source.sourceEndSec === window.endSec)
          if (!exists && !attemptedAlignments.has(cacheKey)) {
            const alignmentId = `${generation}:${line.lineIndex}:${window.startSec}:${window.endSec}`
            result.push({ kind: 'align', alignmentId, cacheKey, lineIndex: line.lineIndex, text: sourceLine.text,
              sourceLyricKey: input!.sourceLyricKey, startSec: window.startSec, endSec: window.endSec, language,
              priority: Math.abs(sourceLine.timeSec - position) + 0.5 })
          }
        }
      }
      return result
    })
    return candidates.sort((a, b) => a.priority - b.priority)[0] ?? null
  }
  function schedule(): void {
    clearTimeout(timer)
    if (!enabled || !input || !identity || busy || restoring !== null || snapshot.phase === 'error' || snapshot.phase === 'unavailable') return
    if (!nextWindow()) { publish('complete'); release(); return }
    if (!playing) { publish('paused'); return }
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
        const lease = await charged(() => acquireAnalysisPcm(identity!, signal, deps.decode))
        if (signal.aborted) { lease?.release(); signal.throwIfAborted() }
        if (!lease) { publish('unavailable', null, 'unreadable-file'); return }
        const audio = lease.pcm
        pcmLease = lease
        pcm = audio
        if (cache?.bpm == null) {
          const bpm = await withAnalysisLane(signal, () => charged(async () => (deps.estimateBpm ?? estimateBpm)(audio.pcm, audio.sampleRate)))
          if (bpm.value != null) await checkpoint({ bpm: { bpm: bpm.value, confidence: bpm.confidence } }, job)
        }
        return // Pay preprocessing debt before model initialization or inference.
      }
      const window = nextWindow()
      if (!window) { publish('complete'); release(); return }
      // A timer firing means this track is now doing real work. Do not leave
      // the settings status at “queued” while model or worker initialization runs.
      publish('analyzing')
      const bundle = worker ? null : await deps.native.ensureModel()
      signal.throwIfAborted()
      const audio = pcm
      await withAnalysisLane(signal, async () => {
        if (!worker) {
          if (!bundle) throw new Error('Local model unavailable')
          worker = deps.worker()
          await worker.request({ type: 'init', jobId: job, bundle,
            artifactUrls: Object.fromEntries(bundle.files.map(file => [file.relativePath, deps.native.assetUrl(file.absolutePath)])), wasmBaseUrl: deps.wasmBaseUrl() }, signal)
        }
        signal.throwIfAborted()
        publish('analyzing')
        const fragmentPcm = audio.pcm.slice(Math.floor(window.startSec * 16000), Math.floor(window.endSec * 16000))
        await charged(async () => {
          if (window.kind === 'align') {
            const response = await worker!.request({ type: 'align-known-text', jobId: job, alignmentId: window.alignmentId,
              trackStartSec: window.startSec, sourceEndSec: window.endSec, sampleRate: 16000,
              pcm: fragmentPcm, language: window.language, text: window.text }, signal)
            signal.throwIfAborted()
            if (response.type !== 'alignment') throw new Error('Unexpected known-text alignment response')
            if (job !== generation || input?.sourceLyricKey !== window.sourceLyricKey) return
            const currentLine = input.sourceLines[window.lineIndex]
            const currentWindow = knownTextLineWindow(input.sourceLines, window.lineIndex, input.durationSec)
            if (!currentLine || currentLine.text !== window.text || currentWindow?.startSec !== window.startSec
              || currentWindow.endSec !== window.endSec) return
            attemptedAlignments.add(window.cacheKey)
            if (response.words.length && Number.isFinite(response.confidence) && response.confidence >= 0.001) {
              const expectedWords = knownTextWords(window.text)
              if (response.words.length !== expectedWords.length || response.words.some((word, index) => word.text !== expectedWords[index].text)) return
              const alignedSource: CachedAlignedSourceLine = { sourceLyricKey: window.sourceLyricKey,
                lineIndex: window.lineIndex, sourceText: window.text, sourceStartSec: window.startSec,
                sourceEndSec: window.endSec, confidence: response.confidence, words: response.words }
              await checkpoint({ alignedSource }, job)
            }
          } else {
            const fragmentId = `${window.startSec}:${window.endSec}`
            const response = await worker!.request({ type: 'transcribe', jobId: job, fragmentId,
              trackStartSec: window.startSec, sampleRate: 16000, pcm: fragmentPcm, language: window.language }, signal)
            signal.throwIfAborted()
            if (response.type !== 'result') throw new Error('Unexpected recognition response')
            const fragment: CompletedFragment = { startSec: window.startSec, endSec: window.endSec, status: 'completed', words: response.words }
            await checkpoint({ completedFragment: fragment,
              acceptedMatches: { sourceLyricKey: input!.sourceLyricKey, ends: combineEnds(matches(fragment)) } }, job)
          }
        })
      })
      touchIdle()
    } catch (error) {
      if (job === generation && !signal.aborted) { release(); publish('error', error instanceof Error ? error.message : String(error)) }
    } finally { busy = false; schedule() }
  }
  return {
    /** Explicit availability signal only; never fetches audio or ensures a model. */
    refreshAudioIdentity(): void {
      if (!input || identity) return
      if (restoring !== null) { identityRefreshPending = true; return }
      publish('loading')
      void restore(generation, input.track)
    },
    setEnabled(value: boolean): void {
      if (enabled === value) return
      enabled = value
      if (!value) { cancel(); publish('idle'); if (input && !cache) void restore(generation, input.track) }
      else {
        publish('idle')
        if (input && !identity) { if (restoring === null) void restore(generation, input.track) }
        else schedule()
      }
    },
    setWordTimingsEnabled(value: boolean): void {
      if (wordTimingsEnabled === value) return
      wordTimingsEnabled = value
      publish()
      schedule()
    },
    setTrack(value: AnalysisTrackInput | null): void {
      const sameTrack = input && value && input.track.dbId === value.track.dbId && input.track.source === value.track.source && input.track.sourceId === value.track.sourceId
      if (sameTrack) {
        const changedSource = input!.sourceLyricKey !== value!.sourceLyricKey
        if (changedSource) attemptedAlignments.clear()
        input = value; publish()
        if (changedSource) {
          const ends = combineEnds((cache?.fragments ?? []).flatMap(matches))
          if (ends.length && input) void checkpoint({ acceptedMatches: { sourceLyricKey: input.sourceLyricKey, ends } }, generation).catch(error => publish('error', String(error)))
        }
        schedule(); return
      }
      cancel(); attemptedAlignments.clear(); input = value; identity = null; cache = null
      publish(value ? 'loading' : 'idle')
      if (value) void restore(generation, value.track)
    },
    setPosition(value: number, isPlaying: boolean): void {
      position = Number.isFinite(value) ? Math.max(0, value) : 0; playing = isPlaying
      if (!playing) {
        clearTimeout(timer)
        touchIdle()
      }
      schedule()
    },
    retry(): void {
      if (snapshot.phase !== 'error' && snapshot.phase !== 'unavailable') return
      if (snapshot.phase === 'unavailable' && input) {
        cancel(); identity = null; cache = null; publish('loading'); void restore(generation, input.track)
        return
      }
      publish('idle')
      schedule()
    },
    getSnapshot: (): AnalysisSnapshot => snapshot,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
    stop(): void { enabled = false; wordTimingsEnabled = false; cancel(); attemptedAlignments.clear(); input = null; identity = null; cache = null; wordMatchMemo = null; publish('idle') },
  }
}

const EMPTY_FRAGMENTS: readonly CompletedFragment[] = []
const EMPTY_ALIGNED_SOURCES: readonly CachedAlignedSourceLine[] = []
const EMPTY_LINE_INDICES = new Set<number>()
const EMPTY_SOURCE_ENDS: MatchedSourceEnd[] = []

/** Constructing the singleton does no native calls, decoding, downloads or Worker allocation. */
export const lyricsAnalysisRunner = createLyricsAnalysisRunner()

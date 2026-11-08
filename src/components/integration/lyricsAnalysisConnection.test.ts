import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import { lyricsService, lyricSliceAt, lyricSourceKey } from '../../features/lyrics/lyricsService'
import { createLyricsAnalysisRunner } from '../../features/lyrics/analysis/runner'
import { LYRIC_ANALYSIS_ALGORITHM_VERSION, LYRIC_MODEL_REVISION, type AudioAnalysis } from '../../features/lyrics/analysis/contract'
import { connectLyricsAnalysis, needsLyricsAnalysis, needsLyricsWordTimings } from './lyricsAnalysisConnection'
import type { UnifiedTrack } from '../../types/models'

vi.mock('../../api/client', () => ({ api: { getLyricsOverride: vi.fn(), getTrackLyrics: vi.fn(), fetchOnlineLyrics: vi.fn() } }))
const track: UnifiedTrack = { source: 'local', sourceId: '1', dbId: 1, title: 'song', artists: ['singer'], album: null,
  durationSec: 40, coverPath: null, playable: true, localPath: '/audio.wav', externalUrl: null, gainDb: null }
const result = { kind: 'synced' as const, lines: [{ timeSec: 17, text: 'Silver rivers' }, { timeSec: 27, text: 'Golden mountains' }] }
const key = lyricSourceKey(result, 'manual')
const cache: AudioAnalysis = { fingerprint: 'audio', durationSec: 40, algorithmVersion: LYRIC_ANALYSIS_ALGORITHM_VERSION,
  modelRevision: LYRIC_MODEL_REVISION, bpm: 120, bpmConfidence: 1, fragments: [], lyricMatches: [{ sourceLyricKey: key,
    ends: [{ lineIndex: 0, sourceEndSec: 19, matchedMediaEndSec: 14, offsetAtMatchMs: -5000, confidence: 1 }] }] }
beforeEach(() => { vi.useFakeTimers(); lyricsService.invalidate(); vi.resetAllMocks(); vi.mocked(api.getLyricsOverride).mockReturnValue(new Promise(() => {})) })
afterEach(() => { vi.useRealTimers() })

describe('main playback connection without an overlay', () => {
  it.each([.5, 1, 2])('restores disabled saved ends, publishes baseline immediately and uses media seconds at %s×', async rate => {
    let audioWork = 0
    let resolveCache!: (value: AudioAnalysis) => void
    const saved = new Promise<AudioAnalysis>(resolve => { resolveCache = resolve })
    const runner = createLyricsAnalysisRunner({
      now: () => Date.now(), wasmBaseUrl: () => 'http://localhost/asr-runtime/',
      native: { identity: async () => ({ fingerprint: 'audio', absolutePath: '/audio.wav', fileSize: 1000, durationSec: 40, sampleRate: 16000, channels: 1 }),
        get: () => saved, merge: async () => cache, ensureModel: async () => { audioWork++; throw Error('unexpected model') }, assetUrl: value => value },
      decode: async () => { audioWork++; return null }, worker: () => { audioWork++; throw Error('unexpected worker') },
    })
    let snapshot = { currentTrack: track as UnifiedTrack | null, position: 0, isPlaying: true, playbackRate: rate, duration: 40, preparing: false }
    const listeners = new Set<() => void>()
    const player = { getSnapshot: () => snapshot, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const disconnect = connectLyricsAnalysis({ player, runner, lyrics: lyricsService, lifecycle: { setSchedulingAllowed: () => {} }, cacheOnline: () => false })
    try {
      lyricsService.setActiveCandidate('1', result, 40, key, -5000)
      expect(lyricsService.getCurrent()?.timing.lines[0].endSource).toBe('text')
      await vi.advanceTimersByTimeAsync(0)
      resolveCache(cache); await vi.advanceTimersByTimeAsync(0)
      expect(lyricsService.getCurrent()?.timing.lines[0]).toMatchObject({ timeSec: 12, endTimeSec: 14, endSource: 'recognized' })
      const wallSeconds = 13 / rate
      snapshot = { ...snapshot, position: wallSeconds * rate }; listeners.forEach(listener => listener())
      expect(lyricSliceAt(lyricsService.getCurrent()!.timing, snapshot.position).text).toBe('Silver rivers')
      snapshot = { ...snapshot, position: 14 }; listeners.forEach(listener => listener())
      expect(lyricSliceAt(lyricsService.getCurrent()!.timing, snapshot.position).text).toBeNull()
      lyricsService.setActiveCandidate('1', result, 40, key, -4000)
      snapshot = { ...snapshot, position: 12 }; listeners.forEach(listener => listener())
      expect(lyricsService.getCurrent()?.timing.lines[0]).toMatchObject({ timeSec: 13, endTimeSec: 15 })
      await vi.advanceTimersByTimeAsync(100000)
      expect(audioWork).toBe(0)
      snapshot = { ...snapshot, currentTrack: null }; listeners.forEach(listener => listener())
      expect(runner.getSnapshot().lyricKey).toBeNull()
      expect(lyricsService.getCurrent()).toBeNull()
    } finally { disconnect() }
  })
  it('does not analyze fully authored/source-timed lyrics; mixed lyrics keep their original indices', () => {
    expect(needsLyricsAnalysis([{ text: '', timeSec: 0 }, { text: 'one', timeSec: 1, endTimeSec: 3, endSource: 'manual' },
      { text: 'two', timeSec: 4, words: [{ text: 'two', timeSec: 4, endTimeSec: 5 }] }])).toBe(false)
    expect(needsLyricsAnalysis([{ text: 'one', timeSec: 1, endTimeSec: 3 }, { text: 'two', timeSec: 4 }])).toBe(true)
  })
  it('gates word timing work on explicit opt-in even when manual line ends are already present', async () => {
    const wordResult = { kind: 'synced' as const, lines: [{ timeSec: 1, text: 'Silver rivers carry dreams', endTimeSec: 5, endSource: 'manual' as const }] }
    const sourceKey = lyricSourceKey(wordResult, 'manual')
    expect(needsLyricsAnalysis(wordResult.lines)).toBe(false)
    expect(needsLyricsWordTimings(wordResult.lines)).toBe(true)
    expect(needsLyricsWordTimings([{ ...wordResult.lines[0], words: [
      { text: 'Silver', timeSec: 1, endTimeSec: 1.4 }, { text: 'rivers', timeSec: 1.5, endTimeSec: 2 },
      { text: 'carry', timeSec: 2.2, endTimeSec: 2.6 }, { text: 'dreams', timeSec: 3, endTimeSec: 4 },
    ] }])).toBe(false)
    expect(needsLyricsWordTimings([{ timeSec: 1, text: 'Extraordinary', endTimeSec: 5, endSource: 'manual' }])).toBe(false)

    const runner = createLyricsAnalysisRunner({
      now: () => Date.now(), wasmBaseUrl: () => 'http://localhost/asr-runtime/',
      native: { identity: async () => null, get: async () => null, merge: async () => cache,
        ensureModel: async () => { throw Error('unexpected model') }, assetUrl: value => value },
      decode: async () => null, worker: () => { throw Error('unexpected worker') },
    })
    let wordMode = false
    const scheduling: boolean[] = []
    const disconnect = connectLyricsAnalysis({ player: { getSnapshot: () => ({ currentTrack: track, position: 0, isPlaying: false,
      playbackRate: 1, duration: 40, preparing: false }), subscribe: () => () => {} }, runner, lyrics: lyricsService,
      lifecycle: { setSchedulingAllowed(value) { scheduling.push(value) } }, cacheOnline: () => false,
      wordTimingsEnabled: () => wordMode })
    try {
      lyricsService.setActiveCandidate('1', wordResult, 40, sourceKey)
      expect(scheduling.at(-1)).toBe(false)
      wordMode = true; disconnect.update()
      expect(scheduling.at(-1)).toBe(true)
      wordMode = false; disconnect.update()
      expect(scheduling.at(-1)).toBe(false)
    } finally { disconnect() }
  })
})

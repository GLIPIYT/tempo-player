import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import { lyricsService, lyricSliceAt, lyricSourceKey } from '../../features/lyrics/lyricsService'
import { createLyricsAnalysisRunner } from '../../features/lyrics/analysis/runner'
import { LYRIC_ANALYSIS_ALGORITHM_VERSION, LYRIC_MODEL_REVISION, type AudioAnalysis } from '../../features/lyrics/analysis/contract'
import { connectLyricsAnalysis, needsLyricsAnalysis } from './lyricsAnalysisConnection'
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
    let snapshot = { currentTrack: track as UnifiedTrack | null, position: 0, isPlaying: true, playbackRate: rate }
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
})

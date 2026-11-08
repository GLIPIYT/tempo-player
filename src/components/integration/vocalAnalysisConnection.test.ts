import { describe, expect, it, vi } from 'vitest'
import type { UnifiedTrack } from '../../types/models'
import type { CurrentLyrics } from '../../features/lyrics/lyricsService'
import { VOCAL_ALGORITHM_VERSION, VOCAL_HOP_SEC, VOCAL_MODEL_REVISION,
  type VocalAnalysis, type VocalTimingEvidence } from '../../features/lyrics/analysis/vocalContract'
import { connectVocalAnalysis } from './vocalAnalysisConnection'
import type { LyricsLine } from '../../features/lyrics/types'

const track = { dbId: 1, source: 'local', sourceId: 'media-1', title: 'Song', artists: ['Artist'] } as UnifiedTrack

function currentLyrics(generation: number, lyricKey: string, lines: LyricsLine[] = [{ timeSec: 5, text: 'Silver rivers' }]): CurrentLyrics {
  const synced = { kind: 'synced' as const, lines }
  return { trackId: track.sourceId, provider: 'local', result: synced, sourceResult: synced, lyricKey,
    sourceLyricKey: `source-${lyricKey}`, offsetMs: -250, durationSec: 32, generation,
    timing: { lines: [], segments: [] } as CurrentLyrics['timing'] }
}

function vocalEvidence(): VocalTimingEvidence {
  const analysis: VocalAnalysis = { fingerprint: 'audio', modelRevision: VOCAL_MODEL_REVISION,
    algorithmVersion: VOCAL_ALGORITHM_VERSION, durationSec: 32, hopSec: VOCAL_HOP_SEC, chunks: [
      { startSec: 0, endSec: 20, voice: [210], energy: [170], flux: [25] },
    ] }
  return { analysis, offsetMs: -250 }
}

function fixture(options: { preparing?: boolean; wordMode?: boolean; current?: CurrentLyrics } = {}) {
  let playerSnapshot = { currentTrack: track, position: 9, isPlaying: true, duration: 32, preparing: options.preparing ?? false }
  const current = { value: options.current ?? currentLyrics(1, 'lyric-a') }
  const playerListeners = new Set<() => void>()
  const lyricListeners = new Set<() => void>()
  const runnerListeners = new Set<() => void>()
  const runnerSnapshot = { value: { lyricKey: null as string | null, phase: 'idle' as const, analysis: null as VocalTimingEvidence | null, error: null } }
  const published: { trackId: string; lyricKey: string; generation: number; analysis: VocalTimingEvidence | null }[] = []
  const player = {
    getSnapshot: () => playerSnapshot,
    subscribe: vi.fn((listener: () => void) => { playerListeners.add(listener); return () => playerListeners.delete(listener) }),
  }
  const lyrics = {
    getCurrent: vi.fn(() => current.value),
    subscribe: vi.fn((listener: () => void) => { lyricListeners.add(listener); return () => lyricListeners.delete(listener) }),
    ensure: vi.fn(),
    publishVocalAnalysis: vi.fn((trackId: string, lyricKey: string, generation: number, analysis: VocalTimingEvidence | null) => {
      const latest = current.value
      if (!latest || latest.trackId !== trackId || latest.lyricKey !== lyricKey || latest.generation !== generation) return false
      published.push({ trackId, lyricKey, generation, analysis })
      return true
    }),
  }
  const runner = {
    getSnapshot: vi.fn(() => runnerSnapshot.value),
    setTrack: vi.fn(),
    setPosition: vi.fn(),
    refreshAudioIdentity: vi.fn(),
    stop: vi.fn(),
    subscribe: vi.fn((listener: () => void) => { runnerListeners.add(listener); return () => runnerListeners.delete(listener) }),
  }
  const cacheReady = { handler: (_sourceId: string) => {}, removed: vi.fn() }
  const connection = connectVocalAnalysis({ player, lyrics, runner, cacheOnline: () => true,
    wordTimingsEnabled: () => options.wordMode ?? false,
    listenCacheReady: async (handler: (sourceId: string) => void) => { cacheReady.handler = handler; return cacheReady.removed },
  } as unknown as Parameters<typeof connectVocalAnalysis>[0])

  return {
    connection, player, lyrics, runner, current, published, cacheReady, runnerSnapshot,
    setPlayer(value: Partial<typeof playerSnapshot>) { playerSnapshot = { ...playerSnapshot, ...value } },
    notifyPlayer() { playerListeners.forEach(listener => listener()) },
    notifyLyrics() { lyricListeners.forEach(listener => listener()) },
    notifyRunner() { runnerListeners.forEach(listener => listener()) },
  }
}

describe('vocal analysis connection', () => {
  it('forwards current lyric generations and ignores results from a replaced source', () => {
    const f = fixture()
    expect(f.lyrics.ensure).toHaveBeenCalledWith(track, true)
    expect(f.runner.setPosition).toHaveBeenCalledWith(9, true)
    expect(f.runner.setTrack).toHaveBeenCalledWith({ track, sourceLines: [{ timeSec: 5, text: 'Silver rivers' }],
      durationSec: 32, offsetMs: -250, lyricKey: 'lyric-a', sourceLyricKey: 'source-lyric-a' })

    const firstEvidence = vocalEvidence()
    f.runnerSnapshot.value = { lyricKey: 'lyric-a', phase: 'idle', analysis: firstEvidence, error: null }
    f.notifyRunner()
    expect(f.published).toHaveLength(1)
    expect(f.published[0]).toMatchObject({ trackId: 'media-1', lyricKey: 'lyric-a', generation: 1, analysis: firstEvidence })

    f.current.value = currentLyrics(2, 'lyric-b', [{ timeSec: 7, text: 'New source words' }])
    f.notifyLyrics()
    expect(f.runner.setTrack).toHaveBeenLastCalledWith({ track, sourceLines: [{ timeSec: 7, text: 'New source words' }],
      durationSec: 32, offsetMs: -250, lyricKey: 'lyric-b', sourceLyricKey: 'source-lyric-b' })
    f.notifyRunner()
    expect(f.published).toHaveLength(1)

    const secondEvidence = { ...firstEvidence, offsetMs: 500 }
    f.runnerSnapshot.value = { lyricKey: 'lyric-b', phase: 'idle', analysis: secondEvidence, error: null }
    f.notifyRunner()
    expect(f.published.at(-1)).toMatchObject({ trackId: 'media-1', lyricKey: 'lyric-b', generation: 2, analysis: secondEvidence })
    expect(f.lyrics.publishVocalAnalysis).toHaveBeenCalledWith('media-1', 'lyric-b', 2, secondEvidence)

    f.current.value = currentLyrics(3, 'lyric-c', [{ timeSec: 7, text: 'Fixed line', endTimeSec: 12, endSource: 'source' }])
    f.notifyLyrics()
    expect(f.runner.setTrack).toHaveBeenLastCalledWith(null)
    expect(f.lyrics.publishVocalAnalysis).toHaveBeenLastCalledWith('media-1', 'lyric-c', 3, null)

    f.connection()
    expect(f.runner.stop).toHaveBeenCalledTimes(1)
  })

  it('refreshes identity only for the active cache source and removes async listeners on disconnect', async () => {
    const f = fixture({ preparing: true })
    await Promise.resolve()

    f.cacheReady.handler('other-media')
    expect(f.runner.refreshAudioIdentity).not.toHaveBeenCalled()
    f.cacheReady.handler('media-1')
    expect(f.runner.refreshAudioIdentity).toHaveBeenCalledTimes(1)

    f.setPlayer({ preparing: false })
    f.notifyPlayer()
    expect(f.runner.refreshAudioIdentity).toHaveBeenCalledTimes(2)
    f.notifyPlayer()
    expect(f.runner.refreshAudioIdentity).toHaveBeenCalledTimes(2)

    f.connection()
    expect(f.cacheReady.removed).toHaveBeenCalledTimes(1)
    expect(f.runner.stop).toHaveBeenCalledTimes(1)
    f.cacheReady.handler('media-1')
    f.notifyPlayer()
    expect(f.runner.refreshAudioIdentity).toHaveBeenCalledTimes(2)
    expect(f.player.subscribe.mock.calls).toHaveLength(1)
    expect(f.lyrics.subscribe.mock.calls).toHaveLength(1)
    expect(f.runner.subscribe.mock.calls).toHaveLength(1)
  })

  it('schedules word analysis only when enabled and the current lyrics lack word timings', () => {
    const sourceWithLineEnd = currentLyrics(4, 'lyric-words', [
      { timeSec: 5, text: 'Silver rivers', endTimeSec: 10, endSource: 'source' },
    ])
    const f = fixture({ current: sourceWithLineEnd })
    expect(f.runner.setTrack).toHaveBeenLastCalledWith(null)

    const wordEnabled = fixture({ current: sourceWithLineEnd, wordMode: true })
    expect(wordEnabled.runner.setTrack).toHaveBeenLastCalledWith({ track,
      sourceLines: [{ timeSec: 5, text: 'Silver rivers', endTimeSec: 10, endSource: 'source' }],
      durationSec: 32, offsetMs: -250, lyricKey: 'lyric-words', sourceLyricKey: 'source-lyric-words' })
    f.connection()
    wordEnabled.connection()
  })
})

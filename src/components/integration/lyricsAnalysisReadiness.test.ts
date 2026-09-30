import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import { lyricsService, lyricSourceKey, lyricSliceAt } from '../../features/lyrics/lyricsService'
import { createLyricsAnalysisRunner } from '../../features/lyrics/analysis/runner'
import { LYRIC_ANALYSIS_ALGORITHM_VERSION, LYRIC_MODEL_REVISION, type AudioAnalysis } from '../../features/lyrics/analysis/contract'
import { connectLyricsAnalysis } from './lyricsAnalysisConnection'
import type { UnifiedTrack } from '../../types/models'

vi.mock('../../api/client', () => ({ api: { getLyricsOverride: vi.fn(), getTrackLyrics: vi.fn(), fetchOnlineLyrics: vi.fn() } }))
const track: UnifiedTrack = { source: 'soundcloud', sourceId: 'existing', dbId: 1, title: 'Song', artists: ['Artist'], album: null,
  durationSec: null, coverPath: null, playable: true, localPath: null, externalUrl: null, gainDb: null }
const result = { kind: 'synced' as const, lines: [{ timeSec: 17, text: 'Silver rivers' },
  { timeSec: 39, text: 'A long phrase still singing beyond the final second of the recording' }] }
const key = lyricSourceKey(result, 'lrclib')
const saved: AudioAnalysis = { fingerprint: 'file', algorithmVersion: LYRIC_ANALYSIS_ALGORITHM_VERSION, modelRevision: LYRIC_MODEL_REVISION,
  durationSec: 40, bpm: 120, bpmConfidence: 1, fragments: [], lyricMatches: [{ sourceLyricKey: key,
    ends: [{ lineIndex: 0, sourceEndSec: 19, matchedMediaEndSec: 14, offsetAtMatchMs: -5000, confidence: 1 }] }] }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
beforeEach(() => { vi.useFakeTimers(); lyricsService.invalidate(); vi.resetAllMocks(); vi.mocked(api.getLyricsOverride).mockReturnValue(new Promise(() => {})) })
afterEach(() => vi.useRealTimers())

function fixture(options: { available?: boolean; enabled?: boolean; durationSec?: number | null; delayedIdentity?: boolean } = {}) {
  let available = options.available ?? false, identityCalls = 0, expensiveWork = 0
  let releaseIdentity = () => {}
  let cacheReady: (sourceId: string) => void = () => {}
  const media = { fingerprint: 'file', absolutePath: '/file', fileSize: 100, durationSec: 40, sampleRate: 16000, channels: 1 }
  const identityGate = options.delayedIdentity ? new Promise<void>(resolve => { releaseIdentity = resolve }) : Promise.resolve()
  const runner = createLyricsAnalysisRunner({ now: () => Date.now(), wasmBaseUrl: () => '',
    native: { identity: async () => { identityCalls++; const identity = available ? media : null; if (identityCalls === 1) await identityGate; return identity },
      get: async () => saved, merge: async () => saved, ensureModel: async () => { expensiveWork++; throw Error('unexpected model') }, assetUrl: value => value },
    decode: async () => { expensiveWork++; return null }, worker: () => { expensiveWork++; throw Error('unexpected worker') } })
  let snapshot = { currentTrack: { ...track, durationSec: options.durationSec ?? null } as UnifiedTrack | null,
    position: 0, isPlaying: true, playbackRate: 1, duration: 0, preparing: false }
  const listeners = new Set<() => void>()
  const disconnect = connectLyricsAnalysis({ player: { getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    runner, lyrics: lyricsService, lifecycle: { setSchedulingAllowed: allowed => runner.setEnabled(options.enabled === true && allowed) },
    cacheOnline: () => false, listenCacheReady: async handler => { cacheReady = handler; return () => { cacheReady = () => {} } } })
  lyricsService.setActiveCandidate(track.sourceId, result, options.durationSec ?? null, key, -5000)
  return { runner, disconnect, available: () => { available = true }, releaseIdentity,
    counts: () => ({ identityCalls, expensiveWork }), ready: (id = track.sourceId) => cacheReady(id),
    emit: (patch: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()) } }
}

describe('analysis readiness and actual media duration', () => {
  it('restores an existing row when its current SoundCloud cache completes, without polling or disabled audio work', async () => {
    const f = fixture({ durationSec: 40 })
    try {
      await flush(); expect(f.runner.getSnapshot().phase).toBe('unavailable')
      for (let position = 0; position < 10; position += .1) f.emit({ position })
      f.ready('another'); f.ready(''); await flush()
      expect(f.counts()).toEqual({ identityCalls: 1, expensiveWork: 0 })
      f.available(); f.ready(); f.ready(); await flush()
      expect(f.counts()).toEqual({ identityCalls: 2, expensiveWork: 0 })
      expect(lyricsService.getCurrent()?.timing.lines[0]).toMatchObject({ timeSec: 12, endTimeSec: 14, endSource: 'recognized' })
      f.ready(); await vi.advanceTimersByTimeAsync(100000)
      expect(f.counts()).toEqual({ identityCalls: 2, expensiveWork: 0 })
    } finally { f.disconnect() }
  })
  it('coalesces completion received during an old unavailable identity lookup', async () => {
    const f = fixture({ delayedIdentity: true, durationSec: 40 })
    try {
      await flush(); f.available(); f.ready(); f.ready(); f.releaseIdentity(); await flush()
      expect(f.counts().identityCalls).toBe(2)
      expect(lyricsService.getCurrent()?.timing.lines[0].endSource).toBe('recognized')
      f.emit({ currentTrack: null }); f.ready(); await flush()
      expect(f.counts().identityCalls).toBe(2)
      expect(lyricsService.getCurrent()).toBeNull()
    } finally { f.releaseIdentity(); f.disconnect() }
  })
  it('discards a queued readiness retry when the track clears during identity lookup', async () => {
    const f = fixture({ delayedIdentity: true, durationSec: 40 })
    try {
      await flush(); f.available(); f.ready(); f.emit({ currentTrack: null }); f.releaseIdentity(); await flush()
      expect(f.counts()).toEqual({ identityCalls: 1, expensiveWork: 0 })
      expect(f.runner.getSnapshot().lyricKey).toBeNull()
      expect(lyricsService.getCurrent()).toBeNull()
    } finally { f.releaseIdentity(); f.disconnect() }
  })
  it('deduplicates media readiness but leaves one cache-completion retry after streaming fallback', async () => {
    const f = fixture({ durationSec: 40 })
    try {
      await flush(); f.emit({ preparing: true }); f.emit({ preparing: false }); await flush()
      expect(f.counts().identityCalls).toBe(2)
      f.emit({ preparing: true }); f.emit({ preparing: false }); f.emit({ duration: 40 }); await flush()
      expect(f.counts().identityCalls).toBe(2)
      f.available(); f.ready(); f.ready(); await flush()
      expect(f.counts()).toEqual({ identityCalls: 3, expensiveWork: 0 })
      expect(f.runner.getSnapshot().analysis.matchedEnds[0]?.endTimeSec).toBe(14)
    } finally { f.disconnect() }
  })
  it.each([null, 0, 65])('uses actual duration over metadata %s without candidate/generation refetch', async metadata => {
    const f = fixture({ available: true, durationSec: metadata })
    try {
      await flush()
      const initial = lyricsService.getCurrent()!
      f.emit({ duration: 40 }); await flush()
      const current = lyricsService.getCurrent()!
      expect(current.durationSec).toBe(40)
      expect(current.generation).toBe(initial.generation)
      expect(current.sourceResult).toBe(initial.sourceResult)
      expect(current.offsetMs).toBe(-5000)
      expect(current.timing.lines[0]).toMatchObject({ timeSec: 12, endTimeSec: 14, endSource: 'recognized' })
      expect(current.timing.lines[1].endTimeSec).toBeLessThanOrEqual(40)
      expect(lyricSliceAt(current.timing, 40).text).toBeNull()
      // Overlay supplying the same candidate with metadata cannot replace actual duration.
      lyricsService.setActiveCandidate(track.sourceId, result, metadata, key, -5000)
      expect(lyricsService.getCurrent()?.durationSec).toBe(40)
      expect(lyricsService.getCurrent()?.generation).toBe(initial.generation)
      expect(api.getLyricsOverride).toHaveBeenCalledTimes(1)
    } finally { f.disconnect() }
  })
  it('a known media duration gives the enabled runner a valid analysis window', async () => {
    const f = fixture({ available: true, enabled: true })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(f.counts().expensiveWork).toBe(0)
      f.emit({ duration: 40 }); await vi.advanceTimersByTimeAsync(1)
      expect(f.counts().expensiveWork).toBe(1) // decode requested for the remaining future phrase
    } finally { f.disconnect() }
  })
  it('enabling during an initial identity lookup does not duplicate that lookup or lose its readiness retry', async () => {
    const f = fixture({ enabled: true, delayedIdentity: true, durationSec: 40 })
    try {
      await flush(); expect(f.counts().identityCalls).toBe(1)
      f.available(); f.ready(); f.releaseIdentity(); await vi.advanceTimersByTimeAsync(1)
      expect(f.counts()).toEqual({ identityCalls: 2, expensiveWork: 1 })
    } finally { f.releaseIdentity(); f.disconnect() }
  })
})

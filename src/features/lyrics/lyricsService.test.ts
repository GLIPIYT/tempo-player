import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import { lyricSliceAt, lyricSourceKey, lyricsService } from './lyricsService'
import { lyricTimingAt } from './timingResolver'
import { projectSourceEnds } from './analysis/matchWords'
import type { LyricsOverride } from '../../types/models'

vi.mock('../../api/client', () => ({ api: { getLyricsOverride: vi.fn(), getTrackLyrics: vi.fn(), fetchOnlineLyrics: vi.fn(), setTrackLyrics: vi.fn() } }))
const track = (id: string) => ({ sourceId: id, source: 'local' as const, title: id, artists: [], dbId: 1, durationSec: 40 })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const pin = (text: string): LyricsOverride => ({ provider: 'manual', sourceArtist: null, sourceTitle: null, lrc: `[00:01.00]${text}`, offsetMs: 0, updatedAt: 1 })
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

describe('shared lyrics selection', () => {
  beforeEach(() => { vi.resetAllMocks(); lyricsService.invalidate() })
  it('rejects an old track fetch after B has resolved', async () => {
    const old = deferred<LyricsOverride>()
    vi.mocked(api.getLyricsOverride).mockReturnValueOnce(old.promise).mockResolvedValueOnce(pin('B'))
    lyricsService.ensure(track('A'), false); lyricsService.ensure(track('B'), false)
    await flush(); old.resolve(pin('A')); await flush()
    expect(lyricsService.getCurrent()?.trackId).toBe('B')
  })
  it('rejects a same-track response invalidated by a new fetch', async () => {
    const old = deferred<LyricsOverride>()
    vi.mocked(api.getLyricsOverride).mockReturnValueOnce(old.promise).mockResolvedValueOnce(pin('new'))
    lyricsService.ensure(track('A'), false); lyricsService.invalidate('A'); lyricsService.ensure(track('A'), false)
    await flush(); old.resolve(pin('old')); await flush()
    expect(lyricSliceAt(lyricsService.getCurrent()!.result, 1).text).toBe('new')
  })
  it('does not lead the actual start and releases the final phrase', () => {
    const result = { kind: 'synced' as const, lines: [{ timeSec: 10, endTimeSec: 12, text: 'one' }] }
    expect(lyricSliceAt(result, 9.8).text).toBeNull()
    expect(lyricSliceAt(result, 10).text).toBe('one')
    expect(lyricSliceAt(result, 12).text).toBeNull()
  })
  it('keeps every simultaneous phrase', () => {
    expect(lyricSliceAt({ kind: 'synced', lines: [{ timeSec: 1, text: 'one' }, { timeSec: 1, text: 'two' }] }, 1).text).toBe('one\ntwo')
  })
  it('an explicit selection invalidates a pending fetch and old analysis tokens', async () => {
    const pending = deferred<LyricsOverride>()
    vi.mocked(api.getLyricsOverride).mockReturnValue(pending.promise)
    lyricsService.ensure(track('A'), false)
    const result = { kind: 'synced' as const, lines: [{ timeSec: 17, text: 'chosen words' }] }
    lyricsService.setActiveCandidate('A', result, 40, lyricSourceKey(result, 'one'))
    const first = lyricsService.getCurrent()!
    lyricsService.setActiveCandidate('A', result, 40, lyricSourceKey(result, 'two'))
    expect(lyricsService.publishAnalysis('A', first.lyricKey, first.generation, { bpm: null, matchedEnds: [{ lineIndex: 0, endTimeSec: 38, confidence: 1 }] })).toBe(false)
    pending.resolve(pin('old')); await flush()
    expect(lyricsService.getCurrent()?.sourceLyricKey).toBe(lyricSourceKey(result, 'two'))
    const old = lyricsService.getCurrent()!
    lyricsService.invalidate('A'); lyricsService.ensure(track('A'), false)
    lyricsService.setActiveCandidate('A', result, 40, old.sourceLyricKey)
    expect(lyricsService.publishAnalysis('A', old.lyricKey, old.generation, { bpm: null, matchedEnds: [] })).toBe(false)
  })
  it('uses current offset once on accepted source ends, and keeps overlay and Discord identical', () => {
    vi.mocked(api.getLyricsOverride).mockReturnValue(new Promise(() => {}))
    lyricsService.ensure(track('A'), false); lyricsService.setPosition(0)
    const result = { kind: 'synced' as const, lines: [{ timeSec: 17, text: 'chosen words' }] }
    const accepted = [{ lineIndex: 0, sourceEndSec: 19, matchedMediaEndSec: 14, offsetAtMatchMs: -5000, confidence: 1 }]
    const key = lyricSourceKey(result, 'manual')
    for (const [offsetMs, start, end] of [[-5000, 12, 14], [-4000, 13, 15], [2000, 19, 21], [22000, 39, 40]]) {
      lyricsService.setActiveCandidate('A', result, 40, key, offsetMs)
      const active = lyricsService.getCurrent()!
      expect(lyricsService.publishAnalysis('A', active.lyricKey, active.generation, { bpm: null,
        matchedEnds: projectSourceEnds(accepted, offsetMs, 40) })).toBe(true)
      const timing = lyricsService.getCurrent()!.timing
      expect(timing.segments.find(segment => segment.kind === 'line')).toMatchObject({ timeSec: start, endTimeSec: end })
      for (const position of [start - .1, start, end - .1, end, end + 1]) {
        const segment = timing.segments[lyricTimingAt(timing, position).segmentIndex]
        expect(lyricSliceAt(timing, position).text).toBe(segment?.kind === 'line' ? 'chosen words' : null)
      }
      expect(lyricSliceAt(timing, end).text).toBeNull()
    }
  })
  it('preserves active editor ends/words and never borrows an inactive document', async () => {
    const saved: LyricsOverride = { ...pin('one'), offsetMs: 2000,
      editorDocument: { mode: 'synced', lines: [{ text: 'one', startMs: 1000, endMs: 4000,
        words: [{ text: 'one', startMs: 1000, endMs: 3500 }] }] } }
    vi.mocked(api.getLyricsOverride).mockResolvedValue(saved)
    lyricsService.setPosition(0); lyricsService.ensure(track('A'), false); await flush()
    expect(lyricsService.getCurrent()?.timing.lines[0]).toMatchObject({ timeSec: 3, endTimeSec: 6, endSource: 'manual', words: [{ timeSec: 3, endTimeSec: 5.5 }] })
    expect(lyricsService.getCurrent()?.sourceResult).toMatchObject({ lines: [{ timeSec: 1, endTimeSec: 4 }] })
    lyricsService.invalidate()
    vi.mocked(api.getLyricsOverride).mockResolvedValue({ ...saved, provider: 'other', lrc: '[00:10.00]different',
      editedVersion: { provider: 'manual', sourceArtist: null, sourceTitle: null, lrc: saved.lrc, offsetMs: 0, updatedAt: 1 } })
    lyricsService.ensure(track('A'), false); await flush()
    expect(lyricsService.getCurrent()?.timing.lines[0]).toMatchObject({ timeSec: 12, text: 'different', endSource: 'text' })
  })
})

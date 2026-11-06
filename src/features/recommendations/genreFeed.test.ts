import { describe, expect, it } from 'vitest'
import type { ScTrack } from '../../types/models'
import type { TasteProfile } from './profile'
import { refillGenreRecommendations } from './genreFeed'

const track = (id: string, genre = 'Ambient', title = `Track ${id}`): ScTrack => ({
  id,
  title,
  artist: `Uploader ${id}`,
  durationMs: 180_000,
  artworkUrl: null,
  artistAvatarUrl: null,
  permalinkUrl: null,
  streamable: true,
  hasProgressive: true,
  hasHls: false,
  genre,
  tags: null,
})

const profile = (): TasteProfile => ({
  tracks: [], seeds: [], languages: {}, languageConfidence: 0, unknownShare: 1, confidence: 0,
  artists: {}, genres: {}, tags: {}, versions: {}, tempo: null, features: new Map(), groups: {},
})

describe('genre recommendation refill', () => {
  it('continues after one accepted track and empty filtered pages until the shelf is filled', async () => {
    const remaining = Array.from({ length: 23 }, (_, index) => track(`fill-${index}`))
    const pages = new Map([
      [null, { tracks: [track('first'), track('unsupported', 'Ambient', 'مرحبا بالعالم')], nextCursor: 'cursor-1' }],
      ['cursor-1', { tracks: [track('wrong-genre', 'House')], nextCursor: 'cursor-2' }],
      ['cursor-2', { tracks: remaining, nextCursor: 'cursor-3' }],
    ])
    const requested: (string | null)[] = []
    const appendedCounts: number[] = []
    let lastCursor: string | null = null

    const result = await refillGenreRecommendations({
      genreKey: 'ambient', profile: profile(), tracks: [],
      loadedTrackIds: new Set(), seenCursors: new Set(), startCursor: null,
      fillTarget: 24, pageBudget: 6,
      fetchPage: async cursor => {
        requested.push(cursor)
        const page = pages.get(cursor)
        if (!page) throw new Error(`Unexpected cursor: ${cursor}`)
        return page
      },
      onAppend: (_tracks, appended) => { appendedCounts.push(appended.length) },
      onCursor: cursor => { lastCursor = cursor },
    })

    expect(requested).toEqual([null, 'cursor-1', 'cursor-2'])
    expect(appendedCounts).toEqual([1, 23])
    expect(result.tracks).toHaveLength(24)
    expect(result.tracks.map(item => item.id)).not.toContain('unsupported')
    expect(result.pages).toBe(3)
    expect(result.cursor).toBe('cursor-3')
    expect(lastCursor).toBe('cursor-3')
  })

  it('keeps the failed continuation cursor available for a provider retry', async () => {
    const loadedTrackIds = new Set<string>()
    const seenCursors = new Set<string>()
    let lastCursor: string | null = null
    const saved: ScTrack[] = []

    await expect(refillGenreRecommendations({
      genreKey: 'ambient', profile: profile(), tracks: [], loadedTrackIds, seenCursors,
      startCursor: null, fillTarget: 24, pageBudget: 6,
      fetchPage: async cursor => cursor === null
        ? { tracks: [track('first')], nextCursor: 'cursor-1' }
        : { tracks: [], nextCursor: null, error: 'SoundCloud rate limited' },
      onAppend: merged => { saved.splice(0, saved.length, ...merged) },
      onCursor: cursor => { lastCursor = cursor },
    })).rejects.toThrow('SoundCloud rate limited')

    expect(saved.map(item => item.id)).toEqual(['first'])
    expect(lastCursor).toBe('cursor-1')
    expect(seenCursors.has('cursor-1')).toBe(false)

    const retry = await refillGenreRecommendations({
      genreKey: 'ambient', profile: profile(), tracks: saved, loadedTrackIds, seenCursors,
      startCursor: lastCursor, fillTarget: 24, pageBudget: 6,
      fetchPage: async cursor => {
        expect(cursor).toBe('cursor-1')
        return { tracks: [track('second')], nextCursor: null }
      },
      onAppend: merged => { saved.splice(0, saved.length, ...merged) },
      onCursor: cursor => { lastCursor = cursor },
    })

    expect(retry.tracks.map(item => item.id)).toEqual(['first', 'second'])
    expect(lastCursor).toBeNull()
  })
})

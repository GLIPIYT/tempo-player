import { describe, expect, it } from 'vitest'
import type { ScTrack } from '../../types/models'
import type { TasteProfile } from './profile'
import { genreShelfTracks, refillGenreRecommendations } from './genreFeed'

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
      fillTarget: 24, pageBudget: 6, minimumPages: 3,
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
    expect(appendedCounts).toEqual([24])
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

  it('shuffles the two-page initial batch and continues from its cursor', async () => {
    const firstPage = Array.from({ length: 24 }, (_, index) => track(`first-${index}`))
    const pages = new Map([
      [null, { tracks: firstPage, nextCursor: 'cursor-1' }],
      ['cursor-1', { tracks: [track('second-1'), track('second-2')], nextCursor: 'cursor-2' }],
      ['cursor-2', { tracks: [track('third-1'), track('third-2')], nextCursor: 'cursor-3' }],
      ['cursor-3', { tracks: [track('later-1'), track('later-2')], nextCursor: null }],
    ])
    const loadInitial = async (random: () => number) => {
      const requested: (string | null)[] = []
      const appendedCounts: number[] = []
      const loadedTrackIds = new Set<string>()
      const seenCursors = new Set<string>()
      const result = await refillGenreRecommendations({
        genreKey: 'ambient', profile: profile(), tracks: [], loadedTrackIds, seenCursors,
        startCursor: null, fillTarget: 30, pageBudget: 2, minimumPages: 2, random,
        fetchPage: async cursor => {
          requested.push(cursor)
          const page = pages.get(cursor)
          if (!page) throw new Error(`Unexpected cursor: ${cursor}`)
          return page
        },
        onAppend: (_tracks, appended) => { appendedCounts.push(appended.length) },
      })
      return { ...result, loadedTrackIds, seenCursors, requested, appendedCounts }
    }

    const firstRun = await loadInitial(() => 0)
    const secondRun = await loadInitial(() => 0.999999)
    expect(firstRun.requested).toEqual([null, 'cursor-1'])
    expect(firstRun.pages).toBe(2)
    expect(firstRun.tracks).toHaveLength(26)
    expect(firstRun.appendedCounts).toEqual([26])
    expect(firstRun.tracks.map(item => item.id)).not.toEqual([
      ...firstPage.map(item => item.id), 'second-1', 'second-2',
    ])
    expect(secondRun.tracks.map(item => item.id)).not.toEqual(firstRun.tracks.map(item => item.id))

    const more = await refillGenreRecommendations({
      genreKey: 'ambient', profile: profile(), tracks: firstRun.tracks,
      loadedTrackIds: firstRun.loadedTrackIds, seenCursors: firstRun.seenCursors,
      startCursor: firstRun.cursor, fillTarget: 2, pageBudget: 6, minimumPages: 1, random: () => 0.999999,
      fetchPage: async cursor => {
        expect(cursor).toBe('cursor-2')
        return pages.get(cursor)!
      },
    })
    expect(more.tracks.slice(0, firstRun.tracks.length)).toEqual(firstRun.tracks)
    expect(more.tracks.slice(firstRun.tracks.length).map(item => item.id)).toEqual(['third-1', 'third-2'])
    expect(more.cursor).toBe('cursor-3')

    const later = await refillGenreRecommendations({
      genreKey: 'ambient', profile: profile(), tracks: more.tracks,
      loadedTrackIds: firstRun.loadedTrackIds, seenCursors: firstRun.seenCursors,
      startCursor: more.cursor, fillTarget: 2, pageBudget: 6, minimumPages: 1, random: () => 0.999999,
      fetchPage: async cursor => {
        expect(cursor).toBe('cursor-3')
        return pages.get(cursor)!
      },
    })
    expect(later.tracks.slice(0, more.tracks.length)).toEqual(more.tracks)
    expect(later.tracks.slice(more.tracks.length).map(item => item.id)).toEqual(['later-1', 'later-2'])
  })

  it('shows main-feed matches only after the genre request fails', () => {
    const fallback = track('fallback')
    const provider = track('provider')
    expect(genreShelfTracks([], [fallback], 'ambient', profile(), null)).toEqual([])
    expect(genreShelfTracks([], [fallback], 'ambient', profile(), 'SoundCloud failed')).toEqual([fallback])
    expect(genreShelfTracks([provider], [fallback], 'ambient', profile(), 'SoundCloud failed')).toEqual([provider])
  })
})

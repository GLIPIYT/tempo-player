import { describe, expect, it } from 'vitest'
import type { Track } from '../../types/models'
import { generateCustomMix } from './rules'
import { createCustomMixRule, type CustomMixCandidate } from './types'

function candidate(id: number, patch: Partial<Track> = {}, options: Partial<CustomMixCandidate> = {}): CustomMixCandidate {
  const track: Track = {
    id, path: `C:/music/${id}.mp3`, title: `Track ${id}`, artistId: 1, artistName: 'Artist',
    albumId: null, albumTitle: null, trackNumber: null, discNumber: null, durationSec: 180,
    year: null, genre: null, coverPath: null, fileSize: 0, modifiedAt: 0, addedAt: 0,
    source: 'local', externalId: null, lastPlayedAt: null, playCount: 0, skipCount: 0,
    gainDb: null, peakDb: null,
    ...patch,
  }
  return { track, averageCompletionPercent: null, historyMinutes: [], liked: false, metadataTrusted: true, ...options }
}

function baseRule() {
  return createCustomMixRule('Test mix')
}

describe('generateCustomMix', () => {
  it('keeps an empty rule valid and returns distinct tracks with a repeatable seed', () => {
    const rule = baseRule()
    const candidates = [candidate(4), candidate(2), candidate(3), candidate(1), candidate(2)]
    const first = generateCustomMix(rule, candidates, { limit: 4, seed: 'same' })
    const second = generateCustomMix(rule, candidates, { limit: 4, seed: 'same' })
    expect(first).toEqual(second)
    expect(first.tracks).toHaveLength(4)
    expect(new Set(first.tracks.map((track) => track.id)).size).toBe(4)
    expect(first.warnings).toEqual([])
  })

  it('defaults to 24 tracks and supports the full 50-track cap', () => {
    const rule = baseRule()
    const tracks = Array.from({ length: 60 }, (_, index) => candidate(index + 1))

    expect(generateCustomMix(rule, tracks).tracks).toHaveLength(24)
    const max = generateCustomMix(rule, tracks, { limit: 60, seed: 1 })
    expect(max.requestedCount).toBe(50)
    expect(max.tracks).toHaveLength(50)
  })

  it('validates description length, count bounds, and ten-minute refresh steps', () => {
    const rule = baseRule()
    rule.description = 'x'.repeat(151)
    rule.trackCount = 51
    rule.refreshIntervalMinutes = 15

    expect(generateCustomMix(rule, []).warnings).toEqual([
      'Description must be 150 characters or fewer.',
      'Track count must be an integer from 1 to 50.',
      'Refresh interval must use 10-minute steps from 0 to 1440.',
    ])
  })

  it('selects the genre and forgotten quotas jointly', () => {
    const now = new Date(2026, 0, 1, 12).getTime() / 1000
    const rule = baseRule()
    rule.genres = ['ambient']
    rule.genrePercent = [50, 50]
    rule.specials = ['forgotten']
    rule.forgottenPercent = [50, 50]
    rule.forgottenDays = [30, 60]
    const day = 86_400
    const tracks = [
      candidate(1, { genre: 'Ambient', lastPlayedAt: now - 40 * day }),
      candidate(2, { genre: 'Ambient', lastPlayedAt: now - 40 * day }),
      candidate(3, { genre: 'Ambient', lastPlayedAt: now - day }),
      candidate(4, { genre: 'Ambient', lastPlayedAt: now - day }),
      candidate(5, { genre: 'Rock', lastPlayedAt: now - 40 * day }),
      candidate(6, { genre: 'Rock', lastPlayedAt: now - 40 * day }),
      candidate(7, { genre: 'Rock', lastPlayedAt: now - day }),
      candidate(8, { genre: 'Rock', lastPlayedAt: now - day }),
    ]
    const result = generateCustomMix(rule, tracks, { now, limit: 8, seed: 12 })
    const selected = result.tracks
    expect(selected.filter((track) => track.genre === 'Ambient')).toHaveLength(4)
    expect(selected.filter((track) => track.lastPlayedAt === now - 40 * day)).toHaveLength(4)
    expect(result.warnings).toEqual([])
  })

  it('reports mutually infeasible quotas and returns the closest available mix', () => {
    const now = 2_000_000
    const rule = baseRule()
    rule.genres = ['ambient']
    rule.genrePercent = [75, 100]
    rule.specials = ['forgotten']
    rule.forgottenPercent = [75, 100]
    rule.forgottenDays = [30, 60]
    const day = 86_400
    const tracks = [
      ...Array.from({ length: 6 }, (_, index) => candidate(index + 1, { genre: 'Ambient', lastPlayedAt: now - day })),
      ...Array.from({ length: 6 }, (_, index) => candidate(index + 7, { genre: 'Rock', lastPlayedAt: now - 40 * day })),
    ]
    const result = generateCustomMix(rule, tracks, { now, limit: 12, seed: 19 })
    expect(result.tracks).toHaveLength(12)
    expect(result.warnings).toContain('Genre and forgotten-track targets cannot both be met with the available tracks.')
  })

  it('filters by average completion and allows unknown history only for the full range', () => {
    const rule = baseRule()
    const tracks = [
      candidate(1, {}, { averageCompletionPercent: 80 }),
      candidate(2, {}, { averageCompletionPercent: 45 }),
      candidate(3),
    ]
    expect(generateCustomMix(rule, tracks, { limit: 3, seed: 1 }).tracks).toHaveLength(3)
    rule.completionPercent = [70, 100]
    const result = generateCustomMix(rule, tracks, { limit: 3, seed: 1 })
    expect(result.tracks.map((track) => track.id)).toEqual([1])
    expect(result.warnings[0]).toContain('Only 1 track matches')
  })

  it('matches listening-time windows and current hour against local history minutes', () => {
    const rule = baseRule()
    rule.timeWindow = [0, 30]
    rule.specials = ['currentHour']
    const result = generateCustomMix(rule, [
      candidate(1, {}, { historyMinutes: [615] }),
      candidate(2, {}, { historyMinutes: [659] }),
      candidate(3, {}, { historyMinutes: [690] }),
      candidate(4),
    ], { now: new Date(2026, 1, 2, 10, 12), limit: 4, seed: 2 })
    expect(result.tracks.map((track) => track.id).sort()).toEqual([1, 2])
    expect(result.warnings).toContain('Only 2 tracks match these rules; 4 requested.')
  })

  it('strictly excludes denied artists and genres', () => {
    const rule = baseRule()
    rule.artistMode = 'deny'
    rule.artistIds = [2]
    rule.genreMode = 'deny'
    rule.genres = ['rock']
    const result = generateCustomMix(rule, [
      candidate(1, { artistId: 2, genre: 'Pop' }),
      candidate(2, { artistId: 3, genre: 'Rock' }),
      candidate(3, { artistId: 3, genre: 'Pop' }),
    ], { limit: 3, seed: 4 })
    expect(result.tracks.map((track) => track.id)).toEqual([3])
  })

  it('keeps every feasible selected artist share inside its configured range', () => {
    const rule = baseRule()
    rule.artistIds = [1, 2, 3]
    rule.artistPercent = [33, 34]
    rule.trackCount = 24
    const candidates = [
      ...Array.from({ length: 10 }, (_, index) => candidate(index + 1, { artistId: 1 })),
      ...Array.from({ length: 10 }, (_, index) => candidate(index + 11, { artistId: 2 })),
      ...Array.from({ length: 10 }, (_, index) => candidate(index + 21, { artistId: 3 })),
      ...Array.from({ length: 10 }, (_, index) => candidate(index + 31, { artistId: 4 })),
    ]

    const result = generateCustomMix(rule, candidates, { limit: 24, seed: 17 })
    const counts = [1, 2, 3].map((id) => result.tracks.filter((track) => track.artistId === id).length)

    expect(result.tracks).toHaveLength(24)
    expect(counts).toEqual([8, 8, 8])
    expect(result.tracks.every((track) => track.artistId !== 4)).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('evenly splits incompatible shares across selected artists and ignores outsiders', () => {
    const rule = baseRule()
    rule.artistIds = [1, 2, 3]
    rule.artistPercent = [25, 25]
    rule.trackCount = 24
    const candidates = [
      ...Array.from({ length: 12 }, (_, index) => candidate(index + 1, { artistId: 1 })),
      ...Array.from({ length: 12 }, (_, index) => candidate(index + 13, { artistId: 2 })),
      ...Array.from({ length: 12 }, (_, index) => candidate(index + 25, { artistId: 3 })),
      ...Array.from({ length: 40 }, (_, index) => candidate(index + 37, { artistId: 4 })),
    ]

    const result = generateCustomMix(rule, candidates, { limit: 24, seed: 18 })
    const selectedCounts = [1, 2, 3].map((id) => result.tracks.filter((track) => track.artistId === id).length)

    expect(result.tracks).toHaveLength(24)
    expect(selectedCounts).toEqual([8, 8, 8])
    expect(result.tracks.every((track) => rule.artistIds.includes(track.artistId!))).toBe(true)
    expect(result.warnings).toContain('The selected artist shares cannot be met with the available tracks.')
  })

  it('returns only available whitelisted tracks when the requested count cannot be filled', () => {
    const rule = baseRule()
    rule.artistIds = [1, 2, 3]
    rule.artistPercent = [20, 25]
    rule.trackCount = 24
    const candidates = [
      ...Array.from({ length: 6 }, (_, index) => candidate(index + 1, { artistId: 1 })),
      ...Array.from({ length: 6 }, (_, index) => candidate(index + 7, { artistId: 2 })),
      ...Array.from({ length: 6 }, (_, index) => candidate(index + 13, { artistId: 3 })),
      ...Array.from({ length: 40 }, (_, index) => candidate(index + 19, { artistId: 4 })),
    ]

    const result = generateCustomMix(rule, candidates, { limit: 24, seed: 18 })

    expect(result.actualCount).toBe(18)
    expect(result.tracks).toHaveLength(18)
    expect(new Set(result.tracks.map((track) => `${track.artistId}:${track.id}`)).size).toBe(18)
    expect(result.warnings).toContain('The selected artist shares cannot be met with the available tracks.')
    expect(result.warnings).toContain('Only 18 tracks match these rules; 24 requested.')
  })

  it('splits selected artist slots evenly when the aggregate minimum is impossible', () => {
    const rule = baseRule()
    rule.artistIds = Array.from({ length: 10 }, (_, index) => index + 1)
    rule.artistPercent = [50, 50]
    rule.trackCount = 24
    const candidates = rule.artistIds.flatMap((artistId, artistIndex) =>
      Array.from({ length: 5 }, (_, index) => candidate(artistIndex * 5 + index + 1, { artistId })),
    )

    const result = generateCustomMix(rule, candidates, { limit: 24, seed: 18 })
    const counts = rule.artistIds.map((id) => result.tracks.filter((track) => track.artistId === id).length)

    expect(result.tracks).toHaveLength(24)
    expect(new Set(counts.map((count) => count)).size).toBeLessThanOrEqual(2)
    expect(counts.every((count) => count === 2 || count === 3)).toBe(true)
    expect(result.warnings).toContain('The selected artist shares cannot be met with the available tracks.')
  })

  it('keeps source and completion filters strict while allocating artist shares', () => {
    const rule = baseRule()
    rule.artistIds = [1, 2]
    rule.artistPercent = [49, 51]
    rule.trackCount = 8
    rule.sources = ['local']
    rule.completionPercent = [70, 100]
    const candidates = [
      ...Array.from({ length: 8 }, (_, index) => candidate(index + 1, { artistId: 1 }, { averageCompletionPercent: 90 })),
      ...Array.from({ length: 8 }, (_, index) => candidate(index + 11, { artistId: 2 }, { averageCompletionPercent: 80 })),
      candidate(30, { artistId: 1, source: 'youtube', externalId: 'yt-30' }, { averageCompletionPercent: 99 }),
      candidate(31, { artistId: 2 }, { averageCompletionPercent: 10 }),
    ]

    const result = generateCustomMix(rule, candidates, { limit: 8, seed: 19 })

    expect(result.tracks).toHaveLength(8)
    expect(result.tracks.every((track) => track.source === 'local')).toBe(true)
    expect(result.tracks.every((track) => track.artistId === 1 || track.artistId === 2)).toBe(true)
    expect([1, 2].map((id) => result.tracks.filter((track) => track.artistId === id).length)).toEqual([4, 4])
  })

  it('uses trusted, selected-genre online candidates only when onlineGenre is enabled', () => {
    const rule = baseRule()
    rule.genres = ['ambient']
    rule.specials = ['onlineGenre']
    const online = [
      candidate(1, { source: 'soundcloud', externalId: 'sc-1', genre: 'ambient' }),
      candidate(2, { source: 'soundcloud', externalId: 'sc-2', genre: 'rock' }, { origin: 'online' }),
      candidate(3, { source: 'soundcloud', externalId: 'sc-3', genre: 'ambient' }, { metadataTrusted: false }),
      candidate(4, { source: 'soundcloud', externalId: 'sc-4', genre: 'rock' }),
    ]
    expect(generateCustomMix(rule, online, { limit: 5, seed: 1 }).tracks.map((track) => track.id).sort()).toEqual([1, 4])
    rule.specials = []
    expect(generateCustomMix(rule, online, { limit: 5, seed: 1 }).tracks.map((track) => track.id).sort()).toEqual([1, 4])
  })

  it('matches the built-in On Repeat eligibility and uses the repeat score', () => {
    const now = 2_000_000
    const rule = baseRule()
    rule.specials = ['onRepeat']
    const result = generateCustomMix(rule, [
      candidate(1, { playCount: 8, skipCount: 0, lastPlayedAt: now - 60 }),
      candidate(2, { playCount: 1, skipCount: 0, lastPlayedAt: now - 60 }, { liked: true }),
      candidate(3, { playCount: 1, skipCount: 0, lastPlayedAt: now - 60 }),
      candidate(4, { playCount: 10, skipCount: 0, lastPlayedAt: now - 15 * 86_400 }),
    ], { now, limit: 4, seed: 2 })
    expect(result.tracks.map((track) => track.id).sort()).toEqual([1, 2])
  })

  it('matches built-in New to You eligibility and ranks toward active library artists', () => {
    const now = 2_000_000
    const rule = baseRule()
    rule.specials = ['newToYou']
    const result = generateCustomMix(rule, [
      candidate(1, { artistId: 7, genre: 'Ambient', playCount: 0, addedAt: now - 10 * 86_400 }),
      candidate(2, { artistId: 9, genre: 'Ambient', playCount: 0, addedAt: now - 10 * 86_400 }),
      candidate(3, { artistId: 7, genre: 'Ambient', playCount: 3, addedAt: now - 40 * 86_400 }),
    ], { now, limit: 1, seed: 8 })
    expect(result.tracks.map((track) => track.id)).toEqual([1])
  })

  it('matches built-in No Skips eligibility and ranks higher-play tracks first', () => {
    const rule = baseRule()
    rule.specials = ['noSkips']
    const result = generateCustomMix(rule, [
      candidate(1, { playCount: 20, skipCount: 2 }),
      candidate(2, { playCount: 10, skipCount: 1 }),
      candidate(3, { playCount: 5, skipCount: 1 }),
      candidate(4, { playCount: 4, skipCount: 0 }),
    ], { limit: 1, seed: 3 })
    expect(result.tracks.map((track) => track.id)).toEqual([1])
  })
})

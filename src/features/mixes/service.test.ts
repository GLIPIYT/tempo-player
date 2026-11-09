import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScTrack, Track } from '../../types/models'
import type { TasteProfile } from '../recommendations/profile'
import { createCustomMixRule, type CustomMixCandidate } from './types'

const mocks = vi.hoisted(() => ({
  api: {
    getRecommendationContext: vi.fn(),
    scRecommendationGenreSearch: vi.fn(),
    scSearchArtists: vi.fn(),
    scArtistTracks: vi.fn(),
    scRecommendationPage: vi.fn(),
  },
  buildTasteProfile: vi.fn(),
}))

vi.mock('../../api/client', () => ({ api: mocks.api }))
vi.mock('../recommendations/profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../recommendations/profile')>()
  return { ...actual, buildTasteProfile: mocks.buildTasteProfile }
})
vi.mock('../recommendations/service', () => ({ recommendationLanguagePreference: () => null }))

import { augmentOnlineGenreCandidates } from './service'

function localCandidate(
  id: number,
  genre: string,
  changes: Partial<Track> = {},
  options: Partial<CustomMixCandidate> = {},
): CustomMixCandidate {
  return {
    track: {
      id, path: `C:/music/${id}.mp3`, title: `Track ${id}`, artistId: 1, artistName: null,
      albumId: null, albumTitle: null, trackNumber: null, discNumber: null, durationSec: 180,
      year: null, genre, coverPath: null, fileSize: 0, modifiedAt: 0, addedAt: 0,
      source: 'local', externalId: null, lastPlayedAt: null, playCount: 0, skipCount: 0,
      gainDb: null, peakDb: null,
      ...changes,
    },
    averageCompletionPercent: null,
    historyMinutes: [],
    liked: false,
    metadataTrusted: true,
    ...options,
  }
}

function scTrack(id: string, artist: string, genre: string): ScTrack {
  return {
    id, title: `Song ${id}`, artist, durationMs: 180_000, artworkUrl: null,
    artistAvatarUrl: null, permalinkUrl: `https://soundcloud.com/${id}`, streamable: true,
    hasProgressive: true, hasHls: false, genre, tags: null,
  }
}

function onlineRule() {
  const rule = createCustomMixRule('Genre mix')
  rule.genres = ['Ambient']
  rule.genrePercent = [50, 100]
  rule.specials = ['onlineGenre']
  return rule
}

describe('augmentOnlineGenreCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildTasteProfile.mockReturnValue(null)
    mocks.api.getRecommendationContext.mockResolvedValue({})
    mocks.api.scRecommendationGenreSearch.mockResolvedValue({ tracks: [], nextCursor: null, error: null })
    mocks.api.scSearchArtists.mockResolvedValue([])
    mocks.api.scArtistTracks.mockResolvedValue([])
    mocks.api.scRecommendationPage.mockResolvedValue({ tracks: [], nextCursor: null, error: null })
  })

  it('does not search SoundCloud when the local genre quota is already satisfied', async () => {
    const candidates = Array.from({ length: 24 }, (_, index) => localCandidate(index + 1, 'Ambient'))
    const result = await augmentOnlineGenreCandidates(onlineRule(), candidates)
    expect(result.candidates).toEqual([])
    expect(result.warnings).toEqual([])
    expect(mocks.api.getRecommendationContext).not.toHaveBeenCalled()
    expect(mocks.api.scRecommendationGenreSearch).not.toHaveBeenCalled()
  })

  it('skips online search when completion or clock rules require local history', async () => {
    const rule = onlineRule()
    rule.completionPercent = [70, 100]
    const candidates = Array.from({ length: 24 }, (_, index) => localCandidate(index + 1, index === 0 ? 'Ambient' : 'Rock'))

    const result = await augmentOnlineGenreCandidates(rule, candidates)

    expect(result.candidates).toEqual([])
    expect(result.warnings).toContain('Online tracks cannot meet the selected listening-history filters.')
    expect(mocks.api.getRecommendationContext).not.toHaveBeenCalled()
    expect(mocks.api.scRecommendationGenreSearch).not.toHaveBeenCalled()
  })

  it('fills only a local genre-quota shortage with playable, personally matched results', async () => {
    const candidates = Array.from({ length: 24 }, (_, index) => localCandidate(
      index + 1,
      index === 0 ? 'Ambient' : 'Rock',
      index === 0 ? { artistName: 'Preferred Artist', playCount: 4 } : {},
      index === 0 ? { liked: true } : {},
    ))
    const preferred = scTrack('preferred', 'Preferred Artist', 'Ambient')
    const unrelated = scTrack('unrelated', 'Unrelated Artist', 'Ambient')
    mocks.api.scRecommendationGenreSearch.mockResolvedValue({ tracks: [unrelated, preferred], nextCursor: null, error: null })
    mocks.api.getRecommendationContext.mockRejectedValue(new Error('profile unavailable'))
    mocks.api.scSearchArtists.mockResolvedValue([{ id: 'artist-1', username: 'Preferred Artist', trackCount: 1,
      avatarUrl: null, permalinkUrl: null, verified: false }])
    mocks.api.scArtistTracks.mockResolvedValue([preferred])

    const result = await augmentOnlineGenreCandidates(onlineRule(), candidates)

    expect(mocks.api.scRecommendationGenreSearch).toHaveBeenCalledOnce()
    expect(mocks.api.scRecommendationGenreSearch).toHaveBeenCalledWith('Ambient', null, 40)
    expect(mocks.api.scSearchArtists).toHaveBeenCalledWith('Preferred Artist', 3, 0)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].track.externalId).toBe('preferred')
    expect(result.candidates[0].track.id).toBeLessThan(0)
    expect(result.candidates[0].origin).toBe('online')
    expect(result.candidates[0].metadataTrusted).toBe(true)
    expect(result.warnings).toContain('Listening taste could not be loaded; only direct library artist and related-track matches will be included.')
  })

  it('keeps local results when no personal artist or listening-taste evidence exists', async () => {
    const candidates = Array.from({ length: 24 }, (_, index) => localCandidate(
      index + 1,
      index === 0 ? 'Ambient' : 'Rock',
      { artistId: null, artistName: null },
    ))

    const result = await augmentOnlineGenreCandidates(onlineRule(), candidates)

    expect(result.candidates).toEqual([])
    expect(result.warnings).toContain('Online search was skipped because no library artist or listening-taste match was available.')
    expect(mocks.api.scRecommendationGenreSearch).not.toHaveBeenCalled()
    expect(mocks.api.scSearchArtists).not.toHaveBeenCalled()
  })

  it('does not accept a generic same-genre result from genre taste alone', async () => {
    const candidates = Array.from({ length: 24 }, (_, index) => localCandidate(
      index + 1,
      index === 0 ? 'Ambient' : 'Rock',
      { artistId: null, artistName: null },
    ))
    const profile: TasteProfile = {
      tracks: [], seeds: [], languages: {}, languageConfidence: 0, unknownShare: 1, confidence: 1,
      artists: { 'preferred artist': 1 }, genres: { ambient: 1 }, tags: {}, versions: {},
      tempo: null, features: new Map(), groups: {},
    }
    const generic = scTrack('generic', 'Generic Artist', 'Ambient')
    generic.title = 'Quiet evening'
    mocks.buildTasteProfile.mockReturnValue(profile)
    mocks.api.scRecommendationGenreSearch.mockResolvedValue({
      tracks: [generic], nextCursor: null, error: null,
    })

    const result = await augmentOnlineGenreCandidates(onlineRule(), candidates)

    expect(mocks.api.scRecommendationGenreSearch).toHaveBeenCalledOnce()
    expect(result.candidates).toEqual([])
    expect(result.warnings).toContain('No online tracks matched your artist or sound similarity history; the local mix is unchanged.')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScTrack, Track } from '../../types/models'
import type { TasteProfile } from '../recommendations/profile'
import { createCustomMixRule, type CustomMixCandidate } from './types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  api: {
    getRecommendationContext: vi.fn(),
    scRecommendationGenreSearch: vi.fn(),
    scSearchArtists: vi.fn(),
    scArtistTracks: vi.fn(),
    scRecommendationPage: vi.fn(),
  },
  buildTasteProfile: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../api/client', () => ({ api: mocks.api }))
vi.mock('../recommendations/profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../recommendations/profile')>()
  return { ...actual, buildTasteProfile: mocks.buildTasteProfile }
})
vi.mock('../recommendations/service', () => ({ recommendationLanguagePreference: () => null }))

import { augmentOnlineGenreCandidates, deleteCustomMixRule, generateCustomMixSelection, getCustomMixMemoryState,
  getDisplayableCustomMixSnapshot, getReusableCustomMixSnapshot, listCustomMixRules } from './service'
import { customMixRuleFingerprint } from './snapshot'

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

  it('uses the configured 50-track target when checking whether online genre capacity is needed', async () => {
    const rule = onlineRule()
    rule.trackCount = 50
    rule.genrePercent = [50, 100]
    const candidates = Array.from({ length: 24 }, (_, index) => localCandidate(
      index + 1, 'Ambient', { artistName: index === 0 ? 'Preferred Artist' : null },
      index === 0 ? { liked: true } : {},
    ))

    await augmentOnlineGenreCandidates(rule, candidates)

    expect(mocks.api.scRecommendationGenreSearch).toHaveBeenCalledWith('Ambient', null, 50)
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
    expect(mocks.api.scRecommendationGenreSearch).toHaveBeenCalledWith('Ambient', null, 50)
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

describe('generateCustomMixSelection', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it('reuses interval-zero snapshots during background work and regenerates them on open', async () => {
    const rule = createCustomMixRule('Every open')
    rule.id = 7
    const oldTrack = localCandidate(99, 'Old')
    let stored = {
      ruleFingerprint: customMixRuleFingerprint(rule), generatedAt: 1_000,
      tracks: [oldTrack.track], warnings: [],
    }
    mocks.invoke.mockImplementation(async (command: string, args: { snapshot?: typeof stored }) => {
      if (command === 'get_custom_mix_snapshot') return stored
      if (command === 'save_custom_mix_snapshot') { stored = args.snapshot!; return undefined }
      throw new Error(`Unexpected command ${command}`)
    })
    const library = [localCandidate(1, 'Ambient'), localCandidate(2, 'Rock')]

    const scheduled = await generateCustomMixSelection(rule, library, { reason: 'scheduled', now: 1_001 })
    expect(scheduled).toMatchObject({ tracks: [oldTrack.track], generatedAt: 1_000, fromCache: true })
    expect(mocks.invoke).toHaveBeenCalledTimes(1)

    const opened = await generateCustomMixSelection(rule, library, { reason: 'open', now: 2_000 })
    expect(opened).toMatchObject({ generatedAt: 2_000, fromCache: false })
    expect(opened.tracks).toHaveLength(2)
    expect(stored.generatedAt).toBe(2_000)
  })

  it('keeps a nonempty snapshot when a forced refresh has no eligible tracks', async () => {
    const rule = createCustomMixRule('Keep last selection')
    rule.id = 8
    rule.artistIds = [123]
    const oldTrack = localCandidate(99, 'Ambient')
    const stored = {
      ruleFingerprint: customMixRuleFingerprint(rule), generatedAt: 1_000,
      tracks: [oldTrack.track], warnings: [],
    }
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_custom_mix_snapshot') return stored
      if (command === 'save_custom_mix_snapshot') return undefined
      throw new Error(`Unexpected command ${command}`)
    })

    const refreshed = await generateCustomMixSelection(rule, [localCandidate(1, 'Rock')], {
      reason: 'refresh', now: 2_000,
    })

    expect(refreshed).toMatchObject({ tracks: [oldTrack.track], generatedAt: 1_000, fromCache: true })
    expect(refreshed.warnings).toContain('The mix could not be refreshed; its previous selection is still available.')
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('loads only matching unexpired snapshots for positive-interval hydration', async () => {
    const rule = createCustomMixRule('Timed hydration')
    rule.id = 12
    rule.refreshIntervalMinutes = 30
    const cachedTrack = localCandidate(99, 'Ambient').track
    const snapshot = {
      ruleFingerprint: customMixRuleFingerprint(rule), generatedAt: 1_000,
      tracks: [cachedTrack], warnings: ['cached warning'],
    }
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_custom_mix_snapshot') return snapshot
      throw new Error(`Unexpected command ${command}`)
    })

    await expect(getReusableCustomMixSnapshot(rule, 1_001)).resolves.toEqual({
      tracks: [cachedTrack], warnings: ['cached warning'], generatedAt: 1_000, fromCache: true,
    })
    expect(mocks.invoke).toHaveBeenCalledOnce()

    rule.description = 'Edited'
    await expect(getReusableCustomMixSnapshot(rule, 1_001)).resolves.toBeNull()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)

    rule.refreshIntervalMinutes = 0
    await expect(getReusableCustomMixSnapshot(rule, 1_001)).resolves.toBeNull()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('hydrates a matching interval-zero snapshot immediately and drops it after an edit or delete', async () => {
    const rule = createCustomMixRule('Every open')
    rule.id = 13
    const cachedTrack = localCandidate(96, 'Ambient').track
    const snapshot = {
      ruleFingerprint: customMixRuleFingerprint(rule), generatedAt: 1_000,
      tracks: [cachedTrack], warnings: ['previous selection'],
    }
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_custom_mix_rules') return [rule]
      if (command === 'get_custom_mix_snapshot') return snapshot
      if (command === 'delete_custom_mix_rule') return undefined
      throw new Error(`Unexpected command ${command}`)
    })

    await listCustomMixRules()
    await expect(getDisplayableCustomMixSnapshot(rule)).resolves.toEqual({
      tracks: [cachedTrack], warnings: ['previous selection'], generatedAt: 1_000, fromCache: true,
    })
    expect(getCustomMixMemoryState().selections).toMatchObject([{ ruleId: 13, selection: { generatedAt: 1_000 } }])

    rule.description = 'Edited'
    await listCustomMixRules()
    expect(getCustomMixMemoryState().selections).toEqual([])

    await deleteCustomMixRule(13)
    expect(getCustomMixMemoryState()).toEqual({ rules: [], selections: [] })
  })
})

import { describe, expect, it } from 'vitest'
import type { ScTrack } from '../../types/models'
import type { RecommendationTrack } from './types'
import type { TasteProfile } from './profile'
import { matchesFavoriteGenre, rankGenreTracks } from './genre'

const track = (id: string, updates: Partial<ScTrack> = {}): ScTrack => ({
  id,
  title: `Track ${id}`,
  artist: `Uploader ${id}`,
  durationMs: 180_000,
  artworkUrl: null,
  artistAvatarUrl: null,
  permalinkUrl: null,
  streamable: true,
  hasProgressive: true,
  hasHls: false,
  genre: null,
  tags: null,
  ...updates,
})

const taste = (changes: Partial<TasteProfile> = {}): TasteProfile => ({
  tracks: [], seeds: [], languages: {}, languageConfidence: 0, unknownShare: 1, confidence: 1,
  artists: {}, genres: {}, tags: {}, versions: {}, tempo: null, features: new Map(), groups: {},
  ...changes,
})

describe('genre recommendations', () => {
  it('matches only exact genre or tag metadata, ignoring case and SoundCloud tag markers', () => {
    expect(matchesFavoriteGenre(track('genre', { genre: 'Deep House' }), 'deep house')).toBe(true)
    expect(matchesFavoriteGenre(track('tag', { tags: ['#Deep House'] }), 'deep house')).toBe(true)
    expect(matchesFavoriteGenre(track('machine-tag', { tags: ['genre: Deep House'] }), 'deep house')).toBe(true)
    expect(matchesFavoriteGenre(track('prefixed-hash', { tags: ['genre: #Deep House'] }), 'deep house')).toBe(true)
    expect(matchesFavoriteGenre(track('partial', { tags: ['Deep House Mix'] }), 'deep house')).toBe(false)
    expect(matchesFavoriteGenre(track('title-only', { title: 'Deep House' }), 'deep house')).toBe(false)
  })

  it('uses personalized candidates as a relevant, playable, deduplicated fallback', () => {
    const profile = taste({ artists: { 'preferred uploader': 1 }, tags: { liquid: 1 } })
    const preferred = track('preferred', { artist: 'Preferred Uploader', genre: 'drum & bass', tags: ['Liquid'] })
    const neutral = track('neutral', { artist: 'Other', genre: 'Drum & Bass' })
    const wrongGenre = track('wrong', { genre: 'House' })
    const unavailable = track('blocked', { genre: 'Drum & Bass', hasProgressive: false, hasHls: false, hasProtected: false })

    expect(rankGenreTracks([neutral, wrongGenre, preferred, unavailable, preferred], 'drum & bass', profile))
      .toEqual([preferred, neutral])
  })

  it('preserves provider order when there is no personal evidence', () => {
    const first = track('first', { genre: 'Ambient' })
    const second = track('second', { tags: ['ambient'] })
    expect(rankGenreTracks([first, second], 'ambient', taste())).toEqual([first, second])
  })

  it('uses cached Sonara similarity when available and keeps unmeasured tracks with fallback scoring', () => {
    const seed: RecommendationTrack = {
      trackKey: 'soundcloud:seed', source: 'soundcloud', sourceId: 'seed', dbId: null,
      title: 'Seed', artists: ['seed artist'], album: null, durationSec: 180, coverPath: null, externalUrl: null,
    }
    const profile = taste({ tracks: [{ track: seed, weight: 1, confidence: 1, at: 1, bucket: 'steady' }] })
    const vector = (value: number) => Array.from({ length: 48 }, () => value)
    const addAudio = (key: string, embedding: number[]) => profile.features.set(key, {
      trackKey: key, revision: 1, updatedAt: 1,
      data: { audio: { sonara: { version: 2, windowSchema: 1, windows: [embedding, embedding] } } },
    })
    addAudio(seed.trackKey, vector(0.5))
    addAudio('soundcloud:near', vector(0.5))
    addAudio('soundcloud:far', vector(0))

    const near = track('near', { genre: 'Ambient' })
    const far = track('far', { genre: 'Ambient' })
    const unmeasured = track('unmeasured', { genre: 'Ambient' })

    const ranked = rankGenreTracks([far, unmeasured, near], 'ambient', profile)

    expect(ranked[0]).toBe(near)
    expect(ranked).toContain(unmeasured)
  })
})

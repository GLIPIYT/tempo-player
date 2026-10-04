import { describe, expect, it } from 'vitest'
import type { ScTrack } from '../../types/models'
import type { FeedCandidate } from './storage'
import type { LanguageEvidence, RecommendationSeed, RecommendationTrack } from './types'
import { rankCandidates, type TasteProfile } from './profile'

const recommendationTrack = (key: string): RecommendationTrack => ({
  trackKey: key, source: 'soundcloud', sourceId: key.split(':')[1], dbId: null,
  title: key, artists: [], album: null, durationSec: 180, coverPath: null, externalUrl: null,
})

const seed = (key: string, bucket: RecommendationSeed['bucket'] = 'steady'): RecommendationSeed => ({
  track: recommendationTrack(key), evidence: 'listening', confidence: 1, weight: 1, at: 1_000, bucket,
})

const language = (code: string): LanguageEvidence => ({
  distribution: { [code]: 1 }, confidence: 0.8, unknownShare: 0, textHash: code,
  evidence: { source: 'lyrics', algorithm: 'franc-min-6.2.0-blocks-v1', blocks: 2 },
})

const profileFor = (languages: Record<string, number>, seeds: RecommendationSeed[]): TasteProfile => ({
  tracks: [], seeds, languages, languageConfidence: 0.8, unknownShare: 0.1, confidence: 1,
  artists: {}, genres: {}, tags: {}, versions: {}, tempo: null, groups: {},
  features: new Map(seeds.map(item => [item.track.trackKey, {
    trackKey: item.track.trackKey, revision: 1, updatedAt: 1_000,
    data: { language: language(item.track.trackKey.includes(':en-') ? 'eng' : 'rus') },
  }])),
})

const candidate = (id: string, seedTrackKey: string, addedAt: number): FeedCandidate => {
  const track: ScTrack = {
    id, title: `track ${id}`, artist: `artist ${id}`, durationMs: 180_000,
    artworkUrl: null, artistAvatarUrl: null, permalinkUrl: null,
    streamable: true, hasProgressive: true, hasHls: false,
  }
  return {
    track,
    identity: {
      featureVersion: 1, trackKey: `soundcloud:${id}`, originalTitle: track.title,
      title: track.title, artist: track.artist, artistConfidence: 1, confidence: 1,
      uploaderId: null, uploaderName: track.artist, durationSec: 180, version: 'original',
      isrc: null, specificTitle: true, familyKey: `${track.artist}|${track.title}`, groupKey: `soundcloud:${id}`,
    },
    groupKey: `soundcloud:${id}`, seedTrackKey, cursor: null, alternates: [], addedAt,
  }
}

describe('recommendation diversity', () => {
  it('interleaves candidates from multiple seed languages using the listener language mix', () => {
    const english = seed('soundcloud:en-seed')
    const russian = seed('soundcloud:ru-seed')
    const profile = profileFor({ rus: 0.8, eng: 0.2 }, [english, russian])
    const candidates = [
      candidate('en-1', english.track.trackKey, 1), candidate('en-2', english.track.trackKey, 2),
      candidate('en-3', english.track.trackKey, 3), candidate('en-4', english.track.trackKey, 4),
      candidate('ru-1', russian.track.trackKey, 5), candidate('ru-2', russian.track.trackKey, 6),
      candidate('ru-3', russian.track.trackKey, 7), candidate('ru-4', russian.track.trackKey, 8),
    ]
    for (const item of candidates) {
      const code = item.track.id.startsWith('ru-') ? 'rus' : 'eng'
      profile.features.set(`soundcloud:${item.track.id}`, {
        trackKey: `soundcloud:${item.track.id}`, revision: 1, updatedAt: 1_000,
        data: { language: language(code) },
      })
    }

    const ranked = rankCandidates(candidates, profile)

    expect(ranked.slice(0, 4).map(item => item.seedTrackKey)).toEqual([
      russian.track.trackKey, russian.track.trackKey, english.track.trackKey, russian.track.trackKey,
    ])
  })

  it('does not infer a Latin-script candidate language from its seed', () => {
    const english = seed('soundcloud:en-seed')
    const russian = seed('soundcloud:ru-seed')
    const profile = profileFor({ rus: 0.8, eng: 0.2 }, [english, russian])
    const fromEnglishSeed = candidate('latin-a', english.track.trackKey, 1)
    const fromRussianSeed = candidate('latin-b', russian.track.trackKey, 2)

    expect(rankCandidates([fromEnglishSeed, fromRussianSeed], profile).map(item => item.track.id))
      .toEqual(['latin-a', 'latin-b'])
  })

  it('ranks a candidate higher when independent seed queries agree on it', () => {
    const english = seed('soundcloud:en-seed')
    const russian = seed('soundcloud:ru-seed')
    const otherEnglish = seed('soundcloud:en-seed-2')
    const profile = profileFor({ rus: 0.6, eng: 0.4 }, [english, russian, otherEnglish])
    const single = candidate('single', english.track.trackKey, 1)
    const converged = {
      ...candidate('converged', english.track.trackKey, 2),
      supportingSeedTrackKeys: [russian.track.trackKey, otherEnglish.track.trackKey],
    } as FeedCandidate & { supportingSeedTrackKeys: string[] }

    expect(rankCandidates([single, converged], profile)[0].track.id).toBe('converged')
  })
})

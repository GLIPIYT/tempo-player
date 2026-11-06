import { describe, expect, it } from 'vitest'
import type { ScTrack } from '../../types/models'
import type { RecommendationContext } from './types'
import { hydrateRecommendationState, type FeedCandidate, type StoredRecommendationState } from './storage'

const track = (id: string, title: string): ScTrack => ({
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
  genre: null,
  tags: null,
})

const candidate = (id: string, title: string): FeedCandidate => ({
  track: track(id, title),
  identity: {
    featureVersion: 1,
    trackKey: `soundcloud:${id}`,
    originalTitle: title,
    title,
    artist: `Uploader ${id}`,
    artistConfidence: 1,
    confidence: 1,
    uploaderId: null,
    uploaderName: null,
    durationSec: 180,
    version: '',
    isrc: null,
    specificTitle: true,
    familyKey: `soundcloud:${id}`,
    groupKey: `soundcloud:${id}`,
  },
  groupKey: `soundcloud:${id}`,
  seedTrackKey: 'soundcloud:seed',
  cursor: null,
  alternates: [track(`${id}-alt`, '東京')],
  addedAt: 1,
})

describe('stored recommendation title filtering', () => {
  it('removes unsupported-script tracks and alternates from restored feed data', () => {
    const stored: StoredRecommendationState = {
      version: 1,
      revision: 1,
      candidates: [candidate('1', 'مرحبا بالعالم'), candidate('2', 'English track')],
      published: [candidate('3', '東京の夜'), candidate('4', 'Русский трек')],
      discoveryPool: [candidate('5', 'English 東京')],
      seedFrontier: [],
      usedCursors: [],
      sessionSeen: [],
      groups: [],
      createdAt: 1,
      updatedAt: 1,
      retryAt: null,
      contextKey: '',
    }
    const context = {
      storedState: { revision: 2, data: stored as unknown as Record<string, unknown> },
    } as RecommendationContext

    const restored = hydrateRecommendationState(context)

    expect(restored?.candidates.map(item => item.track.id)).toEqual(['2'])
    expect(restored?.published.map(item => item.track.id)).toEqual(['4'])
    expect(restored?.discoveryPool?.map(item => item.track.id)).toEqual(['5'])
    expect(restored?.published[0]?.alternates).toEqual([])
  })
})

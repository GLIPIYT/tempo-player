import type { SourceId, UnifiedTrack } from '../../types/models'

export type TrackKey = `${SourceId}:${string}`
export type ListeningStartReason = 'manual' | 'queue' | 'autoplay' | 'repeat' | 'restore'
export type ListeningEndReason = 'select' | 'next' | 'previous' | 'clear' | 'end' | 'error' | 'exit' | 'remove' | 'stop'
export interface RecommendationProvenance {
  origin: 'home' | 'radio' | 'search' | 'library'
  seedTrackKey?: string
  recordingGroup?: string
  cursor?: string
  selection?: 'manual' | 'queue' | 'autoplay'
}
export interface RecommendationTrack {
  trackKey: string
  source: SourceId
  sourceId: string
  dbId: number | null
  title: string
  artists: string[]
  album: string | null
  durationSec: number | null
  coverPath: string | null
  externalUrl: string | null
  provenance?: RecommendationProvenance
}
export interface PlaybackSample {
  sessionId: string
  positionSec: number
  epoch: number
  atMs: number
  state: 'playing' | 'paused' | 'waiting' | 'seeking' | 'stopped'
  playbackRate?: number
  durationSec?: number
}
export interface ListeningEvent {
  id: string
  revision: number
  trackKey: string
  track: RecommendationTrack
  startReason: ListeningStartReason
  startedAt: number
  elapsedSec: number
  coveredSec: number
  durationSec: number | null
  playbackRate: number
  endReason?: ListeningEndReason
  finished: boolean
  /** History generation prevents async writes resurrecting cleared feedback. */
  generation: number
}
export interface RecommendationSeed {
  track: RecommendationTrack
  evidence: 'like' | 'playlist' | 'listening' | 'legacy' | 'aggregate'
  confidence: number
  weight: number
  at: number
}
export interface RecommendationImpression {
  id: string
  trackKey: string
  recordingGroup: string | null
  shownAt: number
  surface: 'home' | 'radio'
}
/** Structured bounded feature data; lyrics text must not be stored here. */
export interface RecommendationFeature {
  trackKey: string
  revision: number
  updatedAt: number
  data: Record<string, unknown>
}
export interface RecommendationStoredState {
  revision: number
  data: Record<string, unknown>
}
export interface RecommendationProviderPage {
  key: string
  fetchedAt: number
  data: Record<string, unknown>
}
export interface RecommendationContext {
  generation: number
  seedTracks: RecommendationSeed[]
  likedTrackKeys: string[]
  manuallySavedTrackKeys: string[]
  sessions: ListeningEvent[]
  impressions: RecommendationImpression[]
  features: RecommendationFeature[]
  storedState: RecommendationStoredState | null
}
export function recommendationTrack(track: UnifiedTrack): RecommendationTrack {
  return {
    trackKey: `${track.source}:${track.source === 'local' ? track.dbId ?? track.sourceId : track.sourceId}`,
    source: track.source, sourceId: track.sourceId, dbId: track.dbId, title: track.title,
    artists: track.artists.slice(), album: track.album, durationSec: track.durationSec,
    coverPath: track.coverPath, externalUrl: track.externalUrl, provenance: track.provenance,
  }
}

import type { RepeatMode, Track, UnifiedTrack } from '../types/models'
import type { EqualizerSettings } from '../audio/equalizer'
import type { TrackPlaybackPreferences } from './trackPlaybackPreferences'

export type TrackChangeReason = 'manual' | 'next' | 'previous' | 'queue' | 'natural-end' | 'autoplay' | 'restore'

export interface TrackChangeEvent {
  /** `${source}:${sourceId}`, matching the player's stable track identity. */
  trackKey: string
  reason: TrackChangeReason
  /** Monotonic within the active player controller. */
  transitionId: number
}

export interface PlayerApi {
  currentTrack: UnifiedTrack | null
  queue: UnifiedTrack[]
  queueIndex: number
  isPlaying: boolean
  position: number
  duration: number
  volume: number
  playbackRate: number
  globalVolume?: number
  globalPlaybackRate?: number
  trackPlaybackPreferences?: TrackPlaybackPreferences
  preservePitch: boolean
  repeat: RepeatMode
  shuffle: boolean
  bufferPct: number | null
  /** True while a track is still being fetched and cannot start yet. */
  preparing: boolean
  playTracks(tracks: UnifiedTrack[], startIndex?: number): void
  updateTrackMetadata(track: Track): void
  toggle(): void
  next(): void
  previous(): void
  seek(sec: number): void
  setVolume(v: number): void
  setPlaybackRate(rate: number, persist?: boolean): void
  clearTemporaryPlaybackRate?: () => void
  setPreservePitch(preserve: boolean): void
  setEqualizer(settings: EqualizerSettings): void
  setRepeat(m: RepeatMode): void
  toggleShuffle(): void
  addToQueue(t: UnifiedTrack): void
  removeFromQueue(index: number): void
  moveInQueue(from: number, to: number): void
  clearQueue(): void
}

import type { RepeatMode, UnifiedTrack } from '../types/models'

export interface PlayerApi {
  currentTrack: UnifiedTrack | null
  queue: UnifiedTrack[]
  queueIndex: number
  isPlaying: boolean
  position: number
  duration: number
  volume: number
  repeat: RepeatMode
  shuffle: boolean
  bufferPct: number | null
  playTracks(tracks: UnifiedTrack[], startIndex?: number): void
  toggle(): void
  next(): void
  previous(): void
  seek(sec: number): void
  setVolume(v: number): void
  setRepeat(m: RepeatMode): void
  toggleShuffle(): void
  addToQueue(t: UnifiedTrack): void
  removeFromQueue(index: number): void
  moveInQueue(from: number, to: number): void
  clearQueue(): void
}

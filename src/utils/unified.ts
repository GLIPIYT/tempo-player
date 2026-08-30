import { localTrackToUnified } from '../providers/localProvider'
import { scTrackToUnified } from '../providers/soundcloudProvider'
import type { ScTrack, Track, UnifiedTrack } from '../types/models'

export { scTrackToUnified } from '../providers/soundcloudProvider'

export const trackToUnified: (t: Track) => UnifiedTrack = localTrackToUnified

export function tracksToUnified(ts: Track[]): UnifiedTrack[] {
  return ts.map((t) => trackToUnified(t))
}

export function scTracksToUnified(ts: ScTrack[]): UnifiedTrack[] {
  return ts.map((t) => scTrackToUnified(t))
}

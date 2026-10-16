import { localTrackToUnified } from '../providers/localProvider'
import { scTrackToUnified } from '../providers/soundcloudProvider'
import { rememberSoundCloudSourceTrack } from '../soundcloud/cacheMetadata'
import type { ScTrack, Track, UnifiedTrack } from '../types/models'

export { scTrackToUnified } from '../providers/soundcloudProvider'

export function trackToUnified(track: Track): UnifiedTrack {
  const unified = localTrackToUnified(track)
  rememberSoundCloudSourceTrack(unified)
  return unified
}

export function tracksToUnified(ts: Track[]): UnifiedTrack[] {
  return ts.map((t) => trackToUnified(t))
}

export function scTracksToUnified(ts: ScTrack[]): UnifiedTrack[] {
  return ts.map((t) => scTrackToUnified(t))
}

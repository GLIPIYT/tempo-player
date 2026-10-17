import type { ScTrack } from '../types/models'

/**
 * Whether Tempo can attempt playback for this SoundCloud track.
 * Protected variants still require the signed-in SoundCloud session to grant access.
 */
export function canPlaySoundCloudTrack(
  track: Pick<ScTrack, 'streamable' | 'hasProgressive' | 'hasHls' | 'hasProtected'>,
): boolean {
  return track.streamable && (track.hasProgressive || track.hasHls || track.hasProtected === true)
}

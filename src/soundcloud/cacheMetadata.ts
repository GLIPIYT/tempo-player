import type { ScTrack, Track, UnifiedTrack } from '../types/models'

const MAX_KNOWN_TRACKS = 1500
const knownTracks = new Map<string, ScTrack>()

/** Keeps source metadata available for native cache failures, which only carry a SoundCloud ID. */
export function rememberSoundCloudTrack(track: ScTrack): void {
  const id = track.id.trim()
  if (!/^[1-9]\d*$/.test(id)) return

  knownTracks.delete(id)
  knownTracks.set(id, { ...track, id })
  if (knownTracks.size > MAX_KNOWN_TRACKS) {
    const oldest = knownTracks.keys().next().value
    if (oldest !== undefined) knownTracks.delete(oldest)
  }
}

export function rememberSoundCloudSourceTrack(track: Track | UnifiedTrack): void {
  if (track.source !== 'soundcloud') return

  const unified = 'sourceId' in track
  const id = unified ? track.sourceId : track.externalId
  if (!id) return

  rememberSoundCloudTrack({
    id,
    title: track.title,
    artist: unified ? (track.artists[0] ?? '') : (track.artistName ?? ''),
    durationMs: Math.round(Math.max(0, (track.durationSec ?? 0) * 1000)),
    artworkUrl: /^https?:/.test(track.coverPath ?? '') ? track.coverPath : null,
    artistAvatarUrl: unified ? (track.artistAvatarUrl ?? null) : null,
    permalinkUrl: unified ? (track.externalUrl ?? null) : null,
    streamable: unified ? track.playable : true,
    hasProgressive: false,
    hasHls: false,
  })
}

export function getKnownSoundCloudTrack(id: string): ScTrack | null {
  return knownTracks.get(id) ?? null
}

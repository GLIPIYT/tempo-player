import { api } from '../api/client'
import { getKnownSoundCloudTrack } from '../soundcloud/cacheMetadata'
import type { BaseView, ScArtistFallback } from '../state/nav'
import type { UnifiedTrack } from '../types/models'

const normalized = (name: string) => name.trim().normalize('NFKC').toLowerCase()

export async function resolveLocalArtistView(name: string, imagePath: string | null): Promise<BaseView> {
  const artists = await api.listArtists(name).catch(() => [])
  const local = artists.find(artist => normalized(artist.name) === normalized(name))
  return local
    ? { name: 'artist', id: local.id }
    : { name: 'local-artist', artistName: name, imagePath }
}

export async function resolveArtistView(track: UnifiedTrack, name: string): Promise<BaseView> {
  const expected = normalized(name)
  const known = track.source === 'soundcloud' ? getKnownSoundCloudTrack(track.sourceId) : null
  const knownUploaderMatches = known && normalized(known.uploaderName?.trim() || known.artist) === expected
  const onlineId = track.source === 'soundcloud'
    ? (normalized(track.artists[0] ?? '') === expected ? track.artistSourceId : null) ?? (knownUploaderMatches ? known.uploaderId : null)
    : null
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false

  if (onlineId && !offline) {
    const fallback: ScArtistFallback = { artistName: name, imagePath: track.artistAvatarUrl ?? null }
    return { name: 'sc-artist', id: onlineId, fallback }
  }
  return resolveLocalArtistView(name, track.artistAvatarUrl ?? null)
}

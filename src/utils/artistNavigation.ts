import { api } from '../api/client'
import { getKnownSoundCloudTrack } from '../soundcloud/cacheMetadata'
import type { BaseView } from '../state/nav'
import type { UnifiedTrack } from '../types/models'

const normalized = (name: string) => name.trim().normalize('NFKC').toLowerCase()
const ONLINE_LOOKUP_TIMEOUT_MS = 2500

async function availableOnlineArtist(id: string): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      api.scGetArtist(id).then(() => true, () => false),
      new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), ONLINE_LOOKUP_TIMEOUT_MS) }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function resolveArtistView(track: UnifiedTrack, name: string): Promise<BaseView> {
  const expected = normalized(name)
  const localArtists = api.listArtists(name).catch(() => [])
  const known = track.source === 'soundcloud' ? getKnownSoundCloudTrack(track.sourceId) : null
  const knownUploaderMatches = known && normalized(known.uploaderName?.trim() || known.artist) === expected
  const onlineId = track.source === 'soundcloud'
    ? (normalized(track.artists[0] ?? '') === expected ? track.artistSourceId : null) ?? (knownUploaderMatches ? known.uploaderId : null)
    : null
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false

  if (onlineId && !offline && await availableOnlineArtist(onlineId)) {
    return { name: 'sc-artist', id: onlineId }
  }
  const local = (await localArtists).find(artist => normalized(artist.name) === expected)
  if (local) return { name: 'artist', id: local.id }
  return { name: 'local-artist', artistName: name, imagePath: track.artistAvatarUrl ?? null }
}

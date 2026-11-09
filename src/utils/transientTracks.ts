import { api } from '../api/client'
import type { Track } from '../types/models'
import { getKnownSoundCloudTrack } from '../soundcloud/cacheMetadata'

const saved = new Map<number, number>()
const pending = new Map<number, Promise<number>>()
export const savedTrackId = (id: number) => saved.get(id) ?? id

/** Import metadata after an explicit keep/playlist action, never on discovery. */
export function ensureLibraryTrackId(track: Track): Promise<number> {
  if (track.id > 0 || saved.has(track.id))
    return Promise.resolve(savedTrackId(track.id))
  const current = pending.get(track.id)
  if (current) return current
  if (track.source !== 'soundcloud' || !track.externalId)
    return Promise.reject(new Error('Track has no library identity'))
  const request = api
    .scImportTrack(
      getKnownSoundCloudTrack(track.externalId) ?? {
        id: track.externalId,
        title: track.title,
        artist: track.artistName ?? '',
        durationMs: Math.round((track.durationSec ?? 0) * 1000),
        artworkUrl: track.coverPath,
        artistAvatarUrl: null,
        permalinkUrl: null,
        genre: track.genre,
        streamable: true,
        hasProgressive: false,
        hasHls: false,
      },
    )
    .then((id) => {
      saved.set(track.id, id)
      if (saved.size > 1500) saved.delete(saved.keys().next().value!)
      return id
    })
    .finally(() => pending.delete(track.id))
  pending.set(track.id, request)
  return request
}

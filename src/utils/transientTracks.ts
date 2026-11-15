import { api } from '../api/client'
import type { ScTrack, Track } from '../types/models'
import { getKnownSoundCloudTrack } from '../soundcloud/cacheMetadata'

const saved = new Map<number, number>()
const pending = new Map<number, Promise<number>>()
export const savedTrackId = (id: number) => saved.get(id) ?? id

function onlineTrackId(sourceId: string): number {
  if (/^[1-9]\d*$/u.test(sourceId)) {
    const numericId = Number(sourceId)
    if (Number.isSafeInteger(numericId) && numericId > 0) return -numericId
  }
  let hash = 2166136261
  for (const char of sourceId) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return -1 - ((hash >>> 0) % 2_147_483_647)
}

/** Carries a SoundCloud result through library actions until the user keeps it. */
export function transientSoundCloudTrack(source: ScTrack): Track {
  return {
    id: onlineTrackId(source.id),
    path: `soundcloud://${source.id}`,
    title: source.title,
    artistId: null,
    artistName: source.artist.trim(),
    albumId: null,
    albumTitle: null,
    trackNumber: null,
    discNumber: null,
    durationSec: Number.isFinite(source.durationMs) && source.durationMs > 0 ? source.durationMs / 1000 : null,
    year: null,
    genre: source.genre ?? null,
    coverPath: source.artworkUrl,
    fileSize: 0,
    modifiedAt: 0,
    addedAt: Math.floor(Date.now() / 1000),
    source: 'soundcloud',
    externalId: source.id,
    lastPlayedAt: null,
    playCount: 0,
    skipCount: 0,
    gainDb: null,
    peakDb: null,
  }
}

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

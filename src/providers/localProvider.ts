import { api } from '../api/client'
import type { Album, Artist, Track, UnifiedTrack } from '../types/models'
import type { MusicProvider, SearchHit } from './provider'

export function localTrackToUnified(t: Track): UnifiedTrack {
  if (t.source === 'soundcloud') {
    return {
      source: 'soundcloud',
      sourceId: t.externalId ?? String(t.id),
      dbId: t.id,
      title: t.title,
      artists: t.artistName ? [t.artistName] : [],
      album: null,
      durationSec: t.durationSec,
      coverPath: t.coverPath,
      playable: true,
      localPath: null,
      externalUrl: null,
    }
  }
  return {
    source: 'local',
    sourceId: String(t.id),
    dbId: t.id,
    title: t.title,
    artists: t.artistName === null ? [] : [t.artistName],
    album: t.albumTitle,
    durationSec: t.durationSec,
    coverPath: t.coverPath,
    playable: true,
    localPath: t.path,
    externalUrl: null,
  }
}

function parseDbId(id: string): number {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid track id: ${id}`)
  return n
}

async function findTrackById(id: string): Promise<Track | null> {
  const limit = 500
  const maxOffset = 20000
  for (let offset = 0; offset < maxOffset; offset += limit) {
    const rows = await api.listTracks('', limit, offset)
    const found = rows.find(r => String(r.id) === id)
    if (found) return found
    if (rows.length < limit) return null
  }
  return null
}

export const localProvider: MusicProvider = {
  id: 'local',
  name: 'Local Library',
  capabilities: {
    search: true,
    metadata: true,
    playback: true,
    lyrics: false,
    recommendations: false,
  },
  async search(query: string): Promise<SearchHit[]> {
    if (!query.trim()) return []
    const tracks = await api.listTracks(query, 200, 0)
    return tracks.map<SearchHit>(t => ({ kind: 'track', track: localTrackToUnified(t) }))
  },
  async getTrack(id: string): Promise<UnifiedTrack> {
    parseDbId(id)
    const track = await findTrackById(id)
    if (!track) throw new Error(`track not found in local library: ${id}`)
    return localTrackToUnified(track)
  },
  async getAlbum(id: string): Promise<Album> {
    const detail = await api.getAlbum(parseDbId(id))
    return detail.album
  },
  async getArtist(id: string): Promise<Artist> {
    const detail = await api.getArtist(parseDbId(id))
    return detail.artist
  },
}

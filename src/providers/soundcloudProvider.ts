import { api } from '../api/client'
import type { ScTrack, UnifiedTrack } from '../types/models'
import type { MusicProvider, SearchHit } from './provider'

export function scTrackToUnified(t: ScTrack): UnifiedTrack {
  return {
    source: 'soundcloud',
    sourceId: t.id,
    dbId: null,
    title: t.title,
    artists: [t.artist],
    album: null,
    durationSec: t.durationMs / 1000,
    coverPath: t.artworkUrl,
    playable: t.streamable && (t.hasProgressive || t.hasHls),
    localPath: null,
    externalUrl: t.permalinkUrl,
  }
}

export const soundcloudProvider: MusicProvider = {
  id: 'soundcloud',
  name: 'SoundCloud',
  capabilities: {
    search: true,
    metadata: true,
    playback: true,
    lyrics: false,
    recommendations: false,
  },
  async search(query: string): Promise<SearchHit[]> {
    if (!query.trim()) return []
    const tracks = await api.scSearchTracks(query, 50, 0)
    return tracks.map<SearchHit>(t => ({ kind: 'track', track: scTrackToUnified(t) }))
  },
}

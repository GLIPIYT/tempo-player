import { api } from '../api/client'
import type { ScTrack, UnifiedTrack } from '../types/models'
import type { MusicProvider, SearchHit } from './provider'

export function scTrackToUnified(t: ScTrack): UnifiedTrack {
  return {
    source: 'soundcloud',
    traits: { genre: t.genre?.slice(0, 96) ?? null, tags: t.tags?.slice(0, 16).map(tag => tag.slice(0, 64)) ?? null,
      bpm: Number.isFinite(t.bpm) && t.bpm! >= 30 && t.bpm! <= 300 ? t.bpm : null },
    sourceId: t.id,
    dbId: null,
    title: t.title,
    artists: [t.artist],
    artistAvatarUrl: t.artistAvatarUrl,
    album: null,
    durationSec: t.durationMs / 1000,
    coverPath: t.artworkUrl,
    playable: t.streamable && (t.hasProgressive || t.hasHls),
    localPath: null,
    externalUrl: t.permalinkUrl,
    // streams are never levelled: the gain path is same-origin only
    gainDb: null,
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

import { api } from '../api/client'
import { getSettings } from '../state/settings'
import type { UnifiedTrack, YtSearchHit } from '../types/models'
import type { MusicProvider, SearchHit } from './provider'

/** The yt-dlp binary the user pointed at, or an empty string for "on PATH". */
export function ytdlpPath(): string {
  return getSettings().ytdlp.path
}

/** A YouTube hit as something the player can queue. */
export function ytHitToUnified(hit: YtSearchHit): UnifiedTrack {
  return {
    source: 'youtube',
    sourceId: hit.id,
    dbId: null,
    title: hit.title,
    artists: hit.artist ? [hit.artist] : [],
    album: hit.album,
    durationSec: hit.durationMs > 0 ? hit.durationMs / 1000 : null,
    coverPath: hit.thumbnailUrl,
    playable: true,
    // Nothing is local until a download runs, and the player runs one on play:
    // a googlevideo URL wants a matching User-Agent that an audio element
    // cannot send, so it never goes straight to the element.
    localPath: null,
    externalUrl: hit.url,
    gainDb: null,
  }
}

/**
 * Search reads metadata from YouTube Music's web response, falling back to
 * yt-dlp on failure. Playback and downloads remain managed by yt-dlp.
 */
export const youtubeProvider: MusicProvider = {
  id: 'youtube',
  name: 'YouTube',
  capabilities: {
    search: true,
    metadata: true,
    playback: true,
    lyrics: false,
    recommendations: false,
  },
  async search(query: string): Promise<SearchHit[]> {
    if (!query.trim()) return []
    const hits = await api.ytdlpSearch(ytdlpPath(), query, 20)
    return hits.map<SearchHit>((hit) => ({ kind: 'track', track: ytHitToUnified(hit) }))
  },
}

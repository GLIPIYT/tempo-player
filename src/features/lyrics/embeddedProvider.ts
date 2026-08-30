import { api } from '../../api/client'
import type { UnifiedTrack } from '../../types/models'
import { parseLrc } from './lrc'
import type { LyricsProvider, LyricsResult } from './types'

export const EmbeddedTagsLyricsProvider: LyricsProvider = {
  id: 'embedded',
  name: 'Embedded tags',
  async getLyrics(track: UnifiedTrack): Promise<LyricsResult | null> {
    if (track.dbId == null) return null
    let raw: string | null
    try {
      raw = await api.getTrackLyrics(track.dbId)
    } catch {
      return null
    }
    if (!raw || !raw.trim()) return null
    const lines = parseLrc(raw)
    if (lines && lines.length > 0) return { kind: 'synced', lines }
    return { kind: 'plain', text: raw.trim() }
  },
}

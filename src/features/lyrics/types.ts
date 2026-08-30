import type { UnifiedTrack } from '../../types/models'

export type LyricsResult =
  | { kind: 'synced'; lines: LyricsLine[] }
  | { kind: 'plain'; text: string }

export interface LyricsLine {
  timeSec: number
  text: string
}

export interface LyricsProvider {
  id: string
  name: string
  getLyrics(track: UnifiedTrack): Promise<LyricsResult | null>
}

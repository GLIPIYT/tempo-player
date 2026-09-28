import type { UnifiedTrack } from '../../types/models'

export type LyricsResult =
  | { kind: 'synced'; lines: LyricsLine[] }
  | { kind: 'plain'; text: string }

export interface LyricsLine {
  timeSec: number
  text: string
  endTimeSec?: number
  endSource?: 'manual' | 'source'
  words?: LyricsWord[]
}

export interface LyricsWord {
  text: string
  timeSec: number
  /** A last word start alone does not establish the phrase end. */
  endTimeSec?: number | null
}

export interface LyricsProvider {
  id: string
  name: string
  getLyrics(track: UnifiedTrack): Promise<LyricsResult | null>
}

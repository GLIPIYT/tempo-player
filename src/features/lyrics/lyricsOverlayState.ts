import type { LyricsResult } from './types'
import type { UnifiedTrack } from '../../types/models'
import type { LyricsCandidate } from './onlineProvider'
import { formatLrc } from './lrc'

export type LyricsOverlayMode = LyricsResult['kind'] | 'empty' | 'loading'

export interface ManualLyricsSearchState {
  trackIdentity: string
  artist: string
  title: string
  visible: boolean
}

export type ManualLyricsSearchAction =
  | { type: 'trackChanged'; trackIdentity: string; artist: string; title: string }
  | { type: 'artistChanged'; value: string }
  | { type: 'titleChanged'; value: string }
  | { type: 'visibilityChanged'; visible: boolean }

export function manualLyricsTrackIdentity(track: Pick<UnifiedTrack, 'source' | 'sourceId'> | null): string {
  return track ? `${track.source}|${track.sourceId}` : ''
}

/** Keep saved local-tag lyrics available if manual search races the initial candidate read. */
export function mergeManualLyricsCandidates(
  existing: readonly LyricsCandidate[],
  searched: readonly LyricsCandidate[],
  savedLocalLyrics: LyricsResult | null,
): LyricsCandidate[] {
  const embedded = existing.filter((candidate) => candidate.provider === 'embedded')
  const fallback = embedded.length > 0 || !savedLocalLyrics
    ? []
    : [{
        provider: 'embedded',
        result: savedLocalLyrics,
        plain: savedLocalLyrics.kind === 'plain' ? savedLocalLyrics.text : null,
        syncedLrc: savedLocalLyrics.kind === 'synced' ? formatLrc(savedLocalLyrics.lines) : null,
      }]
  return [...(embedded.length > 0 ? embedded : fallback), ...searched]
}

export function lyricsOverlayMode({
  activeResult,
  candidatesLoading,
  sharedRequestLoading,
  manualSearchLoading,
  candidateCount,
}: {
  activeResult: LyricsResult | null
  candidatesLoading: boolean
  sharedRequestLoading: boolean
  manualSearchLoading: boolean
  candidateCount: number
}): LyricsOverlayMode {
  return activeResult?.kind ?? (candidateCount === 0
    && (candidatesLoading || sharedRequestLoading || manualSearchLoading)
    ? 'loading'
    : 'empty')
}

export function manualLyricsSearchReducer(
  state: ManualLyricsSearchState,
  action: ManualLyricsSearchAction,
): ManualLyricsSearchState {
  if (action.type === 'trackChanged') {
    if (state.trackIdentity === action.trackIdentity) return state
    return {
      trackIdentity: action.trackIdentity,
      artist: action.artist,
      title: action.title,
      visible: false,
    }
  }
  switch (action.type) {
    case 'artistChanged':
      return { ...state, artist: action.value, visible: true }
    case 'titleChanged':
      return { ...state, title: action.value, visible: true }
    case 'visibilityChanged':
      return { ...state, visible: action.visible }
  }
}

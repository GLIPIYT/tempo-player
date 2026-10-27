import type { LyricsResult } from './types'
import type { UnifiedTrack } from '../../types/models'

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

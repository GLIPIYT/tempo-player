import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useSettings } from './settings'
import type { HourMix } from '../utils/hourMixes'
import type { UnifiedTrack } from '../types/models'

export type BaseView =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'albums' }
  | { name: 'artists' }
  | { name: 'playlists' }
  | { name: 'profile' }
  | { name: 'settings' }
  | { name: 'search' }
  | { name: 'album'; id: number }
  | { name: 'artist'; id: number }
  | { name: 'local-artist'; artistName: string; imagePath: string | null }
  | { name: 'playlist'; id: number }
  | { name: 'hour-mix'; mix: HourMix }
  /** SoundCloud pages, browsed live and not written to the library. */
  | { name: 'sc-playlist'; id: string }
  | { name: 'sc-artist'; id: string; artistName?: string; fallback?: ScArtistFallback }
  /** YouTube Music collections, browsed live the same way. */
  | { name: 'yt-collection'; kind: 'album' | 'artist' | 'playlist'; id: string; artistName?: string }

export interface ScArtistFallback {
  artistName: string
  imagePath: string | null
}

export type View = BaseView | { name: 'track-details'; track: UnifiedTrack; previous: BaseView }

interface NavState {
  view: View
  navigate: (v: View) => void
}

const NavContext = createContext<NavState | null>(null)

export function NavProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings()
  const [view, setView] = useState<View>(() => ({ name: settings.startupPage }))
  const navigate = useCallback((v: View) => setView(v), [])
  const value = useMemo(() => ({ view, navigate }), [view, navigate])
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>
}

export function useNav(): NavState {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNav used outside NavProvider')
  return ctx
}

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useSettings } from './settings'

export type View =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'albums' }
  | { name: 'artists' }
  | { name: 'playlists' }
  | { name: 'history' }
  | { name: 'settings' }
  | { name: 'search' }
  | { name: 'album'; id: number }
  | { name: 'artist'; id: number }
  | { name: 'playlist'; id: number }

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

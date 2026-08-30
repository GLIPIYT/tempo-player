import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import LyricsOverlay from './LyricsOverlay'

interface LyricsApi {
  open: boolean
  openLyrics: () => void
  closeLyrics: () => void
}

const LyricsContext = createContext<LyricsApi | null>(null)

export function LyricsContextProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const openLyrics = useCallback(() => setOpen(true), [])
  const closeLyrics = useCallback(() => setOpen(false), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyL' || !(e.ctrlKey || e.metaKey)) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      setOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const value = useMemo(() => ({ open, openLyrics, closeLyrics }), [open, openLyrics, closeLyrics])

  return (
    <LyricsContext.Provider value={value}>
      {children}
      {open && <LyricsOverlay onClose={closeLyrics} />}
    </LyricsContext.Provider>
  )
}

export function useLyrics(): LyricsApi {
  const ctx = useContext(LyricsContext)
  if (!ctx) throw new Error('useLyrics used outside LyricsContextProvider')
  return ctx
}

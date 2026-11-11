import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import LyricsOverlay from './LyricsOverlay'
import { usePlayer, usePlayerField } from '../../player'
import ArtworkView from '../../components/artwork-view/ArtworkView'
import TrackDetails from '../../components/track-details/TrackDetails'
import { useNav } from '../../state/nav'
import { DevProfile } from '../../dev-performance/DevProfile'

interface LyricsApi {
  open: boolean
  openLyrics: () => void
  closeLyrics: () => void
  openArtwork: () => void
  openTrackDetails: (mode: 'full' | 'compact') => void
}

const LyricsContext = createContext<LyricsApi | null>(null)

function CompactTrackDetails({ onClose, onOpenFull, onArtistNavigate }: {
  onClose: () => void
  onOpenFull: () => void
  onArtistNavigate: () => void
}) {
  const { currentTrack, position, duration, seek } = usePlayer()
  if (!currentTrack) return null
  return <TrackDetails track={currentTrack} position={position} duration={duration} onClose={onClose}
    onOpenFull={onOpenFull} onSeek={seek} onArtistNavigate={onArtistNavigate} />
}

export function LyricsContextProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [surface, setSurface] = useState<'artwork' | 'compact' | null>(null)
  const track = usePlayerField('currentTrack')
  const { view, navigate } = useNav()
  const openLyrics = useCallback(() => setOpen(true), [])
  const closeLyrics = useCallback(() => { setOpen(false); setSurface(value => value === 'compact' ? null : value) }, [])
  const openArtwork = useCallback(() => setSurface('artwork'), [])
  const openCompactDetails = useCallback(() => setSurface('compact'), [])
  const openFullDetails = useCallback(() => {
    if (!track) return
    navigate({ name: 'track-details', track, previous: view.name === 'track-details' ? view.previous : view })
    setSurface(null)
    setOpen(false)
  }, [navigate, track, view])
  const openTrackDetails = useCallback((mode: 'full' | 'compact') => {
    if (mode === 'full') openFullDetails()
    else openCompactDetails()
  }, [openCompactDetails, openFullDetails])
  const closeSurface = useCallback(() => setSurface(null), [])

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

  const value = useMemo(() => ({ open, openLyrics, closeLyrics, openArtwork, openTrackDetails }), [open, openLyrics, closeLyrics, openArtwork, openTrackDetails])

  return (
    <LyricsContext.Provider value={value}>
      {children}
      {open && (
        <DevProfile id="lyrics">
          <LyricsOverlay onClose={closeLyrics} onArtwork={openArtwork} onTrackDetails={openCompactDetails} />
        </DevProfile>
      )}
      {surface === 'artwork' && track && <ArtworkView track={track} onClose={closeSurface} />}
      {surface === 'compact' && (
        <CompactTrackDetails onClose={closeSurface} onOpenFull={openFullDetails}
          onArtistNavigate={() => { closeSurface(); closeLyrics() }} />
      )}
    </LyricsContext.Provider>
  )
}

export function useLyrics(): LyricsApi {
  const ctx = useContext(LyricsContext)
  if (!ctx) throw new Error('useLyrics used outside LyricsContextProvider')
  return ctx
}

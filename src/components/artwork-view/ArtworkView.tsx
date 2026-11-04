import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useT } from '../../i18n'
import type { UnifiedTrack } from '../../types/models'
import Cover from '../common/Cover'
import './artwork-view.css'

interface ArtworkViewProps {
  track: UnifiedTrack
  onClose: () => void
}

/** A non-modal artwork view: the rest of the player remains interactive. */
export default function ArtworkView({ track, onClose }: ArtworkViewProps) {
  const t = useT()
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const closeButton = closeRef.current
    closeButton?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopImmediatePropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      // Do not steal focus back after the user has interacted with the player.
      if (document.activeElement === closeButton && previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return createPortal(
    <div className="artwork-view">
      <div className="artwork-view__backdrop" aria-hidden="true" />
      <div className="artwork-view__image" role="img" aria-label={`${t('Artwork')}: ${track.title}`}>
        <Cover path={track.coverPath} label={track.title} size={640} loading="eager" />
      </div>
      <button ref={closeRef} type="button" className="artwork-view__close" onClick={onClose} aria-label={t('Close')} title={t('Close')}>
        <X size={20} aria-hidden="true" />
      </button>
    </div>,
    document.body,
  )
}

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useT } from '../../i18n'
import type { UnifiedTrack } from '../../types/models'
import Cover from '../common/Cover'
import { useExitTransition } from '../common/useExitTransition'
import './artwork-view.css'

interface ArtworkViewProps {
  track: UnifiedTrack
  onClose: () => void
}

export default function ArtworkView({ track, onClose }: ArtworkViewProps) {
  const t = useT()
  const closeRef = useRef<HTMLButtonElement>(null)
  const { closing, close } = useExitTransition(onClose)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const closeButton = closeRef.current
    closeButton?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeButton?.focus()
        return
      }
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopImmediatePropagation()
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [close])

  return createPortal(
    <div className={`artwork-view${closing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-label={`${t('Artwork')}: ${track.title}`}>
      <div className="artwork-view__backdrop" aria-hidden="true" onClick={() => close()} />
      <div className="artwork-view__image" role="img" aria-label={`${t('Artwork')}: ${track.title}`}>
        <Cover path={track.coverPath} label={track.title} size={640} loading="eager" />
      </div>
      <button ref={closeRef} type="button" className="artwork-view__close" onClick={() => close()} aria-label={t('Close')} title={t('Close')}>
        <X size={20} aria-hidden="true" />
      </button>
    </div>,
    document.body,
  )
}

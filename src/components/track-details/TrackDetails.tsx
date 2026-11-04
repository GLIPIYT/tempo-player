import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, X } from 'lucide-react'
import { useT } from '../../i18n'
import type { UnifiedTrack } from '../../types/models'
import { fmtTime } from '../../utils/format'
import Cover from '../common/Cover'
import './track-details.css'

export interface TrackDetailsProps {
  track: UnifiedTrack
  position: number
  duration: number
  onClose: () => void
  onOpenFull: () => void
}

export default function TrackDetails({ track, position, duration, onClose, onOpenFull }: TrackDetailsProps) {
  const t = useT()
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => { previouslyFocused?.focus() }
  }, [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        if (!buttons?.length) return
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handleKey, true)
    return () => document.removeEventListener('keydown', handleKey, true)
  }, [onClose])

  const knownDuration = Number.isFinite(duration) && duration > 0 ? duration : track.durationSec
  const safePosition = Number.isFinite(position) && position >= 0 ? position : null
  const progress = safePosition != null && knownDuration != null && knownDuration > 0
    ? Math.min(100, safePosition / knownDuration * 100) : 0
  const artist = track.artists.filter((name) => name.trim()).join(', ')
  return createPortal(
    <div className="track-details-layer" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="track-details track-details--compact" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="track-details-top">
          <span>{t('Track details')}</span>
          <button ref={closeRef} className="track-details-icon" type="button" onClick={onClose} aria-label={t('Close')}>
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        <div className="track-details-main">
          <div className="track-details-art"><Cover path={track.coverPath} label={track.title} size={104} loading="eager" /></div>
          <div className="track-details-content">
            <div className="track-details-heading">
              <h2 id={titleId}>{track.title}</h2>
              {artist && <p>{artist}</p>}
            </div>
            <div className="track-details-playback" aria-label={`${t('Position')}: ${fmtTime(safePosition)}; ${t('Duration')}: ${fmtTime(knownDuration)}`}>
              <div className="track-details-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
              <div className="track-details-times" aria-hidden="true"><span>{fmtTime(safePosition)}</span><span>{fmtTime(knownDuration)}</span></div>
            </div>
          </div>
        </div>
        <div className="track-details-actions">
          <button className="track-details-expand" type="button" onClick={onOpenFull}>
            {t('Open full details')} <ArrowUpRight size={17} aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>, document.body,
  )
}

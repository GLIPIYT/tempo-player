import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowUpRight, X } from 'lucide-react'
import { useT } from '../../i18n'
import type { UnifiedTrack } from '../../types/models'
import { fmtTime } from '../../utils/format'
import Cover from '../common/Cover'
import './track-details.css'

export interface TrackDetailsProps {
  track: UnifiedTrack
  position: number
  duration: number
  mode: 'full' | 'compact'
  onClose: () => void
  onOpenFull: () => void
}

export default function TrackDetails({ track, position, duration, mode, onClose, onOpenFull }: TrackDetailsProps) {
  const t = useT()
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (mode !== 'compact') return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => { previouslyFocused?.focus() }
  }, [mode])

  useEffect(() => {
    if (mode !== 'compact') return
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
  }, [mode, onClose])

  const knownDuration = Number.isFinite(duration) && duration > 0 ? duration : track.durationSec
  const safePosition = Number.isFinite(position) && position >= 0 ? position : null
  const progress = safePosition != null && knownDuration != null && knownDuration > 0
    ? Math.min(100, safePosition / knownDuration * 100) : 0
  const artist = track.artists.filter((name) => name.trim()).join(', ')
  const genre = track.traits?.genre?.trim()
  const version = track.traits?.version?.trim()
  const tags = track.traits?.tags?.filter((tag) => tag.trim()).join(', ')
  const bpm = track.traits?.bpm
  const source = track.source === 'local' ? t('Local files') : track.source === 'soundcloud' ? 'SoundCloud' : 'YouTube'
  const details = [
    track.album?.trim() && [t('Album'), track.album],
    [t('Source'), source],
    genre && [t('Genre'), genre],
    bpm != null && Number.isFinite(bpm) && bpm > 0 && ['BPM', String(bpm)],
    version && [t('Version'), version],
    tags && [t('Tags'), tags],
  ].filter((entry): entry is string[] => Array.isArray(entry))

  const content = (
      <section ref={dialogRef} className={`track-details track-details--${mode}`} role={mode === 'compact' ? 'dialog' : undefined} aria-modal={mode === 'compact' ? true : undefined} aria-labelledby={titleId}>
        <div className="track-details-top">
          {mode === 'full' ? <button className="track-details-back" type="button" onClick={onClose}><ArrowLeft size={17} aria-hidden="true" />{t('Back')}</button> : <span>{t('Track details')}</span>}
          {mode === 'compact' && <button ref={closeRef} className="track-details-icon" type="button" onClick={onClose} aria-label={t('Close')}>
            <X size={19} aria-hidden="true" />
          </button>}
        </div>
        <div className="track-details-main">
          <div className="track-details-art"><Cover path={track.coverPath} label={track.title} size={mode === 'full' ? 240 : 104} loading="eager" /></div>
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
        {mode === 'compact' && <div className="track-details-actions"><button className="track-details-expand" type="button" onClick={onOpenFull}>{t('Open full details')} <ArrowUpRight size={17} aria-hidden="true" /></button></div>}
        {mode === 'full' && <dl className="track-details-meta">{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      </section>
  )
  if (mode === 'full') return content
  return createPortal(
    <div className="track-details-layer" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      {content}
    </div>, document.body,
  )
}

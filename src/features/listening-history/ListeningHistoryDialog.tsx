import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, CheckCircle2, Clock3, Headphones, Music2, X } from 'lucide-react'
import { api } from '../../api/client'
import type { ListeningPeriodStats } from '../../types/models'
import { useAsync } from '../../hooks/useAsync'
import { useT, resolveLang } from '../../i18n'
import { useSettings } from '../../state/settings'
import { playerController } from '../../player/controller'
import { trackToUnified } from '../../utils/unified'
import Cover from '../../components/common/Cover'
import { useExitTransition } from '../../components/common/useExitTransition'
import { historyDateLabel, historyHours, hourlyLine, listeningPeriod, localDateKey, type ListeningSelection } from './period'
import './history-dialog.css'

const hour = (time: number, lang: 'ru' | 'en') => new Date(time * 1000).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function PeriodContent({ selection, stats, lang, onDay }: {
  selection: ListeningSelection; stats: ListeningPeriodStats; lang: 'ru' | 'en'; onDay: (date: string) => void
}) {
  const t = useT()
  const [hover, setHover] = useState<number | null>(null)
  const gradient = useId().replace(/:/gu, '')
  const selected = hover === null ? null : stats.buckets[hover]
  const max = Math.max(60, ...stats.buckets.map(bucket => bucket.listenedSec))
  const line = hourlyLine(stats.buckets.map(bucket => bucket.listenedSec))
  const title = historyDateLabel(selected?.from ?? stats.from, lang, selection.kind === 'month' && selected === null ? 'month' : 'day')
  const hours = `${historyHours(selected?.listenedSec ?? stats.totalListenedSec, lang)} ${lang === 'ru' ? 'ч' : 'h'}`
  const track = stats.topTrack
  const artist = stats.topArtist
  return (
    <div className="history-detail-content">
      <div className="history-chart-heading" aria-live="polite">
        <h3>{title}</h3>
        <p>{selection.kind === 'day' && selected ? `${hour(selected.from, lang)}–${hour(selected.to, lang)} · ` : ''}{hours}</p>
      </div>
      <div className="history-chart" onPointerLeave={() => setHover(null)} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(null)
      }}>
        <div className="history-chart-grid" aria-hidden="true"><i /><i /><i /></div>
        {selection.kind === 'month' ? (
          <div className={`history-day-bars${hover !== null ? ' has-hover' : ''}`}>
            {stats.buckets.map((bucket, index) => (
              <button key={bucket.from} type="button"
                className={`history-day-bar${hover === index ? ' is-hovered' : ''}${bucket.listenedSec === 0 ? ' is-empty' : ''}`}
                style={{ '--bar-height': `${Math.max(1.5, bucket.listenedSec / max * 100)}%`, '--bar-delay': `${index * 8}ms` } as CSSProperties}
                onPointerEnter={() => setHover(index)} onFocus={() => setHover(index)}
                onClick={() => onDay(localDateKey(new Date(bucket.from * 1000)))}
                aria-label={`${historyDateLabel(bucket.from, lang, 'day')}: ${historyHours(bucket.listenedSec, lang)} ${t('Hours')}. ${t('Show day details')}`}>
                <span className="history-bar-column"><span /></span>
                <span className="history-axis-label">{new Date(bucket.from * 1000).getDate()}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="history-hourly">
            <svg viewBox="0 0 680 180" preserveAspectRatio="none" aria-hidden="true">
              <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".24" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
              <path d={line.area} fill={`url(#${gradient})`} className="history-line-area" />
              <path d={line.path} fill="none" stroke="var(--accent)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" pathLength="1" className="history-line-path" />
              {hover !== null && line.points[hover] && <g className="history-hour-marker">
                <line x1={line.points[hover].x} x2={line.points[hover].x} y1="0" y2="160" stroke="var(--accent)" strokeOpacity=".24" />
                <circle cx={line.points[hover].x} cy={line.points[hover].y} r="4" fill="var(--accent)" stroke="var(--bg-elevated)" strokeWidth="2" />
              </g>}
            </svg>
            <div className="history-hour-hits">
              {stats.buckets.map((bucket, index) => <button key={bucket.from} type="button"
                onPointerEnter={() => setHover(index)} onFocus={() => setHover(index)}
                aria-label={`${hour(bucket.from, lang)}–${hour(bucket.to, lang)}: ${historyHours(bucket.listenedSec, lang)} ${t('Hours')}`}
                title={`${hour(bucket.from, lang)}–${hour(bucket.to, lang)}`} />)}
            </div>
            <div className="history-hour-labels" aria-hidden="true">{stats.buckets.filter((_, index) => index % 4 === 0).map(bucket => <span key={bucket.from}>{hour(bucket.from, lang)}</span>)}<span>24:00</span></div>
          </div>
        )}
      </div>
      <p className="history-chart-note">{t('By listen start time')}</p>
      <div className="history-summary">
        <div><Clock3 size={16} /><strong>{historyHours(stats.totalListenedSec, lang)}</strong><span>{t('Hours')}</span></div>
        <div><Headphones size={16} /><strong>{stats.plays.toLocaleString()}</strong><span>{t('Listens')}</span></div>
        <div><CheckCircle2 size={16} /><strong>{stats.plays ? `${Math.round(stats.completionPct)}%` : '—'}</strong><span>{t('Completion rate')}{stats.plays > 0 ? ` · ${stats.completedPlays}/${stats.plays}` : ''}</span></div>
        <div><Music2 size={16} /><strong>{stats.uniqueTracks}</strong><span>{t('Unique tracks')}</span></div>
      </div>
      {stats.plays > 0 ? <div className="history-favorites">
        <div className="history-favorite">
          <span className="history-favorite-label">{t('Most-listened track')}</span>
          {track ? <button type="button" className="history-featured-track" onClick={() => playerController.playTracks([trackToUnified(track.track)], 0)}>
            <Cover path={track.track.coverPath} label={track.track.title} size={54} />
            <span><strong>{track.track.title}</strong><small>{track.track.artistName ?? t('Unknown artist')}</small><em>{historyHours(track.listenedSec, lang)} {lang === 'ru' ? 'ч' : 'h'} · {track.playCount} {t('plays')}</em></span>
          </button> : <span className="muted">—</span>}
        </div>
        <div className="history-favorite">
          <span className="history-favorite-label">{t(selection.kind === 'month' ? 'Most-listened artist' : 'Artist of the day')}</span>
          {artist ? <div className="history-featured-track">
            <Cover path={artist.artist.imagePath} label={artist.artist.name} size={54} rounded />
            <span><strong>{artist.artist.name}</strong><em>{historyHours(artist.listenedSec, lang)} {lang === 'ru' ? 'ч' : 'h'} · {artist.playCount} {t('plays')}</em></span>
          </div> : <span className="muted">{t('Unknown artist')}</span>}
        </div>
      </div> : <div className="history-empty">{t('No listening in this period')}</div>}
    </div>
  )
}

export default function ListeningHistoryDialog({ initialSelection, onClose }: { initialSelection: ListeningSelection; onClose: () => void }) {
  const t = useT()
  const { settings } = useSettings()
  const lang = resolveLang(settings.lang)
  const [selection, setSelection] = useState(initialSelection)
  const period = useMemo(() => listeningPeriod(selection), [selection])
  const request = useAsync(() => api.getListeningPeriod(period.boundaries), [period.from, period.to])
  const stats = request.data?.from === period.from && request.data?.to === period.to ? request.data : null
  const { closing, close } = useExitTransition(onClose, 180)
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => { previous?.focus() }
  }, [])
  useEffect(() => {
    if (!dialogRef.current?.contains(document.activeElement)) closeRef.current?.focus()
  }, [period.from, period.to, selection.kind])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key !== 'Tab') return
      const items = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')
      if (!items?.length) return
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [close])
  return createPortal(
    <div className={`history-detail-layer${closing ? ' is-closing' : ''}`}>
      <div className="history-detail-backdrop" aria-hidden="true" onClick={() => close()} />
      <section ref={dialogRef} className="history-detail-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="history-detail-header">
          <div className="history-detail-heading">
            {selection.kind === 'day' && <button type="button" className="history-detail-icon" aria-label={t('Back to month')} onClick={() => setSelection({ kind: 'month', date: selection.date })}><ArrowLeft size={18} /></button>}
            <h2 id={titleId}>{t('Listening details')}</h2>
          </div>
          <button ref={closeRef} type="button" className="history-detail-icon" aria-label={t('Close dialog')} onClick={() => close()}><X size={19} /></button>
        </header>
        <div className="history-detail-body" key={`${selection.kind}:${selection.date}`}>
          {request.error ? <div className="history-load-state" role="alert"><p>{t('Could not load listening details')}</p><button className="btn" type="button" onClick={request.reload}>{t('Retry')}</button></div>
            : !stats ? <div className="history-loading" aria-label={t('Loading…')} aria-busy="true"><span /><span /><span /><span /><span /><span /><span /></div>
              : <PeriodContent selection={selection} stats={stats} lang={lang} onDay={date => setSelection({ kind: 'day', date })} />}
        </div>
      </section>
    </div>, document.body,
  )
}

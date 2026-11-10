import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, CheckCircle2, Clock3, Headphones, Music2, X } from 'lucide-react'
import { api } from '../../api/client'
import type { ListeningPeriodStats } from '../../types/models'
import { useAsync } from '../../hooks/useAsync'
import { useT, resolveLang } from '../../i18n'
import { useSettings } from '../../state/settings'
import { useNav } from '../../state/nav'
import Cover from '../../components/common/Cover'
import { useExitTransition } from '../../components/common/useExitTransition'
import { historyDateLabel, historyHours, hourlyLine, smoothHourlyLine, listeningPeriod, listeningComparisonPeriod, localDateKey, type ListeningComparisonPeriod, type ListeningSelection } from './period'
import AnimatedValue from './AnimatedValue'
import AnimatedDelta from './AnimatedDelta'
import { FeaturedTracks } from './FeaturedTracks'
import './history-dialog.css'

const hour = (time: number, lang: 'ru' | 'en') => new Date(time * 1000).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function comparisonPeriodLabel(period: ListeningComparisonPeriod, lang: 'ru' | 'en') {
  if (period.kind === 'month' || period.kind === 'day') return historyDateLabel(period.from, lang, period.kind)
  return `${historyDateLabel(period.from, lang, 'day')} ${hour(period.from, lang)}–${hour(period.to, lang)}`
}

function hoverComparisonKind(kind: ListeningSelection['kind']): ListeningComparisonPeriod['kind'] {
  return kind === 'month' ? 'day' : kind === 'day' ? 'hour' : 'fiveMinutes'
}

interface PeriodComparison {
  key: string
  period: ListeningComparisonPeriod | null
  stats: ListeningPeriodStats | null
  error?: boolean
}

type ListeningPeriodRequestCache = Map<string, Promise<ListeningPeriodStats>>

function requestListeningPeriod(cache: ListeningPeriodRequestCache, boundaries: number[], referenceBefore?: number) {
  const key = `${boundaries.join(',')}:ref=${referenceBefore ?? ''}`
  const cached = cache.get(key)
  if (cached) return cached
  const request = api.getListeningPeriod(boundaries, referenceBefore).catch(error => {
    cache.delete(key)
    throw error
  })
  cache.set(key, request)
  if (cache.size > 128) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return request
}

function PeriodContent({ selection, stats, previous, previousError, previousLoading, requestCache, lang, onDay, onHour }: {
  selection: ListeningSelection; stats: ListeningPeriodStats; previous: PeriodComparison | null; previousError: boolean; previousLoading: boolean; requestCache: ListeningPeriodRequestCache; lang: 'ru' | 'en'; onDay: (date: string) => void; onHour: (time: number) => void
}) {
  const t = useT()
  const { navigate } = useNav()
  const [hover, setHover] = useState<number | null>(null)
  const hoverCache = useRef(new Map<string, Promise<PeriodComparison>>())
  const gradient = useId().replace(/:/gu, '')
  const selected = hover === null ? null : stats.buckets[hover]
  const hoverKey = selected ? `${stats.from}:${stats.to}:${selection.kind}:${selected.from}:${selected.to}` : ''
  const hoverRequest = useAsync(async () => {
    if (!selected) return null
    const cached = hoverCache.current.get(hoverKey)
    if (cached) return cached
    const comparison = (async (): Promise<PeriodComparison> => {
      try {
        const lookup = await requestListeningPeriod(requestCache, [selected.from, selected.to], selected.from)
        if (lookup.from !== selected.from || lookup.to !== selected.to || lookup.previousActiveAt == null) return { key: hoverKey, period: null, stats: null }
        const period = listeningComparisonPeriod(lookup.previousActiveAt, hoverComparisonKind(selection.kind))
        const previousStats = await requestListeningPeriod(requestCache, period.boundaries)
        if (previousStats.from !== period.from || previousStats.to !== period.to) return { key: hoverKey, period: null, stats: null }
        return { key: hoverKey, period, stats: previousStats }
      } catch {
        hoverCache.current.delete(hoverKey)
        return { key: hoverKey, period: null, stats: null, error: true }
      }
    })()
    hoverCache.current.set(hoverKey, comparison)
    return comparison
  }, [hoverKey])
  const hoveredComparison = hoverRequest.data?.key === hoverKey ? hoverRequest.data : null
  const max = Math.max(60, ...stats.buckets.map(bucket => bucket.listenedSec))
  const line = (selection.kind === 'hour' ? smoothHourlyLine : hourlyLine)(stats.buckets.map(bucket => bucket.listenedSec))
  const title = historyDateLabel(selected?.from ?? stats.from, lang, selection.kind === 'month' && selected === null ? 'month' : 'day')
  const unit = selection.kind !== 'hour' ? 'Hours' : selected ? 'Seconds' : 'Minutes'
  const durationDivisor = unit === 'Hours' ? 3600 : unit === 'Minutes' ? 60 : 1
  const durationText = (value: number) => (Math.max(0, value) / durationDivisor).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: unit === 'Seconds' ? 0 : 2 })
  const hours = `${durationText(selected?.listenedSec ?? stats.totalListenedSec)} ${t(unit)}`
  const tracks = useMemo(() => (stats.topTracks?.length ? stats.topTracks : stats.topTrack ? [stats.topTrack] : []).slice(0, 3), [stats])
  const artist = stats.topArtist
  const summary = selected ? { listenedSec: selected.listenedSec, plays: selected.plays,
    completedPlays: selected.completedPlays, completionPct: selected.completionPct ?? (selected.plays ? selected.completedPlays / selected.plays * 100 : 0),
    uniqueTracks: selected.uniqueTracks ?? 0 } : { listenedSec: stats.totalListenedSec, plays: stats.plays,
    completedPlays: stats.completedPlays, completionPct: stats.completionPct, uniqueTracks: stats.uniqueTracks }
  const formatHours = useMemo(() => (value: number) => (Math.max(0, value) / durationDivisor).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: durationDivisor === 1 ? 0 : 2 }), [lang, durationDivisor])
  const comparison = hover === null ? previous : hoveredComparison
  const old = comparison?.stats ? { listenedSec: comparison.stats.totalListenedSec, plays: comparison.stats.plays,
    completionPct: comparison.stats.completionPct, uniqueTracks: comparison.stats.uniqueTracks } : null
  const comparisonLabel = comparison?.period ? comparisonPeriodLabel(comparison.period, lang)
    : hover === null && previousLoading ? t('Loading comparison')
      : hover !== null && hoverRequest.loading ? t('Loading comparison')
        : hover === null && previousError || hover !== null && hoveredComparison?.error ? t('Could not load comparison')
          : t('No previous period')
  const formatNumber = useMemo(() => (value: number) => Math.round(value).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US'), [lang])
  const formatPercent = useMemo(() => (value: number) => `${Math.round(value)}%`, [])
  return (
    <div className="history-detail-content">
      <div className="history-chart-heading" aria-live="polite">
        <h3>{title}</h3>
        <p>{selection.kind !== 'month' && (selected || selection.kind === 'hour') ? `${hour(selected?.from ?? stats.from, lang)}–${hour(selected?.to ?? stats.to, lang)} · ` : ''}{hours}</p>
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
                onClick={() => { if (selection.kind === 'day') onHour(bucket.from) }}
                title={`${hour(bucket.from, lang)}–${hour(bucket.to, lang)}`} />)}
            </div>
            <div className="history-hour-labels" aria-hidden="true">{stats.buckets.filter((_, index) => index % (selection.kind === 'hour' ? 3 : 4) === 0).map(bucket => <span key={bucket.from}>{hour(bucket.from, lang)}</span>)}<span>{selection.kind === 'hour' ? hour(stats.to, lang) : '24:00'}</span></div>
          </div>
        )}
      </div>
      <p className="history-chart-note">{t(selection.kind === 'month' ? 'By day' : selection.kind === 'day' ? 'By hour' : 'By five minutes')}{selection.kind === 'hour' ? ` · ${t('By listening start time')}` : ''}</p>
      <div className="history-summary">
        <div><Clock3 size={16} /><div className="history-stat-main"><strong><AnimatedValue value={summary.listenedSec} format={formatHours} /></strong><AnimatedDelta current={summary.listenedSec} previous={old?.listenedSec ?? null} referenceLabel={comparisonLabel} formatValue={formatHours} /></div><span>{t(unit)}</span></div>
        <div><Headphones size={16} /><div className="history-stat-main"><strong><AnimatedValue value={summary.plays} format={formatNumber} /></strong><AnimatedDelta current={summary.plays} previous={old?.plays ?? null} referenceLabel={comparisonLabel} formatValue={formatNumber} /></div><span>{t('Listens')}</span></div>
        <div><CheckCircle2 size={16} /><div className="history-stat-main"><strong><AnimatedValue value={summary.plays ? summary.completionPct : null} format={formatPercent} /></strong><AnimatedDelta current={summary.plays ? summary.completionPct : null} previous={old?.plays ? old.completionPct : null} referenceLabel={comparisonLabel} formatValue={formatPercent} /></div><span>{t('Completion rate')}{summary.plays > 0 ? ` · ${summary.completedPlays}/${summary.plays}` : ''}</span></div>
        <div><Music2 size={16} /><div className="history-stat-main"><strong><AnimatedValue value={summary.uniqueTracks} format={formatNumber} /></strong><AnimatedDelta current={summary.uniqueTracks} previous={old?.uniqueTracks ?? null} referenceLabel={comparisonLabel} formatValue={formatNumber} /></div><span>{t('Unique tracks')}</span></div>
      </div>
      {stats.plays > 0 ? <div className="history-favorites">
        <div className="history-favorite">
          <span className="history-favorite-label">{t('Most-listened track')}</span>
          <FeaturedTracks tracks={tracks} lang={lang} minutes={selection.kind === 'hour'} />
        </div>
        <div className="history-favorite">
          <span className="history-favorite-label">{t(selection.kind === 'month' ? 'Most-listened artist' : selection.kind === 'day' ? 'Artist of the day' : 'Artist of the hour')}</span>
          {artist ? <div className="history-featured-track">
            <Cover path={artist.artist.imagePath} label={artist.artist.name} size={54} rounded />
            <span><button type="button" className="history-artist-name" onClick={() => navigate({ name: 'artist', id: artist.artist.id })}>{artist.artist.name}</button><em>{selection.kind === 'hour' ? (artist.listenedSec / 60).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 2 }) : historyHours(artist.listenedSec, lang)} {selection.kind === 'hour' ? t('Minutes') : lang === 'ru' ? 'ч' : 'h'} · {artist.playCount} {t('plays')}</em></span>
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
  const [zoom, setZoom] = useState<'in' | 'out' | null>(null)
  const [zoomOrigin, setZoomOrigin] = useState(50)
  const requestCache = useRef<ListeningPeriodRequestCache>(new Map())
  const period = useMemo(() => listeningPeriod(selection), [selection])
  const request = useAsync(() => requestListeningPeriod(requestCache.current, period.boundaries, period.from), [selection.kind, period.from, period.to])
  const stats = request.data?.from === period.from && request.data?.to === period.to ? request.data : null
  const previousRequestKey = `${selection.kind}:${period.from}:${period.to}:${stats?.previousActiveAt ?? 'pending'}`
  const previousRequest = useAsync(async (): Promise<PeriodComparison> => {
    const key = previousRequestKey
    if (!stats || stats.previousActiveAt == null) return { key, period: null, stats: null }
    try {
      const previousPeriod = listeningComparisonPeriod(stats.previousActiveAt, selection.kind)
      const previousStats = await requestListeningPeriod(requestCache.current, previousPeriod.boundaries)
      if (previousStats.from !== previousPeriod.from || previousStats.to !== previousPeriod.to) return { key, period: null, stats: null }
      return { key, period: previousPeriod, stats: previousStats }
    } catch {
      return { key, period: null, stats: null, error: true }
    }
  }, [previousRequestKey])
  const previous = previousRequest.data?.key === previousRequestKey ? previousRequest.data : null
  const previousError = Boolean(previous?.error)
  const previousLoading = Boolean(stats?.previousActiveAt != null && !previous && !previousError)
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
            {selection.kind !== 'month' && <button type="button" className="history-detail-icon" aria-label={t(selection.kind === 'hour' ? 'Back to day' : 'Back to month')} onClick={() => { setZoom('out'); setSelection({ kind: selection.kind === 'hour' ? 'day' : 'month', date: selection.date }) }}><ArrowLeft size={18} /></button>}
            <h2 id={titleId}>{t('Listening details')}</h2>
          </div>
          <button ref={closeRef} type="button" className="history-detail-icon" aria-label={t('Close dialog')} onClick={() => close()}><X size={19} /></button>
        </header>
        <div className={`history-detail-body${zoom ? ` is-zoom-${zoom}` : ''}`} style={{ '--history-zoom-origin': `${zoomOrigin}%` } as CSSProperties} key={`${selection.kind}:${period.from}`}>
          {request.error ? <div className="history-load-state" role="alert"><p>{t('Could not load listening details')}</p><button className="btn" type="button" onClick={request.reload}>{t('Retry')}</button></div>
            : !stats ? <div className="history-loading" aria-label={t('Loading…')} aria-busy="true"><span /><span /><span /><span /><span /><span /><span /></div>
              : <PeriodContent key={`${selection.kind}:${period.from}`} selection={selection} stats={stats} previous={previous} previousError={previousError} previousLoading={previousLoading} requestCache={requestCache.current} lang={lang} onDay={date => { setZoom('in'); setZoomOrigin(50); setSelection({ kind: 'day', date }) }} onHour={hourFrom => { setZoom('in'); setZoomOrigin((hourFrom - period.from) / (period.to - period.from) * 100); setSelection({ kind: 'hour', date: localDateKey(new Date(hourFrom * 1000)), hourFrom }) }} />}
        </div>
      </section>
    </div>, document.body,
  )
}

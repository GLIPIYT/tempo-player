import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Headphones, Music2, X } from 'lucide-react'
import { api } from '../../api/client'
import type { ListeningPeriodStats, Track } from '../../types/models'
import { useAsync } from '../../hooks/useAsync'
import { useT, resolveLang } from '../../i18n'
import { useSettings } from '../../state/settings'
import Cover from '../../components/common/Cover'
import { useExitTransition } from '../../components/common/useExitTransition'
import { historyDateLabel, historyHours, hourlyLine, smoothHourlyLine, listeningPeriod, listeningComparisonPeriod, localDateKey, shiftListeningMonth, type ListeningComparisonPeriod, type ListeningSelection } from './period'
import AnimatedValue from './AnimatedValue'
import AnimatedDelta from './AnimatedDelta'
import { FeaturedTracks } from './FeaturedTracks'
import type { ListeningSubject } from './dialogState'
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

function requestListeningPeriod(cache: ListeningPeriodRequestCache, boundaries: number[], referenceBefore?: number, subject?: ListeningSubject) {
  const key = `${subject?.kind ?? ''}:${subject?.id ?? ''}:${boundaries.join(',')}:ref=${referenceBefore ?? ''}`
  const cached = cache.get(key)
  if (cached) return cached
  const scope = subject ? { kind: subject.kind, id: subject.id } : undefined
  const request = api.getListeningPeriod(boundaries, referenceBefore, scope).catch(error => {
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

interface MonthNavigation {
  previous: () => void
  next: () => void
  canPrevious: boolean
  canNext: boolean
  status: 'idle' | 'loading' | 'error'
  slide?: MonthFrame
  finishSlide: () => void
}

interface MonthFrame {
  key: string
  stats: ListeningPeriodStats
  outgoing: ListeningPeriodStats | null
  direction: -1 | 1
}

function MonthBars({ stats, lang, hover = null, onHover, onDay }: {
  stats: ListeningPeriodStats; lang: 'ru' | 'en'; hover?: number | null
  onHover?: (index: number) => void; onDay?: (date: string) => void
}) {
  const t = useT()
  const max = Math.max(60, ...stats.buckets.map(bucket => bucket.listenedSec))
  const Cell = onDay ? 'button' : 'span'
  return <div className={`history-day-bars${hover !== null ? ' has-hover' : ''}`}>
    {stats.buckets.map((bucket, index) => {
      const date = new Date(bucket.from * 1000)
      return <Cell key={bucket.from} type={onDay ? 'button' : undefined}
        className={`history-day-bar${hover === index ? ' is-hovered' : ''}${bucket.listenedSec === 0 ? ' is-empty' : ''}`}
        style={{ '--bar-height': `${Math.max(1.5, bucket.listenedSec / max * 100)}%`, '--bar-delay': `${index * 8}ms` } as CSSProperties}
        onPointerEnter={onHover ? () => onHover(index) : undefined} onFocus={onHover ? () => onHover(index) : undefined}
        onClick={onDay ? () => onDay(localDateKey(date)) : undefined}
        aria-label={onDay ? `${historyDateLabel(bucket.from, lang, 'day')}: ${historyHours(bucket.listenedSec, lang)} ${t('Hours')}. ${t('Show day details')}` : undefined}>
        <span className="history-bar-column"><span /></span>
        <span className="history-axis-label">{date.getDate()}</span>
      </Cell>
    })}
  </div>
}

function PeriodContent({ selection, stats, previous, previousError, previousLoading, requestCache, lang, subject, monthNavigation, onDay, onHour, onSubject }: {
  selection: ListeningSelection; stats: ListeningPeriodStats; previous: PeriodComparison | null; previousError: boolean; previousLoading: boolean
  requestCache: ListeningPeriodRequestCache; lang: 'ru' | 'en'; subject?: ListeningSubject; monthNavigation?: MonthNavigation
  onDay: (date: string) => void; onHour: (time: number) => void; onSubject: (subject: ListeningSubject) => void
}) {
  const t = useT()
  const [hovered, setHovered] = useState<{ from: number; index: number } | null>(null)
  const hover = hovered?.from === stats.from ? hovered.index : null
  const setHover = (index: number | null) => setHovered(index === null ? null : { from: stats.from, index })
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
        const lookup = await requestListeningPeriod(requestCache, [selected.from, selected.to], selected.from, subject)
        if (lookup.from !== selected.from || lookup.to !== selected.to || lookup.previousActiveAt == null) return { key: hoverKey, period: null, stats: null }
        const period = listeningComparisonPeriod(lookup.previousActiveAt, hoverComparisonKind(selection.kind))
        const previousStats = await requestListeningPeriod(requestCache, period.boundaries, undefined, subject)
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
  const line = (selection.kind === 'hour' ? smoothHourlyLine : hourlyLine)(stats.buckets.map(bucket => bucket.listenedSec))
  const title = historyDateLabel(selected?.from ?? stats.from, lang, selection.kind === 'month' && selected === null ? 'month' : 'day')
  const unit = selection.kind !== 'hour' ? 'Hours' : selected ? 'Seconds' : 'Minutes'
  const durationDivisor = unit === 'Hours' ? 3600 : unit === 'Minutes' ? 60 : 1
  const durationText = (value: number) => (Math.max(0, value) / durationDivisor).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: unit === 'Seconds' ? 0 : 2 })
  const hours = `${durationText(selected?.listenedSec ?? stats.totalListenedSec)} ${t(unit)}`
  const tracks = useMemo(() => stats.topTracks?.length ? stats.topTracks : stats.topTrack ? [stats.topTrack] : [], [stats])
  const artist = stats.topArtist
  const openTrack = (track: Track) => onSubject({
    kind: 'track', id: track.id, title: track.title, coverPath: track.coverPath,
    youtubeVideoId: track.source === 'youtube' ? track.externalId : undefined,
  })
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
  const slide = monthNavigation?.slide
  return (
    <div className="history-detail-content">
      <div className="history-chart-heading" aria-live="polite">
        <h3>{title}</h3>
        <p>{selection.kind !== 'month' && (selected || selection.kind === 'hour') ? `${hour(selected?.from ?? stats.from, lang)}–${hour(selected?.to ?? stats.to, lang)} · ` : ''}{hours}</p>
      </div>
      <div className={monthNavigation ? 'history-chart-row has-month-navigation' : 'history-chart-row'}>
      {monthNavigation && <button type="button" className="history-detail-icon history-month-arrow"
        disabled={!monthNavigation.canPrevious} aria-label={t('Previous month')} title={t('Previous month')}
        aria-disabled={monthNavigation.status === 'loading' || undefined}
        onClick={monthNavigation.previous}><ChevronLeft size={17} /></button>}
      <div className="history-chart" aria-busy={monthNavigation?.status === 'loading' || undefined} onPointerLeave={() => setHover(null)} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(null)
      }}>
        <div className="history-chart-grid" aria-hidden="true"><i /><i /><i /></div>
        {selection.kind === 'month' ? (
          <div className="history-month-viewport" data-direction={slide?.direction}>
            {slide?.outgoing && <div key={slide.outgoing.from} className="history-month-slide is-outgoing" aria-hidden="true"
              onAnimationEnd={event => { if (event.target === event.currentTarget) monthNavigation?.finishSlide() }}>
              <MonthBars stats={slide.outgoing} lang={lang} />
            </div>}
            <div key={stats.from} className={`history-month-slide${slide ? ' is-navigated' : ''}`}>
              <MonthBars stats={stats} lang={lang} hover={hover} onHover={setHover} onDay={onDay} />
            </div>
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
      {monthNavigation && <button type="button" className="history-detail-icon history-month-arrow"
        disabled={!monthNavigation.canNext} aria-label={t('Next month')} title={t('Next month')}
        aria-disabled={monthNavigation.status === 'loading' || undefined}
        onClick={monthNavigation.next}><ChevronRight size={17} /></button>}
      </div>
      {monthNavigation?.status === 'error' ? <p className="history-chart-note" role="alert">{t('Could not load listening details')}</p>
        : <p className="history-chart-note">{t(selection.kind === 'month' ? 'By day' : selection.kind === 'day' ? 'By hour' : 'By five minutes')}{selection.kind === 'hour' ? ` · ${t('By listening start time')}` : ''}</p>}
      <div className="history-summary">
        <div><Clock3 size={16} /><div className="history-stat-main"><strong><AnimatedValue value={summary.listenedSec} format={formatHours} /></strong><AnimatedDelta current={summary.listenedSec} previous={old?.listenedSec ?? null} referenceLabel={comparisonLabel} formatValue={formatHours} /></div><span>{t(unit)}</span></div>
        <div><Headphones size={16} /><div className="history-stat-main"><strong><AnimatedValue value={summary.plays} format={formatNumber} /></strong><AnimatedDelta current={summary.plays} previous={old?.plays ?? null} referenceLabel={comparisonLabel} formatValue={formatNumber} /></div><span>{t('Listens')}</span></div>
        <div><CheckCircle2 size={16} /><div className="history-stat-main"><strong><AnimatedValue value={summary.plays ? summary.completionPct : null} format={formatPercent} /></strong><AnimatedDelta current={summary.plays ? summary.completionPct : null} previous={old?.plays ? old.completionPct : null} referenceLabel={comparisonLabel} formatValue={formatPercent} /></div><span>{t('Completion rate')}{summary.plays > 0 ? ` · ${summary.completedPlays}/${summary.plays}` : ''}</span></div>
        <div><Music2 size={16} /><div className="history-stat-main"><strong><AnimatedValue value={summary.uniqueTracks} format={formatNumber} /></strong><AnimatedDelta current={summary.uniqueTracks} previous={old?.uniqueTracks ?? null} referenceLabel={comparisonLabel} formatValue={formatNumber} /></div><span>{t('Unique tracks')}</span></div>
      </div>
      {stats.plays === 0 ? <div className="history-empty">{t('No listening in this period')}</div>
        : subject?.kind !== 'track' && <div className="history-favorites">
        <FeaturedTracks key={stats.from} tracks={tracks} lang={lang} minutes={selection.kind === 'hour'}
          paired={subject?.kind === 'artist'} onTrack={openTrack} />
        {subject?.kind !== 'artist' && <div className="history-favorite">
          <span className="history-favorite-label">{t(selection.kind === 'month' ? 'Most-listened artist' : selection.kind === 'day' ? 'Artist of the day' : 'Artist of the hour')}</span>
          {artist ? <button type="button" className="history-featured-track"
            onClick={() => onSubject({ kind: 'artist', id: artist.artist.id, title: artist.artist.name, coverPath: artist.artist.imagePath })}>
            <Cover path={artist.artist.imagePath} label={artist.artist.name} size={54} rounded />
            <span><strong>{artist.artist.name}</strong><em>{selection.kind === 'hour' ? (artist.listenedSec / 60).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 2 }) : historyHours(artist.listenedSec, lang)} {selection.kind === 'hour' ? t('Minutes') : lang === 'ru' ? 'ч' : 'h'} · {artist.playCount} {t('plays')}</em></span>
          </button> : <span className="muted">{t('Unknown artist')}</span>}
        </div>}
      </div>}
    </div>
  )
}

const SUBJECT_LABELS = {
  track: 'Track statistics',
  artist: 'Artist statistics',
  album: 'Album statistics',
  playlist: 'Playlist statistics',
} as const

export default function ListeningHistoryDialog({ initialSelection, initialSubject, onClose }: {
  initialSelection: ListeningSelection; initialSubject?: ListeningSubject; onClose: () => void
}) {
  const t = useT()
  const { settings } = useSettings()
  const lang = resolveLang(settings.lang)
  const [selection, setSelection] = useState(initialSelection)
  const [subject, setSubject] = useState(initialSubject)
  const [trail, setTrail] = useState<Array<{ selection: ListeningSelection; subject?: ListeningSubject }>>([])
  const [zoom, setZoom] = useState<'in' | 'out' | null>(null)
  const [zoomOrigin, setZoomOrigin] = useState(50)
  const [monthFrame, setMonthFrame] = useState<MonthFrame | null>(null)
  const [monthStatus, setMonthStatus] = useState<MonthNavigation['status']>('idle')
  const pendingMonth = useRef<symbol | null>(null)
  const requestCache = useRef<ListeningPeriodRequestCache>(new Map())
  const period = useMemo(() => listeningPeriod(selection), [selection])
  const contentKey = `${subject?.kind ?? ''}:${subject?.id ?? ''}:${selection.kind}`
  const viewKey = `${contentKey}:${period.from}`
  const request = useAsync(async () => ({
    key: viewKey,
    stats: await requestListeningPeriod(requestCache.current, period.boundaries, period.from, subject),
  }), [viewKey])
  const activeMonthFrame = monthFrame?.key === viewKey ? monthFrame : undefined
  const stats = activeMonthFrame?.stats ?? (request.data?.key === viewKey ? request.data.stats : null)
  const previousRequestKey = `${viewKey}:${stats?.previousActiveAt ?? 'pending'}`
  const previousRequest = useAsync(async (): Promise<PeriodComparison> => {
    const key = previousRequestKey
    if (!stats || stats.previousActiveAt == null) return { key, period: null, stats: null }
    try {
      const previousPeriod = listeningComparisonPeriod(stats.previousActiveAt, selection.kind)
      const previousStats = await requestListeningPeriod(requestCache.current, previousPeriod.boundaries, undefined, subject)
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
  const selectPeriod = (next: ListeningSelection, zoom: 'in' | 'out' | null) => {
    pendingMonth.current = null
    setMonthStatus('idle')
    setMonthFrame(null)
    setZoom(zoom)
    setSelection(next)
  }
  const openSubject = (next: ListeningSubject) => {
    setTrail(items => [...items, { selection, subject }])
    setSubject(next)
    selectPeriod({ kind: 'month', date: selection.date }, null)
  }
  const parent = trail.at(-1)
  const back = () => {
    if (selection.kind === 'month') {
      if (!parent) return
      setTrail(items => items.slice(0, -1))
      setSubject(parent.subject)
      selectPeriod(parent.selection, null)
      return
    }
    selectPeriod({ kind: selection.kind === 'hour' ? 'day' : 'month', date: selection.date }, 'out')
  }
  const shiftMonth = async (direction: -1 | 1) => {
    if (!stats || pendingMonth.current) return
    const next: ListeningSelection = { kind: 'month', date: shiftListeningMonth(selection.date, direction) }
    const target = listeningPeriod(next)
    const token = Symbol()
    pendingMonth.current = token
    setMonthStatus('loading')
    try {
      const nextStats = await requestListeningPeriod(requestCache.current, target.boundaries, target.from, subject)
      if (pendingMonth.current !== token) return
      setMonthFrame({
        key: `${contentKey}:${target.from}`, stats: nextStats, direction,
        outgoing: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? null : stats,
      })
      setMonthStatus('idle')
      setSelection(next)
    } catch {
      if (pendingMonth.current === token) setMonthStatus('error')
    } finally {
      if (pendingMonth.current === token) pendingMonth.current = null
    }
  }
  const monthNavigation: MonthNavigation | undefined = subject && selection.kind === 'month' ? {
    canPrevious: listeningPeriod({ kind: 'month', date: shiftListeningMonth(selection.date, -1) }).from >= 0,
    canNext: selection.date.slice(0, 7) < localDateKey(new Date()).slice(0, 7),
    previous: () => { void shiftMonth(-1) },
    next: () => { void shiftMonth(1) },
    status: monthStatus,
    slide: activeMonthFrame,
    finishSlide: () => setMonthFrame(frame => frame === activeMonthFrame && frame ? { ...frame, outgoing: null } : frame),
  } : undefined
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => { pendingMonth.current = null; previous?.focus() }
  }, [])
  useEffect(() => {
    if (!dialogRef.current?.contains(document.activeElement)) closeRef.current?.focus()
  }, [viewKey])
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
            {(selection.kind !== 'month' || parent) && <button type="button" className="history-detail-icon"
              aria-label={t(selection.kind === 'hour' ? 'Back to day' : selection.kind === 'day' ? 'Back to month' : 'Back to previous statistics')}
              onClick={back}><ArrowLeft size={18} /></button>}
            {subject ? <div className="history-subject">
              <Cover path={subject.coverPath} label={subject.title} youtubeVideoId={subject.youtubeVideoId}
                size={48} loading="eager" rounded={subject.kind === 'artist'} />
              <div className="history-subject-copy">
                <span>{t(SUBJECT_LABELS[subject.kind])}</span>
                <h2 id={titleId} title={subject.title}>{subject.title}</h2>
              </div>
            </div> : <h2 id={titleId}>{t('Listening details')}</h2>}
          </div>
          <button ref={closeRef} type="button" className="history-detail-icon" aria-label={t('Close dialog')} onClick={() => close()}><X size={19} /></button>
        </header>
        <div className={`history-detail-body${zoom ? ` is-zoom-${zoom}` : ''}`} style={{ '--history-zoom-origin': `${zoomOrigin}%` } as CSSProperties} key={selection.kind === 'month' ? contentKey : viewKey}>
          {!stats && request.error ? <div className="history-load-state" role="alert"><p>{t('Could not load listening details')}</p><button className="btn" type="button" onClick={request.reload}>{t('Retry')}</button></div>
            : !stats ? <div className="history-loading" aria-label={t('Loading…')} aria-busy="true"><span /><span /><span /><span /><span /><span /><span /></div>
              : <PeriodContent selection={selection} stats={stats} previous={previous} previousError={previousError}
                previousLoading={previousLoading} requestCache={requestCache.current} lang={lang} subject={subject}
                monthNavigation={monthNavigation} onSubject={openSubject}
                onDay={date => { setZoomOrigin(50); selectPeriod({ kind: 'day', date }, 'in') }}
                onHour={hourFrom => { setZoomOrigin((hourFrom - period.from) / (period.to - period.from) * 100); selectPeriod({ kind: 'hour', date: localDateKey(new Date(hourFrom * 1000)), hourFrom }, 'in') }} />}
        </div>
      </section>
    </div>, document.body,
  )
}

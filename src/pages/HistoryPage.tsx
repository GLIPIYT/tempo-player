import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Clock,
  Download,
  Gauge,
  History,
  MicVocal,
  Play,
  SkipForward,
  Trash2,
} from 'lucide-react'
import { api } from '../api/client'
import type { AnalyticsData, AnalyticsPeriod, HistoryEntry, Track } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useNav } from '../state/nav'
import { usePlayer } from '../player'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'
import { trackToUnified } from '../utils/unified'
import ConfirmModal from '../components/common/ConfirmModal'
import Cover from '../components/common/Cover'
import EmptyState from '../components/common/EmptyState'
import StatCard from '../components/common/StatCard'

const PERIODS: { id: AnalyticsPeriod; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All time' },
]

function timeAgo(ts: number, t: (key: string) => string): string {
  const diffMin = Math.floor(Math.max(0, Date.now() / 1000 - ts) / 60)
  if (diffMin < 1) return t('Just now')
  if (diffMin < 60) return `${diffMin} ${t('min ago')}`
  const h = Math.floor(diffMin / 60)
  if (h < 24) return `${h} ${t('h ago')}`
  return `${Math.floor(h / 24)} ${t('d ago')}`
}

function unknownArtistOf(track: Track, fallback: string): string {
  return track.artistName ?? fallback
}

export default function HistoryPage() {
  const t = useT()
  const { navigate } = useNav()
  const player = usePlayer()

  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [clearOpen, setClearOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const cacheRef = useRef<Partial<Record<AnalyticsPeriod, AnalyticsData>>>({})
  const noteTimer = useRef<number | null>(null)

  const analytics = useAsync(async () => {
    const cached = cacheRef.current[period]
    if (cached) return cached
    const fresh = await api.getAnalytics(period)
    cacheRef.current[period] = fresh
    return fresh
  }, [period])

  const anyHistory = useAsync(() => api.getHistory(1, 0), [])

  useEffect(() => {
    return () => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
    }
  }, [])

  const flashNote = (msg: string) => {
    setNote(msg)
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(null), 2500)
  }

  const data = analytics.data
  const summary = data?.summary
  const hasAnyHistory = (anyHistory.data?.length ?? 0) > 0
  const unknownArtist = t('Unknown artist')

  const clearAll = async () => {
    setClearOpen(false)
    try {
      await api.clearHistory()
      cacheRef.current = {}
      analytics.reload()
      anyHistory.reload()
    } catch {}
  }

  const exportJson = async () => {
    if (!data) return
    const payload = { exportedAt: new Date().toISOString(), period, ...data }
    const json = JSON.stringify(payload, null, 2)
    try {
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'tempo-history.json'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch {
      try {
        await navigator.clipboard.writeText(json)
        flashNote(t('Copied to clipboard'))
      } catch {}
    }
  }

  const renderTrackRows = (rows: NonNullable<AnalyticsData['topTracks']>) =>
    rows.slice(0, 10).map((item, i) => (
      <button
        key={item.track.id}
        className="top-row"
        onClick={() => player.playTracks([trackToUnified(item.track)], 0)}
      >
        <span className="top-num">{i + 1}</span>
        <Cover path={item.track.coverPath} label={item.track.title} size={34} />
        <span className="top-meta">
          <span className="top-title">{item.track.title}</span>
          <span className="top-sub">{unknownArtistOf(item.track, unknownArtist)}</span>
        </span>
        <span className="count-badge">{item.playCount}</span>
      </button>
    ))

  const renderRecentRow = (entry: HistoryEntry) => (
    <button key={entry.id} className="top-row" onClick={() => player.playTracks([trackToUnified(entry.track)], 0)}>
      <Cover path={entry.track.coverPath} label={entry.track.title} size={34} />
      <span className="top-meta">
        <span className="top-title">{entry.track.title}</span>
        <span className="top-sub">{unknownArtistOf(entry.track, unknownArtist)}</span>
      </span>
      <span className="row-right">
        {entry.completed ? (
          <span className="mini-badge">
            <Check size={11} />
            {t('Completed')}
          </span>
        ) : entry.skipped ? (
          <span className="mini-badge">
            <SkipForward size={11} />
            {t('Skipped')}
          </span>
        ) : null}
        <span className="listened-dur">{fmtTime(entry.listenedSec)}</span>
        <span className="time-ago">{timeAgo(entry.playedAt, t)}</span>
      </span>
    </button>
  )

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('History')}</h1>
          <div className="page-sub">{t('Local listening statistics')}</div>
        </div>
        <div className="page-actions">
          {note ? <span className="export-note">{note}</span> : null}
          <button className="btn" disabled={!data} onClick={() => void exportJson()}>
            <Download size={15} />
            {t('Export')}
          </button>
          <button
            className="btn btn-danger"
            disabled={!hasAnyHistory}
            onClick={() => setClearOpen(true)}
          >
            <Trash2 size={15} />
            {t('Clear')}
          </button>
        </div>
      </div>

      {analytics.error ? <div className="error-line">{analytics.error}</div> : null}

      {!data && analytics.loading ? <div className="muted">{t('Loading…')}</div> : null}

      {anyHistory.data && anyHistory.data.length === 0 ? (
        <EmptyState
          icon={<History size={34} />}
          title={t('Nothing here yet')}
          hint={t('Play something for a few seconds and it will appear')}
        />
      ) : data && summary ? (
        <>
          <div className="seg hist-tabs" role="group">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                className={p.id === period ? 'seg-btn is-active' : 'seg-btn'}
                onClick={() => setPeriod(p.id)}
              >
                {t(p.label)}
              </button>
            ))}
          </div>

          <div className="stat-row">
            <StatCard icon={Clock} value={String(Math.round(summary.totalMinutes))} label={t('Minutes listened')} />
            <StatCard icon={Play} value={String(summary.plays)} label={t('Plays')} />
            <StatCard icon={MicVocal} value={String(summary.uniqueArtists)} label={t('Artists')} />
            <StatCard icon={Gauge} value={`${summary.avgCompletionPct.toFixed(0)}%`} label={t('Avg completion')} />
          </div>

          <div className="hist-cols">
            <section className="panel">
              <div className="panel-title">{t('Top tracks')}</div>
              {data.topTracks.length === 0 ? (
                <div className="muted panel-empty">{t('No listens in this period')}</div>
              ) : (
                renderTrackRows(data.topTracks)
              )}
            </section>
            <section className="panel">
              <div className="panel-title">{t('Top artists')}</div>
              {data.topArtists.length === 0 ? (
                <div className="muted panel-empty">{t('No listens in this period')}</div>
              ) : (
                data.topArtists.slice(0, 10).map((item, i) => (
                  <button
                    key={item.artist.id}
                    className="top-row"
                    onClick={() => navigate({ name: 'artist', id: item.artist.id })}
                  >
                    <span className="top-num">{i + 1}</span>
                    <Cover path={null} label={item.artist.name} size={34} rounded />
                    <span className="top-meta">
                      <span className="top-title">{item.artist.name}</span>
                    </span>
                    <span className="count-badge">{item.playCount}</span>
                  </button>
                ))
              )}
            </section>
          </div>

          <section className="panel hist-recent">
            <div className="panel-title">{t('Recent listens')}</div>
            {data.recent.length === 0 ? (
              <div className="muted panel-empty">{t('No listens in this period')}</div>
            ) : (
              data.recent.slice(0, 20).map(renderRecentRow)
            )}
          </section>
        </>
      ) : null}

      <ConfirmModal
        open={clearOpen}
        danger
        title={t('Clear history')}
        message={`${t('Listening history will be deleted. This cannot be undone.')} ${summary ? `(${summary.plays} ${t('plays')})` : ''}`}
        confirmLabel={t('Clear')}
        onConfirm={() => void clearAll()}
        onClose={() => setClearOpen(false)}
      />
    </div>
  )
}

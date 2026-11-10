import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { BarChart3, CheckCircle2, ChevronRight, Clock3, ImagePlus, ListMusic, Music2, Pencil, Play, Plus, User, Users } from 'lucide-react'
import { api } from '../api/client'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useSettings } from '../state/settings'
import { useNav } from '../state/nav'
import { resolveLang, useT } from '../i18n'
import { playerController } from '../player/controller'
import { trackToUnified } from '../utils/unified'
import Cover from '../components/common/Cover'
import type { Playlist, Track } from '../types/models'
import TrackContextMenu, { type TrackContextRequest } from '../components/common/TrackContextMenu'
import TrackSourceIcon from '../components/common/TrackSourceIcon'
import CreatePlaylistDialog from '../components/common/CreatePlaylistDialog'
import DeletePlaylistDialog from '../components/common/DeletePlaylistDialog'
import { createProfileEntityMenus } from '../features/profile/entityMenus'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { playlistDisplayName } from '../utils/playlists'
import { historyDialogState } from '../features/listening-history/dialogState'
import './profile-page.css'

function localeFor(lang: 'ru' | 'en'): string {
  return lang === 'ru' ? 'ru-RU' : 'en-US'
}

function dayLabel(dateStr: string, lang: 'ru' | 'en'): string {
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString(localeFor(lang), { day: 'numeric', month: 'short' })
}

function monthLabel(date: Date, lang: 'ru' | 'en'): string {
  return date.toLocaleDateString(localeFor(lang), { month: 'short' })
}

function hourLabel(minutes: number, lang: 'ru' | 'en'): string {
  if (minutes >= 60) return `${(minutes / 60).toLocaleString(localeFor(lang), { maximumFractionDigits: 1 })} ${lang === 'ru' ? 'ч' : 'h'}`
  return `${Math.round(minutes)} ${lang === 'ru' ? 'мин' : 'min'}`
}

export default function ProfilePage() {
  const { navigate } = useNav()
  const { settings, update } = useSettings()
  const t = useT()
  const version = useLibraryVersion()
  const lang = resolveLang(settings.lang)
  const [range, setRange] = useState<30 | 365>(365)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [avatarBusy, setAvatarBusy] = useState(false)
  const setHistorySelection = historyDialogState.open

  const stats = useAsync(() => api.getAnalytics('all'), [version])
  const daily = useAsync(() => api.getDailyMinutes(range), [version, range])
  const recent = useAsync(() => api.getHistory(12, 0), [version])
  const playlists = useAsync(() => api.listPlaylists(), [version])
  const [trackContext, setTrackContext] = useState<TrackContextRequest | null>(null)
  const [deletingPlaylist, setDeletingPlaylist] = useState<Playlist | null>(null)
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const createdPlaylistId = useRef<number | null>(null)
  const [chartHover, setChartHover] = useState<number | null>(null)
  const skipRestoredChartFocus = useRef(false)
  const entityMenus = useMemo(() => createProfileEntityMenus({ t, navigate, onDeletePlaylist: setDeletingPlaylist }), [t, navigate])
  const openTrackMenu = (event: MouseEvent, track: Track, tracks: Track[], index: number) => {
    event.preventDefault()
    event.stopPropagation()
    setTrackContext({ x: event.clientX, y: event.clientY, track, tracks, index })
  }


  const nickname = settings.profile.nickname
  const summary = stats.data?.summary
  const totalHours = summary ? Math.round((summary.totalMinutes / 60) * 10) / 10 : 0

  const playTopTrackAt = (index: number) => {
    const items = stats.data?.topTracks ?? []
    if (index < 0 || index >= items.length) return
    playerController.playTracks(items.map((item) => trackToUnified(item.track)), index)
  }

  const playRecentAt = (index: number) => {
    const entries = recent.data ?? []
    if (index < 0 || index >= entries.length) return
    playerController.playTracks(entries.map((entry) => trackToUnified(entry.track)), index)
  }

  const activityDays = useMemo(() => {
    const map = new Map((daily.data ?? []).map((d) => [d.date, d.minutes]))
    const out: { date: string; minutes: number }[] = []
    const today = new Date()
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      out.push({ date: key, minutes: map.get(key) ?? 0 })
    }
    return out
  }, [daily.data, range])
  const chart = useMemo(() => {
    if (range === 30) {
      return activityDays.map((day) => ({
        ...day,
        label: dayLabel(day.date, lang).split(' ')[0],
      }))
    }

    const today = new Date()
    const byMonth = new Map<string, number>()
    for (const day of activityDays) {
      const key = day.date.slice(0, 7)
      byMonth.set(key, (byMonth.get(key) ?? 0) + day.minutes)
    }
    return Array.from({ length: 12 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth() - 11 + index, 1)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      return { date: `${key}-01`, label: monthLabel(date, lang), minutes: byMonth.get(key) ?? 0 }
    })
  }, [activityDays, lang, range])
  const chartMax = Math.max(30, ...chart.map((d) => d.minutes))

  const saveName = () => {
    const trimmed = nameDraft.trim()
    update({ profile: { nickname: trimmed.length > 0 ? trimmed : null } })
    setEditingName(false)
  }

  const changeAvatar = async () => {
    setAvatarBusy(true)
    try {
      const sel = await open({
        multiple: false,
        filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      })
      if (typeof sel === 'string') {
        const stored = await api.importAvatar(sel)
        update({ profile: { avatarPath: stored } })
      }
    } catch {} finally {
      setAvatarBusy(false)
    }
  }

  const favoriteTracks = (stats.data?.topTracks ?? []).map(item => item.track)
  const recentTracks = (recent.data ?? []).map(entry => entry.track)
  const profilePlaylists = (playlists.data ?? []).filter(playlist => !playlist.isLikes).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt).slice(0, 4)
  const headerArtwork = favoriteTracks.find(track => track.coverPath)?.coverPath ?? recentTracks.find(track => track.coverPath)?.coverPath ?? null
  const selectedChart = chartHover === null ? null : chart[chartHover]
  const displayedActivityTotal = chart.reduce((sum, bucket) => sum + bucket.minutes, 0)
  const displayedActiveDays = activityDays.filter(day => day.date >= (chart[0]?.date ?? '') && day.minutes > 0).length
  return (
    <div className="page profile-panorama">
      <div className="pf-page-backdrop" aria-hidden="true" />
      <header className="pf-passport">
        <div className="pf-passport-glow" aria-hidden="true"><Cover path={headerArtwork} label={nickname ?? t('Profile')} size={900} /></div>
        <div className="pf-identity">
          <span className="pf-kicker">{t('Profile')}</span>
          {editingName ? <form className="pf-name-form" onSubmit={event => { event.preventDefault(); saveName() }}><input className="text-input" autoFocus value={nameDraft} aria-label={t('What should we call you?')} placeholder={t('What should we call you?')} maxLength={32} onChange={event => setNameDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setEditingName(false) }} /><button type="submit" className="icon-btn" aria-label={t('Save')}><CheckCircle2 size={21} /></button></form> : <h1><button onClick={() => { setNameDraft(nickname ?? ''); setEditingName(true) }}>{nickname ?? t('Your profile')}<Pencil size={18} /></button></h1>}
          <p>{t('Your music in numbers')}</p>
        </div>
        <button className="pf-avatar" title={t('Change avatar')} disabled={avatarBusy} onClick={() => void changeAvatar()}>
          {settings.profile.avatarPath ? <img src={convertFileSrc(settings.profile.avatarPath)} alt="" draggable={false} /> : <span className="pf-avatar-fallback"><User size={40} /></span>}
          <span className="pf-avatar-edit"><ImagePlus size={20} /></span>
        </button>
        <div className="pf-summary">
          <div><Clock3 size={18} /><strong>{totalHours.toLocaleString(localeFor(lang))}</strong><span>{t('Listening hours')}</span></div>
          <div><Music2 size={18} /><strong>{(summary?.plays ?? 0).toLocaleString(localeFor(lang))}</strong><span>{t('plays')}</span></div>
          <div><Users size={18} /><strong>{summary?.uniqueArtists ?? 0}</strong><span>{t('Artists')}</span></div>
          <div><CheckCircle2 size={18} /><strong>{summary ? `${Math.round(summary.avgCompletionPct)}%` : '—'}</strong><span>{t('Avg completion')}</span></div>
        </div>
      </header>
      {stats.error ? <div className="error-line">{stats.error}</div> : null}
      <section className="pf-activity">
        <div className="pf-section-head"><h2><BarChart3 size={17} />{t('Listening activity')}</h2><div className="pf-chart-controls">

          <div className="seg" role="group" aria-label={t('Time range')}>{([30, 365] as const).map(value => <button key={value} className={`seg-btn${range === value ? ' is-active' : ''}`} aria-pressed={range === value} onClick={() => { setChartHover(null); setRange(value) }}>{t(value === 30 ? 'Last 30 days' : 'Last 12 months')}</button>)}</div>
        </div></div>
        <div className="pf-chart-caption"><div><strong>{selectedChart ? range === 365 ? new Date(`${selectedChart.date}T00:00:00`).toLocaleDateString(localeFor(lang), { month: 'long', year: 'numeric' }) : dayLabel(selectedChart.date, lang) : t(range === 365 ? 'Last 12 months' : 'Last 30 days')}</strong><span>{displayedActiveDays} {t('active days')}</span></div><strong className="pf-chart-hours">{hourLabel(selectedChart?.minutes ?? displayedActivityTotal, lang)}</strong></div>
        {daily.error ? <div className="error-line">{daily.error}</div> : null}
        <div className={`pf-chart${range === 365 ? ' is-year' : ''}`} aria-label={t('Listening activity')} onPointerLeave={() => setChartHover(null)}>
          {chart.map((day, index) => <button type="button" key={day.date} className={`pf-chart-column${chartHover === index ? ' is-hovered' : ''}${chartHover !== null && chartHover !== index ? ' is-muted' : ''}`} onPointerEnter={() => setChartHover(index)} onFocus={event => { if (skipRestoredChartFocus.current) { skipRestoredChartFocus.current = false; return } if (event.currentTarget.matches(':focus-visible')) setChartHover(index) }} onBlur={() => setChartHover(null)} onClick={() => { skipRestoredChartFocus.current = true; setChartHover(null); setHistorySelection({ kind: range === 365 ? 'month' : 'day', date: day.date }) }} aria-label={`${t(range === 365 ? 'Show month details' : 'Show day details')}: ${day.label}`} title={`${day.label} — ${hourLabel(day.minutes, lang)}`}><span className="pf-bar-slot"><i style={{ height: `${Math.max(2, day.minutes / chartMax * 100)}%`, animationDelay: `${index * 10}ms` }} /></span><span>{day.label}</span></button>)}
        </div>
        <div className="pf-chart-foot"><span><i />{t('Listening activity')}</span><span>{t('Click a period to see details')}</span></div>
      </section>
      <div className="pf-rankings">
        <section className="pf-top-tracks"><div className="pf-section-head"><h2>{t('Top tracks')}</h2><span>{t('All time')}</span></div>
          {!favoriteTracks.length ? <p className="muted">{t(stats.loading ? 'Loading…' : 'Nothing here yet')}</p> : <div className="pf-track-list">{(stats.data?.topTracks ?? []).slice(0, 6).map((item, index) => <article key={item.track.id} onContextMenu={event => openTrackMenu(event, item.track, favoriteTracks, index)}><span className="pf-rank">{index + 1}</span><button className="pf-track-open" onClick={() => playTopTrackAt(index)}><span className="pf-track-art"><Cover path={item.track.coverPath} label={item.track.title} size={39} /><i><Play size={15} fill="currentColor" /></i></span><span><strong>{item.track.title}</strong><small>{item.track.artistName ?? t('Unknown artist')}</small></span></button><TrackSourceIcon source={item.track.source} /><span className="pf-play-count">{item.playCount} {t('plays')}</span></article>)}</div>}
        </section>
        <section className="pf-top-artists"><div className="pf-section-head"><h2>{t('Top artists')}</h2><span>{t('All time')}</span></div>
          {!(stats.data?.topArtists ?? []).length ? <p className="muted">{t(stats.loading ? 'Loading…' : 'Nothing here yet')}</p> : <div className="pf-artist-list">{(stats.data?.topArtists ?? []).slice(0, 5).map((item, index) => <button key={item.artist.id} type="button" onClick={() => navigate({ name: 'artist', id: item.artist.id })} onContextMenu={event => entityMenus.artist(event, item.artist)}><span className="pf-rank">{index + 1}</span><Cover path={item.artist.imagePath} label={item.artist.name} size={46} rounded /><span><strong>{item.artist.name}</strong><small>{item.playCount} {t('plays')}</small></span><ChevronRight size={15} /></button>)}</div>}
        </section>
      </div>
      <section className="pf-recent"><div className="pf-section-head"><h2>{t('Recent plays')}</h2><Clock3 size={15} /></div>
        {!recentTracks.length ? <p className="muted">{t(recent.loading ? 'Loading…' : 'Nothing here yet')}</p> : <div className="pf-recent-list">{(recent.data ?? []).slice(0, 8).map((entry, index) => <article key={entry.id} onContextMenu={event => openTrackMenu(event, entry.track, recentTracks, index)}><button className="pf-track-open" onClick={() => playRecentAt(index)}><span className="pf-track-art"><Cover path={entry.track.coverPath} label={entry.track.title} size={38} /><i><Play size={15} fill="currentColor" /></i></span><span><strong>{entry.track.title}</strong><small>{entry.track.artistName ?? t('Unknown artist')}</small></span></button><TrackSourceIcon source={entry.track.source} />{entry.track.albumId != null ? <button className="pf-album-link" onClick={() => navigate({ name: 'album', id: entry.track.albumId! })} onContextMenu={event => { event.stopPropagation(); entityMenus.album(event, { id: entry.track.albumId!, title: entry.track.albumTitle ?? t('Unknown album') }) }}>{entry.track.albumTitle ?? t('Unknown album')}</button> : <span className="pf-album-link">—</span>}<time>{new Date(entry.playedAt * 1000).toLocaleDateString(localeFor(lang), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></article>)}</div>}
      </section>
      <section className="pf-playlists"><div className="pf-section-head"><h2><ListMusic size={16} />{t('Your playlists')}<span className="pf-count">{(playlists.data ?? []).filter(playlist => !playlist.isLikes).length}</span></h2><button className="pf-text-action" onClick={() => { createdPlaylistId.current = null; setCreatingPlaylist(true) }}><Plus size={14} />{t('New playlist')}</button></div><div className="pf-playlist-grid">{profilePlaylists.map(playlist => <button key={playlist.id} onClick={() => navigate({ name: 'playlist', id: playlist.id })} onContextMenu={event => entityMenus.playlist(event, playlist)}><Cover path={playlist.coverPath ?? null} label={playlist.name} size={52} /><span><strong>{playlistDisplayName(playlist, playlist.name, t)}</strong><small>{playlist.trackCount ?? 0} {t('tracks')}</small></span><ChevronRight size={15} /></button>)}</div></section>
      <TrackContextMenu req={trackContext} onClose={() => setTrackContext(null)} />
      {deletingPlaylist && <DeletePlaylistDialog playlist={deletingPlaylist} onDelete={async () => { await api.deletePlaylist(deletingPlaylist.id); bumpLibraryVersion() }} onClose={() => setDeletingPlaylist(null)} />}
      {creatingPlaylist && <CreatePlaylistDialog onCreate={async (name, coverPath) => { const created = await api.createPlaylist(name, coverPath); createdPlaylistId.current = created.id; bumpLibraryVersion() }} onClose={created => { setCreatingPlaylist(false); if (created && createdPlaylistId.current != null) navigate({ name: 'playlist', id: createdPlaylistId.current }) }} />}
    </div>
  )
}

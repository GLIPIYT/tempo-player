import { useMemo, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { BarChart3, Grid2X2, ImagePlus, Pencil, User } from 'lucide-react'
import { api } from '../api/client'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useSettings } from '../state/settings'
import { resolveLang, useT } from '../i18n'
import Cover from '../components/common/Cover'

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

function hourLabel(minutes: number): string {
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)} h`
  return `${Math.round(minutes)} min`
}

export default function ProfilePage() {
  const { settings, update } = useSettings()
  const t = useT()
  const version = useLibraryVersion()
  const lang = resolveLang(settings.lang)
  const [range, setRange] = useState<30 | 365>(365)
  const [activityView, setActivityView] = useState<'graph' | 'grid'>('graph')
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [avatarBusy, setAvatarBusy] = useState(false)

  const stats = useAsync(() => api.getAnalytics('all'), [version])
  const daily = useAsync(() => api.getDailyMinutes(range), [version, range])
  const recent = useAsync(() => api.getHistory(12, 0), [version])

  const nickname = settings.profile.nickname
  const summary = stats.data?.summary
  const totalHours = summary ? Math.round((summary.totalMinutes / 60) * 10) / 10 : 0

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
  const activityGrid = useMemo(() => {
    if (activityDays.length === 0) return []
    const first = new Date(`${activityDays[0].date}T00:00:00`)
    const mondayOffset = (first.getDay() + 6) % 7
    return [...Array.from({ length: mondayOffset }, () => null), ...activityDays]
  }, [activityDays])
  const activeDays = activityDays.filter((day) => day.minutes > 0).length
  const activityTotal = activityDays.reduce((sum, day) => sum + day.minutes, 0)
  const weekdays = lang === 'ru' ? ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

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

  return (
    <div className="page profile-page-remaster">
      <div className="profile-head">
        <button
          className="avatar-edit"
          title={settings.profile.avatarPath ? t('Change avatar') : t('Pick an avatar')}
          disabled={avatarBusy}
          onClick={() => void changeAvatar()}
        >
          {settings.profile.avatarPath ? (
            <img className="profile-avatar" src={convertFileSrc(settings.profile.avatarPath)} alt="" draggable={false} />
          ) : (
            <div className="profile-avatar profile-avatar-fallback">
              <User size={38} />
            </div>
          )}
          <span className="avatar-edit-overlay">
            <ImagePlus size={16} />
            <span>{settings.profile.avatarPath ? t('Change avatar') : t('Pick an avatar')}</span>
          </span>
        </button>
        <div className="profile-info">
          <div className="section-label">{t('Profile')}</div>
          {editingName ? (
            <div className="profile-name-edit">
              <input
                className="text-input"
                autoFocus
                value={nameDraft}
                placeholder={t('What should we call you?')}
                maxLength={32}
                spellCheck={false}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName()
                  if (e.key === 'Escape') setEditingName(false)
                }}
              />
              <button className="btn btn-primary" onClick={saveName}>
                {t('Save')}
              </button>
            </div>
          ) : (
            <h1 className="profile-name">
              {nickname ?? t('Listener')}
              <button
                className="icon-btn"
                aria-label={t('Rename')}
                onClick={() => {
                  setNameDraft(nickname ?? '')
                  setEditingName(true)
                }}
              >
                <Pencil size={14} />
              </button>
            </h1>
          )}
        </div>
        <div className="profile-stats">
          <div className="profile-stat">
            <span className="profile-stat-num">{totalHours}</span>
            <span className="profile-stat-label">{t('Listening hours')}</span>
          </div>
          <div className="profile-stat">
            <span className="profile-stat-num">{summary?.plays ?? 0}</span>
            <span className="profile-stat-label">{t('plays')}</span>
          </div>
          <div className="profile-stat">
            <span className="profile-stat-num">{summary ? `${Math.round(summary.avgCompletionPct)}%` : '—'}</span>
            <span className="profile-stat-label">{t('Avg completion')}</span>
          </div>
        </div>
      </div>

      <section className="home-section">
        <div className="home-section-head profile-chart-head">
          <span className="home-section-title">{t('Listening activity')}</span>
          <div className="profile-chart-controls">
            <div className="seg profile-view-toggle" role="group" aria-label={t('Activity view')}>
              <button
                className={activityView === 'graph' ? 'seg-btn is-active' : 'seg-btn'}
                aria-pressed={activityView === 'graph'}
                onClick={() => setActivityView('graph')}
              >
                <BarChart3 size={13} />
                {t('Graph')}
              </button>
              <button
                className={activityView === 'grid' ? 'seg-btn is-active' : 'seg-btn'}
                aria-pressed={activityView === 'grid'}
                onClick={() => setActivityView('grid')}
              >
                <Grid2X2 size={13} />
                {t('Grid')}
              </button>
            </div>
            <div className="seg profile-range-toggle" role="group" aria-label={t('Time range')}>
              <button
                className={range === 30 ? 'seg-btn is-active' : 'seg-btn'}
                aria-pressed={range === 30}
                onClick={() => setRange(30)}
              >
                {t('Last 30 days')}
              </button>
              <button
                className={range === 365 ? 'seg-btn is-active' : 'seg-btn'}
                aria-pressed={range === 365}
                onClick={() => setRange(365)}
              >
                {t('Last 12 months')}
              </button>
            </div>
          </div>
        </div>
        {activityView === 'graph' ? (
          <div className={range === 365 ? 'chart is-year' : 'chart'} aria-label={t('Listening activity')}>
            {chart.map((d) => (
              <div
                key={d.date}
                className="chart-bar-wrap"
                title={`${range === 365 ? d.label : dayLabel(d.date, lang)} — ${hourLabel(d.minutes)}`}
              >
                <div
                  className="chart-bar"
                  style={{ height: `${Math.max(3, (d.minutes / chartMax) * 100)}%` }}
                />
                <span className="chart-day">{d.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="activity-grid-wrap">
            <div className="activity-weekdays" aria-hidden="true">
              {weekdays.map((day) => <span key={day}>{day}</span>)}
            </div>
            <div className="activity-grid" role="grid" aria-label={t('Listening activity')}>
              {activityGrid.map((d, index) => {
                if (d === null) return <span key={`empty-${index}`} className="activity-cell is-empty" role="presentation" />
                const level = d.minutes === 0 ? 0 : Math.max(1, Math.ceil((d.minutes / chartMax) * 4))
                return (
                  <span
                    key={d.date}
                    className="activity-cell"
                    data-level={Math.min(4, level)}
                    role="gridcell"
                    aria-label={`${dayLabel(d.date, lang)} — ${hourLabel(d.minutes)}`}
                    title={`${dayLabel(d.date, lang)} — ${hourLabel(d.minutes)}`}
                  />
                )
              })}
            </div>
            <div className="activity-grid-footer">
              <span>{activeDays} {t('active days')} · {hourLabel(activityTotal)}</span>
              <span className="activity-legend" aria-label={t('Less to more listening')}>
                <span /> <i data-level="1" /> <i data-level="2" /> <i data-level="3" /> <i data-level="4" />
              </span>
            </div>
          </div>
        )}
      </section>

      <div className="profile-columns">
        <section className="home-section profile-col">
          <div className="home-section-head">
            <span className="home-section-title">{t('Top artists')}</span>
          </div>
          {(stats.data?.topArtists ?? []).length === 0 ? (
            <div className="muted">{t('Nothing here yet')}</div>
          ) : (
            <div className="arow-list">
              {(stats.data?.topArtists ?? []).map((item) => (
                <div key={item.artist.id} className="arow">
                  <Cover path={null} label={item.artist.name} size={30} rounded />
                  <span className="arow-name">{item.artist.name}</span>
                  <span className="arow-sub">{item.playCount} {t('plays')}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="home-section profile-col">
          <div className="home-section-head">
            <span className="home-section-title">{t('Top tracks')}</span>
          </div>
          {(stats.data?.topTracks ?? []).length === 0 ? (
            <div className="muted">{t('Nothing here yet')}</div>
          ) : (
            <div className="arow-list">
              {(stats.data?.topTracks ?? []).map((item) => (
                <div key={item.track.id} className="arow">
                  <Cover path={item.track.coverPath} label={item.track.title} size={30} />
                  <span className="arow-name">{item.track.title}</span>
                  <span className="arow-sub">{item.playCount} {t('plays')}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="home-section">
        <div className="home-section-head">
          <span className="home-section-title">{t('Recent plays')}</span>
        </div>
        {(recent.data ?? []).length === 0 ? (
          <div className="muted">{t('Nothing here yet')}</div>
        ) : (
          <div className="tl">
            {(recent.data ?? []).map((entry) => (
              <div key={entry.id} className="tl-row">
                <div className="tl-main">
                  <Cover path={entry.track.coverPath} label={entry.track.title} size={30} />
                  <div className="tl-meta">
                    <span className="tl-title">{entry.track.title}</span>
                    <span className="tl-artist">{entry.track.artistName ?? t('Unknown artist')}</span>
                  </div>
                </div>
                <div className="tl-album">{entry.track.albumTitle ?? '—'}</div>
                <div className="tl-duration">
                  {new Date(entry.playedAt * 1000).toLocaleDateString(localeFor(lang), {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

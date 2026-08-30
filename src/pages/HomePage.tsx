import { useMemo } from 'react'
import { Clock3, Flame, FolderPlus, RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import type { TopTrackItem, Track } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useFolders } from '../hooks/useFolders'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useScanProgress } from '../hooks/useScanProgress'
import { useSettings } from '../state/settings'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { trackToUnified } from '../utils/unified'
import Cover from '../components/common/Cover'
import CardPlayButton from '../components/common/CardPlayButton'
import EmptyState from '../components/common/EmptyState'
import ScanLine from '../components/common/ScanLine'

function greetingForHour(h: number): string {
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 18) return 'Good afternoon'
  if (h >= 18 && h < 23) return 'Good evening'
  return 'Good night'
}

function dedupeRecent(entries: { track: Track }[], limit: number): Track[] {
  const seen = new Set<number>()
  const out: Track[] = []
  for (const e of entries) {
    if (seen.has(e.track.id)) continue
    seen.add(e.track.id)
    out.push(e.track)
    if (out.length >= limit) break
  }
  return out
}

export default function HomePage() {
  const t = useT()
  const { settings } = useSettings()
  const player = usePlayer()
  const foldersApi = useFolders()
  const scan = useScanProgress()
  const version = useLibraryVersion()
  const total = useAsync(() => api.countTracks(), [version])
  const recent = useAsync(() => api.listTracks('', 12, 0), [version])
  const hourPicks = useAsync(() => api.getHourPicks(12), [version])
  const top = useAsync(() => api.getTopTracks(12), [version])
  const played = useAsync(async () => dedupeRecent((await api.getAnalytics('30d')).recent, 10), [version])
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), [])
  const nickname = settings.profile.nickname

  if (recent.loading) {
    return (
      <div className="page">
        <div className="muted">{t('Loading…')}</div>
      </div>
    )
  }

  const error = recent.error ?? foldersApi.error
  if (error) {
    return (
      <div className="page">
        <div className="error-line">{error}</div>
      </div>
    )
  }

  const totalTracks = total.data ?? 0
  const unknownArtist = t('Unknown artist')
  const hourTracks = hourPicks.data ?? []
  const topTracks: TopTrackItem[] = top.data ?? []
  const recentPlays = played.data ?? []

  const playSection = (tracks: Track[], index: number) => {
    player.playTracks(tracks.map((tr) => trackToUnified(tr)), index)
  }

  return (
    <div className="page">
      <div className="hero">
        <div className="hero-main">
          <h1 className="hero-title">
            {t(greeting)}
            {nickname ? `, ${nickname}` : ''}
          </h1>
          <div className="hero-sub">{t('Tempo · local library')}</div>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-ghost"
            onClick={() => void foldersApi.addFolder()}
            disabled={foldersApi.busy}
          >
            <FolderPlus size={15} />
            {t('Add folder')}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void api.rescanLibrary()}
            disabled={foldersApi.busy || scan.active}
          >
            <RefreshCw size={15} className={scan.active ? 'spin' : undefined} />
            {t('Rescan')}
          </button>
        </div>
      </div>

      <ScanLine />

      {totalTracks === 0 ? (
        <EmptyState
          icon={<FolderPlus size={34} />}
          title={t('Your library is empty')}
          hint={t('Add a folder containing music files. Tempo scans it locally and builds your collection.')}
          action={
            <button
              className="btn btn-primary"
              onClick={() => void foldersApi.addFolder()}
              disabled={foldersApi.busy}
            >
              <FolderPlus size={15} />
              {t('Add folder')}
            </button>
          }
        />
      ) : (
        <>
          {hourTracks.length > 0 ? (
            <section className="home-section">
              <div className="home-section-head">
                <span className="home-section-title">
                  <Clock3 size={15} />
                  {t('For this hour')}
                </span>
                <span className="home-section-hint">
                  {t('Picked from what you usually play around this time of day')}
                </span>
              </div>
              <div className="rail">
                {hourTracks.map((tr, i) => (
                  <button
                    key={`hour-${tr.id}`}
                    className="rail-card"
                    title={tr.title}
                    onClick={() => playSection(hourTracks, i)}
                  >
                    <div className="rail-cover">
                      <Cover path={tr.coverPath} label={tr.title} size={152} />
                      <CardPlayButton onPlay={() => playSection(hourTracks, i)} />
                      <span className="rail-badge rail-badge-hour">
                        <Clock3 size={11} />
                      </span>
                    </div>
                    <span className="card-title">{tr.title}</span>
                    <span className="card-sub">{tr.artistName ?? unknownArtist}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {topTracks.length > 0 ? (
            <section className="home-section">
              <div className="home-section-head">
                <span className="home-section-title">
                  <Flame size={15} />
                  {t('Most played')}
                </span>
                <span className="home-section-hint">{t('Your all-time favorites by play count')}</span>
              </div>
              <div className="rail">
                {topTracks.map((item, i) => (
                  <button
                    key={`top-${item.track.id}`}
                    className="rail-card"
                    title={item.track.title}
                    onClick={() => playSection(topTracks.map((x) => x.track), i)}
                  >
                    <div className="rail-cover">
                      <Cover path={item.track.coverPath} label={item.track.title} size={152} />
                      <CardPlayButton onPlay={() => playSection(topTracks.map((x) => x.track), i)} />
                      <span className="rail-rank">{i + 1}</span>
                    </div>
                    <span className="card-title">{item.track.title}</span>
                    <span className="card-sub">
                      {item.track.artistName ?? unknownArtist}
                      <span className="rail-plays"> · {item.playCount} {t('plays')}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section className="home-section">
            <div className="home-section-head">
              <span className="home-section-title">{t('Recently added')}</span>
            </div>
            <div className="cards-grid cards-grid-tight">
              {(recent.data ?? []).map((tr) => (
                <button
                  key={tr.id}
                  className="card track-card"
                  title={tr.title}
                  onClick={() => player.playTracks([trackToUnified(tr)], 0)}
                >
                  <Cover path={tr.coverPath} label={tr.title} size={120} />
                  <span className="card-title">{tr.title}</span>
                  <span className="card-sub">{tr.artistName ?? unknownArtist}</span>
                </button>
              ))}
            </div>
          </section>

          {recentPlays.length > 0 ? (
            <section className="home-section">
              <div className="home-section-head">
                <span className="home-section-title">{t('Recently played')}</span>
              </div>
              <div className="cards-grid cards-grid-tight">
                {recentPlays.map((tr) => (
                  <button
                    key={`played-${tr.id}`}
                    className="card track-card"
                    title={tr.title}
                    onClick={() => player.playTracks([trackToUnified(tr)], 0)}
                  >
                    <Cover path={tr.coverPath} label={tr.title} size={120} />
                    <span className="card-title">{tr.title}</span>
                    <span className="card-sub">{tr.artistName ?? unknownArtist}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}

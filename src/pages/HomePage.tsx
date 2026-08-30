import { useMemo } from 'react'
import { Disc3, FolderPlus, MicVocal, Music2, RefreshCw, Timer } from 'lucide-react'
import { api } from '../api/client'
import type { Track } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useFolders } from '../hooks/useFolders'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useScanProgress } from '../hooks/useScanProgress'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { trackToUnified } from '../utils/unified'
import Cover from '../components/common/Cover'
import EmptyState from '../components/common/EmptyState'
import ScanLine from '../components/common/ScanLine'

interface HomeCounts {
  tracks: number
  albums: number
  artists: number
  minutes: number
}

function greetingForHour(h: number): string {
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 18) return 'Good afternoon'
  return 'Good evening'
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
  const player = usePlayer()
  const foldersApi = useFolders()
  const scan = useScanProgress()
  const version = useLibraryVersion()
  const counts = useAsync<HomeCounts>(async () => {
    const [tracks, albums, artists, stats] = await Promise.all([
      api.countTracks(),
      api.listAlbums(''),
      api.listArtists(''),
      api.getAnalytics('all'),
    ])
    return {
      tracks,
      albums: albums.length,
      artists: artists.length,
      minutes: Math.round(stats.summary.totalMinutes),
    }
  }, [version])
  const recent = useAsync(() => api.listTracks('', 12, 0), [version])
  const played = useAsync(async () => dedupeRecent((await api.getAnalytics('30d')).recent, 10), [version])
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), [])

  if (counts.loading || recent.loading) {
    return (
      <div className="page">
        <div className="muted">{t('Loading…')}</div>
      </div>
    )
  }

  const error = counts.error ?? recent.error ?? foldersApi.error
  if (error) {
    return (
      <div className="page">
        <div className="error-line">{error}</div>
      </div>
    )
  }

  const total = counts.data?.tracks ?? 0
  const unknownArtist = t('Unknown artist')

  return (
    <div className="page">
      <div className="hero">
        <div className="hero-main">
          <h1 className="hero-title">{t(greeting)}</h1>
          <div className="hero-sub">{t('Tempo · local library')}</div>
          {total > 0 ? (
            <div className="chips hero-chips">
              <span className="chip">
                <Music2 size={13} />
                <span>{total} {t('tracks')}</span>
              </span>
              <span className="chip">
                <Disc3 size={13} />
                <span>{counts.data?.albums ?? 0} {t('albums')}</span>
              </span>
              <span className="chip">
                <MicVocal size={13} />
                <span>{counts.data?.artists ?? 0} {t('artists')}</span>
              </span>
              <span className="chip">
                <Timer size={13} />
                <span>{counts.data?.minutes ?? 0} {t('minutes listened')}</span>
              </span>
            </div>
          ) : null}
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

      {total === 0 ? (
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
          <div className="section-label">{t('Recently added')}</div>
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

          {(played.data?.length ?? 0) > 0 ? (
            <>
              <div className="section-label">{t('Recently played')}</div>
              <div className="cards-grid cards-grid-tight">
                {(played.data ?? []).map((tr) => (
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
            </>
          ) : null}
        </>
      )}
    </div>
  )
}

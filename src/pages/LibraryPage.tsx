import { useEffect, useState } from 'react'
import { FolderPlus, RefreshCw, RotateCw } from 'lucide-react'
import { api } from '../api/client'
import type { Track } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useFolders } from '../hooks/useFolders'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useScanProgress } from '../hooks/useScanProgress'
import { useT } from '../i18n'
import TrackList from '../components/common/TrackList'
import ScanLine from '../components/common/ScanLine'

const PAGE = 500
const SORT_KEY = 'tempo.library.sort'

const SORTS = [
  { value: 'added', label: 'Sort by date added' },
  { value: 'title', label: 'Sort by title' },
  { value: 'artist', label: 'Sort by artist' },
  { value: 'duration', label: 'Sort by duration' },
  { value: 'plays', label: 'Sort by play count' },
] as const

type Sort = (typeof SORTS)[number]['value']

function readSort(): Sort {
  const raw = localStorage.getItem(SORT_KEY)
  return SORTS.some((s) => s.value === raw) ? (raw as Sort) : 'added'
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function LibraryPage() {
  const t = useT()
  const foldersApi = useFolders()
  const scan = useScanProgress()
  const version = useLibraryVersion()
  const total = useAsync(() => api.countTracks(), [version])
  const [sort, setSort] = useState<Sort>(readSort)
  const [tracks, setTracks] = useState<Track[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    api
      .listTracks('', PAGE, 0, sort)
      .then((rows) => {
        if (cancelled) return
        setTracks(rows)
        setHasMore(rows.length >= PAGE)
        setError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(errText(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tick, version, sort])

  const changeSort = (next: Sort) => {
    localStorage.setItem(SORT_KEY, next)
    setLoading(true)
    setSort(next)
  }

  const reload = () => {
    setLoading(true)
    setTick((t) => t + 1)
    total.reload()
  }

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const next = await api.listTracks('', PAGE, tracks.length, sort)
      setTracks((prev) => [...prev, ...next])
      setHasMore(next.length >= PAGE)
      setError(null)
    } catch (e: unknown) {
      setError(errText(e))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('Library')}</h1>
          <div className="page-sub">
            {total.data != null ? `${total.data} ${t('tracks')}` : t('Counting…')} · {t('showing')} {tracks.length}
          </div>
        </div>
        <div className="page-actions">
          <select
            className="select"
            value={sort}
            aria-label={t('Sort by')}
            onChange={(e) => changeSort(e.target.value as Sort)}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {t(s.label)}
              </option>
            ))}
          </select>
          <button className="icon-btn" onClick={reload} aria-label={t('Reload library list')}>
            <RotateCw size={15} />
          </button>
          <button className="btn" onClick={() => void foldersApi.addFolder()} disabled={foldersApi.busy}>
            <FolderPlus size={15} />
            {t('Add folder')}
          </button>
          <button
            className="btn"
            onClick={() => void api.rescanLibrary()}
            disabled={scan.active}
          >
            <RefreshCw size={15} className={scan.active ? 'spin' : undefined} />
            {t('Rescan library')}
          </button>
        </div>
      </div>

      <ScanLine />
      {error ? <div className="error-line">{error}</div> : null}
      {foldersApi.error ? <div className="error-line">{foldersApi.error}</div> : null}

      {loading ? (
        <div className="muted">{t('Loading…')}</div>
      ) : tracks.length === 0 ? (
        <div className="muted">{t('No tracks yet. Add a folder in Settings to start scanning.')}</div>
      ) : (
        <>
          <TrackList tracks={tracks} showAlbum showIndex />
          {hasMore ? (
            <div className="load-more">
              <button className="btn" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? t('Loading…') : t('Load more')}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

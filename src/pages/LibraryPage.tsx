import { useEffect, useState } from 'react'
import { FolderPlus, RefreshCw, RotateCw, Search, X } from 'lucide-react'
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
type LibraryView = 'all' | 'recent' | 'popular' | 'unplayed'

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
  const [query, setQuery] = useState('')
  const [viewFilter, setViewFilter] = useState<LibraryView>('all')
  const [tracks, setTracks] = useState<Track[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      api
        .listTracks(query.trim(), PAGE, 0, sort)
        .then((rows) => {
          if (cancelled) return
          setTracks(rows)
          setHasMore(rows.length >= PAGE)
          setError(null)
        })
        .catch((e: unknown) => {
          if (cancelled) return
          setTracks([])
          setHasMore(false)
          setError(errText(e))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, query.trim() ? 140 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [tick, version, sort, query])

  const changeSort = (next: Sort) => {
    if (sort === next) return
    localStorage.setItem(SORT_KEY, next)
    setLoading(true)
    setSort(next)
  }

  const chooseView = (next: LibraryView) => {
    setViewFilter(next)
    changeSort(next === 'popular' ? 'plays' : 'added')
  }

  const reload = () => {
    setLoading(true)
    setTick((t) => t + 1)
    total.reload()
  }

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const next = await api.listTracks(query.trim(), PAGE, tracks.length, sort)
      setTracks((prev) => [...prev, ...next])
      setHasMore(next.length >= PAGE)
      setError(null)
    } catch (e: unknown) {
      setError(errText(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const recentCutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60
  const visibleTracks = viewFilter === 'unplayed'
    ? tracks.filter((track) => track.playCount === 0)
    : viewFilter === 'recent'
      ? tracks.filter((track) => track.addedAt >= recentCutoff)
      : tracks

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('Library')}</h1>
          <div className="page-sub">
            {total.data != null ? `${total.data} ${t('tracks')}` : t('Counting…')} · {t('showing')} {visibleTracks.length}
          </div>
        </div>
        <div className="page-actions">
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

      <div className="library-remaster-toolbar">
        <label className="library-remaster-search">
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            placeholder={t('Search in library')}
            aria-label={t('Search in library')}
            onChange={(event) => {
              setQuery(event.target.value)
              setLoading(true)
            }}
          />
          {query ? (
            <button type="button" aria-label={t('Clear search')} onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          ) : null}
        </label>
        <select
          className="select"
          value={sort}
          aria-label={t('Sort by')}
          onChange={(event) => {
            setViewFilter('all')
            changeSort(event.target.value as Sort)
          }}
        >
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>{t(option.label)}</option>
          ))}
        </select>
      </div>

      <div className="library-remaster-filters" role="group" aria-label={t('Library views')}>
        {([
          ['all', 'All tracks'],
          ['recent', 'Recently added'],
          ['popular', 'Most played'],
          ['unplayed', 'Never played'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={viewFilter === value ? 'library-remaster-filter is-active' : 'library-remaster-filter'}
            aria-pressed={viewFilter === value}
            onClick={() => chooseView(value)}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="muted">{t('Loading…')}</div>
      ) : tracks.length === 0 ? (
        <div className="muted">{query.trim() ? t('No tracks found') : t('No tracks yet. Add a folder in Settings to start scanning.')}</div>
      ) : visibleTracks.length === 0 ? (
        <>
          <div className="muted library-remaster-empty">
            {viewFilter === 'unplayed' ? t('No unplayed tracks in this part of the library') : t('No tracks match this filter')}
          </div>
          {hasMore ? (
            <div className="load-more">
              <button className="btn" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? t('Loading…') : t('Load more')}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <TrackList tracks={visibleTracks} showAlbum showIndex showHeader />
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

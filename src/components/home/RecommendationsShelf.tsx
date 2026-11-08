import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { ChevronLeft, ChevronRight, Download, LoaderCircle, Play, RefreshCw } from 'lucide-react'
import type { ScTrack } from '../../types/models'
import { useT } from '../../i18n'
import { beginTrackDrag, consumeDragClick } from '../../dnd/trackDrag'
import { useSoundCloudGenreRecommendations } from '../../hooks/useSoundCloudGenreRecommendations'
import { getTrackCacheProgress, subscribeTrackCacheProgress } from '../../soundcloud/cacheJobs'
import ScArtwork from '../common/ScArtwork'

interface RecommendationsShelfProps {
  tracks: ScTrack[]
  favoriteGenre: { key: string; label: string } | null
  loading: boolean
  error: string | null
  persistenceError: string | null
  hasLoaded: boolean
  hasMore: boolean
  exhausted: boolean
  retryAt: number | null
  cachedTrackIds: ReadonlySet<string>
  onPlay: (index: number) => void
  onPlayFavoriteGenre: (tracks: ScTrack[], index: number) => void
  onCache: (track: ScTrack) => void
  onDropToPlaylist: (playlistId: number, track: ScTrack) => void
  onRetry: () => void
  onLoadMore: () => void
  onNearViewport: () => void
  onImpression: (trackKey: string) => void
  onVisibleIds: (ids: string[]) => void
  onTrimPassed: (trackKeys: string[]) => void
  onSectionMenu: (event: MouseEvent) => void
}

interface RecommendationCacheControlProps {
  track: ScTrack
  cached: boolean
  onCache: (track: ScTrack) => void
}

const RecommendationCacheControl = memo(function RecommendationCacheControl({ track, cached, onCache }: RecommendationCacheControlProps) {
  const t = useT()
  const subscribe = useCallback((listener: () => void) => subscribeTrackCacheProgress(track.id, listener), [track.id])
  const getSnapshot = useCallback(() => getTrackCacheProgress(track.id), [track.id])
  const progress = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (progress) {
    if (progress.state === 'failed') {
      return (
        <button
          type="button"
          className={`home-recommendation-cache is-failed${progress.exiting ? ' is-exiting' : ''}`}
          aria-label={`${t('Retry')}: ${track.title}`}
          title={progress.error || t('Caching failed')}
          onClick={() => onCache(track)}
        >
          <RefreshCw size={13} />
        </button>
      )
    }
    const percent = progress.state === 'done'
      ? 100
      : typeof progress.progress === 'number' && Number.isFinite(progress.progress)
        ? Math.min(99, Math.max(0, Math.round(progress.progress * 100)))
        : progress.totalBytes > 0
          ? Math.min(99, Math.round(progress.downloadedBytes / progress.totalBytes * 100))
          : null
    const progressRing = percent ?? 12
    return (
      <button
        type="button"
        className={`home-recommendation-cache is-progress${percent === null ? ' is-indeterminate' : ''}${progress.exiting ? ' is-exiting' : ''}`}
        style={{ '--cache-progress': `${progressRing}%` } as CSSProperties}
        aria-label={`${t('Caching…')}${percent === null ? '' : ` ${percent}%`}: ${track.title}`}
        title={`${t('Caching…')}${percent === null ? '' : ` ${percent}%`}`}
        disabled
      >
        <span className="home-cache-spinner" aria-hidden="true"><LoaderCircle size={17} strokeWidth={1.8} /></span>
        <span className="home-cache-percent" aria-hidden="true">{percent === null ? '' : `${percent}%`}</span>
      </button>
    )
  }

  if (!/^[1-9]\d*$/.test(track.id) || cached) return null
  return (
    <button
      type="button"
      className="home-recommendation-cache"
      aria-label={`${t('Cache track')}: ${track.title}`}
      title={t('Cache track')}
      onClick={() => onCache(track)}
    >
      <Download size={13} />
    </button>
  )
})

export default function RecommendationsShelf({
  tracks,
  favoriteGenre,
  loading,
  error,
  persistenceError,
  hasLoaded,
  hasMore,
  exhausted,
  retryAt,
  cachedTrackIds,
  onPlay,
  onPlayFavoriteGenre,
  onCache,
  onDropToPlaylist,
  onRetry,
  onLoadMore,
  onNearViewport,
  onImpression,
  onVisibleIds,
  onTrimPassed,
  onSectionMenu,
}: RecommendationsShelfProps) {
  const t = useT()
  const {
    tracks: favoriteGenreTracks,
    cachedTrackIds: genreCachedIds,
    loading: genreLoading,
    error: genreError,
    hasMore: genreHasMore,
    loadMore: loadMoreGenre,
    retry: retryGenre,
  } = useSoundCloudGenreRecommendations(favoriteGenre, tracks)
  const genreCachedTrackIds = useMemo(() => new Set([...cachedTrackIds, ...genreCachedIds]), [cachedTrackIds, genreCachedIds])
  const sectionRef = useRef<HTMLElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLSpanElement>(null)
  const genreRailRef = useRef<HTMLDivElement>(null)
  const genreEndRef = useRef<HTMLSpanElement>(null)
  const trimAnchor = useRef<{ id: string; left: number } | null>(null)
  const trimFrame = useRef<number | null>(null)
  const [expiredRetryAt, setExpiredRetryAt] = useState<number | null>(() => retryAt === null || retryAt <= Date.now() ? retryAt : null)
  const coolingDown = retryAt !== null && retryAt > Date.now() && expiredRetryAt !== retryAt
  const scroll = (direction: number) => railRef.current?.scrollBy({ left: direction * 460, behavior: 'smooth' })

  useEffect(() => {
    const section = sectionRef.current
    if (!section) return
    if (typeof IntersectionObserver === 'undefined') {
      onNearViewport()
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      onNearViewport()
    }, { rootMargin: '420px 0px' })
    observer.observe(section)
    return () => observer.disconnect()
  }, [onNearViewport])

  useEffect(() => {
    if (!retryAt || retryAt <= Date.now()) {
      setExpiredRetryAt(retryAt)
      return
    }
    const timer = window.setTimeout(() => setExpiredRetryAt(retryAt), retryAt - Date.now())
    return () => window.clearTimeout(timer)
  }, [retryAt])

  useEffect(() => {
    const rail = railRef.current, end = endRef.current
    if (!rail || !end || !hasMore || loading || error || coolingDown) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onLoadMore()
    }, { root: rail, rootMargin: '0px 300px', threshold: 0 })
    observer.observe(end)
    return () => observer.disconnect()
  }, [tracks, hasMore, loading, error, coolingDown, onLoadMore])

  useEffect(() => {
    const rail = genreRailRef.current, end = genreEndRef.current
    if (!rail || !end || !genreHasMore || genreLoading || genreError
      || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreGenre()
    }, { root: rail, rootMargin: '0px 300px', threshold: 0 })
    observer.observe(end)
    return () => observer.disconnect()
  }, [favoriteGenreTracks, genreHasMore, genreLoading, genreError, loadMoreGenre])

  useEffect(() => {
    const section = sectionRef.current, rail = railRef.current
    if (!section || !rail || typeof IntersectionObserver === 'undefined') return
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const visible = new Set<string>()
    const recorded = new Set<string>()
    let reportedVisible: Set<string> | null = null
    let sectionVisible = false
    const stop = (id: string) => { const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id) }
    const sync = (force = false) => {
      const allowed = sectionVisible && document.visibilityState === 'visible'
      const visibleIds = allowed ? [...visible] : []
      if (force || reportedVisible === null || visibleIds.length !== reportedVisible.size
        || visibleIds.some(id => !reportedVisible!.has(id))) {
        reportedVisible = new Set(visibleIds)
        onVisibleIds(visibleIds)
      }
      for (const id of timers.keys()) if (!allowed || !visible.has(id)) stop(id)
      if (!allowed) return
      for (const id of visible) {
        if (timers.has(id) || recorded.has(id)) continue
        timers.set(id, setTimeout(() => {
          timers.delete(id)
          if (!sectionVisible || document.visibilityState !== 'visible' || !visible.has(id)) return
          recorded.add(id)
          onImpression(`soundcloud:${id}`)
        }, 750))
      }
    }
    // Viewport root includes overflow clipping and page scrolling; no prefetch margin.
    const cardsObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.trackId!
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) visible.add(id)
        else { visible.delete(id); stop(id) }
      }
      sync()
    }, { threshold: [0, 0.5, 1] })
    const sectionObserver = new IntersectionObserver(entries => {
      sectionVisible = entries.some(entry => entry.isIntersecting)
      sync()
    }, { threshold: 0 })
    sectionObserver.observe(section)
    rail.querySelectorAll('[data-track-id]').forEach(card => cardsObserver.observe(card))
    const onVisibilityChange = () => sync(true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    const cacheTimer = setInterval(() => sync(true), 60_000)
    return () => {
      cardsObserver.disconnect(); sectionObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearInterval(cacheTimer)
      for (const id of timers.keys()) stop(id)
      onVisibleIds([])
    }
  }, [tracks, onImpression, onVisibleIds])

  const trimPassed = useCallback(() => {
    if (trimFrame.current !== null) return
    trimFrame.current = window.requestAnimationFrame(() => {
      trimFrame.current = null
      const rail = railRef.current
      if (!rail || tracks.length < 280 || trimAnchor.current) return
      const cards = rail.querySelectorAll<HTMLElement>('[data-track-id]')
      const edge = rail.getBoundingClientRect().left
      let count = 0
      while (count < 20 && count < cards.length && cards[count].getBoundingClientRect().right <= edge) count += 1
      if (!count || count >= cards.length) return
      const anchor = cards[count]
      trimAnchor.current = { id: anchor.dataset.trackId!, left: anchor.getBoundingClientRect().left }
      onTrimPassed(tracks.slice(0, count).map(track => `soundcloud:${track.id}`))
    })
  }, [onTrimPassed, tracks])

  useEffect(() => () => {
    if (trimFrame.current !== null) window.cancelAnimationFrame(trimFrame.current)
  }, [])

  useLayoutEffect(() => {
    const rail = railRef.current
    const anchor = trimAnchor.current
    if (!rail || !anchor) return
    const card = rail.querySelector<HTMLElement>('[data-track-id]')
    if (card?.dataset.trackId === anchor.id) rail.scrollLeft += card.getBoundingClientRect().left - anchor.left
    trimAnchor.current = null
  }, [tracks])

  const renderCards = (items: ScTrack[], play: (index: number) => void, cachedIds = cachedTrackIds) => items.map((track, index) => (
    <div className="home-recommendation-card" key={track.id} data-track-id={track.id}>
      <button
        type="button"
        className="home-rail-track"
        onClick={() => { if (!consumeDragClick()) play(index) }}
        onPointerDown={(event: PointerEvent<HTMLButtonElement>) => beginTrackDrag({
          e: event,
          title: track.title,
          coverPath: track.artworkUrl,
          allowButtons: true,
          onDrop: (playlistId) => onDropToPlaylist(playlistId, track),
        })}
      >
        <span className="home-recommendation-cover">
          <ScArtwork url={track.artworkUrl} title={track.title} resolution="card" loading="lazy" />
        </span>
        <strong title={track.title}>{track.title}</strong>
        <small title={track.artist}>{track.artist}</small>
      </button>
      <RecommendationCacheControl track={track} cached={cachedIds.has(track.id)} onCache={onCache} />
    </div>
  ))

  return (
    <section className="home-section home-recommendations" ref={sectionRef}>
      <div className="home-section-head" onContextMenu={onSectionMenu}>
        <div className="home-recommendations-title">
          <span className="home-section-title">{t('Recommended for you')}</span>
          <small>{t('Based on what you listen to')}</small>
        </div>
        <div className="home-section-tools">
            <button type="button" className="btn btn-ghost home-recommendations-play" onClick={() => onPlay(0)} disabled={tracks.length === 0}>
              <Play size={14} fill="currentColor" />
              {t('Play all')}
            </button>
          {error || persistenceError ? (
            <button type="button" className="btn btn-ghost" onClick={onRetry} disabled={coolingDown || loading}>
              <RefreshCw size={14} />
              {t(coolingDown ? 'Retry after cooldown' : 'Try again')}
            </button>
          ) : hasMore ? (
            <button type="button" className="btn btn-ghost" onClick={onLoadMore} disabled={loading || coolingDown}>
              <RefreshCw size={14} className={loading ? 'spin' : undefined} />
              {t(coolingDown ? 'Retry after cooldown' : 'Load more')}
            </button>
          ) : null}
          {tracks.length > 4 ? (
            <div className="home-rail-controls home-recommendations-scroll-controls">
              <button type="button" aria-label={t('Scroll left')} onClick={() => scroll(-1)}><ChevronLeft size={15} /></button>
              <button type="button" aria-label={t('Scroll right')} onClick={() => scroll(1)}><ChevronRight size={15} /></button>
            </div>
          ) : null}
        </div>
      </div>

      {loading && tracks.length === 0 ? (
        <div className="home-recommendation-skeletons" role="status" aria-label={t('Loading…')}>
          {Array.from({ length: 5 }, (_, index) => <span className="home-recommendation-skeleton" key={index} />)}
        </div>
      ) : tracks.length > 0 ? (
        <div className="home-track-rail home-recommendation-rail" ref={railRef} onScroll={trimPassed} tabIndex={0} aria-label={t('Recommended for you')}>
          {renderCards(tracks, onPlay)}
          <span ref={endRef} aria-hidden="true" style={{ flex: '0 0 1px', alignSelf: 'stretch' }} />
        </div>
      ) : error ? (
        <div className="home-recommendation-empty" role="status">{t('Could not load recommendations')}</div>
      ) : (
        <div className="home-recommendation-empty" role="status">
          {t(exhausted ? 'No more recommendations' : hasLoaded ? 'No recommendations yet' : 'SoundCloud recommendations will appear here.')}
        </div>
      )}
      {favoriteGenre ? (
        <div className="home-favorite-genre">
          <div className="home-section-head">
            <div className="home-recommendations-title">
              <span className="home-section-title">{favoriteGenre.label}</span>
              <small>{t('Your most-listened genre')}</small>
            </div>
            <div className="home-section-tools">
              {favoriteGenreTracks.length > 0 ? (
                <button type="button" className="btn btn-ghost home-recommendations-play" onClick={() => onPlayFavoriteGenre(favoriteGenreTracks, 0)}>
                  <Play size={14} fill="currentColor" />
                  {t('Play all')}
                </button>
              ) : null}
              {genreError ? (
                <button type="button" className="btn btn-ghost" onClick={retryGenre} disabled={genreLoading}>
                  <RefreshCw size={14} />
                  {t('Try again')}
                </button>
              ) : null}
            </div>
          </div>
          {genreLoading && favoriteGenreTracks.length === 0 ? (
            <div className="home-recommendation-skeletons" role="status" aria-label={t('Loading…')}>
              {Array.from({ length: 5 }, (_, index) => <span className="home-recommendation-skeleton" key={index} />)}
            </div>
          ) : favoriteGenreTracks.length > 0 ? (
            <div className="home-track-rail home-recommendation-rail" ref={genreRailRef} tabIndex={0} aria-label={`${favoriteGenre.label} · ${t('Recommended for you')}`}>
              {renderCards(favoriteGenreTracks, (index) => onPlayFavoriteGenre(favoriteGenreTracks, index), genreCachedTrackIds)}
              <span ref={genreEndRef} aria-hidden="true" style={{ flex: '0 0 1px', alignSelf: 'stretch' }} />
            </div>
          ) : genreError ? (
            <div className="home-recommendation-empty" role="status">{t('Could not load recommendations')}: {genreError}</div>
          ) : (
            <div className="home-recommendation-empty" role="status">
              {genreLoading ? t('Loading…') : t('No recommendations yet')}
              {genreHasMore && !genreLoading ? (
                <button type="button" className="btn btn-ghost" onClick={loadMoreGenre}>
                  {t('Continue with recommendations')}
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      {error || persistenceError ? (
        <small className="home-recommendation-error" role="status">
          {error ? <span>{tracks.length > 0 ? `${t('Could not load recommendations')}: ` : ''}{error}</span> : null}
          {persistenceError ? <span>{t('Could not save recommendations')}: {persistenceError}</span> : null}
        </small>
      ) : null}
      {tracks.length > 0 && (exhausted || coolingDown) ? (
        <small className="muted" role="status">{t(coolingDown ? 'Retry after cooldown' : 'No more recommendations')}</small>
      ) : null}
    </section>
  )
}

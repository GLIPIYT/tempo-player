import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react'
import { ChevronLeft, ChevronRight, Download, Play, RefreshCw } from 'lucide-react'
import type { ScTrack } from '../../types/models'
import { useT } from '../../i18n'
import { beginTrackDrag, consumeDragClick } from '../../dnd/trackDrag'

interface RecommendationsShelfProps {
  tracks: ScTrack[]
  loading: boolean
  error: string | null
  hasLoaded: boolean
  hasMore: boolean
  cachedTrackIds: ReadonlySet<string>
  onPlay: (index: number) => void
  onCache: (track: ScTrack) => void
  onDropToPlaylist: (playlistId: number, track: ScTrack) => void
  onRetry: () => void
  onLoadMore: () => void
  onNearViewport: () => void
  onSectionMenu: (event: MouseEvent) => void
}

export default function RecommendationsShelf({
  tracks,
  loading,
  error,
  hasLoaded,
  hasMore,
  cachedTrackIds,
  onPlay,
  onCache,
  onDropToPlaylist,
  onRetry,
  onLoadMore,
  onNearViewport,
  onSectionMenu,
}: RecommendationsShelfProps) {
  const t = useT()
  const sectionRef = useRef<HTMLElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
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

  return (
    <section className="home-section home-recommendations" ref={sectionRef}>
      <div className="home-section-head" onContextMenu={onSectionMenu}>
        <div className="home-recommendations-title">
          <span className="home-section-title">{t('Recommended for you')}</span>
          <small>{t('Based on what you listen to')}</small>
        </div>
        <div className="home-section-tools">
          {tracks.length > 0 ? (
            <button type="button" className="btn btn-ghost home-recommendations-play" onClick={() => onPlay(0)}>
              <Play size={14} fill="currentColor" />
              {t('Play all')}
            </button>
          ) : null}
          {error ? (
            <button type="button" className="btn btn-ghost" onClick={onRetry}>
              <RefreshCw size={14} />
              {t('Try again')}
            </button>
          ) : hasMore ? (
            <button type="button" className="btn btn-ghost" onClick={onLoadMore} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : undefined} />
              {t('Load more')}
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
        <div className="home-track-rail home-recommendation-rail" ref={railRef} tabIndex={0} aria-label={t('Recommended for you')}>
          {tracks.map((track, index) => (
            <div className="home-recommendation-card" key={track.id}>
              <button
                type="button"
                className="home-rail-track"
                onClick={() => { if (!consumeDragClick()) onPlay(index) }}
                onPointerDown={(event: PointerEvent<HTMLButtonElement>) => beginTrackDrag({
                  e: event,
                  title: track.title,
                  coverPath: track.artworkUrl,
                  allowButtons: true,
                  onDrop: (playlistId) => onDropToPlaylist(playlistId, track),
                })}
              >
                <span className="home-recommendation-cover">
                  {track.artworkUrl ? <img src={track.artworkUrl} alt="" loading="lazy" /> : <span aria-hidden="true">♪</span>}
                </span>
                <strong title={track.title}>{track.title}</strong>
                <small title={track.artist}>{track.artist}</small>
              </button>
              {track.streamable && track.hasProgressive && !cachedTrackIds.has(track.id) ? (
                <button
                  type="button"
                  className="home-recommendation-cache"
                  aria-label={`${t('Cache track')}: ${track.title}`}
                  title={t('Cache track')}
                  onClick={() => onCache(track)}
                >
                  <Download size={13} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="home-recommendation-empty" role="status">{t('Could not load recommendations')}</div>
      ) : (
        <div className="home-recommendation-empty" role="status">
          {t(hasLoaded ? 'No recommendations yet' : 'SoundCloud recommendations will appear here.')}
        </div>
      )}
    </section>
  )
}

import type { MouseEvent } from 'react'
import { Download, Play, RefreshCw } from 'lucide-react'
import type { ScTrack } from '../../types/models'
import { useT } from '../../i18n'

interface RecommendationsShelfProps {
  tracks: ScTrack[]
  loading: boolean
  error: string | null
  hasMore: boolean
  onPlay: (index: number) => void
  onCache: (track: ScTrack) => void
  onRetry: () => void
  onLoadMore: () => void
  onSectionMenu: (event: MouseEvent) => void
}

export default function RecommendationsShelf({
  tracks,
  loading,
  error,
  hasMore,
  onPlay,
  onCache,
  onRetry,
  onLoadMore,
  onSectionMenu,
}: RecommendationsShelfProps) {
  const t = useT()

  return (
    <section className="home-section home-recommendations">
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
          ) : hasMore && tracks.length > 0 ? (
            <button type="button" className="btn btn-ghost" onClick={onLoadMore} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : undefined} />
              {t('Load more')}
            </button>
          ) : null}
        </div>
      </div>

      {loading && tracks.length === 0 ? (
        <div className="home-recommendation-skeletons" aria-label={t('Loading…')}>
          {Array.from({ length: 5 }, (_, index) => <span className="home-recommendation-skeleton" key={index} />)}
        </div>
      ) : tracks.length > 0 ? (
        <div className="home-track-rail home-recommendation-rail" tabIndex={0} aria-label={t('Recommended for you')}>
          {tracks.map((track, index) => (
            <div className="home-recommendation-card" key={track.id}>
              <button type="button" className="home-rail-track" onClick={() => onPlay(index)}>
                <span className="home-recommendation-cover">
                  {track.artworkUrl ? <img src={track.artworkUrl} alt="" loading="lazy" /> : <span aria-hidden="true">♪</span>}
                </span>
                <strong title={track.title}>{track.title}</strong>
                <small title={track.artist}>{track.artist}</small>
              </button>
              {track.streamable && track.hasProgressive ? (
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
        <div className="home-recommendation-empty" role="status">{t('SoundCloud recommendations will appear here.')}</div>
      )}
    </section>
  )
}

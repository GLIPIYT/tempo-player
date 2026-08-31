import { ChevronLeft, Heart, Play } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { usePlayer } from '../player'
import { tracksToUnified } from '../utils/unified'
import Cover from '../components/common/Cover'
import EmptyState from '../components/common/EmptyState'
import TrackList from '../components/common/TrackList'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'

export default function AlbumDetailPage({ albumId }: { albumId: number }) {
  const { navigate } = useNav()
  const t = useT()
  const player = usePlayer()
  const version = useLibraryVersion()
  const { data, loading, error, reload } = useAsync(() => api.getAlbum(albumId), [albumId, version])
  const fav = useAsync(() => api.isFavoriteAlbum(albumId), [albumId, version])

  if (loading) {
    return (
      <div className="page">
        <div className="muted">{t('Loading…')}</div>
      </div>
    )
  }
  if (error) {
    return (
      <div className="page">
        <div className="error-line">{error}</div>
        <button className="btn" onClick={reload}>
          {t('Retry')}
        </button>
      </div>
    )
  }
  if (!data) return null

  const { album, tracks } = data
  const unknownArtist = t('Unknown artist')

  return (
    <div className="page">
      <button className="back-link" onClick={() => navigate({ name: 'albums' })}>
        <ChevronLeft size={15} />
        {t('Albums')}
      </button>

      <div className="detail-hero detail-hero-rich">
        {album.coverPath ? (
          <div className="dh-bg" aria-hidden="true">
            <img
              className="dh-bg-img"
              src={convertFileSrc(album.coverPath)}
              alt=""
              draggable={false}
            />
            <div className="dh-fade" />
          </div>
        ) : null}
        <div className="dh-fg">
          <Cover path={album.coverPath} label={album.title} size={132} />
          <div className="detail-hero-info">
            <div className="section-label">{t('Album')}</div>
            <h1 className="detail-title">{album.title}</h1>
            <div className="detail-meta">
              {album.artistId != null ? (
                <button
                  className="link-btn"
                  onClick={() => navigate({ name: 'artist', id: album.artistId as number })}
                >
                  {album.artistName ?? unknownArtist}
                </button>
              ) : (
                <span>{album.artistName ?? unknownArtist}</span>
              )}
              <span className="meta-dot">·</span>
              <span>{album.year ?? '—'}</span>
              <span className="meta-dot">·</span>
              <span>
                {tracks.length === 1 ? `${tracks.length} ${t('track')}` : `${tracks.length} ${t('tracks')}`}
              </span>
            </div>
            {tracks.length > 0 ? (
              <div className="detail-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => player.playTracks(tracksToUnified(tracks), 0)}
                >
                  <Play size={14} />
                  {t('Play all')}
                </button>
                <button
                  className={'btn' + (fav.data ? ' is-active' : '')}
                  title={t('Favorite album')}
                  onClick={() =>
                    void api
                      .toggleFavoriteAlbum(albumId)
                      .then(() => {
                        fav.reload()
                        bumpLibraryVersion()
                      })
                      .catch(() => {})
                  }
                >
                  <Heart size={14} fill={fav.data ? 'currentColor' : 'none'} />
                  {fav.data ? t('Remove from favorites') : t('Add to favorites')}
                </button>
                <span className="muted detail-total">
                  {fmtTime(tracks.reduce((acc, tr) => acc + (tr.durationSec ?? 0), 0))}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {tracks.length === 0 ? (
        <EmptyState title={t('This album has no tracks')} hint={t('Rescan your library if this seems wrong.')} />
      ) : (
        <TrackList tracks={tracks} showAlbum={false} showIndex />
      )}
    </div>
  )
}

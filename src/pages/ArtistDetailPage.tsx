import { ChevronLeft, Play } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import type { Track } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { usePlayer } from '../player'
import { tracksToUnified, trackToUnified } from '../utils/unified'
import Cover from '../components/common/Cover'
import CardPlayButton from '../components/common/CardPlayButton'
import TrackList from '../components/common/TrackList'
import EmptyState from '../components/common/EmptyState'
import { useT } from '../i18n'

export default function ArtistDetailPage({ artistId }: { artistId: number }) {
  const { navigate } = useNav()
  const t = useT()
  const player = usePlayer()
  const version = useLibraryVersion()
  const { data, loading, error, reload } = useAsync(() => api.getArtist(artistId), [artistId, version])
  const tracks = useAsync(() => api.getArtistTracks(artistId), [artistId, version])

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

  const { artist, albums } = data
  const artistTracks: Track[] = tracks.data ?? []

  const playAll = () => {
    if (artistTracks.length > 0) player.playTracks(artistTracks.map(trackToUnified), 0)
  }

  const playAlbum = async (albumId: number) => {
    try {
      const detail = await api.getAlbum(albumId)
      if (detail.tracks.length > 0) player.playTracks(tracksToUnified(detail.tracks), 0)
    } catch {}
  }

  return (
    <div className="page">
      <button className="back-link" onClick={() => navigate({ name: 'artists' })}>
        <ChevronLeft size={15} />
        {t('Artists')}
      </button>

      <div className="detail-hero detail-hero-rich">
        {albums[0]?.coverPath ? (
          <div className="dh-bg" aria-hidden="true">
            <img
              className="dh-bg-img"
              src={convertFileSrc(albums[0].coverPath)}
              alt=""
              draggable={false}
            />
            <div className="dh-fade" />
          </div>
        ) : null}
        <div className="dh-fg">
          <Cover label={artist.name} size={132} rounded />
          <div className="detail-hero-info">
            <div className="section-label">{t('Artist')}</div>
            <h1 className="detail-title">{artist.name}</h1>
            <div className="detail-meta">
              <span>
                {(artist.albumCount ?? albums.length) === 1
                  ? `${artist.albumCount ?? albums.length} ${t('album')}`
                  : `${artist.albumCount ?? albums.length} ${t('albums')}`}
              </span>
              {artist.trackCount != null ? (
                <>
                  <span className="meta-dot">·</span>
                  <span>{artist.trackCount} {t('tracks')}</span>
                </>
              ) : null}
            </div>
            {albums.length > 0 ? (
              <div className="detail-actions">
                <button className="btn btn-primary" onClick={() => void playAll()}>
                  <Play size={14} />
                  {t('Play all')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {albums.length === 0 ? (
        <EmptyState title={t('No albums for this artist')} hint={t('Tracks may be filed without album metadata.')} />
      ) : (
        <div className="cards-grid">
          {albums.map((a) => (
            <button
              key={a.id}
              className="card"
              onClick={() => navigate({ name: 'album', id: a.id })}
              title={a.title}
            >
              <span className="card-cover">
                <Cover path={a.coverPath} label={a.title} size={120} />
                <CardPlayButton
                  label={`${t('Play')} ${a.title}`}
                  onPlay={() => void playAlbum(a.id)}
                />
              </span>
              <span className="card-title">{a.title}</span>
              <span className="card-sub">
                {a.year != null ? `${a.year} · ` : ''}
                {(a.trackCount ?? 0) === 1
                  ? `${a.trackCount ?? 0} ${t('track')}`
                  : `${a.trackCount ?? 0} ${t('tracks')}`}
              </span>
            </button>
          ))}
        </div>
      )}

      {artistTracks.length > 0 ? (
        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-title">{t('Tracks')}</span>
          </div>
          <TrackList tracks={artistTracks} />
        </section>
      ) : null}
    </div>
  )
}

import { useState } from 'react'
import { Heart, ImagePlus, Play, Search } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import type { ArtistImageCandidate, Track } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { usePlayer } from '../player'
import { tracksToUnified, trackToUnified } from '../utils/unified'
import Cover from '../components/common/Cover'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import CacheBadge from '../soundcloud/CacheBadge'
import CardPlayButton from '../components/common/CardPlayButton'
import TrackList from '../components/common/TrackList'
import EmptyState from '../components/common/EmptyState'
import Modal from '../components/common/Modal'
import { useT } from '../i18n'

export default function ArtistDetailPage({ artistId }: { artistId: number }) {
  const { navigate } = useNav()
  const t = useT()
  const player = usePlayer()
  const version = useLibraryVersion()
  const [imageBusy, setImageBusy] = useState(false)
  const [imageSearchBusy, setImageSearchBusy] = useState(false)
  const [imagePickerOpen, setImagePickerOpen] = useState(false)
  const [imageQuery, setImageQuery] = useState('')
  const [imageCandidate, setImageCandidate] = useState<ArtistImageCandidate | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const { data, loading, error, reload } = useAsync(() => api.getArtist(artistId), [artistId, version])
  const tracks = useAsync(() => api.getArtistTracks(artistId), [artistId, version])
  const fav = useAsync(() => api.isFavoriteArtist(artistId), [artistId, version])

  if (loading && data === null) {
    return (
      <div className="page">
        <div className="muted">{t('Loading…')}</div>
      </div>
    )
  }
  if (error && data === null) {
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

  const openImagePicker = () => {
    setImageQuery(artist.name)
    setImageCandidate(null)
    setImageError(null)
    setImagePickerOpen(true)
  }

  const searchOnlineImage = async () => {
    const query = imageQuery.trim()
    if (!query || imageSearchBusy) return
    setImageSearchBusy(true)
    setImageCandidate(null)
    setImageError(null)
    try {
      const candidates = await api.searchArtistImages(query)
      setImageCandidate(candidates[0] ?? null)
      if (candidates.length === 0) setImageError(t('No image found'))
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e))
    } finally {
      setImageSearchBusy(false)
    }
  }

  const saveOnlineImage = async () => {
    if (!imageCandidate || imageBusy) return
    setImageBusy(true)
    setImageError(null)
    try {
      await api.saveArtistImageFromUrl(artistId, imageCandidate.thumbnailUrl)
      setImagePickerOpen(false)
      reload()
      bumpLibraryVersion()
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e))
    } finally {
      setImageBusy(false)
    }
  }

  const chooseLocalImage = async () => {
    if (imageBusy) return
    setImageBusy(true)
    try {
      const sel = await open({
        multiple: false,
        filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      })
      if (typeof sel === 'string') {
        await api.importArtistImage(artistId, sel)
        setImagePickerOpen(false)
        reload()
        bumpLibraryVersion()
      }
    } catch {} finally {
      setImageBusy(false)
    }
  }

  return (
    <EditorialDetailLayout
      onBack={() => navigate({ name: 'artists' })}
      backLabel={t('Artists')}
      round
      art={
        <CacheBadge kind="artist" scId={null} localId={artistId}>
          <button
            className="avatar-edit"
            title={t('Change image')}
            disabled={imageBusy || imageSearchBusy}
            onClick={openImagePicker}
          >
            {artist.imagePath ? (
              <img
                className="profile-avatar"
                style={{ width: '100%', height: '100%' }}
                src={convertFileSrc(artist.imagePath)}
                alt=""
                draggable={false}
              />
            ) : (
              <Cover label={artist.name} size={232} rounded />
            )}
            <span className="avatar-edit-overlay">
              <ImagePlus size={16} />
              <span>{t('Change image')}</span>
            </span>
          </button>
        </CacheBadge>
      }
      kind={t('Artist')}
      title={artist.name}
      meta={
        <>
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
        </>
      }
      actions={
        albums.length > 0 || (tracks.data?.length ?? 0) > 0 ? (
          <>
            <button className="btn btn-primary" onClick={() => void playAll()}>
              <Play size={14} />
              {t('Play all')}
            </button>
            <button
              className={'btn' + (fav.data ? ' is-active' : '')}
              title={t('Favorite artist')}
              onClick={() =>
                void api
                  .toggleFavoriteArtist(artistId)
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
          </>
        ) : undefined
      }
    >

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

      <Modal
        open={imagePickerOpen}
        title={t('Find artist image')}
        onClose={() => setImagePickerOpen(false)}
      >
        <form
          className="artist-image-search-row"
          onSubmit={(event) => {
            event.preventDefault()
            void searchOnlineImage()
          }}
        >
          <input
            className="artist-image-query"
            aria-label={t('Artist name')}
            placeholder={t('Artist name')}
            value={imageQuery}
            maxLength={150}
            onChange={(event) => setImageQuery(event.target.value)}
          />
          <button className="btn" type="submit" disabled={!imageQuery.trim() || imageSearchBusy || imageBusy}>
            <Search size={14} />
            {t('Search')}
          </button>
        </form>
        {imageSearchBusy ? <div className="artist-image-status">{t('Searching…')}</div> : null}
        {imageError ? <div className="artist-image-status is-error">{imageError}</div> : null}
        {imageCandidate ? (
          <div className="artist-image-result">
            <img src={imageCandidate.thumbnailUrl} alt="" referrerPolicy="no-referrer" />
            <strong title={imageCandidate.name}>{imageCandidate.name}</strong>
            <button className="btn btn-primary" disabled={imageBusy} onClick={() => void saveOnlineImage()}>
              {t('Use image')}
            </button>
          </div>
        ) : null}
        <div className="modal-actions">
          <button className="btn" disabled={imageBusy} onClick={() => void chooseLocalImage()}>
            {t('Choose file')}
          </button>
        </div>
      </Modal>
    </EditorialDetailLayout>
  )
}

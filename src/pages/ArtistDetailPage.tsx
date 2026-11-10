import { useFormatCount } from '../i18n/count'
import { useEffect, useId, useState } from 'react'
import { ImagePlus, MicVocal, Play, Search, Shuffle } from 'lucide-react'
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
import CollectionFavoriteButton from '../components/common/CollectionFavoriteButton'
import CacheBadge from '../soundcloud/CacheBadge'
import CollectionAlbumGrid from '../components/common/CollectionAlbumGrid'
import TrackList from '../components/common/TrackList'
import EmptyState from '../components/common/EmptyState'
import Modal from '../components/common/Modal'
import { useT } from '../i18n'

export default function ArtistDetailPage({ artistId }: { artistId: number }) {
  const { navigate } = useNav()
  const t = useT()
  const count = useFormatCount()
  const player = usePlayer()
  const version = useLibraryVersion()
  const [tab, setTab] = useState('popular')
  const [query, setQuery] = useState('')
  const panelId = useId()
  useEffect(() => { setTab('popular'); setQuery('') }, [artistId])
  const [imageBusy, setImageBusy] = useState(false)
  const [imageSearchBusy, setImageSearchBusy] = useState(false)
  const [imagePickerOpen, setImagePickerOpen] = useState(false)
  const [imageQuery, setImageQuery] = useState('')
  const [imageCandidate, setImageCandidate] = useState<ArtistImageCandidate | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const { data, loading, error, reload } = useAsync(() => api.getArtist(artistId), [artistId, version])
  const tracks = useAsync(() => api.getArtistTracks(artistId), [artistId, version])
  const albumFavorites = useAsync(() => api.listFavoriteAlbums(), [version])
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
  const matchingTracks = artistTracks.filter(track => track.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const shownTracks = tab === 'popular' ? [...matchingTracks].sort((a, b) => b.playCount - a.playCount).slice(0, 10) : matchingTracks
  const albumFavoriteIds = new Set((albumFavorites.data ?? []).map(album => album.id))

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

  const discography = <section className="collection-discography">
          <div className="collection-section-heading"><h2>{t('Albums')}<span>{albums.length}</span></h2></div>
          {albums.length ? <CollectionAlbumGrid albums={albums} favoriteIds={albumFavoriteIds} onOpen={album => navigate({ name: 'album', id: album.id })} onPlay={album => void playAlbum(album.id)} onFavorite={album => { void api.toggleFavoriteAlbum(album.id).then(bumpLibraryVersion).catch(() => undefined) }} /> : <EmptyState title={t('No albums for this artist')} hint={t('Tracks may be filed without album metadata.')} />}
        </section>

  return (
    <EditorialDetailLayout
      className="local-artist-page"
      afterContent={tab === 'popular' && albums.length > 0 ? discography : undefined}
      variant="panorama"
      artworkPath={artist.imagePath}
      artworkLabel={artist.name}
      kindIcon={<MicVocal size={13} />}
      onBack={() => navigate({ name: 'artists' })}
      backLabel={t('Artists')}
      round
      art={<CacheBadge kind="artist" scId={null} localId={artistId}><Cover path={artist.imagePath} label={artist.name} size={300} rounded loading="eager" /></CacheBadge>}
      kind={t('Artist')}
      title={artist.name}
      meta={
        <>
          <span>
            {count(artist.albumCount ?? albums.length, 'album')}
          </span>
          {artist.trackCount != null ? (
            <>
              <span className="meta-dot">·</span>
              <span>{count(artist.trackCount, 'track')}</span>
            </>
          ) : null}
        </>
      }
      actions={
        albums.length > 0 || (tracks.data?.length ?? 0) > 0 ? (
          <>
            <button className="btn btn-primary" disabled={!artistTracks.length} onClick={() => void playAll()}>
              <Play size={14} />
              {t('Play all')}
            </button>
            <CollectionFavoriteButton active={fav.data ?? false} onClick={() => {
              void api.toggleFavoriteArtist(artistId).then(() => { fav.reload(); bumpLibraryVersion() }).catch(() => {})
            }} />
            <button type="button" className={`collection-icon-action${player.shuffle ? ' is-active' : ''}`} disabled={!artistTracks.length} title={t('Shuffle')} aria-label={t('Shuffle')} onClick={() => { if (!player.shuffle) player.toggleShuffle(); playAll() }}><Shuffle size={19} /></button>
            <button type="button" className="collection-icon-action" title={t('Change image')} aria-label={t('Change image')} disabled={imageBusy || imageSearchBusy} onClick={openImagePicker}><ImagePlus size={19} /></button>
          </>
        ) : undefined
      }
    >

      <div className="collection-artist-tabs" role="tablist" aria-label={t('Artist')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const keys = ['popular', 'albums', 'tracks']
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (keys.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3
        event.preventDefault(); setTab(keys[index]); event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[index]?.focus()
      }}>
        {[['popular', 'Popular'], ['albums', 'Albums'], ['tracks', 'All tracks']].map(([key, label]) => <button key={key} id={`${panelId}-${key}`} type="button" role="tab" aria-selected={tab === key} aria-controls={`${panelId}-panel`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)}>{t(label)}</button>)}
      </div>
      <div key={tab} className={`collection-tab-panel is-${tab}`} id={`${panelId}-panel`} role="tabpanel" aria-labelledby={`${panelId}-${tab}`}>
        {tab !== 'albums' && <section>
          <div className="collection-section-heading"><h2>{t(tab === 'popular' ? 'Popular tracks' : 'Tracks')}<span>{shownTracks.length}</span></h2><label className="collection-catalog-search"><Search size={14} /><input type="search" aria-label={t('Search tracks')} placeholder={t('Search tracks')} value={query} onChange={event => setQuery(event.target.value)} /></label></div>
          {tracks.loading && !tracks.data ? <p className="muted">{t('Loading…')}</p> : shownTracks.length ? <TrackList showSource tracks={shownTracks} showHeader /> : <EmptyState icon={<Search size={26} />} title={t(query ? 'No tracks found' : 'No tracks')} hint={query ? t('Try another search.') : t('No saved tracks by this artist yet.')} />}
        </section>}
        {tab === 'albums' && discography}
      </div>

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

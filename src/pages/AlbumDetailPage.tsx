import { useEffect, useState } from 'react'
import { useFormatCount } from '../i18n/count'
import { ArrowRight, Disc3, Folder, Play, Shuffle, Users } from 'lucide-react'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { usePlayer } from '../player'
import { tracksToUnified } from '../utils/unified'
import { CollectionTrackHeading } from '../components/common/CollectionCatalog'
import Cover from '../components/common/Cover'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import CollectionFavoriteButton from '../components/common/CollectionFavoriteButton'
import EmptyState from '../components/common/EmptyState'
import TrackList from '../components/common/TrackList'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'
import { normalizeSearchText } from '../utils/searchText'

export default function AlbumDetailPage({ albumId }: { albumId: number }) {
  const { navigate } = useNav()
  const t = useT()
  const count = useFormatCount()
  const player = usePlayer()
  const [query, setQuery] = useState('')
  useEffect(() => setQuery(''), [albumId])
  const version = useLibraryVersion()
  const { data, loading, error, reload } = useAsync(() => api.getAlbum(albumId), [albumId, version])
  const fav = useAsync(() => api.isFavoriteAlbum(albumId), [albumId, version])

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

  const { album, tracks } = data
  const unknownArtist = t('Unknown artist')
  const search = normalizeSearchText(query.trim())
  const shownTracks = tracks.filter(track => normalizeSearchText(`${track.title} ${track.artistName ?? ''}`).includes(search))

  return (
    <EditorialDetailLayout
      className="local-album-page"
      variant="panorama"
      artworkPath={album.coverPath}
      artworkLabel={album.title}
      kindIcon={<Disc3 size={13} />}
      onBack={() => navigate({ name: 'albums' })}
      backLabel={t('Albums')}
      art={<Cover path={album.coverPath} label={album.title} size={232} />}
      kind={t('Album')}
      title={album.title}
      byline={album.artistId != null ? <button type="button" onClick={() => navigate({ name: 'artist', id: album.artistId! })}><Users size={15} />{album.artistName ?? unknownArtist}<ArrowRight size={13} /></button> : <span>{album.artistName ?? unknownArtist}</span>}
      meta={<><span>{album.year ?? '—'}</span><span className="meta-dot">·</span><span>{count(tracks.length, 'track')}</span><span className="meta-dot">·</span><span>{fmtTime(tracks.reduce((sum, track) => sum + (track.durationSec ?? 0), 0))}</span></>}
      actions={
        tracks.length > 0 ? (
          <>
            <button
              className="btn btn-primary"
              onClick={() => player.playTracks(tracksToUnified(tracks), 0)}
            >
              <Play size={14} />
              {t('Play all')}
            </button>
            <CollectionFavoriteButton active={fav.data ?? false} onClick={() => {
              void api.toggleFavoriteAlbum(albumId).then(() => { fav.reload(); bumpLibraryVersion() }).catch(() => {})
            }} />
            <button type="button" className={`collection-icon-action${player.shuffle ? ' is-active' : ''}`} aria-label={t('Shuffle')} title={t('Shuffle')} onClick={() => { if (!player.shuffle) player.toggleShuffle(); player.playTracks(tracksToUnified(tracks), 0) }}><Shuffle size={19} /></button>
          </>
        ) : undefined
      }
    >

      {tracks.length === 0 ? (
        <EmptyState title={t('This album has no tracks')} hint={t('Rescan your library if this seems wrong.')} />
      ) : (
        <section className="detail-tracklist-section">
          <CollectionTrackHeading count={shownTracks.length} query={query} onQuery={setQuery} />
          {shownTracks.length ? <TrackList showSource tracks={shownTracks} showAlbum={false} showIndex showHeader /> : <EmptyState title={t('No tracks found')} hint={t('Try another search.')} />}
        </section>
      )}
      <footer className="collection-detail-footnote"><Folder size={13} />{t('In library')}</footer>
    </EditorialDetailLayout>
  )
}

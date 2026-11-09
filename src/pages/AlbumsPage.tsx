import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Play, Search, Star, StarOff } from 'lucide-react'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import type { Album } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { tracksToUnified } from '../utils/unified'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { openContextMenu, type ContextMenuItem } from '../components/common/ContextMenu'
import CollectionAlbumGrid from '../components/common/CollectionAlbumGrid'
import { CollectionCatalogHeading, CollectionCatalogToolbar } from '../components/common/CollectionCatalog'
import EmptyState from '../components/common/EmptyState'

type AlbumSort = 'title' | 'artist' | 'year'

export default function AlbumsPage() {
  const { navigate } = useNav()
  const t = useT()
  const player = usePlayer()
  const version = useLibraryVersion()
  const { data, loading, error } = useAsync(() => api.listAlbums(''), [version])
  const favorites = useAsync(() => api.listFavoriteAlbums(), [version])
  const favoriteIds = new Set((favorites.data ?? []).map(album => album.id))
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<AlbumSort>('title')
  const search = query.trim().toLocaleLowerCase()
  const visibleAlbums = (data ?? [])
    .filter((album) => (!favoritesOnly || favoriteIds.has(album.id)) && `${album.title} ${album.artistName ?? ''}`.toLocaleLowerCase().includes(search))
    .sort((a, b) => {
      if (sort === 'year') return (b.year ?? -1) - (a.year ?? -1) || a.title.localeCompare(b.title)
      if (sort === 'artist') return (a.artistName ?? '').localeCompare(b.artistName ?? '') || a.title.localeCompare(b.title)
      return a.title.localeCompare(b.title)
    })

  const playAlbum = async (albumId: number) => {
    try {
      const detail = await api.getAlbum(albumId)
      if (detail.tracks.length > 0) player.playTracks(tracksToUnified(detail.tracks), 0)
    } catch {}
  }

  // the favourite state has to be asked for, so the menu opens once it lands
  const albumMenu = (e: ReactMouseEvent, a: Album) => {
    e.preventDefault()
    const x = e.clientX
    const y = e.clientY
    void api
      .isFavoriteAlbum(a.id)
      .then((isFav) => {
        const items: ContextMenuItem[] = [
          {
            id: 'play',
            label: t('Play all'),
            icon: <Play size={13} />,
            onSelect: () => void playAlbum(a.id),
          },
          {
            id: 'fav',
            label: isFav ? t('Remove from favorites') : t('Add to favorites'),
            icon: isFav ? <StarOff size={13} /> : <Star size={13} />,
            onSelect: () => {
              void api
                .toggleFavoriteAlbum(a.id)
                .then(() => bumpLibraryVersion())
                .catch(() => undefined)
            },
          },
        ]
        openContextMenu({ x, y, title: a.title, items })
      })
      .catch(() => undefined)
  }

  return (
    <div className="page album-wall-page collection-catalog collection-albums-panorama">
      <CollectionCatalogHeading title={t('Albums')} count={data?.length} />
      <CollectionCatalogToolbar query={query} onQuery={setQuery} placeholder={t('Search albums')} favoritesOnly={favoritesOnly} onFavoritesOnly={setFavoritesOnly} allLabel={t('All albums')}>
        <select value={sort} aria-label={t('Sort by')} onChange={event => setSort(event.target.value as AlbumSort)}>
          <option value="title">{t('Sort by title')}</option>
          <option value="artist">{t('Sort by artist')}</option>
          <option value="year">{t('Sort by year')}</option>
        </select>
      </CollectionCatalogToolbar>

      {error ? <div className="error-line">{error}</div> : null}
      {loading && data === null ? (
        <div className="muted">{t('Loading…')}</div>
      ) : !data || data.length === 0 ? (
        <EmptyState title={t('No albums found')} hint={t('Albums appear after your library has been scanned.')} />
      ) : visibleAlbums.length === 0 ? (
        <EmptyState icon={<Search size={30} />} title={t('No albums match')} hint={t('Try another search.')} />
      ) : (
        <CollectionAlbumGrid albums={visibleAlbums} panorama favoriteIds={favoriteIds} onOpen={album => navigate({ name: 'album', id: album.id })} onPlay={album => void playAlbum(album.id)} onMenu={albumMenu} onFavorite={album => { void api.toggleFavoriteAlbum(album.id).then(bumpLibraryVersion).catch(() => undefined) }} />
      )}
    </div>
  )
}

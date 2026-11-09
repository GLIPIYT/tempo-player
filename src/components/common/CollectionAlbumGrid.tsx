import { Disc3, Play, Star } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { Album } from '../../types/models'
import { useT } from '../../i18n'
import Cover from './Cover'
import './collectionDesign.css'

export default function CollectionAlbumGrid({ albums, panorama = false, favoriteIds, onOpen, onPlay, onFavorite, onMenu }: {
  albums: Album[]; panorama?: boolean; favoriteIds?: ReadonlySet<number>
  onOpen: (album: Album) => void; onPlay: (album: Album) => void
  onFavorite?: (album: Album) => void; onMenu?: (event: MouseEvent, album: Album) => void
}) {
  const t = useT()
  return <div className={`collection-album-grid${panorama ? ' is-panorama' : ''}`}>
    {albums.map(album => <article key={album.id} className="collection-album-card" onContextMenu={event => onMenu?.(event, album)}>
      <button type="button" className="collection-album-open" title={album.title} onClick={() => onOpen(album)}>
        <span className="collection-album-art"><Cover path={album.coverPath} label={album.title} size={320} />{album.trackCount != null && <span className="collection-art-count"><Disc3 size={12} />{album.trackCount}</span>}</span>
        <strong>{album.title}</strong><small>{album.artistName ?? t('Unknown artist')}</small>{album.year != null && <span className="collection-album-year">{album.year}</span>}
      </button>
      <button type="button" className="collection-card-play" disabled={album.trackCount === 0} aria-label={`${t('Play all')}: ${album.title}`} onClick={() => onPlay(album)}><Play size={17} fill="currentColor" /></button>
      {onFavorite && <button type="button" className={`collection-album-favorite${favoriteIds?.has(album.id) ? ' is-active' : ''}`} aria-label={`${favoriteIds?.has(album.id) ? t('Remove from favorites') : t('Add to favorites')}: ${album.title}`} aria-pressed={favoriteIds?.has(album.id) ?? false} onClick={() => onFavorite(album)}><Star size={15} fill={favoriteIds?.has(album.id) ? 'currentColor' : 'none'} /></button>}
    </article>)}
  </div>
}

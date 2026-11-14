import type { MouseEvent } from 'react'
import type { Album } from '../../types/models'
import Cover from './Cover'
import CollectionAlbumCard from './CollectionAlbumCard'
import CollectionFavoriteButton from './CollectionFavoriteButton'
import './collectionDesign.css'

export default function CollectionAlbumGrid({ albums, panorama = false, favoriteIds, onOpen, onPlay, onFavorite, onMenu }: {
  albums: Album[]; panorama?: boolean; favoriteIds?: ReadonlySet<number>
  onOpen: (album: Album) => void; onPlay: (album: Album) => void
  onFavorite?: (album: Album) => void; onMenu?: (event: MouseEvent, album: Album) => void
}) {
  return <div className={`collection-album-grid${panorama ? ' is-panorama' : ''}`}>
    {albums.map(album => <CollectionAlbumCard key={album.id} title={album.title} artist={album.artistName} year={album.year} count={album.trackCount}
      art={<Cover path={album.coverPath} label={album.title} size={320} />}
      onOpen={() => onOpen(album)} onPlay={() => onPlay(album)} onMenu={event => onMenu?.(event, album)}>
      {onFavorite && <CollectionFavoriteButton className="collection-album-favorite" active={favoriteIds?.has(album.id) ?? false} label={album.title} onClick={() => onFavorite(album)} />}
    </CollectionAlbumCard>)}
  </div>
}

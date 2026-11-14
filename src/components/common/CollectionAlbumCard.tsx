import { Disc3, Play } from 'lucide-react'
import type { MouseEventHandler, ReactNode } from 'react'
import { useT } from '../../i18n'
import './collectionDesign.css'

export default function CollectionAlbumCard({ title, artist, year, count, art, onOpen, onPlay, onMenu, children }: {
  title: string
  artist?: string | null
  year?: number | null
  count?: number | null
  art: ReactNode
  onOpen: () => void
  onPlay?: () => void
  onMenu?: MouseEventHandler
  children?: ReactNode
}) {
  const t = useT()
  return (
    <article className="collection-album-card" onContextMenu={onMenu}>
      <button type="button" className="collection-album-open" title={title} onClick={onOpen}>
        <span className="collection-album-art">
          {art}
          {count != null && <span className="collection-art-count"><Disc3 size={12} />{count}</span>}
        </span>
        <strong>{title}</strong>
        <small>{artist || t('Unknown artist')}</small>
        {year != null && <span className="collection-album-year">{year}</span>}
      </button>
      {onPlay && <button type="button" className="collection-card-play" disabled={count === 0} aria-label={`${t('Play all')}: ${title}`} onClick={onPlay}><Play size={17} fill="currentColor" /></button>}
      {children}
    </article>
  )
}

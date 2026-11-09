import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Folder, Maximize2 } from 'lucide-react'
import { useT } from '../../i18n'
import Cover from './Cover'
import ArtworkView from '../artwork-view/ArtworkView'
import './collectionDesign.css'

/** A cover-led detail page with the collection and its content in one flow. */
export default function EditorialDetailLayout({
  className = '',
  onBack,
  backLabel,
  art,
  round = false,
  kind,
  title,
  description,
  meta,
  actions,
  children,
  variant,
  artworkPath,
  artworkLabel,
  artworkPreview,
  kindIcon,
  byline,
}: {
  className?: string
  onBack: () => void
  backLabel: string
  art: ReactNode
  round?: boolean
  kind: ReactNode
  title: ReactNode
  description?: ReactNode
  meta: ReactNode
  actions?: ReactNode
  children: ReactNode
  variant?: 'air' | 'panorama'
  artworkPath?: string | null
  artworkLabel?: string
  artworkPreview?: ReactNode
  kindIcon?: ReactNode
  byline?: ReactNode
}) {
  const t = useT()
  const [viewingArtwork, setViewingArtwork] = useState(false)
  useEffect(() => setViewingArtwork(false), [artworkLabel])
  const artwork = <>{art}{variant && artworkLabel && <span className="collection-art-zoom" aria-hidden="true"><Maximize2 size={18} /></span>}</>
  return (
    <div className={`page editorial-detail-page ${variant ? `collection-detail collection-detail--${variant} ` : ''}${className}`.trim()}>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={14} />
        <span>{backLabel}</span>
      </button>

      <header className="editorial-detail-hero">
        {variant && artworkPath && <div className="collection-detail-glow" aria-hidden="true"><Cover path={artworkPath} label="" size={500} loading="eager" /></div>}
        {variant && artworkLabel ? <button type="button" className={`editorial-detail-art collection-art-open${round ? ' is-round' : ''}`} aria-label={`${t('View artwork')}: ${artworkLabel}`} onClick={() => setViewingArtwork(true)}>{artwork}</button> : <div className={round ? 'editorial-detail-art is-round' : 'editorial-detail-art'}>{art}</div>}
        <div className="editorial-detail-copy">
          <div className="section-label editorial-detail-kind">{kindIcon}{kind}{variant && <span className="collection-local-badge"><Folder size={11} />{t('In library')}</span>}</div>
          <h1 className="editorial-detail-title">{title}</h1>
          {byline && <div className="collection-detail-byline">{byline}</div>}
          {description ? <p className="editorial-detail-description">{description}</p> : null}
          <div className="editorial-detail-meta">{meta}</div>
          {actions ? <div className="editorial-detail-actions">{actions}</div> : null}
        </div>
      </header>

      <div className="editorial-detail-content">{children}</div>
      {viewingArtwork && <ArtworkView track={{ title: artworkLabel ?? '', coverPath: artworkPath ?? null }} artwork={artworkPreview} onClose={() => setViewingArtwork(false)} />}
    </div>
  )
}

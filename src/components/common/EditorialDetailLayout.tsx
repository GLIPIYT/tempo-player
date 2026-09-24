import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

/** A cover-led detail page with the collection and its content in one flow. */
export default function EditorialDetailLayout({
  onBack,
  backLabel,
  art,
  round = false,
  kind,
  title,
  meta,
  actions,
  children,
}: {
  onBack: () => void
  backLabel: string
  art: ReactNode
  round?: boolean
  kind: ReactNode
  title: string
  meta: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="page editorial-detail-page">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={14} />
        <span>{backLabel}</span>
      </button>

      <header className="editorial-detail-hero">
        <div className={round ? 'editorial-detail-art is-round' : 'editorial-detail-art'}>{art}</div>
        <div className="editorial-detail-copy">
          <div className="section-label editorial-detail-kind">{kind}</div>
          <h1 className="editorial-detail-title">{title}</h1>
          <div className="editorial-detail-meta">{meta}</div>
          {actions ? <div className="editorial-detail-actions">{actions}</div> : null}
        </div>
      </header>

      <div className="editorial-detail-content">{children}</div>
    </div>
  )
}

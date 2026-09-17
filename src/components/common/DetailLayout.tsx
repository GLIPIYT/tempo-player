import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

/**
 * The shell every detail page shares: a sticky column on the left, content on
 * the right.
 *
 * The point of the sticky column is the actions. On a two-hour playlist the
 * cover and the play button should not be a scroll away, and a wide banner
 * above the list pushes them off screen the moment you start reading tracks.
 */
export default function DetailLayout({
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
  /** The cover or avatar. Fills a square, or a circle when `round`. */
  art: ReactNode
  round?: boolean
  /** The eyebrow above the title. Markup, so a source mark can sit in it. */
  kind: ReactNode
  title: string
  meta: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="page">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={14} />
        <span>{backLabel}</span>
      </button>

      <div className="detail-split">
        <aside className="detail-side">
          <div className={round ? 'detail-side-art is-round' : 'detail-side-art'}>{art}</div>
          <div className="section-label detail-kind">{kind}</div>
          <h1 className="detail-side-title">{title}</h1>
          <div className="detail-side-meta">{meta}</div>
          {actions ? <div className="detail-side-actions">{actions}</div> : null}
        </aside>

        <div className="detail-main">{children}</div>
      </div>
    </div>
  )
}

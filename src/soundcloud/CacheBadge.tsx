import type { ReactNode } from 'react'
import { Download } from 'lucide-react'
import { useT } from '../i18n'
import { useCacheJob, useCachePercent, type CacheKind } from './cacheJobs'

/**
 * Dims a cover and stamps the percentage on it while its cache is running.
 *
 * Used wherever a kept playlist or artist is shown, so the same item reads the
 * same way in the search results and in the sidebar rather than each place
 * inventing its own way of saying "not finished yet".
 */
export default function CacheBadge({
  kind,
  scId,
  localId,
  children,
}: {
  kind: CacheKind
  scId: string | null
  localId?: number | null
  children: ReactNode
}) {
  const percent = useCachePercent(kind, scId, localId)
  if (percent === null) return <>{children}</>
  return (
    <span className="cache-badge">
      {children}
      <span className="cache-badge-veil" />
      <span className="cache-badge-pct">{percent}%</span>
    </span>
  )
}

export function CacheProgress({
  kind,
  scId,
  localId,
}: {
  kind: CacheKind
  scId: string | null
  localId?: number | null
}) {
  const t = useT()
  const job = useCacheJob(kind, scId, localId)
  if (!job) return null
  const percent = job.total === 0 ? 0 : Math.min(100, Math.round((job.done / job.total) * 100))

  return (
    <div className="cache-progress" role="status" aria-live="polite">
      <div className="cache-progress-heading">
        <span><Download size={14} />{t('Caching')}</span>
        <strong>{percent}%</strong>
      </div>
      <div
        className="cache-progress-track"
        role="progressbar"
        aria-label={t('Caching')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="cache-progress-meta">
        {job.done} {t('of')} {job.total} {t('tracks')}
        {job.failed > 0 ? ` · ${job.failed} ${t('errors')}` : ''}
      </div>
    </div>
  )
}

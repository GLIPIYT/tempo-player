import type { ReactNode } from 'react'
import { useCachePercent, type CacheKind } from './cacheJobs'

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

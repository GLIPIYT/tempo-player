import { useEffect, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { useT } from '../i18n'
import {
  cancelCacheJob,
  getCacheJobs,
  initCacheJobs,
  subscribeCacheJobs,
  type CacheJob,
} from './cacheJobs'

/**
 * Progress for playlist downloads.
 *
 * The border *is* the progress bar: an SVG rounded rectangle whose stroke is
 * drawn up to the percentage. A separate bar would be a second thing to read
 * when the notification itself can already carry the number.
 */
const W = 320
const H = 60
const R = 12
/** A rounded rect's perimeter, which is the unit `stroke-dasharray` counts in. */
const PERIMETER = 2 * (W + H) - 8 * R + 2 * Math.PI * R

function CacheToast({ job }: { job: CacheJob }) {
  const t = useT()
  const percent = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0

  let status = `${t('Caching…')} ${percent}%`
  if (job.state === 'cancelled') status = t('Caching stopped')
  else if (job.state === 'done') {
    status = job.failed > 0 ? `${t('Cached')} · ${job.failed} ${t('failed')}` : t('Cached')
  }

  return (
    <div className={job.state === 'running' ? 'cache-toast' : 'cache-toast is-done'}>
      <svg
        className="cache-toast-ring"
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        aria-hidden="true"
      >
        <rect className="cache-toast-track" x="1" y="1" width={W - 2} height={H - 2} rx={R} />
        <rect
          className="cache-toast-fill"
          x="1"
          y="1"
          width={W - 2}
          height={H - 2}
          rx={R}
          style={{
            strokeDasharray: PERIMETER,
            strokeDashoffset: PERIMETER * (1 - percent / 100),
          }}
        />
      </svg>
      <div className="cache-toast-body">
        <div className="cache-toast-text">
          <span className="cache-toast-label" title={job.label}>
            {job.label}
          </span>
          <span className="cache-toast-status">{status}</span>
        </div>
        {job.state === 'running' ? (
          <button
            className="icon-btn"
            aria-label={t('Cancel')}
            onClick={() => cancelCacheJob(job.id)}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

export default function CacheToasts() {
  const jobs = useSyncExternalStore(subscribeCacheJobs, getCacheJobs, getCacheJobs)
  // The component that shows progress is also the one that starts listening,
  // so the two cannot drift apart.
  useEffect(() => {
    void initCacheJobs()
  }, [])
  if (jobs.length === 0) return null
  return (
    <div className="cache-toasts">
      {jobs.map((job) => (
        <CacheToast key={job.id} job={job} />
      ))}
    </div>
  )
}

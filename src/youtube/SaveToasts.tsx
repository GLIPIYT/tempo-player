import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { useT } from '../i18n'
import { cancelSave, getSaveJob, subscribeSave, type SaveJob } from './collectionSaver'

/**
 * Progress for saving an album, artist or playlist.
 *
 * The same notification SoundCloud's downloads use, down to the border being
 * the progress bar: an SVG rounded rectangle whose stroke is drawn up to the
 * percentage. A second kind of progress display would be a second thing to
 * learn for no reason.
 */
const W = 320
const H = 60
const R = 12
/** A rounded rect's perimeter, which is the unit `stroke-dasharray` counts in. */
const PERIMETER = 2 * (W + H) - 8 * R + 2 * Math.PI * R

function SaveToast({ job }: { job: SaveJob }) {
  const t = useT()
  const percent = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0

  let status = `${t('Saving')} ${percent}%`
  if (job.state === 'cancelled') status = t('Saving stopped')
  else if (job.state === 'done') {
    status = job.failed > 0 ? `${t('Saved')} · ${job.failed} ${t('unavailable')}` : t('Saved')
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
          <button className="icon-btn" aria-label={t('Cancel')} onClick={cancelSave}>
            <X size={14} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

export default function SaveToasts() {
  const job = useSyncExternalStore(subscribeSave, getSaveJob, getSaveJob)
  if (job === null) return null
  return (
    <div className="cache-toasts">
      <SaveToast job={job} />
    </div>
  )
}

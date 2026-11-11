import { memo, useEffect, useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { usePlayerActions, usePlayerField } from '../../player'
import { useT } from '../../i18n'
import { fmtTime } from '../../utils/format'
import Cover from '../common/Cover'

export default memo(function QueuePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePlayerActions()
  const queue = usePlayerField('queue')
  const queueIndex = usePlayerField('queueIndex')
  const t = useT()
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const finishDrag = (target: number) => {
    const from = dragFrom
    setDragFrom(null)
    setDragOver(null)
    if (from === null || !Number.isInteger(from)) return
    if (target < 0 || target >= queue.length) return
    if (from === target) return
    p.moveInQueue(from, target)
  }

  const clearDrag = () => {
    setDragFrom(null)
    setDragOver(null)
  }

  const current = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null
  const upcomingCount = Math.max(0, queue.length - queueIndex - 1)
  const removeAria = t('Remove')
  const fromQueue = t('from queue')
  const unknownArtist = t('Unknown artist')

  return (
    <aside className={'qpanel' + (open ? ' is-open' : '')} aria-hidden={!open}>
      <div className="qpanel-head">
        <span className="qpanel-title">{t('Queue')}</span>
        <span className="qpanel-count">{upcomingCount}</span>
        <div className="qpanel-actions">
          {queue.length > 0 ? (
            <button className="icon-btn" onClick={() => p.clearQueue()} aria-label={t('Clear queue')}>
              <Trash2 size={15} />
            </button>
          ) : null}
          <button className="icon-btn" onClick={onClose} aria-label={t('Close queue')}>
            <X size={16} />
          </button>
        </div>
      </div>
      {queue.length === 0 ? (
        <div className="qpanel-empty">{t('Queue is empty')}</div>
      ) : (
        <div
          className="qpanel-list"
          onDragOver={(e) => {
            if (dragFrom === null || queue.length === 0) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDragOver(queue.length - 1)
          }}
          onDrop={(e) => {
            if (dragFrom === null) return
            e.preventDefault()
            finishDrag(queue.length - 1)
          }}
        >
          {current ? (
            <div className="qrow qrow-current">
              <span className="qrow-num">{queueIndex + 1}</span>
              <Cover path={current.coverPath} label={current.title} size={34} />
              <div className="qrow-meta">
                <span className="qrow-title">{current.title}</span>
                <span className="qrow-sub">{current.artists.join(', ') || unknownArtist}</span>
              </div>
              <span className="qrow-tag">{t('Now')}</span>
            </div>
          ) : null}
          {queue.map((track, idx) =>
            idx <= queueIndex ? null : (
              <div
                key={`${track.sourceId}-${idx}`}
                className={
                  'qrow' +
                  (dragFrom === idx ? ' qrow-dragging' : '') +
                  (dragOver === idx && dragFrom !== null && dragFrom !== idx ? ' qrow-drop' : '')
                }
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', String(idx))
                  setDragFrom(idx)
                }}
                onDragOver={(e) => {
                  if (dragFrom === null) return
                  e.preventDefault()
                  e.stopPropagation()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOver(idx)
                }}
                onDragLeave={() => {
                  setDragOver((cur) => (cur === idx ? null : cur))
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  finishDrag(idx)
                }}
                onDragEnd={clearDrag}
                onClick={() => p.playTracks(queue, idx)}
              >
                <span className="qrow-num">{idx + 1}</span>
                <Cover path={track.coverPath} label={track.title} size={34} />
                <div className="qrow-meta">
                  <span className="qrow-title">{track.title}</span>
                  <span className="qrow-sub">
                    {track.auto ? <span className="qrow-auto">{t('Autopick')}</span> : null}
                    {track.artists.join(', ') || unknownArtist}
                  </span>
                </div>
                <span className="qrow-dur">{fmtTime(track.durationSec)}</span>
                <button
                  className="icon-btn qrow-remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    p.removeFromQueue(idx)
                  }}
                  aria-label={`${removeAria} ${track.title} ${fromQueue}`}
                >
                  <X size={13} />
                </button>
              </div>
            ),
          )}
        </div>
      )}
    </aside>
  )
})

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Check } from 'lucide-react'
import Modal from '../components/common/Modal'
import ScArtwork from '../components/common/ScArtwork'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'
import {
  dismissArtistChoice,
  getArtistChoice,
  resolveArtistChoice,
  subscribeArtistChoice,
} from './cacheJobs'

/**
 * Which of an artist's tracks to keep, and which local artist to file them
 * under.
 *
 * Only shown when the catalogue is long enough that taking all of it is
 * unlikely to have been the intent. Everything starts ticked: the common case
 * is still "all of it", and unticking a few beats ticking many.
 */
export default function CacheArtistDialog() {
  const t = useT()
  const pending = useSyncExternalStore(subscribeArtistChoice, getArtistChoice, getArtistChoice)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mergeInto, setMergeInto] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)

  const artistId = pending?.artist.id ?? null

  // A different artist means a different question, so the answers start over.
  useEffect(() => {
    if (!pending) return
    setSelected(new Set(pending.plan.tracks.map((trk) => trk.id)))
    setMergeInto('')
    setBusy(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the artist, not the object
  }, [artistId])

  if (!pending) return null

  const tracks = pending.plan.tracks
  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const chosen = tracks.filter((trk) => selected.has(trk.id))

  return (
    <Modal
      open
      title={`${t('Keep this artist')} — ${pending.artist.username}`}
      onClose={dismissArtistChoice}
    >
      <div className="settings-line">
        {`${tracks.length} ${t('tracks')}. ${t('Pick the ones to keep.')}`}
      </div>

      <div className="pick-actions">
        <button className="btn" onClick={() => setSelected(new Set(tracks.map((trk) => trk.id)))}>
          {t('Select all')}
        </button>
        <button className="btn" onClick={() => setSelected(new Set())}>
          {t('Clear all')}
        </button>
      </div>

      <div className="pick-list">
        {tracks.map((trk) => (
          <button
            key={trk.id}
            type="button"
            className={selected.has(trk.id) ? 'pick-row is-on' : 'pick-row'}
            onClick={() => toggle(trk.id)}
          >
            <span className="pick-box">{selected.has(trk.id) ? <Check size={12} /> : null}</span>
            <ScArtwork url={trk.artworkUrl} title={trk.title} />
            <span className="pick-meta">
              <span className="pick-title">{trk.title}</span>
              <span className="pick-sub">{pending.plan.albumOf[trk.id] ?? trk.artist}</span>
            </span>
            <span className="pick-duration">{fmtTime(trk.durationMs / 1000)}</span>
          </button>
        ))}
      </div>

      <div className="pick-merge">
        <div className="section-label">{t('File them under')}</div>
        <select
          className="text-input"
          value={mergeInto}
          onChange={(e) => setMergeInto(e.target.value === '' ? '' : Number(e.target.value))}
        >
          <option value="">{`${t('A new artist')} — ${pending.artist.username}`}</option>
          {pending.mergeCandidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
        {pending.mergeCandidates.length > 0 ? (
          <div className="set-note">
            {t('These local artists look like the same one. Picking one files the tracks under it.')}
          </div>
        ) : null}
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={dismissArtistChoice}>
          {t('Cancel')}
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || chosen.length === 0}
          onClick={() => {
            setBusy(true)
            void resolveArtistChoice(chosen, mergeInto === '' ? null : mergeInto)
          }}
        >
          {`${t('Cache')} ${chosen.length}`}
        </button>
      </div>
    </Modal>
  )
}

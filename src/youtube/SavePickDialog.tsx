import { useEffect, useState, useSyncExternalStore } from 'react'
import { Check } from 'lucide-react'
import Modal from '../components/common/Modal'
import ScArtwork from '../components/common/ScArtwork'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'
import {
  dismissSaveChoice,
  getSaveChoice,
  resolveSaveChoice,
  subscribeSaveChoice,
} from './collectionSaver'

/**
 * Which of a collection's tracks to keep.
 *
 * Only asked when the list is long enough that taking all of it is unlikely to
 * have been the intent - an artist can hold a hundred tracks and nobody wants
 * all of them. Everything starts ticked: the common case is still "all of it",
 * and unticking a few beats ticking many.
 *
 * There is no "file them under" here, unlike SoundCloud's. That question exists
 * because SoundCloud's artists are separate entities that can collide; a
 * YouTube track carries its artist's name with it, so there is nothing to
 * decide.
 */
export default function SavePickDialog() {
  const t = useT()
  const pending = useSyncExternalStore(subscribeSaveChoice, getSaveChoice, getSaveChoice)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const key = pending?.id ?? null

  // A different collection means a different question, so the answers start over.
  useEffect(() => {
    if (!pending) return
    setSelected(new Set(pending.tracks.map((track) => track.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the collection, not the object
  }, [key])

  if (!pending) return null

  const tracks = pending.tracks
  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const chosen = tracks.filter((track) => selected.has(track.id))

  return (
    <Modal
      open
      title={`${t('Save to library')} — ${pending.label}`}
      onClose={dismissSaveChoice}
    >
      <div className="settings-line">
        {`${tracks.length} ${t('tracks')}. ${t('Pick the ones to keep.')}`}
      </div>

      <div className="pick-actions">
        <button className="btn" onClick={() => setSelected(new Set(tracks.map((x) => x.id)))}>
          {t('Select all')}
        </button>
        <button className="btn" onClick={() => setSelected(new Set())}>
          {t('Clear all')}
        </button>
      </div>

      <div className="pick-list">
        {tracks.map((track) => (
          <button
            key={track.id}
            type="button"
            className={selected.has(track.id) ? 'pick-row is-on' : 'pick-row'}
            onClick={() => toggle(track.id)}
          >
            <span className="pick-box">{selected.has(track.id) ? <Check size={12} /> : null}</span>
            <ScArtwork url={track.thumbnailUrl} title={track.title} />
            <span className="pick-meta">
              <span className="pick-title">{track.title}</span>
              <span className="pick-sub">{track.artist}</span>
            </span>
            <span className="pick-duration">{fmtTime(track.durationMs / 1000)}</span>
          </button>
        ))}
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={dismissSaveChoice}>
          {t('Cancel')}
        </button>
        <button
          className="btn btn-primary"
          disabled={chosen.length === 0}
          onClick={() => resolveSaveChoice(chosen)}
        >
          {`${t('Save')} ${chosen.length}`}
        </button>
      </div>
    </Modal>
  )
}

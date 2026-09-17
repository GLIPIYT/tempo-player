import { useSyncExternalStore } from 'react'
import Modal from '../components/common/Modal'
import { useT } from '../i18n'
import {
  dismissCacheChoice,
  getCacheChoice,
  resolveCacheChoice,
  subscribeCacheChoice,
} from './cacheJobs'

/**
 * Asks what to do when a SoundCloud playlist's name is already taken.
 *
 * Lives next to the progress toasts rather than inside a page: the question can
 * be raised from a right-click on a card, and a card can unmount the moment the
 * menu closes. Putting the state here means the answer survives that.
 */
export default function CacheChoiceDialog() {
  const t = useT()
  const pending = useSyncExternalStore(subscribeCacheChoice, getCacheChoice, getCacheChoice)
  if (!pending) return null

  return (
    <Modal open title={t('A playlist with this name already exists')} onClose={dismissCacheChoice}>
      <div className="settings-line">
        {`${t('You already have a playlist called')} «${pending.existing.name}».`}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={dismissCacheChoice}>
          {t('Cancel')}
        </button>
        <button className="btn" onClick={() => void resolveCacheChoice('new')}>
          {t('Create a second one')}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void resolveCacheChoice(pending.existing.id)}
        >
          {t('Append to it')}
        </button>
      </div>
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import Modal from '../components/common/Modal'
import { useT } from '../i18n'
import UpdateDialog from './UpdateDialog'
import {
  appVersion,
  listReleases,
  skippedVersions,
  takePendingUpdate,
  type ReleaseInfo,
} from './service'
import { compareVersions, newerThan } from './version'

/**
 * Checks for updates once per launch.
 *
 * Renders nothing at all until there is something to say. Only the newest
 * release the user has not skipped is ever offered - skipping 0.6.0 says
 * nothing about 0.6.1, which is what makes "skip" per version rather than
 * permanent.
 */
export default function UpdateWatcher() {
  const t = useT()
  const [release, setRelease] = useState<ReleaseInfo | null>(null)
  const [updatedTo, setUpdatedTo] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let current: string
      try {
        current = await appVersion()
      } catch {
        return
      }
      if (cancelled) return

      // Did the update started last session actually land? The marker on its
      // own proves nothing - an installer the user cancelled leaves it behind -
      // so the running version has to agree before anything is announced.
      const pending = takePendingUpdate()
      if (pending && compareVersions(current, pending) >= 0) setUpdatedTo(pending)

      try {
        const releases = await listReleases()
        if (cancelled) return
        const skipped = new Set(skippedVersions())
        const candidate = newerThan(releases, current).find(
          (r) => r.assetUrl !== null && !skipped.has(r.version),
        )
        if (candidate) setRelease(candidate)
      } catch {
        // offline, rate limited, or GitHub is down - none of it worth a dialog
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!release && !updatedTo) return null

  return (
    <>
      {release ? <UpdateDialog release={release} onDismiss={() => setRelease(null)} /> : null}
      {updatedTo ? (
        <Modal open title={t('Update installed')} onClose={() => setUpdatedTo(null)}>
          <div className="settings-line">{`${t('Tempo updated successfully. Now running version')} ${updatedTo}.`}</div>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => setUpdatedTo(null)}>
              {t('Close dialog')}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  )
}

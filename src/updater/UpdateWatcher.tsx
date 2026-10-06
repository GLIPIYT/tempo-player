import { useEffect, useState } from 'react'
import UpdateDialog from './UpdateDialog'
import {
  appVersion,
  listReleases,
  skippedVersions,
  takePendingUpdate,
  type ReleaseInfo,
} from './service'
import { compareVersions, newerThan } from './version'

interface UpdateDialogState {
  releases: ReleaseInfo[]
  initialVersion: string
  installedVersion?: string
}

/** Finds an update once per launch, or opens the same version browser after installation. */
export default function UpdateWatcher() {
  const [dialog, setDialog] = useState<UpdateDialogState | null>(null)

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

      const pending = takePendingUpdate()
      const updateLanded = Boolean(pending && compareVersions(current, pending) >= 0)
      let releases: ReleaseInfo[] = []
      try {
        releases = await listReleases()
      } catch {
        if (updateLanded && !cancelled) {
          setDialog({ releases, initialVersion: current, installedVersion: current })
        }
        return
      }
      if (cancelled) return

      if (updateLanded) {
        setDialog({ releases, initialVersion: current, installedVersion: current })
        return
      }

      const skipped = new Set(skippedVersions())
      const candidate = newerThan(releases, current).find(
        release => release.assetUrl !== null && !skipped.has(release.version),
      )
      if (candidate) setDialog({ releases, initialVersion: candidate.version })
    })()
    return () => { cancelled = true }
  }, [])

  if (!dialog) return null
  return (
    <UpdateDialog
      releases={dialog.releases}
      initialVersion={dialog.initialVersion}
      installedVersion={dialog.installedVersion}
      onDismiss={() => setDialog(null)}
    />
  )
}

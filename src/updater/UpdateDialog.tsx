import { useEffect, useRef, useState } from 'react'
import Modal from '../components/common/Modal'
import { toast } from '../components/common/Toast'
import { useT } from '../i18n'
import {
  downloadUpdate,
  formatBytes,
  installUpdate,
  markPendingUpdate,
  onDownloadProgress,
  skipVersion,
  type ReleaseInfo,
} from './service'

interface Props {
  release: ReleaseInfo
  onDismiss: () => void
}

type Phase = 'offer' | 'downloading' | 'failed'

/**
 * The "a new version is out" dialog.
 *
 * Download and install are one action on purpose: the installer cannot replace
 * a running executable, so the app has to quit for the upgrade to happen, and
 * splitting it into two buttons would only make that a surprise later.
 */
export default function UpdateDialog({ release, onDismiss }: Props) {
  const t = useT()
  const [phase, setPhase] = useState<Phase>('offer')
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const downloadedPath = useRef<string | null>(null)

  const version = release.version

  // a fresh offer starts from scratch
  useEffect(() => {
    setPhase('offer')
    setProgress(null)
    setError(null)
    downloadedPath.current = null
  }, [version])

  // progress arrives from Rust while the download runs
  useEffect(() => {
    if (phase !== 'downloading') return
    let stop: (() => void) | null = null
    let cancelled = false
    void onDownloadProgress((p) => {
      if (cancelled || p.version !== version) return
      setProgress({ downloaded: p.downloaded, total: p.total })
    })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else stop = unlisten
      })
      .catch(() => {})
    return () => {
      cancelled = true
      stop?.()
    }
  }, [phase, version])

  const begin = async () => {
    if (!release.assetUrl) {
      setError(t('This release has no Windows installer attached.'))
      setPhase('failed')
      return
    }
    setError(null)
    setPhase('downloading')
    setProgress({ downloaded: 0, total: release.assetSize ?? 0 })
    try {
      const path = await downloadUpdate(release.assetUrl, version)
      downloadedPath.current = path
      // written before the app goes away, so the next launch can say what happened
      markPendingUpdate(version)
      await installUpdate(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('failed')
    }
  }

  const skip = () => {
    skipVersion(version)
    toast.show(`${t('Skipped update')} ${version}`)
    onDismiss()
  }

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null

  return (
    <Modal open title={`${t('Update available')} — ${version}`} onClose={onDismiss}>
      <div className="update-head">
        <span className="update-version">{release.name || release.tag}</span>
        {release.assetSize ? (
          <span className="muted update-size">{formatBytes(release.assetSize)}</span>
        ) : null}
      </div>

      {release.notes ? (
        <div className="update-notes">{release.notes}</div>
      ) : (
        <div className="muted settings-line">{t('No release notes.')}</div>
      )}

      {phase === 'downloading' ? (
        <>
          <div className="update-progress" role="progressbar" aria-valuenow={percent ?? 0}>
            <div className="update-progress-fill" style={{ width: `${percent ?? 0}%` }} />
          </div>
          <div className="muted settings-line" style={{ marginTop: 6 }}>
            {percent === null
              ? t('Downloading…')
              : `${t('Downloading…')} ${percent}% · ${formatBytes(progress?.downloaded ?? 0)}`}
          </div>
          <div className="set-note">
            {t('Tempo will close and start again to finish installing.')}
          </div>
        </>
      ) : null}

      {phase === 'failed' && error ? <div className="error-line">{error}</div> : null}

      {phase === 'downloading' ? null : (
        <div className="modal-actions">
          <button className="btn" onClick={skip}>
            {t('Skip this version')}
          </button>
          <button className="btn btn-primary" onClick={() => void begin()}>
            {phase === 'failed' ? t('Try again') : t('Download and install')}
          </button>
        </div>
      )}
    </Modal>
  )
}

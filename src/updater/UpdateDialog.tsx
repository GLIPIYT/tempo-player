import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Download, PackageCheck } from 'lucide-react'
import Modal from '../components/common/Modal'
import { toast } from '../components/common/Toast'
import { useT } from '../i18n'
import {
  downloadUpdate,
  discardUpdate,
  formatBytes,
  installUpdate,
  installUpdateWithPendingMarker,
  onDownloadProgress,
  skipVersion,
  type ReleaseInfo,
} from './service'
import { compareVersions } from './version'
import ReleaseNotes from './ReleaseNotes'

interface Props {
  releases: ReleaseInfo[]
  initialVersion: string
  currentVersion?: string
  installedVersion?: string
  onDismiss: () => void
}

type Phase = 'offer' | 'downloading' | 'installing' | 'failed'

const CONFETTI_COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#48bfe3', '#c77dff']

function emptyRelease(version: string): ReleaseInfo {
  return {
    version,
    tag: `v${version}`,
    name: '',
    notes: '',
    publishedAt: '',
    assetName: null,
    assetUrl: null,
    assetSize: null,
  }
}

/** Version menu and changelog shared by manual and automatic update offers. */
export default function UpdateDialog({ releases, initialVersion, currentVersion, installedVersion, onDismiss }: Props) {
  const t = useT()
  const [selectedVersion, setSelectedVersion] = useState(initialVersion)
  const [phase, setPhase] = useState<Phase>('offer')
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const downloadedPath = useRef<string | null>(null)
  const confettiRef = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(false)
  const progressUnlisten = useRef<(() => void) | null>(null)
  const installerLaunchAttempted = useRef(false)
  const operationRunning = useRef(false)

  const installableReleases = [...new Map(releases
    .filter(release => release.assetUrl !== null)
    .map(release => [release.version, release])).values()]
    .sort((a, b) => compareVersions(b.version, a.version))
  const latestRelease = [...releases].sort((a, b) => compareVersions(b.version, a.version))[0]
  const latestVersion = latestRelease?.version ?? null
  const versionChoices = [...installableReleases]
  if (latestRelease && latestRelease.assetUrl === null && !versionChoices.some(release => release.version === latestRelease.version)) {
    versionChoices.push(latestRelease)
  }
  const installedVersions = [...new Set([currentVersion, installedVersion].filter((version): version is string => Boolean(version)))]
  for (const version of installedVersions) {
    if (!versionChoices.some(release => release.version === version)) {
      versionChoices.push(releases.find(release => release.version === version) ?? emptyRelease(version))
    }
  }
  versionChoices.sort((a, b) => compareVersions(b.version, a.version))
  const release = versionChoices.find(item => item.version === selectedVersion)
    ?? releases.find(item => item.version === selectedVersion)
    ?? emptyRelease(selectedVersion)
  const isInstalled = installedVersion === release.version
  const isCurrent = currentVersion === release.version || isInstalled
  const busy = phase === 'downloading' || phase === 'installing'
  const percent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : null

  useEffect(() => {
    setSelectedVersion(initialVersion)
  }, [initialVersion])

  // Selecting a different version starts its controls from a clean state.
  useEffect(() => {
    setPhase('offer')
    setProgress(null)
    setError(null)
  }, [selectedVersion])

  useEffect(() => {
    if (!installedVersion) return
    const timer = window.setTimeout(() => {
      confettiRef.current?.classList.add('is-active')
    }, 30)
    return () => window.clearTimeout(timer)
  }, [installedVersion])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      progressUnlisten.current?.()
      progressUnlisten.current = null
      const path = downloadedPath.current
      downloadedPath.current = null
      if (path && !installerLaunchAttempted.current) {
        void discardUpdate(path).catch(() => {})
      }
    }
  }, [])

  const discardDownloadedInstaller = () => {
    const path = downloadedPath.current
    downloadedPath.current = null
    if (path && !installerLaunchAttempted.current) {
      void discardUpdate(path).catch(() => {})
    }
  }

  const selectVersion = (version: string) => {
    if (busy || version === selectedVersion) return
    discardDownloadedInstaller()
    setSelectedVersion(version)
  }

  const begin = async () => {
    if (operationRunning.current || busy || !release.assetUrl) return
    operationRunning.current = true
    setError(null)
    let stop: (() => void) | null = null
    let path = downloadedPath.current
    try {
      if (!path) {
        setProgress({ downloaded: 0, total: release.assetSize ?? 0 })
        // Lock closing and version selection before async listener setup begins.
        setPhase('downloading')
        stop = await onDownloadProgress((p) => {
          if (!mounted.current || p.version !== release.version) return
          setProgress({ downloaded: p.downloaded, total: p.total })
        })
        progressUnlisten.current = stop
        if (!mounted.current) return
        path = await downloadUpdate(release.assetUrl, release.version)
        downloadedPath.current = path
        if (!mounted.current) {
          downloadedPath.current = null
          await discardUpdate(path).catch(() => {})
          return
        }
      }

      if (!path) throw new Error(t('This release has no Windows installer attached.'))
      const installerPath = path
      setPhase('installing')
      installerLaunchAttempted.current = true
      await installUpdateWithPendingMarker(release.version, () => installUpdate(installerPath))
    } catch (cause) {
      if (mounted.current) {
        installerLaunchAttempted.current = false
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase('failed')
      }
    } finally {
      if (stop && progressUnlisten.current === stop) {
        progressUnlisten.current = null
        stop()
      }
      operationRunning.current = false
    }
  }

  const skip = () => {
    if (busy || isCurrent || !release.assetUrl) return
    skipVersion(release.version)
    toast.show(`${t('Skipped update')} ${release.version}`)
    dismiss()
  }

  const dismiss = () => {
    if (busy) return
    discardDownloadedInstaller()
    onDismiss()
  }

  const title = isInstalled ? t('Update installed') : t('Updates')

  return (
    <Modal open className="update-modal" title={`${title} — ${release.version}`} onClose={dismiss} closeDisabled={busy}>
      {installedVersion ? (
        <div className="update-confetti" ref={confettiRef} aria-hidden="true">
          {Array.from({ length: 18 }, (_, index) => (
            <i
              key={index}
              style={{
                '--confetti-x': `${(index * 37 + 11) % 100}%`,
                '--confetti-delay': `${(index % 7) * 45}ms`,
                '--confetti-color': CONFETTI_COLORS[index % CONFETTI_COLORS.length],
              } as CSSProperties}
            />
          ))}
        </div>
      ) : null}
      <div className="update-dialog-layout">
        <aside className="update-version-picker" aria-label={t('Available versions')}>
          <div className="update-version-picker-heading">{t('Available versions')}</div>
          <div className="update-version-picker-list">
            {versionChoices.map(item => {
              const selected = item.version === release.version
              const current = currentVersion === item.version || installedVersion === item.version
              const latest = latestVersion === item.version
              const unavailable = item.assetUrl === null && !current
              return (
                <button
                  type="button"
                  key={item.version}
                  className={`update-version-choice${selected ? ' is-selected' : ''}${latest ? ' is-latest' : ''}${current ? ' is-installed' : ''}`}
                  aria-pressed={selected}
                  disabled={unavailable || busy}
                  onClick={() => selectVersion(item.version)}
                >
                  <span className="update-version-choice-main">
                    <strong>{item.version}</strong>
                    {latest ? <span className="update-version-badge is-latest">{t('Latest')}</span> : null}
                    {current ? <span className="update-version-badge">{t('Installed')}</span> : null}
                  </span>
                  <span className="update-version-choice-name">{item.name || item.tag}</span>
                </button>
              )
            })}
            {versionChoices.length === 0 ? <div className="muted update-version-empty">{t('No installable versions.')}</div> : null}
          </div>
        </aside>

        <section className="update-release-panel" aria-label={t('Release notes')}>
          <div className="update-summary">
            <div className="update-head">
              <span className="update-version">{release.name || release.tag}</span>
              {release.assetSize ? <span className="muted update-size">{formatBytes(release.assetSize)}</span> : null}
              {isInstalled ? (
                <span className="update-installed-message">
                  <PackageCheck size={15} />
                  {`${t('Tempo updated successfully. Now running version')} ${release.version}.`}
                </span>
              ) : null}
            </div>
            {!isCurrent && !release.assetUrl ? (
              <div className="error-line update-error">{t('This release has no Windows installer attached.')}</div>
            ) : null}
            {phase === 'downloading' ? (
              <div className="update-download-state">
                <div className="update-progress" role="progressbar" aria-valuenow={percent ?? 0}>
                  <div className="update-progress-fill" style={{ width: `${percent ?? 0}%` }} />
                </div>
                <div className="muted settings-line" style={{ marginTop: 6 }}>
                  {percent === null ? t('Downloading…') : `${t('Downloading…')} ${percent}% · ${formatBytes(progress?.downloaded ?? 0)}`}
                </div>
                <div className="set-note">{t('Tempo will close and start again to finish installing.')}</div>
              </div>
            ) : null}
            {phase === 'installing' ? (
              <div className="update-download-state" role="status">
                <div className="muted settings-line"><PackageCheck size={15} /> {t('Starting installer…')}</div>
                <div className="set-note">{t('Tempo will close and start again to finish installing.')}</div>
              </div>
            ) : null}
            {phase === 'failed' && error ? <div className="error-line update-error">{error}</div> : null}
          </div>

          <section className="update-release-notes">
            <div className="update-notes-heading">{t('Release notes')}</div>
            {release.notes ? (
              <div className="update-notes"><ReleaseNotes markdown={release.notes} /></div>
            ) : (
              <div className="muted settings-line">{t('No release notes.')}</div>
            )}
          </section>
        </section>

        {!busy ? (
          <div className="modal-actions update-dialog-actions">
            {isCurrent || !release.assetUrl ? (
              <button className="btn btn-primary" onClick={dismiss}>{t('Close')}</button>
            ) : (
              <>
                <button className="btn" onClick={skip}>{t('Skip this version')}</button>
                <button className="btn btn-primary" onClick={() => void begin()}>
                  {phase === 'failed' ? t('Try again') : <><Download size={14} /> {t('Download and install')}</>}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

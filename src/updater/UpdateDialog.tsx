import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Download, PackageCheck } from 'lucide-react'
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
import { compareVersions } from './version'
import ReleaseNotes from './ReleaseNotes'

interface Props {
  releases: ReleaseInfo[]
  initialVersion: string
  installedVersion?: string
  onDismiss: () => void
  preview?: boolean
}

type Phase = 'offer' | 'downloading' | 'failed'

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

/** Version picker and changelog for both an available update and an installed release. */
export default function UpdateDialog({ releases, initialVersion, installedVersion, onDismiss, preview = false }: Props) {
  const t = useT()
  const [selectedVersion, setSelectedVersion] = useState(initialVersion)
  const [phase, setPhase] = useState<Phase>('offer')
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const downloadedPath = useRef<string | null>(null)
  const confettiRef = useRef<HTMLDivElement | null>(null)

  const installableReleases = [...new Map(releases
    .filter(release => release.assetUrl !== null)
    .map(release => [release.version, release])).values()]
    .sort((a, b) => compareVersions(b.version, a.version))
  const latestVersion = installableReleases[0]?.version ?? null
  const versionChoices = [...installableReleases]
  if (installedVersion && !versionChoices.some(release => release.version === installedVersion)) {
    versionChoices.push(releases.find(release => release.version === installedVersion) ?? emptyRelease(installedVersion))
    versionChoices.sort((a, b) => compareVersions(b.version, a.version))
  }
  const release = versionChoices.find(item => item.version === selectedVersion)
    ?? releases.find(item => item.version === selectedVersion)
    ?? emptyRelease(selectedVersion)
  const isInstalled = installedVersion === release.version
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
    downloadedPath.current = null
  }, [selectedVersion])

  useEffect(() => {
    if (!installedVersion || preview) return
    const timer = window.setTimeout(() => {
      confettiRef.current?.classList.add('is-active')
    }, 30)
    return () => window.clearTimeout(timer)
  }, [installedVersion, preview])

  useEffect(() => {
    if (phase !== 'downloading') return
    let stop: (() => void) | null = null
    let cancelled = false
    void onDownloadProgress((p) => {
      if (cancelled || p.version !== release.version) return
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
  }, [phase, release.version])

  const begin = async () => {
    if (preview) return
    if (!release.assetUrl) {
      setError(t('This release has no Windows installer attached.'))
      setPhase('failed')
      return
    }
    setError(null)
    setPhase('downloading')
    setProgress({ downloaded: 0, total: release.assetSize ?? 0 })
    try {
      const path = await downloadUpdate(release.assetUrl, release.version)
      downloadedPath.current = path
      markPendingUpdate(release.version)
      await installUpdate(path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setPhase('failed')
    }
  }

  const skip = () => {
    if (preview || isInstalled) return
    skipVersion(release.version)
    toast.show(`${t('Skipped update')} ${release.version}`)
    onDismiss()
  }

  const title = isInstalled ? t('Update installed') : t('Update available')

  return (
    <Modal open className="update-modal" title={`${title} — ${release.version}`} onClose={onDismiss}>
      {installedVersion && !preview ? (
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
              const current = installedVersion === item.version
              const latest = latestVersion === item.version
              const unavailable = item.assetUrl === null && !current
              return (
                <button
                  type="button"
                  key={item.version}
                  className={`update-version-choice${selected ? ' is-selected' : ''}${latest ? ' is-latest' : ''}${current ? ' is-installed' : ''}`}
                  aria-pressed={selected}
                  disabled={unavailable || phase === 'downloading'}
                  onClick={() => setSelectedVersion(item.version)}
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
              {preview ? <span className="update-preview-badge">{t('Preview only')}</span> : null}
              {release.assetSize ? <span className="muted update-size">{formatBytes(release.assetSize)}</span> : null}
              {isInstalled ? (
                <span className="update-installed-message">
                  <PackageCheck size={15} />
                  {`${t('Tempo updated successfully. Now running version')} ${release.version}.`}
                </span>
              ) : null}
            </div>
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

        {phase !== 'downloading' ? (
          <div className="modal-actions update-dialog-actions">
            {preview || isInstalled ? (
              <button className="btn btn-primary" onClick={onDismiss}>{t('Close')}</button>
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

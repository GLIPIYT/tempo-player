import { DevProfile } from '../dev-performance/DevProfile'
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Download, Filter, PackageCheck } from 'lucide-react'
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
import { releaseType, RELEASE_TYPE_LABELS, type ReleaseType } from './releaseType'
import { filterReleasesByType, type ReleaseTypeFilter } from './releaseFilter'
import './releaseFilter.css'
import ReleaseTypeBadge from './ReleaseTypeBadge'

interface Props {
  releases: ReleaseInfo[]
  initialVersion: string
  currentVersion?: string
  installedVersion?: string
  onDismiss: () => void
}

type Phase = 'offer' | 'downloading' | 'installing' | 'failed'

const CONFETTI_COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#48bfe3', '#c77dff']

const ConfettiBurst = memo(function ConfettiBurst({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!active || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const start = window.setTimeout(() => setVisible(true), 30)
    const stop = window.setTimeout(() => setVisible(false), 4730)
    return () => {
      window.clearTimeout(start)
      window.clearTimeout(stop)
    }
  }, [active])

  if (!visible) return null
  return (
    <div className="update-confetti is-active" aria-hidden="true">
      {Array.from({ length: 80 }, (_, index) => (
        <i
          key={index}
          style={{
            '--confetti-x': `${(index * 37 + 11) % 100}%`,
            '--confetti-delay': `${(index % 13) * 65}ms`,
            '--confetti-duration': `${2400 + index % 7 * 180}ms`,
            '--confetti-drift': `${(index * 23 % 150) - 75}px`,
            '--confetti-turn': `${index % 2 ? -840 : 720}deg`,
            width: `${5 + index % 5}px`, height: `${8 + index % 7}px`,
            '--confetti-color': CONFETTI_COLORS[index % CONFETTI_COLORS.length],
          } as CSSProperties}
        />
      ))}
    </div>
  )
})

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
function UpdateDialogContent({ releases, initialVersion, currentVersion, installedVersion, onDismiss }: Props) {
  const t = useT()
  const [selectedVersion, setSelectedVersion] = useState(initialVersion)
  const [typeFilter, setTypeFilter] = useState<ReleaseTypeFilter>('all')
  const [phase, setPhase] = useState<Phase>('offer')
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const downloadedToken = useRef<string | null>(null)
  const mounted = useRef(false)
  const progressUnlisten = useRef<(() => void) | null>(null)
  const installerLaunchAttempted = useRef(false)
  const operationRunning = useRef(false)

  const installableReleases = useMemo(() => [...new Map(releases
    .filter(release => release.assetUrl !== null)
    .map(release => [release.version, release])).values()]
    .sort((a, b) => compareVersions(b.version, a.version)), [releases])
  const latestRelease = useMemo(() => [...releases].sort((a, b) => compareVersions(b.version, a.version))[0], [releases])
  const latestVersion = latestRelease?.version ?? null
  const installedVersions = useMemo(() => new Set([currentVersion, installedVersion]
    .filter((version): version is string => Boolean(version))), [currentVersion, installedVersion])
  const versionChoices = useMemo(() => {
    const choices = [...installableReleases]
    if (latestRelease && latestRelease.assetUrl === null && !choices.some(release => release.version === latestRelease.version)) {
      choices.push(latestRelease)
    }
    for (const version of installedVersions) {
      if (!choices.some(release => release.version === version)) {
        choices.push(releases.find(release => release.version === version) ?? emptyRelease(version))
      }
    }
    return choices.sort((a, b) => compareVersions(b.version, a.version))
  }, [installableReleases, latestRelease, installedVersions, releases])
  const filteredChoices = useMemo(() => filterReleasesByType(versionChoices, releases, typeFilter), [versionChoices, releases, typeFilter])
  const hasVisibleSelection = filteredChoices.some(item => item.version === selectedVersion)
  const release = useMemo(() => versionChoices.find(item => item.version === selectedVersion)
    ?? releases.find(item => item.version === selectedVersion)
    ?? emptyRelease(selectedVersion), [versionChoices, releases, selectedVersion])
  const isInstalled = installedVersion === release.version
  const selectedType = useMemo(() => releaseType(release, releases), [release, releases])
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
    mounted.current = true
    return () => {
      mounted.current = false
      progressUnlisten.current?.()
      progressUnlisten.current = null
      const token = downloadedToken.current
      downloadedToken.current = null
      if (token && !installerLaunchAttempted.current) {
        void discardUpdate(token).catch(() => {})
      }
    }
  }, [])

  const discardDownloadedInstaller = () => {
    const token = downloadedToken.current
    downloadedToken.current = null
    if (token && !installerLaunchAttempted.current) {
      void discardUpdate(token).catch(() => {})
    }
  }

  const selectVersion = (version: string) => {
    if (busy || version === selectedVersion) return
    discardDownloadedInstaller()
    setSelectedVersion(version)
  }

  const changeFilter = (filter: ReleaseTypeFilter) => {
    if (busy) return
    const nextChoices = filterReleasesByType(versionChoices, releases, filter)
    if (nextChoices.length && !nextChoices.some(item => item.version === selectedVersion)) {
      selectVersion((nextChoices.find(item => item.assetUrl || installedVersions.has(item.version)) ?? nextChoices[0]).version)
    }
    setTypeFilter(filter)
  }

  const begin = async () => {
    if (operationRunning.current || busy || !release.assetUrl) return
    operationRunning.current = true
    setError(null)
    let stop: (() => void) | null = null
    let token = downloadedToken.current
    try {
      if (!token) {
        setProgress({ downloaded: 0, total: release.assetSize ?? 0 })
        // Lock closing and version selection before async listener setup begins.
        setPhase('downloading')
        stop = await onDownloadProgress((p) => {
          if (!mounted.current || p.version !== release.version) return
          setProgress({ downloaded: p.downloaded, total: p.total })
        })
        progressUnlisten.current = stop
        if (!mounted.current) return
        token = await downloadUpdate(release.version)
        downloadedToken.current = token
        if (!mounted.current) {
          downloadedToken.current = null
          await discardUpdate(token).catch(() => {})
          return
        }
      }

      if (!token) throw new Error(t('This release has no Windows installer attached.'))
      const installerToken = token
      setPhase('installing')
      installerLaunchAttempted.current = true
      await installUpdateWithPendingMarker(release.version, () => installUpdate(installerToken))
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

  const title = hasVisibleSelection && isInstalled ? t('Update installed') : t('Updates')

  return (
    <Modal open className="update-modal" title={hasVisibleSelection ? `${title} — ${release.version}` : title} onClose={dismiss} closeDisabled={busy}>
      <ConfettiBurst key={installedVersion ?? 'no-installed-update'} active={Boolean(installedVersion)} />
      <div className="update-dialog-layout">
        <aside className="update-version-picker" aria-label={t('Available versions')}>
          <div className="update-version-picker-heading">{t('Available versions')}</div>
          <div className="update-version-filter">
            <Filter size={14} aria-hidden="true" />
            <select aria-label={t('Filter release type')} value={typeFilter} disabled={busy} onChange={event => changeFilter(event.target.value as ReleaseTypeFilter)}>
              <option value="all">{t('No filter')}</option>
              {(Object.keys(RELEASE_TYPE_LABELS) as ReleaseType[]).map(type => (
                <option key={type} value={type}>{t(RELEASE_TYPE_LABELS[type])}</option>
              ))}
            </select>
          </div>
          <div className="update-version-picker-list">
            {filteredChoices.map(item => {
              const selected = item.version === release.version
              const current = currentVersion === item.version || installedVersion === item.version
              const latest = latestVersion === item.version
              const unavailable = item.assetUrl === null && !current
              const kind = releaseType(item, releases)
              return (
                <button
                  type="button"
                  key={item.version}
                  className={`update-version-choice${selected ? ' is-selected' : ''}${latest ? ' is-latest' : ''}${current ? ' is-installed' : ''}${kind === 'major' ? ' is-major-release' : ''}`}
                  aria-pressed={selected}
                  disabled={unavailable || busy}
                  onClick={() => selectVersion(item.version)}
                >
                  <span className="update-version-choice-main">
                    <strong>{item.version}</strong>
                    {kind && <ReleaseTypeBadge type={kind} />}
                    {latest ? <span className="update-version-badge is-latest">{t('Latest')}</span> : null}
                    {current ? <span className="update-version-badge">{t('Installed')}</span> : null}
                  </span>
                  <span className="update-version-choice-name">{item.name || item.tag}</span>
                </button>
              )
            })}
            {filteredChoices.length === 0 ? (
              <div className="muted update-version-empty">
                {typeFilter === 'all' ? t('No installable versions.') : t('No versions match this filter.')}
                {typeFilter !== 'all' && <button type="button" onClick={() => changeFilter('all')}>{t('Clear filter')}</button>}
              </div>
            ) : null}
          </div>
        </aside>

        {hasVisibleSelection ? <section className="update-release-panel" aria-label={t('Release notes')}>
          <div className="update-summary">
            <div className="update-head">
              <div className="update-version-heading">
                <span className={`update-version${selectedType === 'major' ? ' is-major-release' : ''}`}>{release.name || release.tag}</span>
                {selectedType && <ReleaseTypeBadge type={selectedType} />}
              </div>
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
        </section> : <div className="muted update-release-empty" /> }

        {!busy ? (
          <div className="modal-actions update-dialog-actions">
            {!hasVisibleSelection || isCurrent || !release.assetUrl ? (
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

export default function UpdateDialog(props: Props) {
  return <DevProfile id="updates"><UpdateDialogContent {...props} /></DevProfile>
}

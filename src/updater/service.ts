import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getVersion } from '@tauri-apps/api/app'

/**
 * Update checking, backed by the project's GitHub releases.
 *
 * The download and the install happen in Rust; this only decides what to offer
 * and remembers what the user said.
 */

export interface ReleaseInfo {
  version: string
  tag: string
  name: string
  /** The release body, shown as the changelog. */
  notes: string
  publishedAt: string
  assetName: string | null
  assetUrl: string | null
  assetSize: number | null
}

export interface DownloadProgress {
  version: string
  downloaded: number
  total: number
}

export const UPDATE_PROGRESS_EVENT = 'updater://progress'

const SKIPPED_KEY = 'tempo.skippedVersions.v1'
const PENDING_KEY = 'tempo.pendingUpdate.v1'

/** Every published release, newest first. */
export function listReleases(): Promise<ReleaseInfo[]> {
  return invoke<ReleaseInfo[]>('updater_releases')
}

/** The version this build actually is, straight from the bundle. */
export function appVersion(): Promise<string> {
  return getVersion()
}

/**
 * Versions the user asked not to be offered again.
 *
 * Per version rather than permanent: skipping 0.6.0 says nothing about 0.6.1,
 * which is the whole point - a later release has to be able to reach them.
 */
export function skippedVersions(): string[] {
  try {
    const raw = localStorage.getItem(SKIPPED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function skipVersion(version: string): void {
  const next = [...new Set([...skippedVersions(), version])]
  try {
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(next))
  } catch {
    /* storage full or unavailable */
  }
}

export function forgetSkippedVersions(): void {
  try {
    localStorage.removeItem(SKIPPED_KEY)
  } catch {
    /* nothing to do */
  }
}

/**
 * Records what we are about to install.
 *
 * The webview's storage survives an upgrade - the installer only replaces the
 * program files - so the next launch can read this back and say "you are now on
 * 0.6.0" exactly once.
 */
export function markPendingUpdate(version: string): void {
  try {
    localStorage.setItem(PENDING_KEY, version)
  } catch {
    /* storage full or unavailable */
  }
}

/** Reads and clears the marker, so the notice can only be shown once. */
export function takePendingUpdate(): string | null {
  try {
    const value = localStorage.getItem(PENDING_KEY)
    if (value) localStorage.removeItem(PENDING_KEY)
    return value
  } catch {
    return null
  }
}

export function downloadUpdate(url: string, version: string): Promise<string> {
  return invoke<string>('updater_download', { url, version })
}

/** Starts the installer and quits - it cannot replace a running executable. */
export function installUpdate(path: string): Promise<void> {
  return invoke<void>('updater_install', { path })
}

export function discardUpdate(path: string): Promise<void> {
  return invoke<void>('updater_discard', { path })
}

export function onDownloadProgress(handler: (progress: DownloadProgress) => void): Promise<UnlistenFn> {
  return listen<DownloadProgress>(UPDATE_PROGRESS_EVENT, (event) => handler(event.payload))
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const mb = bytes / 1048576
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`
}

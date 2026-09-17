import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { api } from '../api/client'
import type { ScPlaylist, ScTrack } from '../types/models'

/**
 * Playlist caching, as a job the UI can watch.
 *
 * The download happens in Rust and reports through events rather than returning
 * a result, because it can take minutes and has to survive the user navigating
 * away. This side only keeps the list of jobs and what the user asked for.
 */

export interface CacheJob {
  id: string
  label: string
  done: number
  total: number
  failed: number
  state: 'running' | 'done' | 'cancelled'
}

export const CACHE_PROGRESS_EVENT = 'sc-cache://progress'

interface ProgressPayload {
  jobId: string
  label: string
  done: number
  total: number
  failed: number
  state: CacheJob['state']
}

/** How long a finished job stays on screen so the ring can be seen filling. */
const LINGER_MS = 4000

let jobs: CacheJob[] = []
const listeners = new Set<() => void>()
let starting = false

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeCacheJobs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getCacheJobs(): CacheJob[] {
  return jobs
}

/** Starts listening for progress. Safe to call more than once. */
export async function initCacheJobs(): Promise<void> {
  if (starting) return
  starting = true
  try {
    // Never unlistened: the listener lives as long as the window, which is
    // exactly as long as jobs can be running.
    await listen<ProgressPayload>(CACHE_PROGRESS_EVENT, (event) => {
      const p = event.payload
      const next: CacheJob = {
        id: p.jobId,
        label: p.label,
        done: p.done,
        total: p.total,
        failed: p.failed,
        state: p.state,
      }
      const known = jobs.some((job) => job.id === p.jobId)
      jobs = known ? jobs.map((job) => (job.id === p.jobId ? next : job)) : [...jobs, next]
      emit()
      if (p.state !== 'running') {
        window.setTimeout(() => dismissCacheJob(p.jobId), LINGER_MS)
      }
    })
  } catch {
    starting = false
  }
}

export function dismissCacheJob(id: string): void {
  if (!jobs.some((job) => job.id === id)) return
  jobs = jobs.filter((job) => job.id !== id)
  emit()
}

export function cancelCacheJob(id: string): void {
  void invoke('sc_cache_cancel', { jobId: id }).catch(() => {})
}

export interface PlaylistCachePlan {
  tracks: ScTrack[]
  /** A local playlist already carrying this name, if there is one. */
  existing: { id: number; name: string } | null
}

/** A cache request waiting on the "that name is taken" answer. */
export interface PendingCacheChoice {
  playlist: ScPlaylist
  tracks: ScTrack[]
  existing: { id: number; name: string }
}

let pendingChoice: PendingCacheChoice | null = null
const choiceListeners = new Set<() => void>()

function emitChoice(): void {
  for (const listener of choiceListeners) listener()
}

export function subscribeCacheChoice(listener: () => void): () => void {
  choiceListeners.add(listener)
  return () => {
    choiceListeners.delete(listener)
  }
}

export function getCacheChoice(): PendingCacheChoice | null {
  return pendingChoice
}

export function dismissCacheChoice(): void {
  if (!pendingChoice) return
  pendingChoice = null
  emitChoice()
}

/**
 * Fetches what is needed to cache a playlist, and checks whether the name is
 * already taken.
 *
 * Deliberately does not decide: a name clash is the user's call, so the caller
 * shows the choice and then calls `runPlaylistCache` with the answer.
 */
export async function planPlaylistCache(playlist: ScPlaylist): Promise<PlaylistCachePlan> {
  const [detail, local] = await Promise.all([api.scGetPlaylist(playlist.id), api.listPlaylists()])
  const wanted = playlist.title.trim().toLowerCase()
  const clash = local.find((pl) => pl.name.trim().toLowerCase() === wanted) ?? null
  return {
    // Only tracks that can actually be downloaded are worth counting: an HLS
    // stream never lands in the cache, and including it would leave the ring
    // permanently short of 100%.
    tracks: detail.tracks.filter((trk) => trk.streamable && trk.hasProgressive),
    existing: clash ? { id: clash.id, name: clash.name } : null,
  }
}

export type CacheRequestOutcome = 'started' | 'asked' | 'empty'

/**
 * The one way to start caching a playlist, from wherever it was triggered.
 *
 * Kept in the store rather than in a page so the right-click menu and the page
 * button cannot drift apart - and so the name question has somewhere to live
 * that outlives whichever screen asked it.
 */
export async function requestPlaylistCache(playlist: ScPlaylist): Promise<CacheRequestOutcome> {
  const plan = await planPlaylistCache(playlist)
  if (plan.tracks.length === 0) return 'empty'
  if (plan.existing) {
    pendingChoice = { playlist, tracks: plan.tracks, existing: plan.existing }
    emitChoice()
    return 'asked'
  }
  await runPlaylistCache(playlist, plan.tracks, 'new')
  return 'started'
}

/** Answers the pending question and starts the download. */
export async function resolveCacheChoice(into: 'new' | number): Promise<void> {
  const choice = pendingChoice
  if (!choice) return
  pendingChoice = null
  emitChoice()
  await runPlaylistCache(choice.playlist, choice.tracks, into)
}

/**
 * Imports the playlist and starts downloading it.
 *
 * `into` is either `'new'` or the id of the local playlist to append to.
 */
export async function runPlaylistCache(
  playlist: ScPlaylist,
  tracks: ScTrack[],
  into: 'new' | number,
): Promise<number> {
  const playlistId = await invoke<number>('sc_import_playlist', {
    name: playlist.title,
    tracks,
    playlistId: into === 'new' ? null : into,
  })

  const jobId = `playlist:${playlist.id}`
  jobs = [
    ...jobs.filter((job) => job.id !== jobId),
    {
      id: jobId,
      label: playlist.title,
      done: 0,
      total: tracks.length,
      failed: 0,
      state: 'running',
    },
  ]
  emit()

  // Not awaited: the download reports through events, and holding the IPC call
  // open for minutes would just be a promise nobody is waiting on.
  void invoke('sc_cache_tracks', {
    jobId,
    label: playlist.title,
    trackIds: tracks.map((trk) => trk.id),
  }).catch(() => {
    // the job never started, so there is nothing to show progress for
    dismissCacheJob(jobId)
  })
  return playlistId
}

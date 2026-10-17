import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { api } from '../api/client'
import { toast } from '../components/common/Toast'
import { withExplicitFeedback } from '../features/recommendations/feedbackBridge'
import { resolveLang } from '../i18n'
import { getSettings } from '../state/settings'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import type { ScArtist, ScPlaylist, ScTrack, Track, UnifiedTrack } from '../types/models'
import { getKnownSoundCloudTrack, rememberSoundCloudTrack } from './cacheMetadata'

/**
 * Caching, as a job the UI can watch.
 *
 * The download happens in Rust and reports through events rather than returning
 * a result, because it can take minutes and has to survive the user navigating
 * away. This side keeps the list of jobs, what the user asked for, and the
 * questions that need answering along the way.
 */

export type CacheKind = 'playlist' | 'artist' | 'track'

export interface CacheJob {
  /** `${kind}:${SoundCloud id}` - stable from the moment it is requested. */
  id: string
  kind: CacheKind
  /** The library row it created, once there is one. */
  localId: number | null
  /**
   * Whether this job is what put that row there. Cancelling a job that created
   * its playlist takes the playlist away again; cancelling one that appended to
   * an existing playlist must not.
   */
  created: boolean
  label: string
  done: number
  total: number
  failed: number
  state: 'running' | 'done' | 'cancelled' | 'failed'
  /** Set when the cache command itself could not be started. */
  error?: string
  /** Unique for each run, even when the same SoundCloud item is cached again. */
  generation: number
  /** The completed toast is fading out and is waiting for its removal timer. */
  exiting: boolean
}

export interface TrackCacheProgress {
  trackId: string
  downloadedBytes: number
  totalBytes: number
  /** Coverage fraction for browser recordings; byte fields remain downloads only. */
  progress?: number
  state: 'running' | 'done' | 'failed'
  error?: string
  exiting: boolean
}

/** Track metadata needed for a cache request; provider flags may be absent. */
export type CacheTrackInput = Pick<ScTrack, 'id' | 'title' | 'artist' | 'durationMs'> &
  Partial<Omit<ScTrack, 'id' | 'title' | 'artist' | 'durationMs'>>

interface CacheJobRequest {
  kind: CacheKind
  scId: string
  localId: number | null
  label: string
  trackIds: string[]
  created: boolean
}

export const CACHE_PROGRESS_EVENT = 'sc-cache://progress'
export const CACHE_TRACK_PROGRESS_EVENT = 'sc-cache://track-progress'

interface ProgressPayload {
  jobId: string
  label: string
  done: number
  total: number
  failed: number
  state: CacheJob['state']
  error?: string
}

interface TrackProgressPayload {
  trackId: string
  downloadedBytes: number
  totalBytes: number
  progress?: number
  state: TrackCacheProgress['state']
  error?: string
}

/** How long a finished job stays on screen so the ring can be seen closing. */
const LINGER_MS = 4000
/** Keep in sync with the toast's CSS exit transition. */
const EXIT_MS = 240

/** Above this many tracks, an artist cache asks which ones to keep. */
export const ARTIST_PICKER_THRESHOLD = 15

let jobs: CacheJob[] = []
const listeners = new Set<() => void>()
let initialization: Promise<void> | null = null
let nextGeneration = 0
const completionTimers = new Map<string, { generation: number; timer: number }>()
const trackProgressTimers = new Map<string, number[]>()
let trackProgresses: TrackCacheProgress[] = []
const cacheRequests = new Map<string, CacheJobRequest>()
const trackRequests = new Map<string, Promise<CacheRequestOutcome>>()
const reportedTrackFailures = new Set<string>()

function cacheRetryLabel(): string {
  return resolveLang(getSettings().lang) === 'ru' ? 'Повторить' : 'Retry'
}

function retryKnownTrackCache(track: ScTrack): void {
  void requestTrackCache(track).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    toast.show(`${track.title}: ${message}`, 'error', 7000, {
      label: cacheRetryLabel(),
      run: () => retryKnownTrackCache(track),
    })
  })
}

function reportTrackCacheFailure(payload: TrackProgressPayload): void {
  const track = getKnownSoundCloudTrack(payload.trackId) ?? {
    id: payload.trackId,
    title: payload.trackId,
    artist: '',
    durationMs: 0,
    artworkUrl: null,
    artistAvatarUrl: null,
    permalinkUrl: null,
    streamable: true,
    hasProgressive: false,
    hasHls: false,
  }
  const language = resolveLang(getSettings().lang)
  const error = payload.error?.trim() || (language === 'ru' ? 'Не удалось сохранить трек' : 'Track cache failed')
  toast.show(`${track.title}: ${error}`, 'error', 8000, {
    label: cacheRetryLabel(),
    run: () => retryKnownTrackCache(track),
  })
}

function clearCompletionTimer(id: string): void {
  const current = completionTimers.get(id)
  if (!current) return
  window.clearTimeout(current.timer)
  completionTimers.delete(id)
}

function scheduleDismiss(job: CacheJob): void {
  const current = completionTimers.get(job.id)
  if (current?.generation === job.generation) return
  clearCompletionTimer(job.id)

  const generation = job.generation
  const timer = window.setTimeout(() => {
    const latest = jobs.find((entry) => entry.id === job.id)
    if (!latest || latest.generation !== generation || latest.state === 'running') {
      if (completionTimers.get(job.id)?.timer === timer) completionTimers.delete(job.id)
      return
    }

    jobs = jobs.map((entry) =>
      entry.id === job.id && entry.generation === generation ? { ...entry, exiting: true } : entry,
    )
    emit()

    const exitTimer = window.setTimeout(() => {
      const currentJob = jobs.find((entry) => entry.id === job.id)
      if (currentJob?.generation === generation && currentJob.exiting) {
        dismissCacheJob(job.id, generation)
      }
      if (completionTimers.get(job.id)?.timer === exitTimer) completionTimers.delete(job.id)
    }, EXIT_MS)
    if (completionTimers.get(job.id)?.timer === timer) {
      completionTimers.set(job.id, { generation, timer: exitTimer })
    }
  }, LINGER_MS)

  completionTimers.set(job.id, { generation, timer })
}

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

export function getTrackCacheProgresses(): TrackCacheProgress[] {
  return trackProgresses
}

function clearTrackProgressTimers(trackId: string): void {
  for (const timer of trackProgressTimers.get(trackId) ?? []) window.clearTimeout(timer)
  trackProgressTimers.delete(trackId)
}

function removeTrackProgress(trackId: string): void {
  trackProgresses = trackProgresses.filter(progress => progress.trackId !== trackId)
  trackProgressTimers.delete(trackId)
  emit()
}

function finishTrackProgress(trackId: string): void {
  const lingerMs = trackProgresses.find(progress => progress.trackId === trackId)?.state === 'failed'
    ? 5000
    : 620
  const lingerTimer = window.setTimeout(() => {
    trackProgresses = trackProgresses.map(progress => progress.trackId === trackId
      ? { ...progress, exiting: true }
      : progress)
    emit()
    const removeTimer = window.setTimeout(() => removeTrackProgress(trackId), EXIT_MS)
    trackProgressTimers.set(trackId, [removeTimer])
  }, lingerMs)
  trackProgressTimers.set(trackId, [lingerTimer])
}

/** Starts listening for progress. Safe to call more than once. */
export function initCacheJobs(): Promise<void> {
  if (initialization) return initialization
  initialization = (async () => {
    const unsubscribers: (() => void)[] = []
    try {
      // Never unlistened: the listeners live as long as the window, which is
      // exactly as long as jobs can be running. Concurrent callers wait until
      // both subscriptions exist before any job can be treated as observable.
      unsubscribers.push(await listen<ProgressPayload>(CACHE_PROGRESS_EVENT, (event) => {
        const p = event.payload
        const known = jobs.find((job) => job.id === p.jobId)
        const next: CacheJob = {
          id: p.jobId,
          kind: known?.kind ?? 'playlist',
          localId: known?.localId ?? null,
          created: known?.created ?? false,
          label: p.label,
          done: p.done,
          total: p.total,
          failed: p.failed,
          state: p.state,
          error: p.error,
          generation: known?.generation ?? ++nextGeneration,
          exiting: known?.exiting ?? false,
        }
        jobs = known ? jobs.map((job) => (job.id === p.jobId ? next : job)) : [...jobs, next]
        emit()

        if (p.state === 'cancelled' && next.kind === 'playlist' && next.created && next.localId !== null) {
          cacheRequests.delete(p.jobId)
          // Cancelling means "I did not want this". The playlist only exists
          // because the job was started, so it goes away with it. Whatever was
          // already downloaded stays in the cache - it will be reused if the
          // playlist is cached again.
          void api
            .deletePlaylist(next.localId)
            .then(() => bumpLibraryVersion())
            .catch(() => undefined)
        }
        if (p.state !== 'running') {
          if (p.state === 'done' && p.failed === 0) cacheRequests.delete(p.jobId)
          scheduleDismiss(next)
        }
      }))
      unsubscribers.push(await listen<TrackProgressPayload>(CACHE_TRACK_PROGRESS_EVENT, (event) => {
        const payload = event.payload
        clearTrackProgressTimers(payload.trackId)
        if (payload.state === 'running' || payload.state === 'done') {
          reportedTrackFailures.delete(payload.trackId)
        } else if (!reportedTrackFailures.has(payload.trackId)) {
          const belongsToVisibleJob = [...cacheRequests.values()]
            .some((request) => request.trackIds.includes(payload.trackId))
          if (!belongsToVisibleJob) {
            reportedTrackFailures.add(payload.trackId)
            if (reportedTrackFailures.size > 500) {
              const oldest = reportedTrackFailures.values().next().value
              if (oldest !== undefined) reportedTrackFailures.delete(oldest)
            }
            reportTrackCacheFailure(payload)
          }
        }
        trackProgresses = [
          ...trackProgresses.filter(progress => progress.trackId !== payload.trackId),
          { ...payload, exiting: false },
        ]
        emit()
        if (payload.state !== 'running') finishTrackProgress(payload.trackId)
      }))
    } catch (error) {
      for (const unsubscribe of unsubscribers) unsubscribe()
      initialization = null
      throw error
    }
  })()
  return initialization
}

export function dismissCacheJob(id: string, generation?: number): void {
  const job = jobs.find((entry) => entry.id === id)
  if (!job || (generation !== undefined && job.generation !== generation)) return
  clearCompletionTimer(id)
  jobs = jobs.filter((job) => job.id !== id)
  emit()
}

export function cancelCacheJob(id: string): void {
  void invoke('sc_cache_cancel', { jobId: id }).catch(() => {})
}

export function canRetryCacheJob(id: string): boolean {
  return cacheRequests.has(id)
}

/** Retries failed or incomplete cache work; already cached files are reused. */
export function retryCacheJob(id: string): void {
  const request = cacheRequests.get(id)
  if (!request) return
  void startJob(request.kind, request.scId, request.localId, request.label, request.trackIds, request.created)
    .catch((error: unknown) => toast.show(error instanceof Error ? error.message : String(error), 'error', 6000))
}

/** Adds a library track and schedules its SoundCloud cache through the shared job path. */
export async function addTrackToPlaylistAndCache(playlistId: number, track: Track): Promise<void> {
  await api.playlistAddTrack(playlistId, track.id)
  bumpLibraryVersion()
  if (track.source !== 'soundcloud') return
  scheduleTrackCacheForSource(track)
}

/**
 * How far along a cache is, for the cover that belongs to it.
 *
 * Matched by the SoundCloud id while the job runs and by the library id after,
 * so a card in the search results and the same playlist in the sidebar both
 * find it. `null` means nothing is being cached.
 */
export function useCacheJob(kind: CacheKind, scId: string | null, localId?: number | null): CacheJob | null {
  const all = useSyncExternalStore(subscribeCacheJobs, getCacheJobs, getCacheJobs)
  return all.find(
    (j) =>
      j.kind === kind &&
      j.state === 'running' &&
      ((scId !== null && j.id === `${kind}:${scId}`) ||
        (localId != null && j.localId === localId)),
  ) ?? null
}

export function useCachePercent(kind: CacheKind, scId: string | null, localId?: number | null): number | null {
  const job = useCacheJob(kind, scId, localId)
  if (!job || job.total === 0) return null
  return Math.min(100, Math.round((job.done / job.total) * 100))
}

/** Explicitly keeps one SoundCloud track and starts the shared cache job. */
export function requestTrackCache(
  input: CacheTrackInput,
  options: { localId?: number } = {},
): Promise<CacheRequestOutcome> {
  const track = normalizeCacheTrack(input)
  if (!cacheEligible(input)) return Promise.resolve('empty')
  rememberSoundCloudTrack(track)
  const inFlight = trackRequests.get(track.id)
  if (inFlight) return inFlight

  const activeJob = jobs.find((job) => job.id === `track:${track.id}` && job.state === 'running')
  if (activeJob || trackProgresses.some((progress) => progress.trackId === track.id && progress.state === 'running')) {
    return Promise.resolve('started')
  }

  const request = requestTrackCacheOnce(track, options)
  trackRequests.set(track.id, request)
  void request.then(
    () => { if (trackRequests.get(track.id) === request) trackRequests.delete(track.id) },
    () => { if (trackRequests.get(track.id) === request) trackRequests.delete(track.id) },
  )
  return request
}

/** Starts the same cache path for an already-imported SoundCloud library row. */
export function requestTrackCacheForSource(track: Track | UnifiedTrack): Promise<CacheRequestOutcome> {
  if (track.source !== 'soundcloud') return Promise.resolve('empty')
  const input: CacheTrackInput = 'sourceId' in track
    ? {
      id: track.sourceId,
      title: track.title,
      artist: track.artists[0] ?? '',
      durationMs: Math.round(Math.max(0, track.durationSec ?? 0) * 1000),
      artworkUrl: /^https?:/.test(track.coverPath ?? '') ? track.coverPath : null,
      artistAvatarUrl: track.artistAvatarUrl ?? null,
      permalinkUrl: track.externalUrl ?? null,
      streamable: track.playable,
    }
    : {
      id: track.externalId ?? '',
      title: track.title,
      artist: track.artistName ?? '',
      durationMs: Math.round(Math.max(0, track.durationSec ?? 0) * 1000),
      artworkUrl: /^https?:/.test(track.coverPath ?? '') ? track.coverPath : null,
      streamable: true,
    }
  if (!input.id) return Promise.resolve('empty')
  const localId = 'dbId' in track ? track.dbId : track.id
  return requestTrackCache(input, localId === null ? {} : { localId })
}

/** Starts a known-source cache request and leaves a retry on metadata failures. */
export function scheduleTrackCacheForSource(track: Track | UnifiedTrack): void {
  void requestTrackCacheForSource(track).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    const language = getSettings().lang
    const retryLabel = language === 'ru' || (language === 'system' && typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('ru'))
      ? 'Повторить'
      : 'Retry'
    toast.show(message, 'error', 6000, {
      label: retryLabel,
      run: () => scheduleTrackCacheForSource(track),
    })
  })
}

async function requestTrackCacheOnce(
  track: ScTrack,
  options: { localId?: number },
): Promise<CacheRequestOutcome> {
  const cachedIds = await api.scGetCachedTrackIds([track.id])
  if (cachedIds.includes(track.id)) {
    // Reattach metadata if the catalog was reset while its complete cache
    // files remained. This command reuses the file without downloading it.
    await api.scPrecache(track, getSettings().ytdlp.path)
    bumpLibraryVersion()
    return 'cached'
  }

  const localId = options.localId ?? await withExplicitFeedback(() => api.scImportTrack(track),
    dbId => ({ trackKey: `soundcloud:${track.id}`, dbId, action: 'cache', intent: 'manual' }))
  bumpLibraryVersion()
  await startJob('track', track.id, localId, track.title, [track.id], false)
  return 'started'
}

/** Cache attempts use the stable SoundCloud ID; transport flags can vary by session. */
function cacheEligible(track: CacheTrackInput): boolean {
  return /^[1-9]\d*$/.test(track.id.trim())
}

function normalizeCacheTrack(track: CacheTrackInput): ScTrack {
  return {
    ...track,
    artworkUrl: track.artworkUrl ?? null,
    artistAvatarUrl: track.artistAvatarUrl ?? null,
    permalinkUrl: track.permalinkUrl ?? null,
    streamable: track.streamable ?? true,
    hasProgressive: track.hasProgressive ?? false,
    hasHls: track.hasHls ?? false,
  }
}

function downloadable(tracks: ScTrack[]): ScTrack[] {
  return tracks.filter(cacheEligible)
}

async function startJob(
  kind: CacheKind,
  scId: string,
  localId: number | null,
  label: string,
  trackIds: string[],
  created: boolean,
): Promise<void> {
  await initCacheJobs()
  const id = `${kind}:${scId}`
  if (jobs.some((job) => job.id === id && job.state === 'running')) return
  clearCompletionTimer(id)
  const generation = ++nextGeneration
  const request: CacheJobRequest = { kind, scId, localId, label, trackIds, created }
  cacheRequests.set(id, request)
  jobs = [
    ...jobs.filter((job) => job.id !== id),
    {
      id,
      kind,
      localId,
      created,
      label,
      done: 0,
      total: trackIds.length,
      failed: 0,
      state: 'running',
      generation,
      exiting: false,
    },
  ]
  emit()
  // The command reports progress through events and resolves after the job.
  // Keep it detached so callers can navigate while the cache continues.
  void invoke<void>('sc_cache_tracks', {
    jobId: id,
    label,
    trackIds,
    ytdlpPath: getSettings().ytdlp.path,
  }).catch((error: unknown) => {
    const current = jobs.find((job) => job.id === id && job.generation === generation)
    if (!current || current.state !== 'running') return
    const message = error instanceof Error ? error.message : String(error)
    jobs = jobs.map((job) => job.id === id && job.generation === generation
      ? { ...job, state: 'failed', failed: Math.max(1, job.failed), error: message }
      : job)
    emit()
    const failed = jobs.find((job) => job.id === id && job.generation === generation)
    if (failed) scheduleDismiss(failed)
  })
}

// ── Playlists ──────────────────────────────────────────────────────────────

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
    tracks: downloadable(detail.tracks),
    existing: clash ? { id: clash.id, name: clash.name } : null,
  }
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
  const playlistId = await withExplicitFeedback(() => invoke<number>('sc_import_playlist', {
    name: playlist.title,
    tracks,
    playlistId: into === 'new' ? null : into,
    manualIntent: true,
  }), playlistId => tracks.flatMap(track => [
    { trackKey: `soundcloud:${track.id}`, playlistId, action: 'playlist-add', intent: 'manual' },
    { trackKey: `soundcloud:${track.id}`, action: 'cache', intent: 'manual' },
  ]))
  // The playlist exists from here on, so the lists that show playlists need to
  // know before the download has finished.
  bumpLibraryVersion()
  await startJob('playlist', playlist.id, playlistId, playlist.title, tracks.map((track) => track.id), into === 'new')
  return playlistId
}

export type CacheRequestOutcome = 'started' | 'cached' | 'asked' | 'empty'

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
 * Adds a playlist to favorites, which also keeps it.
 *
 * A SoundCloud playlist is not a library playlist until it is imported, so
 * favoriting has to bring it in first - which is why the two actions are the
 * same thing here rather than two buttons that mostly do the same work.
 */
export async function favoritePlaylist(playlist: ScPlaylist): Promise<CacheRequestOutcome> {
  const plan = await planPlaylistCache(playlist)
  if (plan.tracks.length === 0) return 'empty'

  let target: number
  if (plan.existing) {
    // already in the library: favoriting it must not start a second copy
    target = plan.existing.id
  } else {
    target = await runPlaylistCache(playlist, plan.tracks, 'new')
  }
  await api.setPlaylistPinned(target, true)
  // Pinning is what puts it in the sidebar's favorites, so that list has to be
  // told - otherwise it only appears on the next unrelated refresh.
  bumpLibraryVersion()
  // Appending to something already there: cancelling must not take it away.
  if (plan.existing) await startJob('playlist', playlist.id, target, playlist.title, plan.tracks.map((track) => track.id), false)
  return 'started'
}

// ── Artists ────────────────────────────────────────────────────────────────

export interface ArtistCachePlan {
  tracks: ScTrack[]
  /** Release title per track id, for the tracks that belong to one. */
  albumOf: Record<string, string>
  /** Set when the track count is high enough to be worth asking about. */
  needsPicker: boolean
}

/**
 * Everything needed to cache an artist: their tracks, and which release each
 * one came from so the albums arrive with them.
 *
 * Releases are fetched in full because a release's own track list is what maps
 * a track to its album - the artist's track listing carries no album at all.
 */
export async function planArtistCache(artist: ScArtist): Promise<ArtistCachePlan> {
  const [tracks, releases] = await Promise.all([
    api.scArtistTracks(artist.id, 200, 0),
    api.scArtistReleases(artist.id),
  ])
  const albumOf: Record<string, string> = {}
  for (const release of releases) {
    for (const track of release.tracks) albumOf[track.id] = release.playlist.title
  }
  const playable = downloadable(tracks)
  return {
    tracks: playable,
    albumOf,
    needsPicker: playable.length > ARTIST_PICKER_THRESHOLD,
  }
}

/** A cache request waiting on which tracks to keep, and what to merge into. */
export interface PendingArtistChoice {
  artist: ScArtist
  plan: ArtistCachePlan
  /** Local artists whose name looks like this one, offered for merging. */
  mergeCandidates: { id: number; name: string }[]
  /** Whether this request also meant "add to favorites". */
  favorite: boolean
}

let pendingArtist: PendingArtistChoice | null = null
const artistListeners = new Set<() => void>()

function emitArtist(): void {
  for (const listener of artistListeners) listener()
}

export function subscribeArtistChoice(listener: () => void): () => void {
  artistListeners.add(listener)
  return () => {
    artistListeners.delete(listener)
  }
}

export function getArtistChoice(): PendingArtistChoice | null {
  return pendingArtist
}

export function dismissArtistChoice(): void {
  if (!pendingArtist) return
  pendingArtist = null
  emitArtist()
}

/**
 * Imports the chosen tracks and starts downloading them.
 *
 * `mergeInto` files them under an existing local artist instead of creating one
 * named after the SoundCloud account. `favorite` only ever adds: an artist that
 * is already in favorites stays there, which matters because re-caching one is
 * the normal way to pick up tracks that were added later.
 */
export async function runArtistCache(
  artist: ScArtist,
  tracks: ScTrack[],
  albumOf: Record<string, string>,
  mergeInto: number | null,
  favorite: boolean,
): Promise<number> {
  const artistId = await withExplicitFeedback(() => api.scImportArtist(
    artist.username,
    artist.avatarUrl,
    tracks,
    albumOf,
    mergeInto,
  ), tracks.flatMap(track => [
    { trackKey: `soundcloud:${track.id}`, action: 'collection-save', intent: 'manual' },
    { trackKey: `soundcloud:${track.id}`, action: 'cache', intent: 'manual' },
  ]))
  if (favorite) {
    // `toggleFavoriteArtist` would *remove* an artist that is already there.
    const already = await api.isFavoriteArtist(artistId).catch(() => false)
    if (!already) await api.toggleFavoriteArtist(artistId).catch(() => undefined)
  }
  bumpLibraryVersion()
  await startJob('artist', artist.id, artistId, artist.username, tracks.map((track) => track.id), true)
  return artistId
}

export type ArtistRequestOutcome = 'started' | 'asked' | 'empty'

/**
 * Keeps an artist's tracks, and optionally favorites them.
 *
 * A short catalogue is taken whole; a long one asks first, because caching
 * everything an artist ever posted is rarely what was meant.
 */
export async function requestArtistCache(
  artist: ScArtist,
  favorite: boolean,
): Promise<ArtistRequestOutcome> {
  const plan = await planArtistCache(artist)
  if (plan.tracks.length === 0) return 'empty'
  if (plan.needsPicker) {
    const local = await api.listArtists('').catch(() => [])
    pendingArtist = {
      artist,
      plan,
      mergeCandidates: suggestMerges(artist.username, local),
      favorite,
    }
    emitArtist()
    return 'asked'
  }
  await runArtistCache(artist, plan.tracks, plan.albumOf, null, favorite)
  return 'started'
}

/** Answers the artist question and starts the download. */
export async function resolveArtistChoice(
  selected: ScTrack[],
  mergeInto: number | null,
): Promise<void> {
  const pending = pendingArtist
  if (!pending) return
  pendingArtist = null
  emitArtist()
  await runArtistCache(pending.artist, selected, pending.plan.albumOf, mergeInto, pending.favorite)
}

/**
 * Local artists worth offering to merge into.
 *
 * Fuzzy on purpose: the reason to merge is that the two names are *almost* the
 * same, so an exact match would find nothing. Normalised containment catches
 * "cupsi" against "cupsize", which is the case that prompted this.
 */
function suggestMerges(
  username: string,
  local: { id: number; name: string }[],
): { id: number; name: string }[] {
  const wanted = username.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (wanted.length < 3) return []
  return local
    .filter((entry) => {
      const name = entry.name.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
      if (name.length < 3) return false
      return name.includes(wanted) || wanted.includes(name)
    })
    .slice(0, 5)
}

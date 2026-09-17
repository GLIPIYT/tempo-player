import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { api } from '../api/client'
import type { ScArtist, ScPlaylist, ScTrack } from '../types/models'

/**
 * Caching, as a job the UI can watch.
 *
 * The download happens in Rust and reports through events rather than returning
 * a result, because it can take minutes and has to survive the user navigating
 * away. This side keeps the list of jobs, what the user asked for, and the
 * questions that need answering along the way.
 */

export type CacheKind = 'playlist' | 'artist'

export interface CacheJob {
  /** `${kind}:${SoundCloud id}` - stable from the moment it is requested. */
  id: string
  kind: CacheKind
  /** The library row it created, once there is one. */
  localId: number | null
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

/** How long a finished job stays on screen so the ring can be seen closing. */
const LINGER_MS = 4000

/** Above this many tracks, an artist cache asks which ones to keep. */
export const ARTIST_PICKER_THRESHOLD = 15

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
      const known = jobs.find((job) => job.id === p.jobId)
      const next: CacheJob = {
        id: p.jobId,
        kind: known?.kind ?? 'playlist',
        localId: known?.localId ?? null,
        label: p.label,
        done: p.done,
        total: p.total,
        failed: p.failed,
        state: p.state,
      }
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

/**
 * How far along a cache is, for the cover that belongs to it.
 *
 * Matched by the SoundCloud id while the job runs and by the library id after,
 * so a card in the search results and the same playlist in the sidebar both
 * find it. `null` means nothing is being cached.
 */
export function useCachePercent(kind: CacheKind, scId: string | null, localId?: number | null): number | null {
  const all = useSyncExternalStore(subscribeCacheJobs, getCacheJobs, getCacheJobs)
  const job = all.find(
    (j) =>
      j.kind === kind &&
      j.state === 'running' &&
      ((scId !== null && j.id === `${kind}:${scId}`) ||
        (localId != null && j.localId === localId)),
  )
  if (!job || job.total === 0) return null
  return Math.min(100, Math.round((job.done / job.total) * 100))
}

/** Only tracks that can actually be downloaded: HLS never lands in the cache. */
function downloadable(tracks: ScTrack[]): ScTrack[] {
  return tracks.filter((trk) => trk.streamable && trk.hasProgressive)
}

function startJob(
  kind: CacheKind,
  scId: string,
  localId: number,
  label: string,
  tracks: ScTrack[],
): void {
  const id = `${kind}:${scId}`
  jobs = [
    ...jobs.filter((job) => job.id !== id),
    { id, kind, localId, label, done: 0, total: tracks.length, failed: 0, state: 'running' },
  ]
  emit()
  // Not awaited: the download reports through events, and holding the IPC call
  // open for minutes would just be a promise nobody is waiting on.
  void invoke('sc_cache_tracks', {
    jobId: id,
    label,
    trackIds: tracks.map((trk) => trk.id),
  }).catch(() => {
    // the job never started, so there is nothing to show progress for
    dismissCacheJob(id)
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
  const playlistId = await invoke<number>('sc_import_playlist', {
    name: playlist.title,
    tracks,
    playlistId: into === 'new' ? null : into,
  })
  startJob('playlist', playlist.id, playlistId, playlist.title, tracks)
  return playlistId
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
  if (plan.existing) startJob('playlist', playlist.id, target, playlist.title, plan.tracks)
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
  const artistId = await invoke<number>('sc_import_artist', {
    name: artist.username,
    tracks,
    albumOf,
    mergeInto,
  })
  if (favorite) {
    // `toggleFavoriteArtist` would *remove* an artist that is already there.
    const already = await api.isFavoriteArtist(artistId).catch(() => false)
    if (!already) await api.toggleFavoriteArtist(artistId).catch(() => undefined)
  }
  startJob('artist', artist.id, artistId, artist.username, tracks)
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

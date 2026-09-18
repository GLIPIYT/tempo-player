import { api } from '../api/client'
import { getSettings } from '../state/settings'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import type { YtSearchHit } from '../types/models'

/**
 * Saving a whole album, artist or playlist from YouTube Music.
 *
 * A module-level job rather than one owned by the page: a collection is dozens
 * of tracks and several minutes, and leaving the page should not abandon the
 * work half done.
 *
 * One job at a time, unlike SoundCloud's list. Two saves at once would compete
 * for the same yt-dlp binary and the same cache directory for no benefit, and a
 * queue would be a great deal of machinery to say "wait your turn".
 *
 * Simpler than the SoundCloud equivalent in another way too: that one plans
 * first and asks what to do when the album already exists. Both steps here are
 * idempotent - a track already cached comes straight back off disk, and filing
 * is an upsert - so saving something twice costs nothing and needs no question.
 */

export interface SaveJob {
  /** Which collection, so a card can show its own progress and no one else's. */
  id: string
  /** What is being saved, for the notification. */
  label: string
  done: number
  total: number
  failed: number
  state: 'running' | 'done' | 'cancelled'
}

let job: SaveJob | null = null
let cancelled = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeSave(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSaveJob(): SaveJob | null {
  return job
}

export function cancelSave(): void {
  cancelled = true
}

/** A finished job is cleared, so the notification does not sit there for ever. */
function clearWhenDone(): void {
  window.setTimeout(() => {
    if (job !== null && job.state !== 'running') {
      job = null
      emit()
    }
  }, 6000)
}

async function run(id: string, label: string, tracks: YtSearchHit[]): Promise<void> {
  cancelled = false
  job = { id, label, done: 0, total: tracks.length, failed: 0, state: 'running' }
  emit()

  const configured = getSettings().ytdlp.path
  for (const track of tracks) {
    if (cancelled) break
    try {
      // Downloading is the slow part and the one that can fail on a track that
      // is unavailable; filing after it is what puts the track in the library.
      const file = await api.ytdlpCache(configured, track.url, track.id)
      await api.upsertYtTrack({
        videoId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album ?? '',
        durationMs: track.durationMs,
        artworkUrl: track.thumbnailUrl,
        cachedPath: file,
      })
      bumpLibraryVersion()
    } catch {
      // One unavailable track should not abandon the other twenty-nine.
      if (job !== null) job = { ...job, failed: job.failed + 1 }
    }
    if (job !== null) job = { ...job, done: job.done + 1 }
    emit()
  }

  if (job !== null) job = { ...job, state: cancelled ? 'cancelled' : 'done' }
  emit()
  clearWhenDone()
}

export async function saveCollection(
  id: string,
  label: string,
  tracks: YtSearchHit[],
): Promise<void> {
  if (job?.state === 'running') return
  await run(id, label, tracks)
}

/**
 * Saves a collection that has not been opened yet.
 *
 * A card knows only an id, and saving needs the tracks - so the page is opened
 * first. One extra call of about three seconds, and only on this route; the
 * preview page already has them and goes straight to the download.
 */
export async function saveCollectionById(
  id: string,
  label: string,
  browseUrl: string,
): Promise<void> {
  if (job?.state === 'running') return
  const detail = await api.ytdlpOpenCollection(getSettings().ytdlp.path, browseUrl)
  await run(id, label, detail.tracks)
}

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
 * Simpler than the SoundCloud equivalent on purpose. That one plans first and
 * asks what to do when the album already exists; this downloads each track and
 * files it, and both steps are idempotent - a track already cached comes
 * straight back off disk, and filing is an upsert - so saving something twice
 * costs nothing and needs no question.
 */

export interface SaveProgress {
  /** Which collection, so a card can show its own progress and no one else's. */
  id: string
  /** What is being saved, for the message. */
  name: string
  done: number
  total: number
  failed: number
  running: boolean
}

let progress: SaveProgress | null = null
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

export function getSaveProgress(): SaveProgress | null {
  return progress
}

export function cancelSave(): void {
  cancelled = true
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
  name: string,
  browseUrl: string,
): Promise<void> {
  if (progress?.running) return
  const detail = await api.ytdlpOpenCollection(getSettings().ytdlp.path, browseUrl)
  await saveCollection(id, name, detail.tracks)
}

export async function saveCollection(
  id: string,
  name: string,
  tracks: YtSearchHit[],
): Promise<void> {
  if (progress?.running) return
  cancelled = false
  progress = { id, name, done: 0, total: tracks.length, failed: 0, running: true }
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
      if (progress) progress = { ...progress, failed: progress.failed + 1 }
    }
    if (progress) progress = { ...progress, done: progress.done + 1 }
    emit()
  }

  if (progress) progress = { ...progress, running: false }
  emit()
}

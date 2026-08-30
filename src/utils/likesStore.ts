import { api } from '../api/client'
import { bumpLibraryVersion } from './libraryVersion'

type Listener = () => void

let version = 0
let loaded = false
let loading: Promise<void> | null = null
const ids = new Set<number>()
const listeners = new Set<Listener>()

function emit(): void {
  version += 1
  listeners.forEach((l) => l())
}

async function fetchIds(): Promise<void> {
  try {
    const list = await api.listLikedTrackIds()
    ids.clear()
    for (const id of list) ids.add(id)
    loaded = true
    emit()
  } catch {
    // keep previous state; next bump retries
  } finally {
    loading = null
  }
}

export const likesStore = {
  get: () => version,
  subscribe: (l: Listener) => {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  isLiked: (trackId: number): boolean => ids.has(trackId),
  /** Ensures the liked ids are fetched once per session. */
  ensureLoaded: (): void => {
    if (loaded || loading !== null) return
    loading = fetchIds()
  },
  reload: (): void => {
    if (loading === null) loading = fetchIds()
  },
  setLiked: (trackId: number, liked: boolean): void => {
    if (liked) ids.add(trackId)
    else ids.delete(trackId)
    emit()
  },
  toggle: (trackId: number): void => {
    const liked = ids.has(trackId)
    if (liked) ids.delete(trackId)
    else ids.add(trackId)
    emit()
    const request = liked ? api.unlikeTrack(trackId) : api.likeTrack(trackId)
    void request
      .then(() => {
        // keep track counts on the likes playlist fresh
        bumpLibraryVersion()
      })
      .catch(() => {
        // revert on failure
        if (liked) ids.add(trackId)
        else ids.delete(trackId)
        emit()
      })
  },
}

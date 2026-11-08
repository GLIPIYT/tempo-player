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

type Listener = () => void

/** A keyed store keeps a progress tick for one track local to that track's UI. */
export function createTrackCacheProgressStore() {
  let snapshot: TrackCacheProgress[] = []
  const byTrackId = new Map<string, TrackCacheProgress>()
  const listenersByTrackId = new Map<string, Set<Listener>>()

  const notify = (trackId: string) => {
    for (const listener of listenersByTrackId.get(trackId) ?? []) listener()
  }

  return {
    getAll: () => snapshot,
    get: (trackId: string) => byTrackId.get(trackId) ?? null,
    subscribe(trackId: string, listener: Listener) {
      let listeners = listenersByTrackId.get(trackId)
      if (!listeners) {
        listeners = new Set()
        listenersByTrackId.set(trackId, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners!.delete(listener)
        if (listeners!.size === 0) listenersByTrackId.delete(trackId)
      }
    },
    set(progress: TrackCacheProgress) {
      byTrackId.set(progress.trackId, progress)
      snapshot = [...snapshot.filter(item => item.trackId !== progress.trackId), progress]
      notify(progress.trackId)
    },
    update(trackId: string, update: (progress: TrackCacheProgress) => TrackCacheProgress) {
      const current = byTrackId.get(trackId)
      if (!current) return
      const next = update(current)
      byTrackId.set(trackId, next)
      snapshot = snapshot.map(item => item.trackId === trackId ? next : item)
      notify(trackId)
    },
    remove(trackId: string) {
      if (!byTrackId.delete(trackId)) return
      snapshot = snapshot.filter(item => item.trackId !== trackId)
      notify(trackId)
    },
  }
}

export const trackCacheProgressStore = createTrackCacheProgressStore()

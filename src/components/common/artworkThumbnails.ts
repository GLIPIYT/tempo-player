import { invoke, isTauri } from '@tauri-apps/api/core'

const MAX_RESULTS = 1024
const results = new Map<string, string>()
type ArtworkPriority = 'high' | 'low' | 'auto'
interface QueuedArtworkRequest {
  key: string
  priority: number
  order: number
  start: () => void
}
interface PendingArtworkRequest {
  promise: Promise<string | null>
  queued: QueuedArtworkRequest | null
}
const pending = new Map<string, PendingArtworkRequest>()
const waiters: QueuedArtworkRequest[] = []
const MAX_ACTIVE_REQUESTS = 2
let activeRequests = 0
let nextRequestOrder = 0
let pumpScheduled = false
const visibleCallbacks = new Map<Element, () => void>()
let observer: IntersectionObserver | undefined

export function localArtworkSize(path: string | null | undefined, pixels: number, preferOriginal: boolean, thumbnailOnly = false): number | null {
  if (!path || preferOriginal || (!thumbnailOnly && pixels > 512) || !isTauri()
    || !/^(?:[a-z]:[\\/]|[\\/])/i.test(path) || !/[\\/](covers|avatars)[\\/]/i.test(path)) return null
  return pixels <= 128 ? 128 : pixels <= 256 ? 256 : 512
}

function priorityScore(priority: ArtworkPriority): number {
  return priority === 'high' ? 2 : priority === 'low' ? 0 : 1
}

function sortWaiters(): void {
  waiters.sort((a, b) => b.priority - a.priority || a.order - b.order)
}

function pumpArtworkRequests(): void {
  while (activeRequests < MAX_ACTIVE_REQUESTS && waiters.length > 0) {
    const request = waiters.shift()!
    const requestState = pending.get(request.key)
    if (!requestState || requestState.queued !== request) continue
    requestState.queued = null
    activeRequests += 1
    request.start()
  }
}

function scheduleArtworkRequestPump(): void {
  if (pumpScheduled) return
  pumpScheduled = true
  queueMicrotask(() => {
    pumpScheduled = false
    pumpArtworkRequests()
  })
}

export function requestArtworkThumbnail(path: string, size: number, priority: ArtworkPriority = 'auto'): Promise<string | null> {
  const key = `${size}:${path}`
  const cached = results.get(key)
  if (cached) return Promise.resolve(cached)
  const existing = pending.get(key)
  if (existing) {
    if (existing.queued && priorityScore(priority) > existing.queued.priority) {
      existing.queued.priority = priorityScore(priority)
      sortWaiters()
    }
    return existing.promise
  }

  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const queued: QueuedArtworkRequest = { key, priority: priorityScore(priority), order: nextRequestOrder++, start }
  const request = started
    .then(() => invoke<string | null>('get_artwork_thumbnail', { path, size }))
    .then(result => {
      if (result) results.set(key, result)
      if (results.size > MAX_RESULTS) results.delete(results.keys().next().value!)
      return result
    })
    .catch(() => null)
    .finally(() => {
      pending.delete(key)
      activeRequests -= 1
      scheduleArtworkRequestPump()
    })
  pending.set(key, { promise: request, queued })
  waiters.push(queued)
  sortWaiters()
  scheduleArtworkRequestPump()
  return request
}

export function forgetArtworkThumbnail(path: string, size: number, thumbnail: string): void {
  const key = `${size}:${path}`
  if (results.get(key) === thumbnail) results.delete(key)
}

export function whenArtworkNear(element: Element, callback: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    callback()
    return () => {}
  }
  observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const load = visibleCallbacks.get(entry.target)
      visibleCallbacks.delete(entry.target)
      observer?.unobserve(entry.target)
      load?.()
    }
  }, { rootMargin: '220px' })
  visibleCallbacks.set(element, callback)
  observer.observe(element)
  return () => {
    visibleCallbacks.delete(element)
    observer?.unobserve(element)
  }
}

import { invoke, isTauri } from '@tauri-apps/api/core'

const MAX_RESULTS = 1024
const results = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()
const waiters: Array<() => void> = []
let activeRequests = 0
const visibleCallbacks = new Map<Element, () => void>()
let observer: IntersectionObserver | undefined

export function localArtworkSize(path: string | null | undefined, pixels: number, preferOriginal: boolean): number | null {
  if (!path || preferOriginal || pixels > 512 || !isTauri()
    || !/^(?:[a-z]:[\\/]|[\\/])/i.test(path) || !/[\\/](covers|avatars)[\\/]/i.test(path)) return null
  return pixels <= 128 ? 128 : pixels <= 256 ? 256 : 512
}

export function requestArtworkThumbnail(path: string, size: number): Promise<string | null> {
  const key = `${size}:${path}`
  const cached = results.get(key)
  if (cached) return Promise.resolve(cached)
  const existing = pending.get(key)
  if (existing) return existing

  const request = new Promise<void>(resolve => {
    if (activeRequests < 2) { activeRequests += 1; resolve() }
    else waiters.push(resolve)
  })
    .then(() => invoke<string | null>('get_artwork_thumbnail', { path, size }))
    .then(result => {
      if (result) results.set(key, result)
      if (results.size > MAX_RESULTS) results.delete(results.keys().next().value!)
      return result
    })
    .catch(() => null)
    .finally(() => {
      pending.delete(key)
      const next = waiters.shift()
      if (next) next()
      else activeRequests -= 1
    })
  pending.set(key, request)
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

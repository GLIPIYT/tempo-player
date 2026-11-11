import type { LyricsCandidate } from './onlineProvider'

export interface LyricsOverlayCacheValue {
  candidates: LyricsCandidate[]
  selectedIndex: number
}

const CACHE_CAP = 32
const cache = new Map<string, LyricsOverlayCacheValue>()

export function getLyricsOverlayCache(key: string): LyricsOverlayCacheValue | undefined {
  const value = cache.get(key)
  if (!value) return undefined
  cache.delete(key)
  cache.set(key, value)
  return value
}

export function setLyricsOverlayCache(key: string, value: LyricsOverlayCacheValue): void {
  cache.delete(key)
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, value)
}

export function clearLyricsOverlayCache(): void {
  cache.clear()
}

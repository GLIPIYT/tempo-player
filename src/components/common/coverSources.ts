import { buildArtworkSources } from './artworkFallback'

/** Build image candidates for a cover without changing its normal card size. */
export function buildCoverSources(path: string | null | undefined, preferOriginal = false, displayPixels?: number): string[] {
  if (!path) return []

  const original = preferOriginal ? originalYoutubeArtworkUrl(path) : null
  if (original && original !== path) return [original, path]

  const compact = !preferOriginal && displayPixels !== undefined && displayPixels <= 100
  const card = !preferOriginal && displayPixels !== undefined && displayPixels <= 300
  const soundCloud = buildArtworkSources(path, [], compact, card ? 'card' : 'full')
  return soundCloud.length > 1 ? soundCloud : [path]
}

export interface CoverSourceRetry {
  source: string
  attempt: number
}

export const MAX_COVER_SOURCE_RETRIES = 2

/** Retry a transient image failure a bounded number of times before trying a fallback source. */
export function nextCoverSourceRetry(source: string, current: CoverSourceRetry | null): CoverSourceRetry | null {
  const attempts = current?.source === source ? current.attempt : 0
  if (attempts >= MAX_COVER_SOURCE_RETRIES) return null
  return { source, attempt: attempts + 1 }
}

/** Leave a short gap so temporary local asset or network failures can recover. */
export function coverSourceRetryDelay(attempt: number): number {
  return Math.min(800, 160 * 2 ** Math.max(0, attempt - 1))
}

/**
 * YouTube Music's Google image URLs commonly point at a 544px rendition even
 * when the same image has a larger original. `=s0` asks the image host for
 * that original; keep the reported rendition as a fallback if it is absent.
 */
function originalYoutubeArtworkUrl(path: string): string | null {
  let url: URL
  try {
    url = new URL(path)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' || !/^lh\d\.googleusercontent\.com$/i.test(url.hostname)) return null

  const modifierStart = url.pathname.lastIndexOf('=')
  if (modifierStart < 0) return null

  const modifier = url.pathname.slice(modifierStart)
  if (!/^=(?:w\d+-h\d+|s\d+)(?:-[a-z\d]+)*$/i.test(modifier)) return null

  url.pathname = `${url.pathname.slice(0, modifierStart)}=s0`
  return url.toString()
}

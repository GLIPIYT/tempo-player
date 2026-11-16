import { buildArtworkSources } from './artworkFallback'

/** Build image candidates for a cover without changing its normal card size. */
export function buildCoverSources(
  path: string | null | undefined,
  preferOriginal = false,
  displayPixels?: number,
  youtubeVideoId?: string | null,
): string[] {
  const sourceVideoId = youtubeVideoIdFromUrl(path)
  const videoId = sourceVideoId ?? validVideoId(youtubeVideoId)
  const large = preferOriginal || (displayPixels ?? 0) > 100
  const videoFallback = videoId ? youtubeVideoThumbnails(videoId, large, preferOriginal) : []
  if (!path) return videoFallback

  const musicArtwork = youtubeMusicRendition(path, preferOriginal, displayPixels)
  if (sourceVideoId) {
    const alreadyLarge = /\/(?:maxresdefault|sddefault|hq720)\.(?:jpe?g|webp)(?=[?#]|$)/i.test(path)
    return [...new Set(alreadyLarge ? [path, ...videoFallback] : [...videoFallback, path])]
  }
  if (musicArtwork || videoFallback.length > 0) {
    return [...new Set([musicArtwork ?? path, path, ...videoFallback])]
  }

  const compact = !preferOriginal && displayPixels !== undefined && displayPixels <= 100
  const card = !preferOriginal && displayPixels !== undefined && displayPixels <= 300
  const soundCloud = buildArtworkSources(path, [], compact, card ? 'card' : 'full')
  return soundCloud.length > 1 ? soundCloud : [path]
}

function validVideoId(id: string | null | undefined): string | null {
  return id && /^[\w-]{11}$/.test(id) ? id : null
}

function youtubeVideoIdFromUrl(path: string | null | undefined): string | null {
  const match = path?.match(/^https:\/\/(?:i\.ytimg\.com|img\.youtube\.com)\/vi(?:_webp)?\/([\w-]{11})\//i)
  return match?.[1] ?? null
}

function youtubeVideoThumbnails(id: string, large: boolean, original: boolean): string[] {
  const base = 'https://i.ytimg.com/vi/' + id
  return [
    ...(original ? [base + '/maxresdefault.jpg', base + '/sddefault.jpg'] : []),
    ...(large ? [base + '/hqdefault.jpg'] : []),
    base + '/mqdefault.jpg',
  ]
}

export function isYoutubeArtworkSource(source: string): boolean {
  return youtubeVideoIdFromUrl(source) !== null
    || /^https:\/\/lh\d\.googleusercontent\.com\//i.test(source)
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
function youtubeMusicRendition(path: string, preferOriginal: boolean, displayPixels?: number): string | null {
  let url: URL
  try {
    url = new URL(path)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' || !/^lh\d\.googleusercontent\.com$/i.test(url.hostname)) return null

  const modifierStart = url.pathname.lastIndexOf('=')
  if (modifierStart < 0) return null

  const modifier = url.pathname.slice(modifierStart).match(/^=(?:w(\d+)-h(\d+)|s(\d+))(?:-[a-z\d]+)*$/i)
  if (!modifier) return null
  const width = Number(modifier[1] ?? modifier[3])
  const height = Number(modifier[2] ?? modifier[3])
  const pixels = displayPixels ?? 0
  if (!preferOriginal && (pixels <= 100 || width === 0 || Math.min(width, height) >= pixels)) return null
  const rendition = preferOriginal ? 's0' : pixels <= 544 ? 'w544-h544' : 'w1080-h1080'

  url.pathname = `${url.pathname.slice(0, modifierStart)}=${rendition}`
  return url.toString()
}

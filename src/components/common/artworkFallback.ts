/** Return the first image URL that has not failed to load. */
export function firstAvailableArtwork(sources: string[], failedSources: string[]): string | null {
  return sources.find((source) => !failedSources.includes(source)) ?? null
}

export type ArtworkResolution = 'full' | 'card'

/**
 * Build ordered image candidates while keeping the current full-size and
 * compact fallbacks intact. Recommendation cards request a 300px SoundCloud
 * thumbnail first, then retain both the full and small variants as fallbacks.
 */
export function buildArtworkSources(
  url: string | null,
  fallbackUrls: string[] = [],
  compact = false,
  resolution: ArtworkResolution = 'full',
): string[] {
  const urls = [url, ...fallbackUrls].filter((source): source is string => Boolean(source))
  return Array.from(new Set(urls.flatMap((source) => {
    const isSoundCloudArtwork = /^https:\/\/[^/]+\.sndcdn\.com\//i.test(source)
    const thumbnail = isSoundCloudArtwork
      ? source.replace(/-t500x500\.(jpg|png|webp)(?=[?#]|$)/i, '-large.$1')
      : source

    if (compact) return [thumbnail, source]
    if (resolution === 'card' && isSoundCloudArtwork) {
      const card = source.replace(/-(?:t500x500|large)\.(jpg|png|webp)(?=[?#]|$)/i, '-t300x300.$1')
      return [card, source, thumbnail]
    }
    return [source, thumbnail]
  })))
}

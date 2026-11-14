/** Return the first image URL that has not failed to load. */
export function firstAvailableArtwork(sources: string[], failedSources: string[]): string | null {
  return sources.find((source) => !failedSources.includes(source)) ?? null
}

export type ArtworkResolution = 'full' | 'card' | 'small-card'

/**
 * Build ordered image candidates with a first choice sized for the surface.
 * Keep the reported URL and the compact variant available as fallbacks.
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
    const resize = (size: string) => source.replace(/-(?:t500x500|t300x300|t200x200|large)\.(jpg|png|webp)(?=[?#]|$)/i, `-${size}.$1`)
    const thumbnail = isSoundCloudArtwork ? resize('large') : source

    if (compact) return [thumbnail, source]
    if (resolution !== 'full' && isSoundCloudArtwork) {
      const card = resize('t300x300')
      return resolution === 'small-card'
        ? [resize('t200x200'), card, source, thumbnail]
        : [card, source, thumbnail]
    }
    return [source, thumbnail]
  })))
}

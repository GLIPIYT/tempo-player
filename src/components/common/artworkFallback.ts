/** Return the first image URL that has not failed to load. */
export function firstAvailableArtwork(sources: string[], failedSources: string[]): string | null {
  return sources.find((source) => !failedSources.includes(source)) ?? null
}

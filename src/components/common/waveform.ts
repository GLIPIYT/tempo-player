const FALLBACK_BAR_COUNT = 90

function hashUnit(input: string): number {
  let hash = 2166136261
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4294967296
}

function bellWeight(position: number): number {
  const sigma = 0.24
  return Math.exp(-((position - 0.5) ** 2) / (2 * sigma * sigma))
}

/** Fit normalized SoundCloud peaks to the visible bars without losing transients. */
export function resampleWaveform(samples: readonly number[], count: number): number[] | null {
  if (samples.length === 0 || !Number.isFinite(count) || count < 1) return null

  const targetCount = Math.floor(count)
  const clean = samples.map(sample => Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0)

  if (clean.length >= targetCount) {
    return Array.from({ length: targetCount }, (_, index) => {
      const start = Math.floor(index * clean.length / targetCount)
      const end = Math.max(start + 1, Math.ceil((index + 1) * clean.length / targetCount))
      let peak = 0
      for (let sampleIndex = start; sampleIndex < end; sampleIndex++) {
        peak = Math.max(peak, clean[sampleIndex] ?? 0)
      }
      return peak
    })
  }

  if (targetCount === 1) return [Math.max(...clean)]

  return Array.from({ length: targetCount }, (_, index) => {
    const point = index * (clean.length - 1) / (targetCount - 1)
    const left = Math.floor(point)
    const right = Math.min(clean.length - 1, left + 1)
    const blend = point - left
    return (clean[left] ?? 0) * (1 - blend) + (clean[right] ?? 0) * blend
  })
}

/** Use a level line while a SoundCloud waveform is loading or unavailable. */
export function soundCloudWaveformHeights(samples: readonly number[] | null, count: number): number[] {
  const targetCount = Math.max(0, Math.floor(count))
  if (targetCount === 0) return []
  const peaks = samples ? resampleWaveform(samples, targetCount) : null
  return peaks ? peaks.map(peak => peak * 100) : Array.from({ length: targetCount }, () => 14)
}

/** Deduplicate in-flight fetches and allow a failed track to be retried. */
export function cachedWaveformRequest(
  cache: Map<string, Promise<number[]>>,
  trackId: string,
  load: () => Promise<number[]>,
): Promise<number[]> {
  const cached = cache.get(trackId)
  if (cached) return cached

  const request = load()
  cache.set(trackId, request)
  void request.catch(() => {
    if (cache.get(trackId) === request) cache.delete(trackId)
  })
  return request
}

/** Stable visual fallback for sources that do not publish waveform peaks. */
export function fallbackWaveformHeights(seed: string, count: number): number[] {
  const targetCount = Math.max(0, Math.floor(count))
  const range = FALLBACK_BAR_COUNT - 1
  return Array.from({ length: targetCount }, (_, index) => {
    const position = index / Math.max(1, targetCount - 1)
    const sampleIndex = Math.round(index * range / Math.max(1, targetCount - 1))
    const random = hashUnit(`${seed}:${sampleIndex}`)
    const shaped = random ** 1.3 * (0.38 + 0.62 * bellWeight(position))
    return 18 + shaped * 82
  })
}

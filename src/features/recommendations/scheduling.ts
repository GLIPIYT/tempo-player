import { candidateLanguage, effectiveLanguageWeights, recommendationSeedLanguage, type TasteProfile } from './profile'
import type { FeedCandidate, SeedFrontier } from './storage'

const BUCKETS = ['steady', 'recent', 'discovery'] as const
const BUCKET_WEIGHTS = [0.6, 0.25, 0.15]

function chooseDeficit<K extends string | number>(keys: K[], weight: (key: K) => number, count: (key: K) => number): K {
  const mass = keys.reduce((sum, key) => sum + weight(key), 0)
  // Missing pools cannot repay a debt; normalize only over currently available pools.
  const delivered = keys.reduce((sum, key) => sum + count(key), 0)
  const debt = (key: K) => weight(key) / mass * (delivered + 1) - count(key)
  return keys.reduce((best, next) => debt(next) > debt(best) ? next : best, keys[0])
}

function languageWeight(profile: TasteProfile | null): (key: string) => number {
  const weights = profile ? effectiveLanguageWeights(profile) : {}
  return key => key === '?' ? Math.max(0.05, Math.min(profile?.languagePreference ? 0.12 : 0.18, profile?.unknownShare ?? 1))
    : Math.max(0.02, weights[key] ?? 0)
}

/** Eligible seeds for the next provider request; the caller rotates within this pool. */
export function seedSchedulingPool(ready: SeedFrontier[], profile: TasteProfile | null,
  languageCounts: ReadonlyMap<string, number>, bucketCounts: readonly number[]): SeedFrontier[] {
  if (!ready.length) return []
  const languages = new Map(ready.map(item => [item, profile ? recommendationSeedLanguage(item.seed, profile) ?? '?' : '?']))
  const language = chooseDeficit([...new Set(languages.values())], languageWeight(profile), key => languageCounts.get(key) ?? 0)
  const eligible = ready.filter(item => languages.get(item) === language)
  const active = BUCKETS.map((name, index) => eligible.some(item => (item.seed.bucket ?? 'steady') === name) ? index : -1).filter(index => index >= 0)
  const selected = chooseDeficit(active, index => BUCKET_WEIGHTS[index], index => bucketCounts[index] ?? 0)
  return eligible.filter(item => (item.seed.bucket ?? 'steady') === BUCKETS[selected])
}

/** Select a visible prefix while keeping artist, recording-family and seed diversity. */
export function selectRecommendationBatch(ranked: FeedCandidate[], profile: TasteProfile | null,
  history: FeedCandidate[], limit: number): FeedCandidate[] {
  const available = ranked.slice(), selected: FeedCandidate[] = []
  const balanceLanguages = profile && (profile.languageConfidence >= 0.05 || profile.languagePreference)
    && Object.keys(effectiveLanguageWeights(profile)).length > 0
  const languages = new Map([...history.slice(-20), ...ranked].map(item => [item, profile ? candidateLanguage(item, profile) ?? '?' : '?']))
  const counts = new Map<string, number>()
  for (const item of history.slice(-20)) {
    const key = languages.get(item)!
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const artists = history.slice(-9).map(item => item.identity.artist)
  const families = history.slice(-9).map(item => `${item.identity.artist}|${item.identity.title}`)
  while (selected.length < limit && available.length) {
    const language = balanceLanguages
      ? chooseDeficit([...new Set(available.map(item => languages.get(item)!))], languageWeight(profile), key => counts.get(key) ?? 0)
      : null
    const pool = language ? available.filter(item => languages.get(item) === language) : available
    const lastSeed = selected.at(-1)?.seedTrackKey ?? history.at(-1)?.seedTrackKey
    const diverseArtist = (item: FeedCandidate) => !item.identity.artist || artists.slice(-9).filter(artist => artist === item.identity.artist).length < 2
    const diverseFamily = (item: FeedCandidate) => !families.slice(-9).includes(`${item.identity.artist}|${item.identity.title}`)
    let index = pool.findIndex(item => item.seedTrackKey !== lastSeed && diverseArtist(item) && diverseFamily(item))
    if (index < 0) index = pool.findIndex(item => diverseArtist(item) && diverseFamily(item))
    if (index < 0) index = pool.findIndex(diverseFamily)
    const item = pool[index >= 0 ? index : 0]
    available.splice(available.indexOf(item), 1)
    if (selected.some(previous => previous.groupKey === item.groupKey)) continue
    selected.push(item)
    const key = languages.get(item)!
    counts.set(key, (counts.get(key) ?? 0) + 1)
    artists.push(item.identity.artist)
    families.push(`${item.identity.artist}|${item.identity.title}`)
  }
  return selected
}

import type {
  CustomMixCandidate,
  CustomMixGenerationOptions,
  CustomMixGenerationResult,
  CustomMixRule,
} from './types'

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 50
const FULL_PERCENT_RANGE: readonly [number, number] = [0, 100]
const FULL_DAY_RANGE: readonly [number, number] = [0, 1440]
const DAY_SECONDS = 86_400

export function validateCustomMixRule(rule: CustomMixRule): string[] {
  const errors: string[] = []
  if (!rule.name.trim()) errors.push('Give this mix a name.')
  if (rule.description.length > 150) errors.push('Description must be 150 characters or fewer.')
  if (!Number.isInteger(rule.trackCount) || rule.trackCount < 1 || rule.trackCount > 50) {
    errors.push('Track count must be an integer from 1 to 50.')
  }
  if (!Number.isInteger(rule.refreshIntervalMinutes) || rule.refreshIntervalMinutes < 0
    || rule.refreshIntervalMinutes > 1440 || rule.refreshIntervalMinutes % 10 !== 0) {
    errors.push('Refresh interval must use 10-minute steps from 0 to 1440.')
  }
  if (!isRange(rule.timeWindow, 0, 1440, true) || rule.timeWindow[0] > rule.timeWindow[1]) {
    errors.push('Choose a valid listening-time range.')
  } else if (rule.timeWindow.some((minute) => minute !== 1440 && minute % 30 !== 0)) {
    errors.push('Listening-time boundaries must use half-hour steps.')
  }
  for (const [label, range] of [
    ['Artist', rule.artistPercent],
    ['Completion', rule.completionPercent],
    ['Genre', rule.genrePercent],
    ['Forgotten-track', rule.forgottenPercent],
  ] as const) {
    if (!isRange(range, 0, 100, false) || range[0] > range[1]) {
      errors.push(`${label} range must be between 0 and 100.`)
    }
  }
  if (!isRange(rule.forgottenDays, 1, 365, true) || rule.forgottenDays[0] > rule.forgottenDays[1]) {
    errors.push('Choose a valid forgotten-track age range.')
  }
  if (!['allow', 'deny'].includes(rule.artistMode)) errors.push('Choose an artist mode.')
  if (!['allow', 'deny'].includes(rule.genreMode)) errors.push('Choose a genre mode.')
  if (rule.artistIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) errors.push('Artist IDs must be positive integers.')
  if (rule.sources.some((source) => !['local', 'soundcloud', 'youtube'].includes(source))) errors.push('Choose valid track sources.')
  if (rule.specials.some((special) => !['currentHour', 'onlineGenre', 'forgotten', 'onRepeat', 'newToYou', 'noSkips'].includes(special))) errors.push('Choose valid mix options.')
  return errors
}

function isRange(value: readonly number[], min: number, max: number, integer: boolean): boolean {
  return value.length === 2 && value.every((part) => Number.isFinite(part)
    && part >= min && part <= max && (!integer || Number.isInteger(part)))
}

function isFullRange(range: readonly [number, number], full: readonly [number, number]): boolean {
  return range[0] === full[0] && range[1] === full[1]
}

function currentDate(now?: Date | number): Date {
  if (now instanceof Date) return now
  return typeof now === 'number' ? new Date(now * 1000) : new Date()
}

function normalizeGenre(genre: string | null): string[] {
  return genre?.split(/[;,|]/u).map((part) => part.trim().toLocaleLowerCase()).filter(Boolean) ?? []
}

function matchesGenre(candidate: CustomMixCandidate, genres: ReadonlySet<string>): boolean {
  if (genres.size === 0) return false
  return normalizeGenre(candidate.track.genre).some((genre) => genres.has(genre))
}

function candidateKey(candidate: CustomMixCandidate): string {
  const { track } = candidate
  const identity = track.source === 'local' ? String(track.id) : track.externalId || String(track.id)
  return `${track.source}:${identity}`
}

function isForgotten(candidate: CustomMixCandidate, nowSeconds: number, days: readonly [number, number]): boolean {
  const lastPlayedAt = candidate.track.lastPlayedAt
  if (lastPlayedAt == null) return false
  const ageDays = (nowSeconds - lastPlayedAt) / DAY_SECONDS
  return ageDays >= days[0] && ageDays <= days[1]
}

function isInMinuteRange(minutes: readonly number[], range: readonly [number, number]): boolean {
  return minutes.some((minute) => Number.isInteger(minute) && minute >= range[0] && minute <= range[1])
}

function passesHardFilters(
  candidate: CustomMixCandidate,
  rule: CustomMixRule,
  now: Date,
): boolean {
  const { track } = candidate
  if (!candidate.metadataTrusted && track.source !== 'local') return false
  if (candidate.origin === 'online' && !rule.specials.includes('onlineGenre')) return false
  if (!rule.sources.includes(track.source)) return false

  if (rule.artistIds.length > 0) {
    const artistId = track.artistId
    if (rule.artistMode === 'allow') {
      const selectedArtist = artistId != null && rule.artistIds.includes(artistId)
      // A restrictive per-artist range reserves those shares and lets other
      // identified artists fill the remaining slots. The legacy full range
      // keeps the original allow-list behavior.
      if (artistId == null || (!selectedArtist && isFullRange(rule.artistPercent, FULL_PERCENT_RANGE))) return false
    }
    if (rule.artistMode === 'deny' && artistId != null && rule.artistIds.includes(artistId)) return false
  }

  const selectedGenres = new Set(rule.genres.map((genre) => genre.trim().toLocaleLowerCase()).filter(Boolean))
  if (rule.genreMode === 'deny' && matchesGenre(candidate, selectedGenres)) return false

  if (!rule.specials.includes('currentHour') && !isFullRange(rule.timeWindow, FULL_DAY_RANGE)
    && !isInMinuteRange(candidate.historyMinutes, rule.timeWindow)) return false
  if (rule.specials.includes('currentHour')) {
    const currentHour = now.getHours()
    if (!candidate.historyMinutes.some((minute) => Number.isInteger(minute) && Math.floor(minute / 60) === currentHour)) return false
  }

  if (!isFullRange(rule.completionPercent, FULL_PERCENT_RANGE)) {
    const completion = candidate.averageCompletionPercent
    if (completion == null || !Number.isFinite(completion)
      || completion < rule.completionPercent[0] || completion > rule.completionPercent[1]) return false
  }

  const nowSeconds = now.getTime() / 1000
  if (rule.specials.includes('onRepeat')) {
    const lastPlayedAt = track.lastPlayedAt
    if (lastPlayedAt == null || lastPlayedAt < nowSeconds - 14 * DAY_SECONDS
      || (track.playCount < 2 && !candidate.liked)) return false
  }
  if (rule.specials.includes('newToYou')
    && (track.addedAt < nowSeconds - 30 * DAY_SECONDS || track.playCount > 1)) return false
  if (rule.specials.includes('noSkips')
    && (track.playCount < 5 || track.skipCount > Math.floor(track.playCount * 0.15))) return false

  // An allow-list of genres is a quota pool; tracks outside it can still fill
  // the rest of the mix. Deny mode remains a hard exclusion above.
  if (candidate.origin === 'online' && rule.specials.includes('onlineGenre')) {
    if (selectedGenres.size === 0 || !matchesGenre(candidate, selectedGenres)) return false
  }
  return true
}

interface RandomSource {
  next(): number
}

function hashSeed(seed: string): number {
  let hash = 2166136261
  for (const char of seed) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function createRandomSource(seed?: number | string): RandomSource {
  const seedValue = seed === undefined
    ? Math.floor(Math.random() * 0x1_0000_0000)
    : typeof seed === 'string' ? hashSeed(seed) : seed >>> 0
  let state = seedValue || 0x6d2b79f5
  return {
    next() {
      state += 0x6d2b79f5
      let value = state
      value = Math.imul(value ^ value >>> 15, value | 1)
      value ^= value + Math.imul(value ^ value >>> 7, value | 61)
      return ((value ^ value >>> 14) >>> 0) / 0x1_0000_0000
    },
  }
}

function shuffled<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random.next() * (index + 1))
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}

function mixArtistKey(candidate: CustomMixCandidate): string {
  if (candidate.track.artistId != null) return `id:${candidate.track.artistId}`
  const name = candidate.track.artistName?.trim().toLocaleLowerCase()
  return name ? `name:${name}` : `track:${candidate.track.id}`
}

function repeatScore(candidate: CustomMixCandidate, nowSeconds: number): number {
  const track = candidate.track
  const ageDays = Math.max(0, (nowSeconds - (track.lastPlayedAt ?? nowSeconds)) / DAY_SECONDS)
  const skipRate = track.playCount > 0 ? track.skipCount / track.playCount : 0
  return Math.log1p(track.playCount) * Math.exp(-ageDays / 10)
    + (candidate.liked ? 0.35 : 0)
    - Math.min(1, skipRate) * 0.7
}

function newToYouScore(
  candidate: CustomMixCandidate,
  nowSeconds: number,
  activeArtists: ReadonlySet<string>,
  activeGenres: ReadonlySet<string>,
): number {
  const track = candidate.track
  const ageDays = Math.max(0, (nowSeconds - track.addedAt) / DAY_SECONDS)
  const genre = track.genre?.trim().toLocaleLowerCase()
  const familiarity = (activeArtists.has(mixArtistKey(candidate)) ? 2 : 0)
    + (genre && activeGenres.has(genre) ? 1 : 0)
  return familiarity + Math.exp(-ageDays / 30) - track.playCount * 0.25
}

function specialScores(
  candidates: readonly CustomMixCandidate[],
  rule: CustomMixRule,
  nowSeconds: number,
): ReadonlyMap<string, number> {
  const active = candidates.filter((candidate) => candidate.liked || candidate.track.playCount >= 3)
  const activeArtists = new Set(active.map(mixArtistKey))
  const activeGenres = new Set(active
    .map((candidate) => candidate.track.genre?.trim().toLocaleLowerCase())
    .filter((genre): genre is string => Boolean(genre)))
  return new Map(candidates.map((candidate) => {
    const score = (rule.specials.includes('onRepeat') ? repeatScore(candidate, nowSeconds) : 0)
      + (rule.specials.includes('newToYou') ? newToYouScore(candidate, nowSeconds, activeArtists, activeGenres) : 0)
      + (rule.specials.includes('noSkips') ? candidate.track.playCount - candidate.track.skipCount * 2 : 0)
    return [candidateKey(candidate), score]
  }))
}

function rankedTake(
  candidates: readonly CustomMixCandidate[],
  count: number,
  scores: ReadonlyMap<string, number>,
  random: RandomSource,
): CustomMixCandidate[] {
  return shuffled(candidates, random)
    .sort((left, right) => (scores.get(candidateKey(right)) ?? 0) - (scores.get(candidateKey(left)) ?? 0))
    .slice(0, count)
}

interface QuotaCounts {
  both: number
  genreOnly: number
  forgottenOnly: number
  neither: number
  score: number
}

function quotaDistance(count: number, size: number, range: readonly [number, number], active: boolean): number {
  if (!active || size === 0) return 0
  const minimum = Math.ceil(size * range[0] / 100 - 1e-9)
  const maximum = Math.floor(size * range[1] / 100 + 1e-9)
  return Math.max(0, minimum - count) + Math.max(0, count - maximum)
}

function chooseQuotaCounts(
  capacities: readonly [number, number, number, number],
  size: number,
  genreRange: readonly [number, number],
  forgottenRange: readonly [number, number],
  genreActive: boolean,
  forgottenActive: boolean,
  random: RandomSource,
): QuotaCounts {
  const possible: QuotaCounts[] = []
  let bestScore = Number.POSITIVE_INFINITY
  for (let both = 0; both <= Math.min(capacities[0], size); both += 1) {
    for (let genreOnly = 0; genreOnly <= Math.min(capacities[1], size - both); genreOnly += 1) {
      for (let forgottenOnly = 0; forgottenOnly <= Math.min(capacities[2], size - both - genreOnly); forgottenOnly += 1) {
        const neither = size - both - genreOnly - forgottenOnly
        if (neither > capacities[3]) continue
        const score = quotaDistance(both + genreOnly, size, genreRange, genreActive)
          + quotaDistance(both + forgottenOnly, size, forgottenRange, forgottenActive)
        if (score < bestScore) {
          bestScore = score
          possible.length = 0
        }
        if (score === bestScore) possible.push({ both, genreOnly, forgottenOnly, neither, score })
      }
    }
  }
  const choice = possible[Math.floor(random.next() * possible.length)]
  return choice ?? { both: 0, genreOnly: 0, forgottenOnly: 0, neither: size, score: Number.POSITIVE_INFINITY }
}

function quotaWarning(
  selected: readonly CustomMixCandidate[],
  genrePool: ReadonlySet<string>,
  rule: CustomMixRule,
  nowSeconds: number,
): string[] {
  const genreActive = rule.genreMode === 'allow' && genrePool.size > 0 && !isFullRange(rule.genrePercent, FULL_PERCENT_RANGE)
  const forgottenActive = rule.specials.includes('forgotten') && !isFullRange(rule.forgottenPercent, FULL_PERCENT_RANGE)
  if (!genreActive && !forgottenActive) return []

  const genreCount = genreActive ? selected.filter((candidate) => matchesGenre(candidate, genrePool)).length : 0
  const forgottenCount = forgottenActive
    ? selected.filter((candidate) => isForgotten(candidate, nowSeconds, rule.forgottenDays)).length
    : 0
  const size = selected.length
  const outOfRange = (count: number, range: readonly [number, number]) => {
    const percentage = count * 100 / size
    return percentage < range[0] - 1e-9 || percentage > range[1] + 1e-9
  }
  const genreMiss = genreActive && outOfRange(genreCount, rule.genrePercent)
  const forgottenMiss = forgottenActive && outOfRange(forgottenCount, rule.forgottenPercent)
  if (genreMiss && forgottenMiss) return ['Genre and forgotten-track targets cannot both be met with the available tracks.']
  if (genreMiss) return ['The selected genre share cannot be met with the available tracks.']
  if (forgottenMiss) return ['The selected forgotten-track share cannot be met with the available tracks.']
  return []
}

interface ArtistSelectionGroup {
  artistId: number | null
  candidates: readonly CustomMixCandidate[]
  count: number
}

type CandidateBuckets = [
  CustomMixCandidate[],
  CustomMixCandidate[],
  CustomMixCandidate[],
  CustomMixCandidate[],
]

interface ArtistBucketPlan {
  counts: [number, number, number, number]
  genreCount: number
  forgottenCount: number
}

function bucketCandidates(
  candidates: readonly CustomMixCandidate[],
  genrePool: ReadonlySet<string>,
  forgottenActive: boolean,
  nowSeconds: number,
  forgottenDays: readonly [number, number],
): CandidateBuckets {
  const groups: CandidateBuckets = [[], [], [], []]
  for (const candidate of candidates) {
    const genreMatch = matchesGenre(candidate, genrePool)
    const forgottenMatch = forgottenActive && isForgotten(candidate, nowSeconds, forgottenDays)
    const index = genreMatch ? (forgottenMatch ? 0 : 1) : (forgottenMatch ? 2 : 3)
    groups[index].push(candidate)
  }
  return groups
}

function fillArtistCounts(
  ids: readonly number[],
  counts: Map<number, number>,
  capacities: ReadonlyMap<number, number>,
  limits: ReadonlyMap<number, number>,
  size: number,
  random: RandomSource,
): void {
  const order = shuffled(ids, random)
  let remaining = size - [...counts.values()].reduce((sum, count) => sum + count, 0)
  while (remaining > 0) {
    const available = order.filter((id) => (counts.get(id) ?? 0) < Math.min(
      capacities.get(id) ?? 0,
      limits.get(id) ?? 0,
    ))
    if (available.length === 0) break
    const lowest = Math.min(...available.map((id) => counts.get(id) ?? 0))
    const tied = available.filter((id) => (counts.get(id) ?? 0) === lowest)
    for (const id of tied) {
      if (remaining === 0) break
      counts.set(id, (counts.get(id) ?? 0) + 1)
      remaining -= 1
    }
  }
}

/** Spread tracks evenly across selected artists when their combined minimum exceeds the mix. */
function allocateEvenly(
  artistIds: readonly number[],
  capacities: ReadonlyMap<number, number>,
  size: number,
  random: RandomSource,
): Map<number, number> {
  const ids = [...new Set(artistIds)]
  const counts = new Map<number, number>(ids.map((id) => [id, 0]))
  fillArtistCounts(ids, counts, capacities, capacities, size, random)
  return counts
}

function artistQuotaWarning(
  selected: readonly CustomMixCandidate[],
  rule: CustomMixRule,
): string[] {
  if (selected.length === 0 || rule.artistMode !== 'allow' || rule.artistIds.length === 0
    || isFullRange(rule.artistPercent, FULL_PERCENT_RANGE)) return []
  const size = selected.length
  const counts = new Map<number, number>()
  for (const candidate of selected) {
    const artistId = candidate.track.artistId
    if (artistId != null) counts.set(artistId, (counts.get(artistId) ?? 0) + 1)
  }
  const missed = [...new Set(rule.artistIds)].some((artistId) => {
    const percent = (counts.get(artistId) ?? 0) * 100 / size
    return percent < rule.artistPercent[0] - 1e-9 || percent > rule.artistPercent[1] + 1e-9
  })
  return missed ? ['The selected artist shares cannot be met with the available tracks.'] : []
}

/** Choose category counts after artist allocation so artist targets remain primary. */
function selectWithArtistShares(
  eligible: readonly CustomMixCandidate[],
  rule: CustomMixRule,
  size: number,
  genrePool: ReadonlySet<string>,
  genreActive: boolean,
  forgottenActive: boolean,
  nowSeconds: number,
  scores: ReadonlyMap<string, number>,
  random: RandomSource,
): CustomMixCandidate[] {
  const candidatesByArtist = new Map<number, CustomMixCandidate[]>()
  for (const candidate of eligible) {
    const id = candidate.track.artistId
    if (id == null) continue
    const group = candidatesByArtist.get(id) ?? []
    group.push(candidate)
    candidatesByArtist.set(id, group)
  }
  const artistIds = [...new Set(rule.artistIds)]
  const capacities = new Map(artistIds.map((id) => [id, candidatesByArtist.get(id)?.length ?? 0] as const))
  const otherCandidates = eligible.filter((candidate) => !artistIds.includes(candidate.track.artistId ?? -1))
  const minimumPercentTotal = rule.artistPercent[0] * artistIds.length
  const minimumCount = Math.ceil(size * rule.artistPercent[0] / 100 - 1e-9)
  const maximumCount = Math.floor(size * rule.artistPercent[1] / 100 + 1e-9)
  const aggregateImpossible = minimumPercentTotal > 100
    || minimumCount * artistIds.length > size
    || maximumCount < minimumCount
  let allocation: Map<number, number>
  let otherCount = 0
  if (aggregateImpossible) {
    allocation = allocateEvenly(artistIds, capacities, size, random)
    const selectedCount = [...allocation.values()].reduce((sum, count) => sum + count, 0)
    otherCount = Math.min(size - selectedCount, otherCandidates.length)
  } else {
    allocation = new Map<number, number>(artistIds.map((id) => [id, Math.min(minimumCount, capacities.get(id) ?? 0)]))
    const initialSelectedCount = [...allocation.values()].reduce((sum, count) => sum + count, 0)
    otherCount = Math.min(size - initialSelectedCount, otherCandidates.length)
    const maxCounts = new Map(artistIds.map((id) => [id, maximumCount] as const))
    const selectedCountAfterOther = initialSelectedCount + otherCount
    fillArtistCounts(
      artistIds,
      allocation,
      capacities,
      maxCounts,
      size - selectedCountAfterOther + initialSelectedCount,
      random,
    )
  }
  const groups = artistIds.flatMap((artistId): ArtistSelectionGroup[] => {
    const count = allocation.get(artistId) ?? 0
    const candidates = candidatesByArtist.get(artistId) ?? []
    return count > 0 ? [{ artistId, candidates, count }] : []
  })
  if (otherCount > 0) groups.push({ artistId: null, candidates: otherCandidates, count: otherCount })

  const candidatesByArtistAndBucket = groups.map((group) => ({
    group,
    buckets: bucketCandidates(group.candidates, genrePool, forgottenActive, nowSeconds, rule.forgottenDays),
  }))
  let states = new Map<string, { genre: number; forgotten: number; plans: ArtistBucketPlan[] }>([
    ['0:0', { genre: 0, forgotten: 0, plans: [] }],
  ])
  for (const { group, buckets } of candidatesByArtistAndBucket) {
    const options: ArtistBucketPlan[] = []
    const count = group.count
    for (let both = 0; both <= Math.min(buckets[0].length, count); both += 1) {
      for (let genreOnly = 0; genreOnly <= Math.min(buckets[1].length, count - both); genreOnly += 1) {
        for (let forgottenOnly = 0; forgottenOnly <= Math.min(buckets[2].length, count - both - genreOnly); forgottenOnly += 1) {
          const neither = count - both - genreOnly - forgottenOnly
          if (neither < 0 || neither > buckets[3].length) continue
          options.push({
            counts: [both, genreOnly, forgottenOnly, neither],
            genreCount: (genreActive ? both + genreOnly : 0),
            forgottenCount: (forgottenActive ? both + forgottenOnly : 0),
          })
        }
      }
    }
    const next = new Map<string, { genre: number; forgotten: number; plans: ArtistBucketPlan[] }>()
    for (const state of states.values()) {
      for (const option of options) {
        const genre = state.genre + option.genreCount
        const forgotten = state.forgotten + option.forgottenCount
        if (genre > size || forgotten > size) continue
        const key = `${genre}:${forgotten}`
        const existing = next.get(key)
        if (!existing || random.next() < 0.5) {
          next.set(key, { genre, forgotten, plans: [...state.plans, option] })
        }
      }
    }
    states = next
  }

  let bestScore = Number.POSITIVE_INFINITY
  let best: Array<{ genre: number; forgotten: number; plans: ArtistBucketPlan[] }> = []
  for (const state of states.values()) {
    const score = quotaDistance(state.genre, size, rule.genrePercent, genreActive)
      + quotaDistance(state.forgotten, size, rule.forgottenPercent, forgottenActive)
    if (score < bestScore) {
      bestScore = score
      best = [state]
    } else if (score === bestScore) {
      best.push(state)
    }
  }
  const choice = best[Math.floor(random.next() * best.length)]
  if (!choice) return []
  const selected: CustomMixCandidate[] = []
  choice.plans.forEach((plan, index) => {
    const { buckets } = candidatesByArtistAndBucket[index]
    plan.counts.forEach((count, bucketIndex) => {
      selected.push(...rankedTake(buckets[bucketIndex], count, scores, random))
    })
  })
  return selected
}

/** Generate a distinct, randomly ordered mix while keeping both quotas feasible together. */
export function generateCustomMix(
  rule: CustomMixRule,
  candidates: readonly CustomMixCandidate[],
  options: CustomMixGenerationOptions = {},
): CustomMixGenerationResult {
  const requestedCount = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_LIMIT, Math.floor(options.limit!)))
    : DEFAULT_LIMIT
  const errors = validateCustomMixRule(rule)
  if (errors.length > 0) return { tracks: [], warnings: errors, requestedCount, actualCount: 0 }
  if (requestedCount === 0) return { tracks: [], warnings: [], requestedCount, actualCount: 0 }

  const now = currentDate(options.now)
  const nowSeconds = now.getTime() / 1000
  const allCandidates = [...candidates]
    .filter((candidate) => candidate.track.source === 'local' || candidate.metadataTrusted)
    .slice()
    .sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)))
  const unique = new Map<string, CustomMixCandidate>()
  for (const candidate of allCandidates) {
    const key = candidateKey(candidate)
    if (!unique.has(key)) unique.set(key, candidate)
  }
  const eligible = [...unique.values()].filter((candidate) => passesHardFilters(candidate, rule, now))
  const actualCount = Math.min(requestedCount, eligible.length)
  const warnings = eligible.length < requestedCount
    ? [`Only ${eligible.length} ${eligible.length === 1 ? 'track matches' : 'tracks match'} these rules; ${requestedCount} requested.`]
    : []
  if (actualCount === 0) return { tracks: [], warnings, requestedCount, actualCount: 0 }

  const random = createRandomSource(options.seed)
  const genrePool = new Set(rule.genreMode === 'allow'
    ? rule.genres.map((genre) => genre.trim().toLocaleLowerCase()).filter(Boolean)
    : [])
  const genreActive = genrePool.size > 0 && !isFullRange(rule.genrePercent, FULL_PERCENT_RANGE)
  const forgottenActive = rule.specials.includes('forgotten')
    && !isFullRange(rule.forgottenPercent, FULL_PERCENT_RANGE)
  const scores = specialScores([...unique.values()], rule, nowSeconds)
  const artistSharesActive = rule.artistMode === 'allow' && rule.artistIds.length > 0
    && !isFullRange(rule.artistPercent, FULL_PERCENT_RANGE)
  let selected: CustomMixCandidate[]
  if (artistSharesActive) {
    selected = selectWithArtistShares(
      eligible,
      rule,
      actualCount,
      genrePool,
      genreActive,
      forgottenActive,
      nowSeconds,
      scores,
      random,
    )
    warnings.push(...artistQuotaWarning(selected, rule))
    if (selected.length < actualCount) {
      const fit = selected.length === 1 ? 'track fits' : 'tracks fit'
      warnings.push(`Only ${selected.length} ${fit} the selected artist shares; ${requestedCount} requested.`)
    }
  } else {
    const groups = bucketCandidates(eligible, genrePool, forgottenActive, nowSeconds, rule.forgottenDays)
    const counts = chooseQuotaCounts(
      groups.map((group) => group.length) as [number, number, number, number],
      actualCount,
      rule.genrePercent,
      rule.forgottenPercent,
      genreActive,
      forgottenActive,
      random,
    )
    selected = [
      ...rankedTake(groups[0], counts.both, scores, random),
      ...rankedTake(groups[1], counts.genreOnly, scores, random),
      ...rankedTake(groups[2], counts.forgottenOnly, scores, random),
      ...rankedTake(groups[3], counts.neither, scores, random),
    ]
  }
  warnings.push(...quotaWarning(selected, genrePool, rule, nowSeconds))
  const tracks = shuffled(selected, random).map((candidate) => candidate.track)
  return { tracks, warnings, requestedCount, actualCount: tracks.length }
}

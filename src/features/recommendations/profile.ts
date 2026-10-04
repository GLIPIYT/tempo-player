import { normalizeRecordingText } from './identity'
import type { FeedCandidate } from './storage'
import type { LanguageEvidence, RecommendationContext, RecommendationSeed, RecommendationTrack } from './types'

const DAY = 86_400_000
const CYRILLIC_SCRIPT_LANGUAGE = 'und-Cyrl'
const CYRILLIC_LANGUAGE_CODES = new Set(['rus', 'ukr', 'bul', 'bel', 'mkd', 'srp', 'kaz', 'kir'])
export interface TasteTrack {
  track: RecommendationTrack; weight: number; confidence: number; at: number
  bucket: 'steady' | 'recent' | 'discovery'
}
export interface TasteProfile {
  tracks: TasteTrack[]; seeds: RecommendationSeed[]; languages: Record<string, number>
  /** Best-known language per seed, including weak title-script inference. */
  seedLanguages?: Record<string, string>
  languageConfidence: number; unknownShare: number; confidence: number
  artists: Record<string, number>; genres: Record<string, number>; tags: Record<string, number>
  versions: Record<string, number>; tempo: number | null
  features: Map<string, RecommendationContext['features'][number]>
  groups: Record<string, string>
}
export interface TasteContext extends RecommendationContext { sessionStartedAt?: number }
type SeedBucket = TasteTrack['bucket']
const canonical = (context: RecommendationContext, key: string) => context.canonicalGroups?.[key]
  ?? context.recordingGroups?.find(group => group.trackKeys.includes(key))?.groupKey ?? key
const decay = (at: number, now: number) => Math.pow(0.5, Math.max(0, now - at) / (45 * DAY))
const norm = normalizeRecordingText

function titleScriptLanguage(title: string): string | null {
  const letters = title.match(/\p{L}/gu)?.length ?? 0
  const cyrillic = title.match(/\p{Script=Cyrillic}/gu)?.length ?? 0
  return letters >= 3 && cyrillic / letters >= 0.65 ? CYRILLIC_SCRIPT_LANGUAGE : null
}

function strongestLanguage(evidence: LanguageEvidence | undefined): [string, number] | null {
  if (!evidence || evidence.evidence.translated || evidence.confidence < 0.2) return null
  const [code, share] = Object.entries(evidence.distribution).sort((a, b) => b[1] - a[1])[0] ?? []
  return code && share >= 0.4 ? [code, share] : null
}

/** Weighted deficit order, redistributing missing buckets among the available ones. */
export function mixBuckets<T>(pools: T[][], weights: number[], limit = Infinity): T[] {
  const result: T[] = [], counts = pools.map(() => 0)
  while (result.length < limit && pools.some(pool => pool.length)) {
    const active = pools.map((pool, index) => pool.length ? index : -1).filter(index => index >= 0)
    const total = active.reduce((sum, index) => sum + weights[index], 0)
    const index = active.reduce((best, next) => {
      const debt = (i: number) => weights[i] / total * (result.length + 1) - counts[i]
      return debt(next) > debt(best) ? next : best
    }, active[0])
    result.push(pools[index].shift()!); counts[index] += 1
  }
  return result
}

export function buildTasteProfile(context: TasteContext, now: number): TasteProfile {
  const features = new Map(context.features.map(feature => [feature.trackKey, feature]))
  const groups = { ...context.canonicalGroups }
  const catalogFor = (track: RecommendationTrack) => {
    const feature = features.get(track.trackKey) ?? [...features.values()].find(value => canonical(context, value.trackKey) === canonical(context, track.trackKey))
    return (feature?.data.catalog ?? feature?.data) as Record<string, unknown> | undefined
  }
  // Cohorts coalesce versions into a family for evidence only. Playback identity
  // still keeps original/remix recordings distinct.
  const familyOf = (track: RecommendationTrack) => {
    const identity = catalogFor(track)?.identity as { artist?: string; title?: string } | undefined
    const artist = norm(identity?.artist ?? track.artists[0] ?? '')
    const title = norm(identity?.title ?? track.title).replace(/\s*[([][^()[\]]*(?:remix|live|slowed|sped[ -]?up|cover|instrumental|acoustic|edit)[^()[\]]*[)\]]/gu, '').trim()
    return artist && title ? `${artist}|${title}` : canonical(context, track.trackKey)
  }
  const qualified = [...new Map(context.sessions.map(event => [event.id, event])).values()].filter(event => event.endReason !== 'error' && (event.durationSec ?? 0) >= 15
    && event.coveredSec / event.durationSec! >= 0.5 && event.elapsedSec >= Math.min(30, event.durationSec! * 0.8))
  const listeningDays = new Map<string, Set<number>>()
  for (const event of qualified) {
    const group = canonical(context, event.trackKey), days = listeningDays.get(group) ?? new Set<number>()
    days.add(Math.floor(event.startedAt / DAY)); listeningDays.set(group, days)
  }
  for (const day of context.tasteDays ?? []) if (day.weight >= 0.5) {
    const group = canonical(context, day.trackKey), days = listeningDays.get(group) ?? new Set<number>()
    days.add(Math.floor(day.at / DAY)); listeningDays.set(group, days)
  }
  const confirmedListeningGroups = new Set([...listeningDays].filter(([, days]) => days.size >= 2).map(([group]) => group))
  const evidenceTracks = [...context.seedTracks.filter(seed => seed.evidence === 'like' || seed.evidence === 'playlist').map(seed => seed.track),
    ...qualified.map(event => event.track)]
  const artistFamilies = new Map<string, Set<string>>(), genreFamilies = new Map<string, Set<string>>()
  for (const track of evidenceTracks) {
    if ((track.durationSec ?? 0) < 15) continue
    const family = familyOf(track)
    for (const artist of track.artists.map(norm).filter(Boolean)) {
      const cohort = artistFamilies.get(artist) ?? new Set<string>(); cohort.add(family); artistFamilies.set(artist, cohort)
    }
    const traits = catalogFor(track)?.traits as RecommendationTrack['traits']
    const genre = norm(traits?.genre ?? track.traits?.genre ?? '')
    if (genre) { const cohort = genreFamilies.get(genre) ?? new Set<string>(); cohort.add(family); genreFamilies.set(genre, cohort) }
  }
  const confirmedArtist = (artist: string) => (artistFamilies.get(norm(artist))?.size ?? 0) >= 2
  const listeningArtistFamilies = new Map<string, Set<string>>()
  for (const event of qualified) for (const artist of event.track.artists.map(norm).filter(Boolean)) {
    const cohort = listeningArtistFamilies.get(artist) ?? new Set<string>()
    cohort.add(familyOf(event.track)); listeningArtistFamilies.set(artist, cohort)
  }
  const limitedLike = (track: RecommendationTrack) => !confirmedListeningGroups.has(canonical(context, track.trackKey))
    && !track.artists.some(artist => (listeningArtistFamilies.get(norm(artist))?.size ?? 0) >= 2)
  const records = new Map<string, { track: RecommendationTrack; long: number; session: number; confidence: number; at: number; discovery: boolean }>()
  const sessionStart = context.sessionStartedAt ?? now - 6 * 60 * 60_000
  const days = new Map<string, { track: RecommendationTrack; at: number; listen: number; listenCap: number; action: number; sessionListen: number; sessionAction: number; confidence: number; discovery: boolean }>()
  const likeFamilies = new Map<string, number>(), likeArtists = new Map<string, number>()
  const addLike = (track: RecommendationTrack, at: number, discovery: boolean) => {
    const clip = (track.durationSec ?? 0) > 0 && track.durationSec! < 15
    const amount = clip ? 0.1 : limitedLike(track) ? 0.35 : 1
    const day = Math.floor(at / DAY), family = `${familyOf(track)}|${day}`
    const artist = `${norm(track.artists[0] ?? canonical(context, track.trackKey))}|${day}`
    const contribution = Math.max(0, Math.min(amount - (likeFamilies.get(family) ?? 0), 1 - (likeArtists.get(artist) ?? 0)))
    if (!contribution) return
    likeFamilies.set(family, (likeFamilies.get(family) ?? 0) + contribution)
    likeArtists.set(artist, (likeArtists.get(artist) ?? 0) + contribution)
    addDay(track, at, contribution, clip ? 0.1 : limitedLike(track) ? 0.35 : 0.8, 'action', discovery)
  }
  const addDay = (track: RecommendationTrack, at: number, amount: number, confidence: number, kind: 'listen' | 'action', discovery: boolean, listenCap = 1) => {
    if (kind === 'listen' && track.durationSec != null && track.durationSec > 0 && track.durationSec < 15) {
      listenCap = Math.min(listenCap, 0.1)
      confidence = Math.min(confidence, 0.1)
    }
    const group = canonical(context, track.trackKey); groups[track.trackKey] = group
    const dayKey = `${group}|${Math.floor(at / DAY)}`
    const item = days.get(dayKey) ?? { track, at, listen: 0, listenCap: 1, action: 0, sessionListen: 0, sessionAction: 0, confidence: 0, discovery: false }
    if (kind === 'listen') item.listenCap = Math.min(item.listenCap, listenCap)
    item[kind] = Math.min(kind === 'listen' ? item.listenCap : 4, item[kind] + amount)
    item.listen = Math.min(item.listen, item.listenCap)
    if (at >= sessionStart) {
      const sessionKind = kind === 'listen' ? 'sessionListen' : 'sessionAction'
      item[sessionKind] = Math.min(kind === 'listen' ? item.listenCap : 4, item[sessionKind] + amount)
    }
    item.sessionListen = Math.min(item.sessionListen, item.listenCap)
    item.at = Math.max(item.at, at); item.confidence = Math.max(item.confidence, confidence)
    item.discovery ||= discovery; days.set(dayKey, item)
  }
  const currentLikes = new Set(context.likedTrackKeys.map(key => canonical(context, key)))
  const detailedTasteDays = new Set((context.tasteDays ?? []).map(day => `${canonical(context, day.trackKey)}|${Math.floor(day.at / DAY)}`))
  for (const seed of context.seedTracks) {
    if (seed.evidence === 'like' || seed.evidence === 'playlist') {
      // Current likes/manual membership survive history reset; imported membership is not provided as manual.
      if (seed.evidence === 'like') addLike(seed.track, seed.at, false)
      else addDay(seed.track, seed.at, 2, seed.confidence, 'action', false)
    } else if (seed.evidence === 'legacy') addDay(seed.track, seed.at, 0.2, 0.25, 'listen', false)
    // Archived taste contains positive history older than the per-day retention
    // window. The context always supplies tasteDays (often for other tracks),
    // so compare the same canonical track/day to avoid dropping or double-counting it.
    else if (seed.evidence === 'aggregate'
      && !detailedTasteDays.has(`${canonical(context, seed.track.trackKey)}|${Math.floor(seed.at / DAY)}`)) {
      addDay(seed.track, seed.at, Math.min(1, seed.weight), 0.5, 'listen', false)
    }
  }
  const tracks = new Map([...context.seedTracks.map(seed => [seed.track.trackKey, seed.track] as const),
    ...context.sessions.map(event => [event.trackKey, event.track] as const)])
  for (const day of context.tasteDays ?? []) {
    const track = tracks.get(day.trackKey)
    if (track) addDay(track, day.at, Math.min(1, day.weight), 0.7, 'listen', false)
  }
  const skips = new Map<string, number[]>()
  // Latest unique session revision only; checkpoint growth replaces earlier coverage.
  const sessions = new Map(context.sessions.map(event => [event.id, event]))
  for (const event of sessions.values()) {
    if (event.endReason === 'error') continue
    const duration = event.durationSec ?? 0, coverage = duration > 0 ? Math.min(1, event.coveredSec / duration) : 0
    const group = canonical(context, event.trackKey)
    if (event.finished && ['next', 'select'].includes(event.endReason ?? '')
      && event.elapsedSec < Math.min(30, duration > 0 ? duration * 0.2 : 30)) {
      skips.set(group, [...(skips.get(group) ?? []), event.startedAt])
    }
    if (duration <= 0 || coverage < 0.5 || event.elapsedSec < Math.min(30, duration * 0.8)) continue
    const shortWeight = duration < 15 ? 0.1 : 1
    addDay(event.track, event.startedAt, coverage * shortWeight * (event.startReason === 'autoplay' ? 0.7 : 1), duration < 15 ? 0.1 : 0.9,
      'listen', !!event.track.provenance?.recommendationId || ['home', 'radio'].includes(event.track.provenance?.origin ?? ''), shortWeight)
  }
  for (const action of context.explicitActions ?? []) {
    if (action.generation !== context.generation || action.intent !== 'manual' || action.action === 'unlike') continue
    if (action.action === 'like' && !currentLikes.has(canonical(context, action.trackKey))) continue
    const discovery = !!action.track.provenance?.recommendationId || ['home', 'radio'].includes(action.track.provenance?.origin ?? '')
    if (action.action === 'like') addLike(action.track, action.at, discovery)
    else addDay(action.track, action.at, action.action === 'cache' ? 0.25 : 2, 1, 'action', discovery)
  }
  for (const item of days.values()) {
    const group = canonical(context, item.track.trackKey)
    const record = records.get(group) ?? { track: item.track, long: 0, session: 0, confidence: 0, at: 0, discovery: false }
    const amount = Math.min(4, item.listen + item.action)
    record.long += amount * decay(item.at, now)
    record.session += Math.min(4, item.sessionListen + item.sessionAction)
    record.confidence = Math.max(record.confidence, item.confidence); record.at = Math.max(record.at, item.at)
    record.discovery ||= item.discovery; records.set(group, record)
  }
  const longTotal = [...records.values()].reduce((sum, item) => sum + item.long, 0)
  const sessionTotal = [...records.values()].reduce((sum, item) => sum + item.session, 0)
  const tasteTracks: TasteTrack[] = []
  for (const [group, item] of records) {
    const times = (skips.get(group) ?? []).sort((a, b) => a - b)
    const rapid = times.filter((at, index) => index > 0 && at - times[index - 1] <= 24 * 60 * 60_000 && at > now - 14 * DAY).length
    const weight = (0.7 * item.long / Math.max(1, longTotal) + 0.3 * item.session / Math.max(1, sessionTotal)) * Math.pow(0.65, Math.min(3, rapid))
    if (weight <= 0) continue
    const bucket: SeedBucket = item.discovery && item.at >= now - 30 * DAY ? 'discovery'
      : item.at >= sessionStart && !currentLikes.has(group) ? 'recent' : 'steady'
    tasteTracks.push({ track: item.track, weight, confidence: item.confidence, at: item.at, bucket })
  }
  tasteTracks.sort((a, b) => b.weight - a.weight || b.at - a.at)
  const profile: TasteProfile = { tracks: tasteTracks, seeds: [], languages: {}, languageConfidence: 0, unknownShare: 1,
    confidence: Math.min(1, [...days.values()].reduce((sum, item) => sum + Math.min(1, item.listen + item.action) * item.confidence, 0) / 12),
    artists: {}, genres: {}, tags: {}, versions: {}, tempo: null, features, groups }
  let languageTotal = 0, known = 0, tempoSum = 0, tempoWeight = 0
  const seedLanguages: Record<string, string> = {}
  const add = (map: Record<string, number>, value: string, weight: number) => { if (norm(value)) map[norm(value)] = (map[norm(value)] ?? 0) + weight }
  for (const item of tasteTracks) {
    const feature = features.get(item.track.trackKey) ?? [...features.values()].find(value => canonical(context, value.trackKey) === canonical(context, item.track.trackKey))
    const catalog = (feature?.data.catalog ?? feature?.data) as Record<string, unknown> | undefined
    const traits = { ...item.track.traits, ...(catalog?.traits as RecommendationTrack['traits']) }
    const language = feature?.data.language as unknown as LanguageEvidence | undefined
    const weight = item.weight * item.confidence
    // Language is a slow-moving preference. Square-root and cap each track's
    // vote so a few freshly liked tracks cannot rewrite the listener's profile.
    const languageWeight = Math.min(0.08, Math.sqrt(Math.max(0, item.weight))) * item.confidence
    languageTotal += languageWeight
    for (const artist of item.track.artists) add(profile.artists, artist, weight)
    const supported = confirmedListeningGroups.has(canonical(context, item.track.trackKey)) || item.track.artists.some(confirmedArtist)
    if (traits?.genre && (genreFamilies.get(norm(traits.genre))?.size ?? 0) >= 2) add(profile.genres, traits.genre, weight)
    if (supported) {
      for (const tag of traits?.tags ?? []) add(profile.tags, tag, weight)
      if (traits?.version) add(profile.versions, traits.version, weight)
      if (traits?.bpm && traits.bpm >= 30 && traits.bpm <= 300) { tempoSum += traits.bpm * weight; tempoWeight += weight }
    }
    const learnedLanguage = strongestLanguage(language)
    if (language && language.confidence >= 0.2 && !language.evidence.translated) {
      for (const [code, share] of Object.entries(language.distribution)) {
        profile.languages[code] = (profile.languages[code] ?? 0) + share * language.confidence * languageWeight
      }
      known += languageWeight * language.confidence * (1 - language.unknownShare)
      if (learnedLanguage) seedLanguages[item.track.trackKey] = learnedLanguage[0]
    } else {
      // Lyric metadata is often absent for older Russian tracks. Cyrillic in
      // the song title is useful weak evidence; artist names/handles are not.
      const inferred = titleScriptLanguage(item.track.title)
      if (inferred) {
        const confidence = 0.45
        profile.languages[inferred] = (profile.languages[inferred] ?? 0) + confidence * languageWeight
        known += confidence * languageWeight
        seedLanguages[item.track.trackKey] = inferred
      }
    }
  }
  profile.seedLanguages = seedLanguages
  profile.unknownShare = languageTotal ? Math.max(0, 1 - known / languageTotal) : 1
  profile.languageConfidence = languageTotal ? known / languageTotal * profile.confidence : 0
  const knownCyrillicLanguage = Object.entries(profile.languages)
    .filter(([code, weight]) => CYRILLIC_LANGUAGE_CODES.has(code) && weight > 0)
    .sort((a, b) => b[1] - a[1])[0]?.[0]
  if (knownCyrillicLanguage && profile.languages[CYRILLIC_SCRIPT_LANGUAGE]) {
    profile.languages[knownCyrillicLanguage] += profile.languages[CYRILLIC_SCRIPT_LANGUAGE]
    delete profile.languages[CYRILLIC_SCRIPT_LANGUAGE]
    for (const [trackKey, code] of Object.entries(seedLanguages)) {
      if (code === CYRILLIC_SCRIPT_LANGUAGE) seedLanguages[trackKey] = knownCyrillicLanguage
    }
  }
  const languageMass = Object.values(profile.languages).reduce((sum, value) => sum + value, 0)
  for (const code of Object.keys(profile.languages)) profile.languages[code] /= languageMass || 1
  profile.tempo = tempoWeight ? tempoSum / tempoWeight : null
  const pools = (['steady', 'recent', 'discovery'] as const).map(bucket => tasteTracks.filter(item => item.bucket === bucket)
    .map(item => ({ track: item.track, weight: item.weight, confidence: item.confidence, at: item.at, bucket,
      limitedEvidence: (item.track.durationSec != null && item.track.durationSec > 0 && item.track.durationSec < 15)
        || (currentLikes.has(canonical(context, item.track.trackKey)) && limitedLike(item.track)),
      evidence: (currentLikes.has(canonical(context, item.track.trackKey)) ? 'like' : 'listening') as RecommendationSeed['evidence'] })))
  profile.seeds = mixBuckets(pools, [0.6, 0.25, 0.15], 40)
  // Reserve actual secondary-language seeds before trimming to the source budget.
  for (const code of Object.keys(profile.languages)) {
    const seed = tasteTracks.find(item => seedLanguages[item.track.trackKey] === code)
    if (seed && !profile.seeds.some(item => item.track.trackKey === seed.track.trackKey)) {
      if (profile.seeds.length >= 40) profile.seeds.pop()
      profile.seeds.push({ ...seed, evidence: 'listening', limitedEvidence: seed.track.durationSec != null && seed.track.durationSec > 0 && seed.track.durationSec < 15
        || (currentLikes.has(canonical(context, seed.track.trackKey)) && limitedLike(seed.track)) })
    }
  }
  // Put minority-language queries near the front. The resolver uses an early
  // capped frontier, so appending a secondary-language seed to the end did not
  // protect the first recommendations from a recent like streak.
  const languagePools = new Map<string, RecommendationSeed[]>()
  const unknownSeeds: RecommendationSeed[] = []
  for (const seed of profile.seeds) {
    const code = seedLanguages[seed.track.trackKey]
    if (!code || profile.languages[code] === undefined) { unknownSeeds.push(seed); continue }
    const pool = languagePools.get(code) ?? []
    pool.push(seed); languagePools.set(code, pool)
  }
  if (languagePools.size + Number(unknownSeeds.length > 0) > 1) {
    const pools = [...languagePools.entries()]
    const seedPools = pools.map(([, pool]) => pool)
    const weights = pools.map(([code]) => profile.languages[code])
    if (unknownSeeds.length) {
      seedPools.push(unknownSeeds)
      weights.push(Math.min(0.2, Math.max(0.05, profile.unknownShare)))
    }
    profile.seeds = mixBuckets(seedPools, weights, 40)
  }
  return profile
}

export function candidateScore(candidate: Readonly<FeedCandidate>, profile: TasteProfile): number {
  const max = (values: Record<string, number>) => Math.max(...Object.values(values), 0.001)
  const relative = (values: Record<string, number>, value: string | null | undefined) => value ? (values[norm(value)] ?? 0) / max(values) : 0
  const seedKeys = [...new Set([candidate.seedTrackKey, ...(candidate.supportingSeedTrackKeys ?? [])])]
  const seedScores = seedKeys.flatMap(key => {
    const seed = profile.seeds.find(item => item.track.trackKey === key)
    return seed ? [seed.weight * seed.confidence * (seed.limitedEvidence ? 0.25 : 1)] : []
  })
  const strongestSeedScore = Math.max(0, ...seedScores)
  // Several independent related queries returning the same track is stronger
  // evidence than a hit from only one seed, while one weak seed cannot dominate.
  let score = strongestSeedScore + (seedScores.reduce((sum, value) => sum + value, 0) - strongestSeedScore) * 0.35
  let affinityScore = relative(profile.artists, candidate.identity.artist) * 0.6
  affinityScore += relative(profile.genres, candidate.track.genre) * 0.25
  affinityScore += Math.max(0, ...(candidate.track.tags ?? []).map(tag => relative(profile.tags, tag))) * 0.15
  affinityScore += relative(profile.versions, candidate.identity.version) * 0.1
  if (profile.tempo && candidate.track.bpm) affinityScore += Math.max(0, 1 - Math.abs(candidate.track.bpm - profile.tempo) / 60) * 0.1
  score += affinityScore * profile.confidence
  const language = candidateLanguage(candidate, profile)
  if (language) score += 0.12 * (profile.languages[language] ?? 0) * profile.languageConfidence
  return score
}

function languageFeature(key: string, profile: TasteProfile): LanguageEvidence | undefined {
  const group = profile.groups[key]
  const feature = profile.features.get(key)
    ?? (group ? [...profile.features.values()].find(item => profile.groups[item.trackKey] === group) : undefined)
  return feature?.data.language as unknown as LanguageEvidence | undefined
}

function candidateLanguage(candidate: Readonly<FeedCandidate>, profile: TasteProfile): string | null {
  const key = `soundcloud:${candidate.track.id}`
  const group = profile.groups[key] ?? candidate.groupKey
  const feature = profile.features.get(key)
    ?? [...profile.features.values()].find(item => profile.groups[item.trackKey] === group)
  const direct = strongestLanguage(feature?.data.language as unknown as LanguageEvidence | undefined)
  if (direct) return direct[0]

  // Short metadata is too weak for a language detector, but Cyrillic script
  // reliably separates Russian-language catalogue items from Latin titles.
  if (titleScriptLanguage(candidate.track.title)) {
    const learned = Object.entries(profile.languages).filter(([code, weight]) => CYRILLIC_LANGUAGE_CODES.has(code) && weight > 0)
      .sort((a, b) => b[1] - a[1])[0]
    return learned?.[0] ?? CYRILLIC_SCRIPT_LANGUAGE
  }

  const scores: Record<string, number> = {}
  for (const seedKey of new Set([candidate.seedTrackKey, ...(candidate.supportingSeedTrackKeys ?? [])])) {
    const evidence = languageFeature(seedKey, profile)
    if (evidence?.evidence.translated || (evidence && evidence.confidence < 0.2)) continue
    const seed = profile.seeds.find(item => item.track.trackKey === seedKey)
    const weight = (seed?.weight ?? 1) * (seed?.confidence ?? 1) * (evidence?.confidence ?? 1)
    const code = profile.seedLanguages?.[seedKey] ?? strongestLanguage(evidence)?.[0]
    if (code) scores[code] = (scores[code] ?? 0) + weight
  }
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  return entries[0] && total > 0 && entries[0][1] / total >= 0.55 ? entries[0][0] : null
}

function interleaveLanguages(ordered: FeedCandidate[], profile: TasteProfile): FeedCandidate[] {
  if (profile.languageConfidence < 0.05) return ordered
  const codes = Object.keys(profile.languages).filter(code => profile.languages[code] > 0)
  if (!codes.length) return ordered
  const pools = new Map(codes.map(code => [code, [] as FeedCandidate[]]))
  const unknown: FeedCandidate[] = []
  for (const candidate of ordered) {
    const code = candidateLanguage(candidate, profile)
    const pool = code ? pools.get(code) : undefined
    if (pool) pool.push(candidate)
    else unknown.push(candidate)
  }
  const active = [...pools.entries()].filter(([, pool]) => pool.length > 0)
  if (active.length + Number(unknown.length > 0) < 2) return ordered
  const activePools = active.map(([, pool]) => pool)
  const weights = active.map(([code]) => profile.languages[code])
  if (unknown.length) {
    activePools.push(unknown)
    weights.push(Math.max(0.1, Math.min(0.25, profile.unknownShare)))
  }
  return mixBuckets(activePools, weights)
}

/** Rebalances a previously published batch without filtering or dropping cards. */
export function rebalanceCandidateLanguages(candidates: FeedCandidate[], profile: TasteProfile): FeedCandidate[] {
  return interleaveLanguages(candidates, profile)
}

export function rankCandidates(candidates: FeedCandidate[], profile: TasteProfile,
  history: { seedTrackKey: string }[] = []): FeedCandidate[] {
  const ordered = candidates.slice().sort((a, b) => candidateScore(b, profile) - candidateScore(a, profile) || a.addedAt - b.addedAt)
  const limited = (item: FeedCandidate) => !!profile.seeds.find(seed => seed.track.trackKey === item.seedTrackKey)?.limitedEvidence
  const priorWindow = history.slice(-19)
  const priorWeak = priorWindow.filter(item => !!profile.seeds.find(seed => seed.track.trackKey === item.seedTrackKey)?.limitedEvidence).length
  const supportedCount = ordered.filter(item => !limited(item)).length + priorWindow.length - priorWeak
  // At most 4 weak suggestions among a 20-card mixed publication (<=20%).
  // With no listening baseline, expose only two exploration cards per window.
  const weakQuota = Math.max(0, (supportedCount ? Math.min(4, Math.floor(supportedCount / 4)) : 2) - priorWeak)
  let weakCount = 0
  const weakArtists = new Map<string, number>()
  const sorted = ordered.filter(item => {
    if (!limited(item)) return true
    const artist = item.identity.artist ?? item.seedTrackKey
    const count = weakArtists.get(artist) ?? 0
    if (weakCount >= weakQuota || count >= 2) return false
    weakCount += 1; weakArtists.set(artist, count + 1); return true
  })
  const bucket = (candidate: FeedCandidate) => profile.seeds.find(seed => seed.track.trackKey === candidate.seedTrackKey)?.bucket ?? 'steady'
  const pools = (['steady', 'recent', 'discovery'] as const).map(kind => sorted.filter(item => bucket(item) === kind))
  // Carry the prior published prefix's bucket debt to avoid resetting proportions at every page.
  const prior = history.slice(-20), result: FeedCandidate[] = []
  const weights = [0.75, 0.15, 0.1], kinds = ['steady', 'recent', 'discovery'] as const
  const counts = kinds.map(kind => prior.filter(item => profile.seeds.find(seed => seed.track.trackKey === item.seedTrackKey)?.bucket === kind).length)
  while (pools.some(pool => pool.length)) {
    const active = pools.map((pool, index) => pool.length ? index : -1).filter(index => index >= 0)
    const total = active.reduce((sum, index) => sum + weights[index], 0)
    const index = active.reduce((best, next) => weights[next] / total * (prior.length + result.length + 1) - counts[next]
      > weights[best] / total * (prior.length + result.length + 1) - counts[best] ? next : best, active[0])
    result.push(pools[index].shift()!); counts[index] += 1
  }
  return interleaveLanguages(result, profile)
}

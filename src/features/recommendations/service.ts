import { api } from '../../api/client'
import { onSoundcloudCacheReady } from '../../api/events'
import { libraryVersion } from '../../utils/libraryVersion'
import { scTrackToUnified } from '../../utils/unified'
import type { ScTrack, UnifiedTrack } from '../../types/models'
import { chooseRepresentative, duplicateConfidence, normalizeRecordingText, recordingIdentity } from './identity'
import { compactScTrack, FEED_CACHE_TTL_MS, FEED_LIMITS, MAX_PENDING_RECOMMENDATION_WRITES, hydrateRecommendationState, RecommendationStorage,
  type FeedCandidate, type SeedFrontier, type StoredRecommendationState } from './storage'
import type { RecordingIdentity, RecommendationContext, RecommendationFeature, RecommendationImpression, RecommendationSeed } from './types'
import { RecommendationReceipts } from './receipts'
import { buildTasteProfile, candidateScore, favoriteGenre as getFavoriteGenre, rankCandidates, rebalanceCandidateLanguages, type TasteProfile } from './profile'
import { detectLyricLanguages, type LyricEvidenceSource } from './language'
import { analyzeCachedRecommendationTrack } from './audio'
import { flushFeedbackOperations, stopFeedbackOperations, type ExplicitActionIntent } from './feedbackBridge'
import { recommendationTrack, type ExplicitActionKind, type FeatureSectionUpdate, type LanguageEvidence, type ListeningEvent, type RecommendationTrack } from './types'

const DAY = 86400_000
const PUBLISH_SIZE = 20
const LOW_WATER = 30
const PAGE_BUDGET = 6
const DISCOVERY_SEED_LIMIT = 3
const PROFILE_SEED_LIMIT = FEED_LIMITS.seeds - DISCOVERY_SEED_LIMIT
const MIN_DISCOVERY_SEED_SCORE = 0.005
const CACHE_FLAG_TTL = 60_000
const WRITE_BATCH = 100
const MAX_PENDING_ACTIONS = 5000
const MAX_LANGUAGE_JOBS = 5000
const RECOMMENDATION_ENDPOINTS = new Set(['related', 'station', 'search', 'track-hydration'])
const keyOf = (track: ScTrack) => `soundcloud:${track.id}`
const playable = (track: ScTrack) => track.streamable && (track.hasProgressive || track.hasHls)
const isUnavailableRecommendationSource = (status: unknown, endpoint: unknown) =>
  (status === 400 || status === 404) && typeof endpoint === 'string' && RECOMMENDATION_ENDPOINTS.has(endpoint)
const message = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  try { return JSON.stringify(cause) ?? String(cause) } catch { return String(cause) }
}
const catalogOf = (feature: RecommendationFeature) => (feature.data.catalog ?? feature.data) as Record<string, unknown>
// Fixed-size cursor signatures keep active frontier history inside the state budget.
function signature(input: string): string {
  let a = 2166136261, b = 5381
  for (const character of input) { a = Math.imul(a ^ character.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ character.charCodeAt(0) }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`
}
function cursorKey(seed: SeedFrontier): string {
  const scope = signature(`${seed.seed.track.trackKey}:${seed.seedId}:${seed.source}`)
  return `${scope}:${signature(seed.cursor ?? '<first>')}`
}
export interface RecommendationSnapshot {
  tracks: ScTrack[]
  favoriteGenre: { key: string; label: string } | null
  loading: boolean
  error: string | null
  persistenceError: string | null
  hasLoaded: boolean
  hasMore: boolean
  exhausted: boolean
  retryAt: number | null
  revision: number
  cachedTrackIds: ReadonlySet<string>
}
export interface RadioReservation {
  track: UnifiedTrack
  trackKey: string
  recordingGroup: string
  commit: () => void
  release: () => void
}
export type CandidateRanker = (candidate: Readonly<FeedCandidate>) => number

class RecommendationService {
  private listeners = new Set<() => void>()
  private snapshot: RecommendationSnapshot = { tracks: [], favoriteGenre: null, loading: false, error: null, persistenceError: null, hasLoaded: false,
    hasMore: true, exhausted: false, retryAt: null, revision: 0, cachedTrackIds: new Set() }
  private candidates: FeedCandidate[] = []
  private published: FeedCandidate[] = []
  private discoveryPool: FeedCandidate[] = []
  private frontier: SeedFrontier[] = []
  private expandedSeedKeys = new Set<string>()
  private usedCursors = new Set<string>()
  private sessionSeen = new RecommendationReceipts()
  private radioSeen = new RecommendationReceipts()
  private radioRecent: FeedCandidate[] = []
  private seedBucketCounts = [0, 0, 0]
  private seedLanguageCounts = new Map<string, number>()
  private seedLanguageContextKey = ''
  private reservations = new Map<string, symbol>()
  private aliases = new Map<string, string>()
  private cooldowns = new Map<string, number>()
  private skipCooldowns = new Map<string, number>()
  private homeCooldownOverflow = new RecommendationReceipts(8192)
  private skipCooldownOverflow = new RecommendationReceipts(8192)
  private homeCooldownOverflowUntil = 0
  private skipCooldownOverflowUntil = 0
  private features = new Map<string, RecommendationFeature>()
  private ranker: CandidateRanker = () => 0
  private generation = 0
  private epoch = 0
  private createdAt = Date.now()
  private contextKey = ''
  private lastBadRequest: string | null = null
  private initialized = false
  private active = false
  private wantsPublish = false
  private initializeFlight: Promise<void> | null = null
  private fillFlight: Promise<void> | null = null
  private contextFlight: Promise<void> | null = null
  private cycleTimer: ReturnType<typeof setTimeout> | null = null
  private impressionTimer: ReturnType<typeof setTimeout> | null = null
  private impressions: RecommendationImpression[] = []
  private visibleIds = new Set<string>()
  private cacheFlags = new Map<string, { cached: boolean; checkedAt: number }>()
  private cacheFlight: Promise<void> | null = null
  private cacheEpoch = 0
  private nextSeed = 0
  private featuresFlight: Promise<void> | null = null
  private impressionFlight: Promise<void> | null = null
  private drainFlight: Promise<void> | null = null
  private featuresFailed = false
  private impressionsFailed = false
  private pendingFeatures = new Map<string, FeedCandidate>()
  private featureTimer: ReturnType<typeof setTimeout> | null = null
  private storage = new RecommendationStorage(error => this.reportPersistenceError('State', error))
  private persistenceErrors = new Map<string, string>()
  private context: RecommendationContext | null = null
  private profile: TasteProfile | null = null
  private readonly sessionStartedAt = Date.now()
  private closing = false
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null
  private pendingSections = new Map<string, FeatureSectionUpdate>()
  private sectionFlight: Promise<void> | null = null
  private sectionFailed = false
  private actionJobs = new Set<Promise<void>>()
  private pendingActions: Parameters<typeof api.recordRecommendationAction>[0][] = []
  private actionFlight: Promise<void> | null = null
  private languageJobs = new Set<Promise<void>>()
  private languageSequences = new Map<string, number>()
  private languageHashes = new Map<string, string>()
  private sectionClocks = new Map<string, number>()
  private audioQueue = new Map<string, RecommendationTrack>()
  private audioAttempted = new Set<string>()
  private audioTimer: ReturnType<typeof setTimeout> | null = null
  private audioController: AbortController | null = null
  private audioFlight: Promise<void> | null = null
  private audioActiveKey: string | null = null
  private lastAudioStartedAt = 0

  constructor() {
    if (typeof window === 'undefined') return
    window.addEventListener('tempo:explicit-action', event => {
      const detail = (event as CustomEvent<ExplicitActionIntent>).detail
      void this.recordExplicitAction(detail.trackKey, detail.action, detail.intent, detail).catch(cause => this.reportPersistenceError('Actions', cause))
    })
    window.addEventListener('tempo:original-lyrics', event => {
      if (this.closing) return
      const detail = (event as CustomEvent<{ trackKey: string; text: string; evidence: LyricEvidenceSource }>).detail
      this.observeLyrics(detail.trackKey, detail.text, detail.evidence)
    })
    window.addEventListener('tempo:listening-feedback', event => {
      if (this.closing) return
      const detail = (event as CustomEvent<ListeningEvent>).detail
      if (this.initialized && detail.generation !== this.generation) return
      if (this.audioEligible(detail)) this.queueAudioAnalysis(detail.track)
      this.scheduleFeedbackRefresh()
    })
    // One app-owned listener; flags stay bounded by the current metadata window.
    void onSoundcloudCacheReady(id => {
      if (!this.published.some(item => item.track.id === id) && !this.visibleIds.has(id)) return
      this.cacheFlags.set(id, { cached: true, checkedAt: Date.now() })
      this.emitCacheFlags()
    }).catch(() => undefined)
    libraryVersion.subscribe(() => {
      this.cacheEpoch += 1
      this.cacheFlags.clear()
      this.emitCacheFlags()
      void this.queryCacheFlags()
      if (!this.closing && this.active && this.initialized) void this.refreshContext()
    })
    window.addEventListener('tempo:soundcloud-cache-invalidated', () => {
      this.cacheEpoch += 1
      this.cacheFlags.clear()
      this.emitCacheFlags()
      void this.queryCacheFlags()
    })
    window.addEventListener('tempo:listening-history-cleared', () => {
      this.epoch += 1
      this.storage.reset()
      this.initialized = false
      this.initializeFlight = null
      this.candidates = []
      this.discoveryPool = []
      this.frontier = []
      this.expandedSeedKeys.clear()
      this.usedCursors.clear()
      this.cooldowns.clear()
      this.impressions = []
      this.sessionSeen.clear()
      this.radioSeen.clear()
      this.radioRecent = []
      this.seedBucketCounts = [0, 0, 0]
      this.seedLanguageCounts.clear()
      this.seedLanguageContextKey = ''
      this.skipCooldowns.clear()
      this.homeCooldownOverflow.clear()
      this.skipCooldownOverflow.clear()
      this.homeCooldownOverflowUntil = 0
      this.skipCooldownOverflowUntil = 0
      this.aliases.clear()
      for (const item of this.published) { this.sessionSeen.add(item.groupKey); this.sessionSeen.add(keyOf(item.track)) }
      this.pendingFeatures.clear()
      this.pendingActions = []
      this.context = null
      this.profile = null
      // Lyrics are factual metadata, retained by history clear. An in-flight
      // detector still belongs to its track/text sequence after feedback resets.
      this.featuresFailed = false
      this.impressionsFailed = false
      this.emit({ favoriteGenre: null, error: null, hasMore: true, exhausted: false })
      if (this.active) void this.activate()
    })
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void this.flush().catch(() => undefined) })
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  private group(key: string) { return this.aliases.get(key) ?? key }
  private emit(change: Partial<RecommendationSnapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...change, revision: Math.max(this.snapshot.revision + 1, change.revision ?? 0) }
    this.listeners.forEach(listener => listener())
  }
  private reportPersistenceError(source: string, cause: unknown) {
    this.persistenceErrors.set(source, message(cause))
    this.emit({ persistenceError: [...this.persistenceErrors].map(([name, error]) => `${name}: ${error}`).join('\n') })
  }
  private save(immediate = false) {
    if (!this.initialized) return
    const relevant = new Set([...this.published, ...this.candidates].flatMap(item => [item.groupKey, keyOf(item.track)]))
    const state: StoredRecommendationState = { version: 1, revision: this.snapshot.revision,
      candidates: this.candidates.slice(), published: this.published.slice(), discoveryPool: this.discoveryPool.slice(-FEED_LIMITS.discoveryPool),
      seedFrontier: structuredClone(this.frontier),
      usedCursors: [...this.usedCursors], sessionSeen: this.sessionSeen.keys(),
      expandedSeedKeys: [...this.expandedSeedKeys].slice(-FEED_LIMITS.expandedSeeds),
      receipts: { home: this.sessionSeen.snapshot(), radio: this.radioSeen.snapshot() },
      cooldownReceipts: {
        home: { state: this.homeCooldownOverflow.snapshot(), until: this.homeCooldownOverflowUntil },
        skip: { state: this.skipCooldownOverflow.snapshot(), until: this.skipCooldownOverflowUntil },
      },
      groups: [...this.aliases].filter(([key, group]) => relevant.has(key) || relevant.has(group))
        .slice(0, FEED_LIMITS.groups).map(([key, groupKey]) => ({ key, groupKey })),
      radioRecent: this.radioRecent.slice(-9), createdAt: this.createdAt, updatedAt: Date.now(), retryAt: this.snapshot.retryAt, contextKey: this.contextKey }
    this.storage.schedule(state, this.generation)
    if (immediate) void this.storage.flush().catch(() => undefined)
  }
  private hasPendingWrites() {
    return this.impressions.length > 0 || this.pendingFeatures.size > 0 || this.impressionFlight !== null
      || this.featuresFlight !== null || this.storage.hasPendingWrites() || this.pendingSections.size > 0
      || this.sectionFlight !== null || this.pendingActions.length > 0 || this.actionFlight !== null || this.actionJobs.size > 0 || this.languageJobs.size > 0
  }
  flush = async (): Promise<void> => {
    if (this.drainFlight) {
      await this.drainFlight
      if (this.hasPendingWrites()) await this.flush()
      return
    }
    const flight = (async () => {
      do {
        await Promise.all([...this.actionJobs, ...this.languageJobs])
        await this.flushActions()
        await this.flushSections()
        await this.flushImpressions()
        await this.flushFeatures()
        await this.storage.flush()
      } while (this.hasPendingWrites())
      this.persistenceErrors.clear()
      this.emit({ persistenceError: null })
    })().finally(() => { if (this.drainFlight === flight) this.drainFlight = null })
    this.drainFlight = flight
    await flight
    if (this.hasPendingWrites()) await this.flush()
  }

  private async resolveKeys(trackKeys: string[], groupKeys: string[] = []) {
    const epoch = this.epoch
    const tracks = [...new Set(trackKeys)].filter(key => !this.aliases.has(key))
    const groups = [...new Set(groupKeys)].filter(key => !this.aliases.has(key) && !tracks.includes(key))
    const inputs = [...tracks.map(key => ({ key, track: true })), ...groups.map(key => ({ key, track: false }))]
    for (let start = 0; start < inputs.length; start += 60) {
      const batch = inputs.slice(start, start + 60)
      const result = await api.resolveRecommendationGroups(batch.filter(item => item.track).map(item => item.key), batch.filter(item => !item.track).map(item => item.key))
      if (epoch !== this.epoch) return
      for (const entry of result) {
        const root = entry.groupKey ?? entry.key
        this.migrateGroups([entry.key, this.group(entry.key)], root)
        this.aliases.set(entry.key, root)
      }
    }
  }
  private async applyContext(context: RecommendationContext) {
    const epoch = this.epoch
    this.generation = context.generation
    const previousAliases = new Map(this.aliases)
    this.aliases.clear()
    // Samples are hints only; missing identities are resolved authoritatively.
    for (const alias of context.groupAliases ?? []) {
      this.migrateGroups([alias.alias, previousAliases.get(alias.alias) ?? alias.alias], alias.groupKey)
      this.aliases.set(alias.alias, alias.groupKey)
    }
    for (const group of context.recordingGroups ?? []) for (const key of group.trackKeys) {
      this.migrateGroups([key, previousAliases.get(key) ?? key], group.groupKey)
      this.aliases.set(key, group.groupKey)
    }
    await this.resolveKeys([...context.seedTracks.map(seed => seed.track.trackKey), ...context.sessions.map(event => event.trackKey),
      ...(context.explicitActions ?? []).map(action => action.trackKey),
      ...context.impressions.map(impression => impression.trackKey), ...context.features.map(feature => feature.trackKey),
      ...this.published.map(item => keyOf(item.track)), ...this.candidates.map(item => keyOf(item.track))],
    [...context.impressions.flatMap(impression => impression.recordingGroup ? [impression.recordingGroup] : []),
      ...this.sessionSeen.keys(), ...this.radioSeen.keys(), ...this.published.map(item => item.groupKey), ...this.candidates.map(item => item.groupKey),
      ...context.features.flatMap(feature => typeof catalogOf(feature).recordingGroup === 'string' ? [catalogOf(feature).recordingGroup as string] : [])])
    if (epoch !== this.epoch) return
    for (const key of this.sessionSeen.keys()) this.sessionSeen.add(this.group(key))
    for (const key of this.radioSeen.keys()) this.radioSeen.add(this.group(key))
    const latest = new Map(context.features.map(feature => [feature.trackKey, feature]))
    for (const [key, feature] of this.features) if (feature.revision > (latest.get(key)?.revision ?? -1)) latest.set(key, feature)
    this.features = latest
    context.features = [...latest.values()]
    this.context = { ...context, canonicalGroups: Object.fromEntries(this.aliases) }
    this.scheduleContextAudioAnalysis(context)
    this.profile = buildTasteProfile({ ...this.context, sessionStartedAt: this.sessionStartedAt }, Date.now())
    this.emit({ favoriteGenre: getFavoriteGenre(this.profile) })
    for (const [key, until] of this.cooldowns) if (until > Date.now()) {
      this.homeCooldownOverflow.add(key)
      this.homeCooldownOverflowUntil = Math.max(this.homeCooldownOverflowUntil, until)
    }
    for (const [key, until] of this.skipCooldowns) if (until > Date.now()) {
      this.skipCooldownOverflow.add(key)
      this.skipCooldownOverflowUntil = Math.max(this.skipCooldownOverflowUntil, until)
    }
    this.cooldowns.clear()
    this.skipCooldowns.clear()
    for (const impression of [...context.impressions, ...this.impressions]) {
      const group = this.group(impression.recordingGroup ?? impression.trackKey)
      this.cooldowns.set(group, Math.max(this.cooldowns.get(group) ?? 0, impression.shownAt + 7 * DAY))
    }
    const skips = new Map<string, number[]>()
    for (const event of context.sessions) {
      if (!event.finished || !['next', 'select'].includes(event.endReason ?? '') || event.startedAt < Date.now() - 30 * DAY) continue
      if (event.elapsedSec >= Math.min(30, (event.durationSec ?? 120) * 0.2)) continue
      const group = this.group(event.trackKey)
      skips.set(group, [...(skips.get(group) ?? []), event.startedAt])
    }
    for (const [group, times] of skips) if (times.length >= 2) {
      const until = Math.max(...times) + 14 * DAY
      this.skipCooldowns.set(group, until)
      this.cooldowns.set(group, Math.max(this.cooldowns.get(group) ?? 0, until))
    }
    for (const item of [...this.published, ...this.candidates]) item.groupKey = this.group(keyOf(item.track))
    this.setSeedPlan(this.profile.seeds)
    if (!this.initialized && this.published.length > 1) {
      // The stored home rail may have been generated before language balancing.
      // Reorder that first batch in place so the fix takes effect after an app update.
      this.published = rebalanceCandidateLanguages(this.published, this.profile)
    }
    this.pruneMetadata()
  }
  private async initialize() {
    if (this.initialized) return
    if (this.initializeFlight) return this.initializeFlight
    const epoch = this.epoch, revision = this.snapshot.revision
    this.initializeFlight = (async () => {
      const [context, providerRetry] = await Promise.all([api.getRecommendationContext(), api.getAppSetting('recommendation_provider_retry_at')])
      if (epoch !== this.epoch) return
      this.storage.initialize(context.storedState?.revision ?? 0)
      const technicalRetry = Number(providerRetry)
      const stored = hydrateRecommendationState(context)
      // Hydration is allowed only before local publications/mutations.
      if (stored && revision === this.snapshot.revision && !this.published.length) {
        this.candidates = stored.candidates
        this.published = stored.published
        this.discoveryPool = stored.discoveryPool ?? []
        this.frontier = stored.seedFrontier
        this.expandedSeedKeys = new Set(stored.expandedSeedKeys ?? [])
        this.usedCursors = new Set(stored.usedCursors)
        this.contextKey = stored.contextKey
        this.createdAt = stored.createdAt
        this.radioRecent = stored.radioRecent ?? []
        if (Date.now() - stored.createdAt < FEED_CACHE_TTL_MS && stored.receipts) {
          this.sessionSeen.restore(stored.receipts.home)
          this.radioSeen.restore(stored.receipts.radio)
        } else if (!stored.receipts) for (const key of stored.sessionSeen) this.sessionSeen.add(key)
        if (stored.cooldownReceipts) {
          this.homeCooldownOverflow.restore(stored.cooldownReceipts.home.state)
          this.skipCooldownOverflow.restore(stored.cooldownReceipts.skip.state)
          this.homeCooldownOverflowUntil = stored.cooldownReceipts.home.until
          this.skipCooldownOverflowUntil = stored.cooldownReceipts.skip.until
        }
        for (const alias of stored.groups) this.aliases.set(alias.key, alias.groupKey)
        this.emit({ retryAt: Math.max(stored.retryAt ?? 0, technicalRetry || 0) || null, revision: Math.max(this.snapshot.revision, stored.revision) })
      }
      if (Number.isFinite(technicalRetry) && technicalRetry > Date.now()) this.emit({ retryAt: Math.max(this.snapshot.retryAt ?? 0, technicalRetry) })
      await this.applyContext(context)
      if (epoch !== this.epoch) return
      this.recoverDiscoveryPoolFromFeatures()
      this.candidates = this.candidates.filter(item => this.cooldownUntil(this.group(item.groupKey)) <= Date.now())
      this.published = this.published.filter(item => this.cooldownUntil(this.group(item.groupKey)) <= Date.now())
      for (const item of this.published) { this.sessionSeen.add(this.group(item.groupKey)); this.sessionSeen.add(keyOf(item.track)) }
      this.initialized = true
      this.emit({ tracks: this.published.map(item => item.track), hasLoaded: this.published.length > 0, error: null })
      this.save()
      void this.queryCacheFlags()
    })().finally(() => { if (epoch === this.epoch) this.initializeFlight = null })
    return this.initializeFlight
  }
  refreshContext = async () => {
    if (this.closing || !this.initialized || this.contextFlight) return this.contextFlight
    const epoch = this.epoch
    this.contextFlight = (async () => {
      const context = await api.getRecommendationContext()
      if (epoch !== this.epoch) return
      await this.applyContext(context)
      this.save()
      if (this.candidates.length < LOW_WATER) void this.fill()
    })().catch(cause => this.emit({ error: message(cause) })).finally(() => { this.contextFlight = null })
    return this.contextFlight
  }
  /** Task 4 can replace seed weighting/ranking without disturbing published cards. */
  setSeedPlan = (seeds: RecommendationSeed[]) => {
    const unique = new Map<string, RecommendationSeed>()
    for (const seed of seeds) {
      const group = this.group(seed.track.trackKey)
      const previous = unique.get(group)
      if (!previous || seed.weight * seed.confidence > previous.weight * previous.confidence) unique.set(group, seed)
    }
    const sorted = [...unique.values()]
    const artists = new Map<string, number>()
    const selected = sorted.filter(seed => {
      const artist = normalizeRecordingText(seed.track.artists[0] ?? '')
      const count = artists.get(artist) ?? 0
      if (artist && count >= 3) return false
      artists.set(artist, count + 1)
      return true
    }).slice(0, PROFILE_SEED_LIMIT)
    const previous = new Map(this.frontier.map(seed => [seed.seed.track.trackKey, seed]))
    // Keep minority confirmed languages inside the capped frontier even when the artist limit creates a deficit.
    for (const seed of seeds) if (!selected.some(item => item.track.trackKey === seed.track.trackKey)) {
      const language = this.profile?.seedLanguages?.[seed.track.trackKey]
      if (!language || (this.profile?.languages[language] ?? 0) <= 0
        || selected.some(item => this.profile?.seedLanguages?.[item.track.trackKey] === language)) continue
      if (selected.length >= PROFILE_SEED_LIMIT) selected.pop()
      selected.push(seed)
    }
    const contextKey = selected.map(seed => seed.track.trackKey).sort().join('|')
    const sameProfile = contextKey === this.contextKey
    const languageContextKey = selected.map(seed => `${seed.track.trackKey}:${this.profile?.seedLanguages?.[seed.track.trackKey] ?? '?'}`).sort().join('|')
    if (!sameProfile) this.lastBadRequest = null
    if (languageContextKey !== this.seedLanguageContextKey) {
      this.seedLanguageCounts.clear(); this.seedBucketCounts = [0, 0, 0]
    }
    this.seedLanguageContextKey = languageContextKey
    this.contextKey = contextKey
    const discovered = sameProfile ? [...previous.values()].filter(item => item.discovered)
      .slice(0, DISCOVERY_SEED_LIMIT) : []
    this.frontier = selected.map(seed => {
      const old = previous.get(seed.track.trackKey)
      if (old && Date.now() - old.updatedAt < FEED_CACHE_TTL_MS) {
        if (old.seed.limitedEvidence && !seed.limitedEvidence && (old.limitedAccepted ?? 0) >= 4) old.exhausted = false
        if (seed.limitedEvidence) {
          const known = new Set([...this.candidates, ...this.published, ...this.radioRecent]
            .filter(item => item.seedTrackKey === seed.track.trackKey).map(item => this.group(item.groupKey)))
          old.limitedAccepted = Math.max(old.limitedAccepted ?? 0, known.size)
          if (old.limitedAccepted >= 4) old.exhausted = true
        }
        old.seed = seed; return old
      }
      return { seed, seedId: null, resolved: false, source: 'related', cursor: null,
        emptyPages: 0, exhausted: false, retryAt: null, pages: 0, updatedAt: Date.now() }
    })
    const baseKeys = new Set(this.frontier.map(item => item.seed.track.trackKey))
    this.frontier.push(...discovered.filter(item => !baseKeys.has(item.seed.track.trackKey)))
    if (!this.initialized) {
      // Apply the new policy before showing a pre-policy cached rail.
      let weakShown = 0
      this.published = this.published.filter(item => !this.frontier.find(seed => seed.seed.track.trackKey === item.seedTrackKey)?.seed.limitedEvidence
        || ++weakShown <= 4)
    }
    // Older cached pools predate sparse-evidence limits. Preserve displayed
    // cards, but retire their excess unpublished suggestions before delivery.
    const weakCounts = new Map<string, number>()
    for (const item of this.published) weakCounts.set(item.seedTrackKey, (weakCounts.get(item.seedTrackKey) ?? 0) + 1)
    this.candidates = this.candidates.filter(item => {
      if (!this.frontier.find(seed => seed.seed.track.trackKey === item.seedTrackKey)?.seed.limitedEvidence) return true
      const count = weakCounts.get(item.seedTrackKey) ?? 0
      weakCounts.set(item.seedTrackKey, count + 1)
      return count < 4
    })
    const scopes = new Set(this.frontier.filter(frontier => previous.get(frontier.seed.track.trackKey) === frontier)
      .flatMap(frontier => ['related', 'station', 'search'].map(source => signature(`${frontier.seed.track.trackKey}:${frontier.seedId}:${source}`))))
    this.usedCursors = new Set([...this.usedCursors].filter(key => scopes.has(key.slice(0, 16))))
    if (this.initialized) {
      const exhausted = !this.frontier.some(seed => !seed.exhausted)
      this.emit({ exhausted: exhausted && this.candidates.length === 0, hasMore: this.candidates.length > 0 || !exhausted })
      this.save()
    }
  }
  setCandidateRanker = (ranker: CandidateRanker) => { this.ranker = ranker }

  private scheduleFeedbackRefresh() {
    if (this.closing || this.feedbackTimer) return
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = null
      if (!this.initialized) void this.initialize().catch(cause => this.emit({ error: message(cause) }))
      else void this.refreshContext()
    }, 250)
  }
  private audioEligible(event: ListeningEvent): boolean {
    const duration = event.durationSec ?? event.track.durationSec
    if (!duration || duration < 30 || !Number.isFinite(event.coveredSec)) return false
    return event.finished || event.coveredSec >= Math.min(45, duration * 0.5)
  }
  private scheduleContextAudioAnalysis(context: RecommendationContext) {
    for (const event of context.sessions.filter(item => this.audioEligible(item)).slice(0, 8)) {
      this.queueAudioAnalysis(event.track)
    }
    for (const action of (context.explicitActions ?? []).filter(item =>
      item.action === 'cache' || item.action === 'collection-save' || item.action === 'playlist-add').slice(-4)) {
      this.queueAudioAnalysis(action.track)
    }
    for (const seed of context.seedTracks.filter(item => item.evidence === 'like' || item.evidence === 'playlist').slice(0, 4)) {
      this.queueAudioAnalysis(seed.track)
    }
  }
  private queueAudioAnalysis(track: RecommendationTrack, refresh = false) {
    if (this.closing || !track.trackKey || !track.durationSec || track.durationSec < 30) return
    const key = track.trackKey
    if (refresh) this.audioAttempted.delete(key)
    if (this.audioAttempted.has(key) || this.audioQueue.has(key) || this.audioActiveKey === key || this.audioQueue.size >= 32) return
    this.audioQueue.set(key, track)
    this.scheduleAudioDrain()
  }
  private scheduleAudioDrain() {
    if (this.closing || this.audioTimer || this.audioFlight || !this.audioQueue.size) return
    const delay = this.lastAudioStartedAt
      ? Math.max(10_000, 30_000 - (Date.now() - this.lastAudioStartedAt))
      : 8_000
    this.audioTimer = setTimeout(() => {
      this.audioTimer = null
      void this.drainAudioQueue()
    }, delay)
  }
  private async drainAudioQueue() {
    if (this.closing || this.audioFlight || !this.audioQueue.size) return
    const next = this.audioQueue.entries().next().value as [string, RecommendationTrack] | undefined
    if (!next) return
    const [trackKey, track] = next
    this.audioQueue.delete(trackKey)
    this.audioActiveKey = trackKey
    const epoch = this.epoch
    const generation = this.generation
    const controller = new AbortController()
    this.audioController = controller
    const flight = (async () => {
      this.lastAudioStartedAt = Date.now()
      const feature = await analyzeCachedRecommendationTrack(track, controller.signal)
      this.audioAttempted.add(trackKey)
      if (this.audioAttempted.size > 5000) this.audioAttempted.delete(this.audioAttempted.values().next().value!)
      if (!feature?.matchGroup || feature.matchGroup === trackKey || controller.signal.aborted
        || this.closing || epoch !== this.epoch || generation !== this.generation) return
      const matchedKey = feature.matchGroup
      const merged = await api.mergeRecommendationGroups(
        [matchedKey, this.group(matchedKey), trackKey, this.group(trackKey)], [matchedKey, trackKey], generation,
      )
      if (controller.signal.aborted || this.closing || epoch !== this.epoch || generation !== this.generation) return
      const roots = [matchedKey, this.group(matchedKey), trackKey, this.group(trackKey), merged.groupKey]
      this.migrateGroups(roots, merged.groupKey)
      this.aliases.set(matchedKey, merged.groupKey)
      this.aliases.set(trackKey, merged.groupKey)
      for (const candidate of [...this.candidates, ...this.published]) {
        if (this.group(candidate.groupKey) === merged.groupKey) this.persistFeature(candidate)
      }
    })().catch(cause => {
      if (!controller.signal.aborted && !this.closing && epoch === this.epoch && generation === this.generation) {
        this.reportPersistenceError('Audio', cause)
      }
    }).finally(() => {
      if (this.audioFlight === flight) this.audioFlight = null
      if (this.audioController === controller) this.audioController = null
      if (this.audioActiveKey === trackKey) this.audioActiveKey = null
      this.scheduleAudioDrain()
    })
    this.audioFlight = flight
    await flight
  }
  private observeLyrics(trackKey: string, text: string, evidence: LyricEvidenceSource) {
    if (this.languageJobs.size >= MAX_LANGUAGE_JOBS) {
      this.reportPersistenceError('Language', new Error('Language analysis queue is full; this lyric update was skipped'))
      return
    }
    const sequence = (this.languageSequences.get(trackKey) ?? 0) + 1
    this.languageSequences.set(trackKey, sequence)
    const job = detectLyricLanguages(text, evidence).then(result => {
      if (this.closing || this.languageSequences.get(trackKey) !== sequence) return
      this.recordLanguage(trackKey, result)
    }).catch(cause => { this.reportPersistenceError('Language', cause) }).finally(() => {
      this.languageJobs.delete(job)
      if (this.languageSequences.size > 5000) {
        const oldest = this.languageSequences.keys().next().value
        if (oldest) { this.languageSequences.delete(oldest); this.languageHashes.delete(oldest) }
      }
    })
    this.languageJobs.add(job)
  }
  private nextSectionTime(trackKey: string, section: string): number {
    const key = `${trackKey}|${section}`
    const persisted = this.features.get(trackKey)?.data.sectionUpdatedAt as Record<string, number> | undefined
    const at = Math.max(Date.now(), (persisted?.[section] ?? 0) + 1, (this.sectionClocks.get(key) ?? 0) + 1)
    this.sectionClocks.set(key, at)
    if (this.sectionClocks.size > 15_000) this.sectionClocks.delete(this.sectionClocks.keys().next().value!)
    return at
  }
  recordLanguage = (trackKey: string, evidence: LanguageEvidence) => {
    if (this.closing) return
    const hash = `${evidence.textHash}|${JSON.stringify(evidence.evidence)}`
    if (this.languageHashes.get(trackKey) === hash) return
    this.languageHashes.set(trackKey, hash)
    const key = `${trackKey}|language`
    if (this.pendingSections.has(key)) this.pendingSections.delete(key)
    else if (this.pendingSections.size >= MAX_PENDING_RECOMMENDATION_WRITES) {
      const oldest = this.pendingSections.keys().next().value
      if (oldest) {
        const dropped = this.pendingSections.get(oldest)
        this.pendingSections.delete(oldest)
        if (dropped?.section === 'language') this.languageHashes.delete(dropped.trackKey)
        this.reportPersistenceError('Features', new Error('Feature write backlog is full; oldest unsaved feature was dropped'))
      }
    }
    this.pendingSections.set(key, { trackKey, section: 'language', data: evidence as unknown as Record<string, unknown>, updatedAt: this.nextSectionTime(trackKey, 'language') })
    if (!this.sectionFailed) void this.flushSections().catch(() => undefined)
  }
  private async flushSections(): Promise<void> {
    if (this.sectionFlight) { await this.sectionFlight; return this.flushSections() }
    if (!this.pendingSections.size) return
    this.sectionFailed = false
    const flight = (async () => {
      while (this.pendingSections.size) {
        const entries = [...this.pendingSections.entries()].slice(0, WRITE_BATCH)
        for (const [key, update] of entries) if (this.pendingSections.get(key) === update) this.pendingSections.delete(key)
        try {
          const features = await api.mergeRecommendationFeatureSections(entries.map(([, update]) => update))
          for (const feature of features) if (feature.revision >= (this.features.get(feature.trackKey)?.revision ?? -1)) this.features.set(feature.trackKey, feature)
          if (this.context) {
            this.context.features = [...this.features.values()]
            this.profile = buildTasteProfile({ ...this.context, sessionStartedAt: this.sessionStartedAt }, Date.now())
            if (!this.closing) {
              this.emit({ favoriteGenre: getFavoriteGenre(this.profile) })
              this.setSeedPlan(this.profile.seeds)
            }
          }
        } catch (cause) {
          for (const [key, update] of entries) if (!this.pendingSections.has(key)) this.pendingSections.set(key, update)
          this.sectionFailed = true; this.reportPersistenceError('Features', cause); throw cause
        }
      }
    })().finally(() => { if (this.sectionFlight === flight) this.sectionFlight = null })
    this.sectionFlight = flight; await flight
  }
  recordExplicitAction = (trackKey: string, action: ExplicitActionKind, intent: 'manual' | 'automatic',
    detail?: Partial<ExplicitActionIntent>): Promise<void> => {
    if (intent !== 'manual' || (this.closing && detail?.generation === undefined)) return Promise.resolve()
    if (this.actionJobs.size + this.pendingActions.length >= MAX_PENDING_ACTIONS) {
      const cause = new Error('Explicit feedback retry queue exceeds limit')
      this.reportPersistenceError('Actions', cause)
      return Promise.reject(cause)
    }
    const epoch = this.epoch, id = crypto.randomUUID(), at = detail?.at ?? Date.now()
    const job = (async () => {
      await this.initialize()
      if (epoch !== this.epoch) return
      const known = this.context?.sessions.find(event => event.trackKey === trackKey || event.track.dbId === detail?.dbId)?.track
      const candidate = [...this.published, ...this.candidates].find(item => keyOf(item.track) === trackKey)
      if (action === 'cache' || action === 'collection-save' || action === 'playlist-add') {
        const audioTrack = known ?? (candidate ? recommendationTrack(this.toUnified(candidate.track)) : undefined)
        if (audioTrack) this.queueAudioAnalysis(audioTrack, true)
      }
      const provenance = known?.provenance ?? (candidate ? this.toUnified(candidate.track).provenance : undefined)
      if (this.pendingActions.length >= 5000) throw new Error('Explicit feedback retry queue exceeds limit')
      this.pendingActions.push({ id, trackKey, action, intent, at, generation: detail?.generation ?? this.generation, dbId: detail?.dbId, playlistId: detail?.playlistId, provenance })
      await this.flushActions()
    })().finally(() => { this.actionJobs.delete(job) })
    this.actionJobs.add(job); return job
  }
  private async flushActions(): Promise<void> {
    if (this.actionFlight) { await this.actionFlight; return this.flushActions() }
    if (!this.pendingActions.length) return
    const flight = (async () => {
      while (this.pendingActions.length) {
        const action = this.pendingActions[0], epoch = this.epoch
        try {
          await api.recordRecommendationAction(action)
          if (this.pendingActions[0] === action) this.pendingActions.shift()
          this.scheduleFeedbackRefresh()
        } catch (cause) {
          if (epoch !== this.epoch || action.generation !== this.generation || message(cause).includes('feedback was cleared')) {
            if (this.pendingActions[0] === action) this.pendingActions.shift()
            continue
          }
          this.reportPersistenceError('Actions', cause); throw cause
        }
      }
    })().finally(() => { if (this.actionFlight === flight) this.actionFlight = null })
    this.actionFlight = flight; await flight
  }
  takeForAutoplay = async ({ currentTrack, excludedTrackKeys, signal }: {
    currentTrack: UnifiedTrack | null; excludedTrackKeys: Iterable<string>; signal?: AbortSignal
  }): Promise<RadioReservation | null> => {
    if (this.closing || signal?.aborted) return null
    return this.reserveForRadio([...excludedTrackKeys, ...(currentTrack ? [`${currentTrack.source}:${currentTrack.sourceId}`] : [])], signal)
  }
  /** Stop future producers, await previously authorized actions, then drain captured-generation writes. */
  prepareExit = async (): Promise<void> => {
    this.closing = true; this.active = false; stopFeedbackOperations()
    if (this.cycleTimer) clearTimeout(this.cycleTimer)
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer)
    this.cycleTimer = null; this.feedbackTimer = null
    if (this.audioTimer) clearTimeout(this.audioTimer)
    this.audioTimer = null
    this.audioQueue.clear()
    this.audioController?.abort()
    this.audioController = null
    await flushFeedbackOperations()
    await this.flush()
  }

  activate = async () => {
    if (this.closing) return
    this.active = true
    try {
      await this.initialize()
      this.wantsPublish ||= this.published.length === 0
      this.publish()
      if (this.candidates.length < LOW_WATER) await this.fill()
    } catch (cause) { this.emit({ error: message(cause), hasLoaded: true }) }
  }
  loadMore = async () => {
    if (this.closing || this.snapshot.loading || (this.snapshot.retryAt ?? 0) > Date.now()) return
    this.active = true
    try { await this.initialize() } catch (cause) { this.emit({ error: message(cause), hasLoaded: true }); return }
    if (this.published.length >= FEED_LIMITS.published) return
    this.wantsPublish = true
    this.publish()
    if (this.candidates.length < LOW_WATER || this.wantsPublish) await this.fill()
  }
  retry = async () => {
    if ((this.snapshot.retryAt ?? 0) > Date.now() || this.snapshot.loading) return
    this.emit({ error: null, retryAt: null })
    if (this.lastBadRequest) {
      // Explicit retry may recheck sources that previously rejected a request;
      // they are not marked exhausted forever by one HTTP 400.
      for (const frontier of this.frontier) if (frontier.exhausted) {
        frontier.exhausted = false; frontier.source = 'related'; frontier.cursor = null
        frontier.emptyPages = 0; frontier.pages = 0; frontier.retryAt = null
        frontier.resolved = !!frontier.seedId
      }
      this.lastBadRequest = null
    }
    // Retain failed writes for a later drain, but do not make fetching depend on them.
    void this.flush().catch(() => undefined)
    this.wantsPublish = this.published.length === 0 || this.wantsPublish
    await this.activate()
  }
  private nextFrontier(): SeedFrontier | undefined {
    const now = Date.now()
    const primaryRemaining = this.frontier.some(seed => !seed.exhausted && seed.source !== 'search')
    const bucketNames = ['steady', 'recent', 'discovery'] as const, weights = [0.6, 0.25, 0.15]
    const ready = this.frontier.filter(seed => !seed.exhausted && (!primaryRemaining || seed.source !== 'search') && (seed.retryAt ?? 0) <= now)
    const active = bucketNames.map((name, index) => ready.some(seed => (seed.seed.bucket ?? 'steady') === name) ? index : -1).filter(index => index >= 0)
    if (!active.length) return
    const total = active.reduce((sum, index) => sum + weights[index], 0), count = this.seedBucketCounts.reduce((sum, value) => sum + value, 0)
    const selected = active.reduce((best, next) => weights[next] / total * (count + 1) - this.seedBucketCounts[next]
      > weights[best] / total * (count + 1) - this.seedBucketCounts[best] ? next : best, active[0])
    const bucket = bucketNames[selected]
    const eligible = ready.filter(seed => (seed.seed.bucket ?? 'steady') === bucket)
    const languagePools = new Map<string, SeedFrontier[]>()
    for (const seed of eligible) {
      const code = this.profile?.seedLanguages?.[seed.seed.track.trackKey] ?? '?'
      const pool = languagePools.get(code) ?? []
      pool.push(seed); languagePools.set(code, pool)
    }
    const languageEntries = [...languagePools.entries()]
    const languageWeights = languageEntries.map(([code]) => code === '?'
      ? Math.max(0.05, this.profile?.unknownShare ?? 1)
      : Math.max(0.01, this.profile?.languages[code] ?? 0))
    const languageTotal = languageWeights.reduce((sum, weight) => sum + weight, 0)
    const languageCount = [...this.seedLanguageCounts.values()].reduce((sum, value) => sum + value, 0)
    const languageDebt = (candidate: number) => languageWeights[candidate] / languageTotal * (languageCount + 1)
      - (this.seedLanguageCounts.get(languageEntries[candidate][0]) ?? 0)
    let languageIndex = 0
    for (let index = 1; index < languageEntries.length; index += 1) {
      if (languageDebt(index) > languageDebt(languageIndex)) languageIndex = index
    }
    const language = languageEntries[languageIndex]?.[0] ?? '?'
    for (let offset = 0; offset < this.frontier.length; offset += 1) {
      const index = (this.nextSeed + offset) % this.frontier.length
      const frontier = this.frontier[index]
      if (ready.includes(frontier) && (frontier.seed.bucket ?? 'steady') === bucket
        && (this.profile?.seedLanguages?.[frontier.seed.track.trackKey] ?? '?') === language) {
        this.seedBucketCounts[selected] += 1
        this.seedLanguageCounts.set(language, (this.seedLanguageCounts.get(language) ?? 0) + 1)
        this.nextSeed = (index + 1) % this.frontier.length
        return frontier
      }
    }
  }
  /** Fetch up to three seed pages as one small related cohort. */
  private nextFrontierBatch(maxSize = 3): SeedFrontier[] {
    const first = this.nextFrontier()
    if (!first || first.source === 'search') return first ? [first] : []
    if (maxSize <= 1) return [first]
    const artistKeys = new Set(first.seed.track.artists.map(normalizeRecordingText).filter(Boolean))
    const genreKey = normalizeRecordingText(first.seed.track.traits?.genre ?? '')
    if (!artistKeys.size && !genreKey) return [first]
    const ready = new Set(this.frontier.filter(seed => !seed.exhausted && seed.source === first.source
      && (seed.seed.bucket ?? 'steady') === (first.seed.bucket ?? 'steady') && (seed.retryAt ?? 0) <= Date.now()))
    const sameCohort = (seed: SeedFrontier) => {
      if (seed === first || !ready.has(seed)) return false
      const sameArtist = seed.seed.track.artists.some(artist => artistKeys.has(normalizeRecordingText(artist)))
      const sameGenre = !!genreKey && genreKey === normalizeRecordingText(seed.seed.track.traits?.genre ?? '')
      return sameArtist || sameGenre
    }
    const others = this.frontier.filter(sameCohort)
    const firstLanguage = this.profile?.seedLanguages?.[first.seed.track.trackKey] ?? '?'
    others.sort((left, right) => Number((this.profile?.seedLanguages?.[right.seed.track.trackKey] ?? '?') === firstLanguage)
      - Number((this.profile?.seedLanguages?.[left.seed.track.trackKey] ?? '?') === firstLanguage))
    const batch = [first, ...others.slice(0, Math.min(2, maxSize - 1))]
    const bucketIndex = (['steady', 'recent', 'discovery'] as const).indexOf(first.seed.bucket ?? 'steady')
    for (const seed of batch.slice(1)) {
      if (bucketIndex >= 0) this.seedBucketCounts[bucketIndex] += 1
      const language = this.profile?.seedLanguages?.[seed.seed.track.trackKey] ?? '?'
      this.seedLanguageCounts.set(language, (this.seedLanguageCounts.get(language) ?? 0) + 1)
    }
    if (batch.length > 1) {
      const lastIndex = this.frontier.indexOf(batch[batch.length - 1])
      this.nextSeed = (lastIndex + 1) % this.frontier.length
    }
    return batch
  }
  private hasReadyFrontier() {
    const primaryRemaining = this.frontier.some(seed => !seed.exhausted && seed.source !== 'search')
    return this.frontier.some(seed => !seed.exhausted && (!primaryRemaining || seed.source !== 'search') && (seed.retryAt ?? 0) <= Date.now())
  }
  private async resolveSeed(frontier: SeedFrontier): Promise<string | null> {
    const track = frontier.seed.track
    if (track.source === 'soundcloud' && /^\d+$/u.test(track.sourceId)) return track.sourceId
    const artist = track.artists.find(value => normalizeRecordingText(value))
    if (!artist || !track.durationSec || track.durationSec <= 0) return null
    const result = await api.scRecommendationSearch(`${artist} ${track.title}`.slice(0, 256), 8)
    if (result.error) {
      throw Object.assign(new Error(result.error), { retryAt: result.retryAt,
        status: result.status, failedEndpoint: result.failedEndpoint })
    }
    const hits = result.tracks
    const reference: ScTrack = { id: '0', title: track.title, artist, metadataArtist: artist,
      durationMs: track.durationSec * 1000, artworkUrl: null, artistAvatarUrl: null, permalinkUrl: null,
      streamable: true, hasProgressive: true, hasHls: false }
    const identity = recordingIdentity(reference, track.artists)
    const matches = hits.filter(hit => playable(hit) && duplicateConfidence(identity, recordingIdentity(hit, track.artists)) >= 0.95)
    return matches.length ? chooseRepresentative(matches).id : null
  }
  private expandSeedFrontier(): boolean {
    if (!this.profile || !this.frontier.length || !this.frontier.every(seed => seed.exhausted)) return false

    const baseFrontier = this.frontier.filter(seed => !seed.discovered)
    const slots = Math.min(DISCOVERY_SEED_LIMIT, FEED_LIMITS.seeds - baseFrontier.length)
    if (slots <= 0 || this.expandedSeedKeys.size >= FEED_LIMITS.expandedSeeds) return false

    const activeSeedKeys = new Set(baseFrontier.map(seed => seed.seed.track.trackKey))
    const pool = new Map<string, FeedCandidate>()
    for (const candidate of [...this.discoveryPool, ...this.published, ...this.candidates]) {
      const key = keyOf(candidate.track)
      if (pool.has(key)) continue
      const parent = this.profile.seeds.find(seed => seed.track.trackKey === candidate.seedTrackKey)
      const parentWasDiscovered = this.expandedSeedKeys.has(candidate.seedTrackKey)
      const parentIsStrong = !!parent && !parent.limitedEvidence && parent.evidence !== 'legacy' && parent.confidence >= 0.45
      if (!playable(candidate.track) || candidate.track.durationMs < 15_000
        || activeSeedKeys.has(key) || this.expandedSeedKeys.has(key)) continue
      if (parent?.limitedEvidence) continue
      const score = candidateScore(candidate, this.profile)
      if (!parentIsStrong && !parentWasDiscovered && (parent || score < MIN_DISCOVERY_SEED_SCORE * 3)) continue
      pool.set(key, candidate)
    }
    if (!pool.size) return false

    const ranked = rankCandidates([...pool.values()], this.profile, this.published)
      .map(candidate => ({ candidate, score: candidateScore(candidate, this.profile!) }))
      .sort((a, b) => b.score - a.score || a.candidate.addedAt - b.candidate.addedAt)
    const bestScore = ranked[0]?.score ?? 0
    const minimumScore = Math.max(MIN_DISCOVERY_SEED_SCORE, bestScore * 0.3)
    const artists = new Set<string>()
    const selected: typeof ranked = []
    for (const entry of ranked) {
      const candidate = entry.candidate
      const key = keyOf(candidate.track)
      const artist = normalizeRecordingText(candidate.identity.artist ?? candidate.track.artist ?? '')
      if (entry.score < minimumScore || (artist && artists.has(artist))) continue
      selected.push(entry)
      this.expandedSeedKeys.delete(key)
      this.expandedSeedKeys.add(key)
      if (artist) artists.add(artist)
      if (selected.length >= slots || this.expandedSeedKeys.size >= FEED_LIMITS.expandedSeeds) break
    }
    if (!selected.length) return false

    this.frontier = baseFrontier
    for (const { candidate, score } of selected) {
      const parent = this.profile.seeds.find(seed => seed.track.trackKey === candidate.seedTrackKey)
      const confidence = parent?.confidence ?? this.profile.confidence
      this.frontier.push({
        seed: {
          track: recommendationTrack(this.toUnified(candidate.track)), evidence: 'aggregate',
          confidence: Math.max(0.5, Math.min(1, confidence)), weight: Math.max(0.02, Math.min(1, score)),
          at: Date.now(), bucket: 'discovery', limitedEvidence: false,
        },
        discovered: true, seedId: candidate.track.id, resolved: true, source: 'related', cursor: null,
        emptyPages: 0, exhausted: false, retryAt: null, pages: 0, updatedAt: Date.now(),
      })
    }
    while (this.expandedSeedKeys.size > FEED_LIMITS.expandedSeeds) {
      this.expandedSeedKeys.delete(this.expandedSeedKeys.values().next().value!)
    }
    const scopes = new Set(this.frontier.flatMap(frontier => ['related', 'station', 'search']
      .map(source => signature(`${frontier.seed.track.trackKey}:${frontier.seedId}:${source}`))))
    this.usedCursors = new Set([...this.usedCursors].filter(key => scopes.has(key.slice(0, 16))))
    this.lastBadRequest = null
    this.emit({ error: null, hasMore: true, exhausted: false })
    this.save()
    return true
  }
  private recoverDiscoveryPoolFromFeatures() {
    if (!this.profile || this.discoveryPool.length >= FEED_LIMITS.discoveryPool) return
    const candidates = new Map(this.discoveryPool.map(candidate => [keyOf(candidate.track), candidate]))
    for (const feature of this.features.values()) {
      const catalog = catalogOf(feature)
      const track = catalog.playable as ScTrack | undefined
      const identity = catalog.identity as RecordingIdentity | undefined
      if (!track || !identity || !/^\d{1,64}$/u.test(track.id) || !playable(track) || track.durationMs < 15_000
        || typeof identity.trackKey !== 'string' || typeof catalog.recordingGroup !== 'string') continue
      const key = keyOf(track)
      if (candidates.has(key) || this.expandedSeedKeys.has(key)) continue
      candidates.set(key, { track, identity, groupKey: this.group(catalog.recordingGroup), seedTrackKey: feature.trackKey,
        cursor: null, alternates: (catalog.alternates as ScTrack[] | undefined)?.slice(0, 3) ?? [], addedAt: feature.updatedAt })
    }
    this.discoveryPool = [...candidates.values()]
      .sort((left, right) => candidateScore(right, this.profile!) - candidateScore(left, this.profile!) || right.addedAt - left.addedAt)
      .slice(0, FEED_LIMITS.discoveryPool)
  }
  private fallback(frontier: SeedFrontier) {
    frontier.cursor = null
    frontier.emptyPages = 0
    frontier.pages = 0
    if (frontier.source === 'related') frontier.source = 'station'
    else if (frontier.source === 'station' && frontier.seed.confidence >= 0.65 && frontier.seed.evidence !== 'legacy' && frontier.seed.track.artists.length) frontier.source = 'search'
    else frontier.exhausted = true
  }
  private handleFrontierFailure(frontier: SeedFrontier, cause: unknown, epoch: number): boolean {
    if (this.closing || epoch !== this.epoch || !this.frontier.includes(frontier)) return true
    const providerFailure = typeof cause === 'object' && cause !== null
      ? cause as { status?: unknown; failedEndpoint?: unknown; retryAt?: unknown } : null
    if (isUnavailableRecommendationSource(Number(providerFailure?.status), providerFailure?.failedEndpoint)
      && providerFailure?.failedEndpoint === 'search') {
      this.lastBadRequest = Number(providerFailure?.status) === 400 ? message(cause) : null
      frontier.exhausted = true
      frontier.retryAt = null
      this.emit({ error: null, retryAt: null })
      this.publish()
      this.save(true)
      return true
    }
    const retryAt = Number(providerFailure?.retryAt ?? 0)
    frontier.retryAt = Math.max(Number.isFinite(retryAt) ? retryAt : 0, this.snapshot.retryAt ?? 0, Date.now() + 30_000)
    this.emit({ error: message(cause), retryAt: frontier.retryAt })
    this.save(true)
    return false
  }
  private async fetchFrontierBatch(batch: SeedFrontier[], cycle: number, epoch: number): Promise<boolean> {
    const requests: { frontier: SeedFrontier; signature: string; cursor: string | null; promise: Promise<Awaited<ReturnType<typeof api.scRecommendationPage>>> }[] = []
    let canContinue = true
    for (const frontier of batch) {
      if (!this.frontier.includes(frontier)) continue
      try {
        if (!frontier.resolved) {
          frontier.seedId = await this.resolveSeed(frontier)
          if (this.closing || epoch !== this.epoch) break
          if (!this.frontier.includes(frontier)) continue
          frontier.resolved = true
          if (!frontier.seedId) { frontier.exhausted = true; continue }
        }
        const signature = cursorKey(frontier)
        if (this.usedCursors.has(signature)) { this.fallback(frontier); continue }
        const cursor = frontier.cursor
        const promise = frontier.source === 'search'
          ? api.scRecommendationSearch(frontier.seed.track.artists[0].slice(0, 128), 20)
          : api.scRecommendationPage(frontier.seedId!, cursor, 30, frontier.source)
        requests.push({ frontier, signature, cursor, promise })
      } catch (cause) {
        if (!this.handleFrontierFailure(frontier, cause, epoch)) canContinue = false
      }
    }
    const responses = await Promise.allSettled(requests.map(request => request.promise))
    if (this.closing || epoch !== this.epoch) return false
    for (let index = 0; index < responses.length; index += 1) {
      const request = requests[index], response = responses[index]
      const { frontier, signature, cursor } = request
      if (!this.frontier.includes(frontier)) continue
      if (response.status === 'rejected') {
        if (!this.handleFrontierFailure(frontier, response.reason, epoch)) canContinue = false
        continue
      }
      try {
        const result = response.value
        const knownArtists = this.frontier.flatMap(seed => seed.seed.track.artists)
        const tracks = frontier.source === 'search' ? result.tracks.filter(track => {
          const identity = recordingIdentity(track, knownArtists)
          return identity.artist !== null && frontier.seed.track.artists.some(artist => normalizeRecordingText(artist) === identity.artist)
        }) : result.tracks
        const accepted = await this.accept(tracks, frontier, cursor, epoch)
        if (this.closing || epoch !== this.epoch) return false
        if (!this.frontier.includes(frontier)) continue
        frontier.updatedAt = Date.now()
        if (frontier.seed.limitedEvidence && (frontier.limitedAccepted ?? 0) >= 4) frontier.exhausted = true
        if (result.error) {
          if (isUnavailableRecommendationSource(result.status, result.failedEndpoint)) {
            this.lastBadRequest = result.status === 400 ? result.error : null
            frontier.retryAt = null
            this.fallback(frontier)
            this.emit({ error: null, retryAt: null })
            this.publish()
            this.save(true)
            continue
          }
          frontier.retryAt = result.retryAt ?? Date.now() + 30_000
          this.emit({ error: result.error, retryAt: frontier.retryAt })
          this.publish()
          this.save(true)
          canContinue = false
          continue
        }
        this.usedCursors.add(signature)
        this.lastBadRequest = null
        const scope = signature.slice(0, 17)
        const recent = [...this.usedCursors].filter(key => key.startsWith(scope))
        for (const old of recent.slice(0, Math.max(0, recent.length - 32))) this.usedCursors.delete(old)
        while (this.usedCursors.size > FEED_LIMITS.cursors) this.usedCursors.delete(this.usedCursors.values().next().value!)
        frontier.pages += 1
        frontier.retryAt = null
        if (canContinue) this.emit({ error: null, retryAt: null })
        frontier.emptyPages = accepted ? 0 : frontier.emptyPages + 1
        frontier.cursor = result.nextCursor
        if (!result.nextCursor || frontier.emptyPages >= 3) this.fallback(frontier)
        if (this.wantsPublish && cycle + index >= 1) this.publish()
        this.save()
      } catch (cause) {
        if (!this.handleFrontierFailure(frontier, cause, epoch)) canContinue = false
      }
    }
    return canContinue
  }
  private fill = async (): Promise<void> => {
    if (this.closing || !this.initialized || (this.snapshot.retryAt ?? 0) > Date.now()) return
    if (this.fillFlight) return this.fillFlight
    const epoch = this.epoch
    this.emit({ loading: true })
    this.fillFlight = (async () => {
      for (let page = 0; page < PAGE_BUDGET && this.candidates.length < FEED_LIMITS.candidates;) {
        const remainingBudget = PAGE_BUDGET - page
        let batch = this.nextFrontierBatch(remainingBudget)
        if (!batch.length && this.expandSeedFrontier()) batch = this.nextFrontierBatch(remainingBudget)
        if (!batch.length) break
        if (!await this.fetchFrontierBatch(batch, page, epoch)) break
        page += batch.length
      }
      if (epoch !== this.epoch) return
      this.publish()
      const exhausted = !this.frontier.some(seed => !seed.exhausted)
      const terminalBadRequest = exhausted && this.candidates.length === 0 ? this.lastBadRequest : null
      if (terminalBadRequest) this.emit({ error: terminalBadRequest })
      this.emit({ loading: false, hasLoaded: true, exhausted: exhausted && this.candidates.length === 0,
        hasMore: this.candidates.length > 0 || !exhausted })
      this.save()
    })().finally(() => {
      this.fillFlight = null
      if (epoch !== this.epoch) { this.emit({ loading: false }); if (this.active) void this.activate(); return }
      // A successful bounded cycle can continue filling; failures require retry.
      if (!this.closing && !this.snapshot.error && this.candidates.length < FEED_LIMITS.candidates && this.hasReadyFrontier()) {
        if (this.cycleTimer) clearTimeout(this.cycleTimer)
        this.cycleTimer = setTimeout(() => { this.cycleTimer = null; void this.fill() }, 800)
      }
    })
    return this.fillFlight
  }
  private async accept(tracks: ScTrack[], frontier: SeedFrontier, cursor: string | null, epoch: number): Promise<number> {
    const incoming = tracks.filter(playable)
    await this.resolveKeys(incoming.map(keyOf))
    if (this.closing || epoch !== this.epoch || !this.frontier.includes(frontier)) return 0
    let accepted = 0
    const knownArtists = this.frontier.flatMap(seed => seed.seed.track.artists)
    for (const track of incoming) {
      if (frontier.seed.limitedEvidence && (frontier.limitedAccepted ?? 0) >= 4) break
      if (this.closing || epoch !== this.epoch || !this.frontier.includes(frontier)) return accepted
      const identity = recordingIdentity(track, knownArtists)
      let groupKey = this.group(identity.trackKey)
      const currentDuplicate = [...this.published, ...this.candidates].find(item => this.group(item.groupKey) === groupKey || duplicateConfidence(item.identity, identity) >= 0.95)
      const feature = !currentDuplicate ? [...this.features.values()].find(item => {
        const previous = catalogOf(item).identity as RecordingIdentity | undefined
        return previous?.featureVersion === 1 && duplicateConfidence(previous, identity) >= 0.95
      }) : undefined
      const savedTrack = feature ? catalogOf(feature).playable as ScTrack | undefined : undefined
      const historicalDuplicate: FeedCandidate | undefined = feature && savedTrack?.id && playable(savedTrack) ? {
        track: savedTrack, identity: catalogOf(feature).identity as RecordingIdentity,
        groupKey: this.group(feature.trackKey), seedTrackKey: frontier.seed.track.trackKey, cursor,
        alternates: (catalogOf(feature).alternates as ScTrack[] | undefined)?.slice(0, 3) ?? [], addedAt: Date.now(),
      } : undefined
      const duplicate = currentDuplicate ?? historicalDuplicate
      if (duplicate) {
        const supportingSeeds = new Set([duplicate.seedTrackKey, ...(duplicate.supportingSeedTrackKeys ?? [])])
        if (!supportingSeeds.has(frontier.seed.track.trackKey)) {
          supportingSeeds.add(frontier.seed.track.trackKey)
          duplicate.supportingSeedTrackKeys = [...supportingSeeds].slice(-FEED_LIMITS.seeds)
        }
        if (keyOf(duplicate.track) !== identity.trackKey) {
          try {
            const roots = [duplicate.groupKey, this.group(duplicate.groupKey), groupKey, this.group(identity.trackKey)]
            const group = await api.mergeRecommendationGroups([duplicate.groupKey, groupKey], [keyOf(duplicate.track), identity.trackKey], this.generation)
            if (this.closing || epoch !== this.epoch || !this.frontier.includes(frontier)) return accepted
            groupKey = group.groupKey
            this.migrateGroups(roots, groupKey)
            this.aliases.set(identity.trackKey, groupKey)
            this.aliases.set(keyOf(duplicate.track), groupKey)
            duplicate.groupKey = groupKey
          } catch (cause) {
            if (this.closing || epoch !== this.epoch || !this.frontier.includes(frontier)) return accepted
            if (!message(cause).includes('catalog capacity')) throw cause
            // Capacity keeps upload-local durable identity; strong duplicates still stay off Home.
            groupKey = duplicate.groupKey
          }
          const uploads = [duplicate.track, ...duplicate.alternates, track]
          if (!uploads.slice(0, -1).some(item => item.id === track.id)) {
            // Published display metadata stays stable. Unpublished representatives may improve.
            const representative = this.published.includes(duplicate) ? duplicate.track : chooseRepresentative(uploads)
            duplicate.track = representative
            duplicate.identity = recordingIdentity(representative, knownArtists)
            duplicate.alternates = uploads.filter(item => item.id !== representative.id).slice(0, 3)
            this.persistFeature(duplicate)
          }
        }
        if (!currentDuplicate && !this.sessionSeen.has(this.group(duplicate.groupKey)) && !this.radioSeen.has(this.group(duplicate.groupKey))
          && !this.sessionSeen.has(keyOf(duplicate.track)) && !this.radioSeen.has(keyOf(duplicate.track))
          && this.cooldownUntil(this.group(duplicate.groupKey)) <= Date.now() && this.candidates.length < FEED_LIMITS.candidates) {
          this.candidates.push(duplicate)
          accepted += 1
          frontier.limitedAccepted = (frontier.limitedAccepted ?? 0) + 1
        }
        continue
      }
      if (this.sessionSeen.has(groupKey) || this.sessionSeen.has(identity.trackKey) || this.radioSeen.has(groupKey) || this.radioSeen.has(identity.trackKey)
        || this.cooldownUntil(groupKey) > Date.now() || this.candidates.length >= FEED_LIMITS.candidates) continue
      const item: FeedCandidate = { track, identity, groupKey, seedTrackKey: frontier.seed.track.trackKey, cursor, alternates: [], addedAt: Date.now() }
      this.candidates.push(item)
      if (frontier.discovered || (!frontier.seed.limitedEvidence && frontier.seed.evidence !== 'legacy' && frontier.seed.confidence >= 0.45)) {
        this.discoveryPool = [...this.discoveryPool.filter(entry => entry.identity.trackKey !== identity.trackKey), structuredClone(item)]
          .slice(-FEED_LIMITS.discoveryPool)
      }
      accepted += 1
      frontier.limitedAccepted = (frontier.limitedAccepted ?? 0) + 1
      this.persistFeature(item)
    }
    this.pruneMetadata()
    return accepted
  }
  private persistFeature(candidate: FeedCandidate) {
    const key = keyOf(candidate.track)
    if (this.pendingFeatures.has(key)) this.pendingFeatures.delete(key)
    else if (this.pendingFeatures.size >= MAX_PENDING_RECOMMENDATION_WRITES) {
      this.pendingFeatures.delete(this.pendingFeatures.keys().next().value!)
      this.reportPersistenceError('Catalog', new Error('Catalog write backlog is full; oldest unsaved metadata was dropped'))
    }
    this.pendingFeatures.set(key, { ...structuredClone(candidate), addedAt: this.nextSectionTime(key, 'catalog') })
    if (this.featureTimer || this.featuresFailed) return
    this.featureTimer = setTimeout(() => { this.featureTimer = null; void this.flushFeatures().catch(() => undefined) }, 400)
  }
  private async flushFeatures(): Promise<void> {
    if (this.featureTimer) clearTimeout(this.featureTimer)
    this.featureTimer = null
    if (this.featuresFlight) { await this.featuresFlight; return this.flushFeatures() }
    if (!this.pendingFeatures.size) return
    this.featuresFailed = false
    const flight = (async () => {
      while (this.pendingFeatures.size) {
        const entries = [...this.pendingFeatures.entries()].slice(0, WRITE_BATCH)
        for (const [key, candidate] of entries) if (this.pendingFeatures.get(key) === candidate) this.pendingFeatures.delete(key)
        const epoch = this.epoch
        try {
          const updates: FeatureSectionUpdate[] = entries.map(([key, candidate]) => ({
            trackKey: key, section: 'catalog', updatedAt: candidate.addedAt,
            data: { identity: candidate.identity, recordingGroup: candidate.groupKey,
              playable: compactScTrack(candidate.track), alternates: candidate.alternates.map(compactScTrack),
              traits: { genre: candidate.track.genre ?? null, tags: candidate.track.tags?.slice(0, 16) ?? [],
                bpm: candidate.track.bpm ?? null, version: candidate.identity.version } },
          }))
          const features = await api.mergeRecommendationFeatureSections(updates)
          if (epoch === this.epoch) {
            for (const feature of features) if (feature.revision >= (this.features.get(feature.trackKey)?.revision ?? -1)) this.features.set(feature.trackKey, feature)
            if (!this.closing) this.scheduleFeedbackRefresh()
          }
        } catch (cause) {
          if (epoch !== this.epoch) continue
          for (const [key, candidate] of entries) if (!this.pendingFeatures.has(key)) this.pendingFeatures.set(key, candidate)
          this.featuresFailed = true
          if (this.featureTimer) clearTimeout(this.featureTimer)
          this.featureTimer = null
          this.reportPersistenceError('Catalog', cause)
          throw cause
        }
      }
    })().finally(() => { if (this.featuresFlight === flight) this.featuresFlight = null })
    this.featuresFlight = flight
    await flight
    await this.flushFeatures()
  }
  private publish() {
    if (this.closing || !this.wantsPublish || this.published.length >= FEED_LIMITS.published) return
    const retained = new Set<string>()
    this.candidates = this.candidates.filter(item => {
      const group = this.group(item.groupKey)
      if (retained.has(group) || this.sessionSeen.has(group) || this.sessionSeen.has(keyOf(item.track)) || this.cooldownUntil(group) > Date.now()) return false
      retained.add(group)
      return true
    })
    const room = Math.min(PUBLISH_SIZE, FEED_LIMITS.published - this.published.length)
    const selected: FeedCandidate[] = []
    const artistWindow = this.published.slice(-9).map(item => item.identity.artist)
    const familyWindow = this.published.slice(-9).map(item => `${item.identity.artist}|${item.identity.title}`)
    const available = this.candidates.filter(item => !this.isReserved(this.group(item.groupKey))
      && !this.sessionSeen.has(this.group(item.groupKey)) && !this.sessionSeen.has(keyOf(item.track)) && this.cooldownUntil(this.group(item.groupKey)) <= Date.now())
      .sort((a, b) => this.ranker(b) - this.ranker(a))
    if (this.profile) {
      const ranked = rankCandidates(available, this.profile, this.published)
      const kept = new Set(ranked)
      const rejectedWeak = new Set(available.filter(item => !kept.has(item)
        && this.profile!.seeds.find(seed => seed.track.trackKey === item.seedTrackKey)?.limitedEvidence))
      // Retire excess speculative suggestions; they remain factual features,
      // but must not leave the rail sentinel loading an undeliverable pool.
      this.candidates = this.candidates.filter(item => !rejectedWeak.has(item))
      available.splice(0, available.length, ...ranked)
    }
    while (selected.length < room && available.length) {
      const lastSeed = selected.at(-1)?.seedTrackKey ?? this.published.at(-1)?.seedTrackKey
      const diverseArtist = (item: FeedCandidate) => !item.identity.artist || artistWindow.slice(-9).filter(artist => artist === item.identity.artist).length < 2
      const diverseFamily = (item: FeedCandidate) => !familyWindow.slice(-9).includes(`${item.identity.artist}|${item.identity.title}`)
      let index = available.findIndex(item => item.seedTrackKey !== lastSeed && diverseArtist(item) && diverseFamily(item))
      if (index < 0) index = available.findIndex(item => diverseArtist(item) && diverseFamily(item))
      if (index < 0) index = available.findIndex(diverseFamily)
      const item = available.splice(index >= 0 ? index : 0, 1)[0]
      if (selected.some(previous => this.group(previous.groupKey) === this.group(item.groupKey))) continue
      selected.push(item)
      artistWindow.push(item.identity.artist)
      familyWindow.push(`${item.identity.artist}|${item.identity.title}`)
      this.sessionSeen.add(this.group(item.groupKey))
      this.sessionSeen.add(keyOf(item.track))
    }
    if (!selected.length) return
    const selectedKeys = new Set(selected.map(item => keyOf(item.track)))
    this.candidates = this.candidates.filter(item => !selectedKeys.has(keyOf(item.track)))
    this.published = [...this.published, ...selected]
    this.wantsPublish = false
    this.emit({ tracks: this.published.map(item => item.track), hasLoaded: true })
    this.save()
    void this.queryCacheFlags()
  }
  /** Caller supplies only the fully passed prefix measured by the Home rail. */
  trimPassed = (trackKeys: string[]) => {
    let count = 0
    while (count < trackKeys.length && this.published[count] && keyOf(this.published[count].track) === trackKeys[count]) count += 1
    if (!count) return
    this.published = this.published.slice(count)
    this.emit({ tracks: this.published.map(item => item.track) })
    this.pruneMetadata()
    this.save()
  }
  toUnified = (track: ScTrack, origin: 'home' | 'radio' = 'home'): UnifiedTrack => {
    const item = [...this.published, ...this.candidates].find(candidate => candidate.track.id === track.id)
    return { ...scTrackToUnified(track), selectionReason: origin === 'radio' ? 'autoplay' : 'queue', provenance: {
      recommendationId: `sc:${track.id}:${item?.addedAt ?? this.createdAt}`,
      recordingKey: this.group(item?.groupKey ?? keyOf(track)), seedIds: item ? [item.seedTrackKey] : [], placement: origin,
      origin, seedTrackKey: item?.seedTrackKey, recordingGroup: this.group(item?.groupKey ?? keyOf(track)),
      cursor: item?.cursor ?? undefined, selection: origin === 'radio' ? 'autoplay' : 'queue',
    } }
  }
  /** Alternate metadata is also available after trim through bounded persisted features. */
  getPlayableAlternates = (trackKey: string): UnifiedTrack[] => {
    const group = this.group(trackKey)
    const item = [...this.published, ...this.candidates].find(candidate => this.group(candidate.groupKey) === group || keyOf(candidate.track) === trackKey)
    const matchingFeatures = [...this.features.values()].filter(feature => feature.trackKey === trackKey || this.group(feature.trackKey) === group)
    const raw = [...(item ? [item.track, ...item.alternates] : []), ...matchingFeatures.flatMap(feature =>
      [catalogOf(feature).playable, ...((catalogOf(feature).alternates as ScTrack[] | undefined) ?? [])])]
    const ids = new Set<string>()
    return raw.filter((track): track is ScTrack => !!track && typeof (track as ScTrack).id === 'string' && playable(track as ScTrack))
      .filter(track => { if (keyOf(track) === trackKey || ids.has(track.id)) return false; ids.add(track.id); return true })
      .slice(0, 3).map(track => ({ ...this.toUnified(track, 'radio'), provenance: { ...this.toUnified(track, 'radio').provenance,
        origin: 'radio', placement: 'radio', recordingKey: group, recordingGroup: group, seedTrackKey: item?.seedTrackKey, cursor: item?.cursor ?? undefined } }))
  }
  reserveForRadio = async (excludedKeys: Iterable<string>, signal?: AbortSignal): Promise<RadioReservation | null> => {
    if (this.closing || signal?.aborted) return null
    this.active = true
    try { await this.initialize() } catch (cause) { this.emit({ error: message(cause) }); return null }
    const excluded = [...excludedKeys]
    await this.resolveKeys(excluded.filter(key => /^(soundcloud|youtube|local):/u.test(key)), excluded.filter(key => !/^(soundcloud|youtube|local):/u.test(key)))
    const excludedGroups = new Set(excluded.map(key => this.group(key)))
    const pick = () => {
      const eligible = (this.profile ? rankCandidates([...this.candidates, ...this.published], this.profile, this.radioRecent) : [...this.candidates, ...this.published]).filter(item => {
      const group = this.group(item.groupKey)
      return !excludedGroups.has(group) && !this.radioSeen.has(group) && !this.radioSeen.has(keyOf(item.track)) && !this.isReserved(group)
        && this.skipCooldownUntil(group) <= Date.now() && playable(item.track)
      })
      const diverseArtist = (item: FeedCandidate) => !item.identity.artist || this.radioRecent.filter(previous => previous.identity.artist === item.identity.artist).length < 2
      const diverseFamily = (item: FeedCandidate) => !this.radioRecent.some(previous => previous.identity.artist === item.identity.artist && previous.identity.title === item.identity.title)
      return eligible.find(item => diverseArtist(item) && diverseFamily(item) && item.seedTrackKey !== this.radioRecent.at(-1)?.seedTrackKey)
        ?? eligible.find(item => diverseArtist(item) && diverseFamily(item)) ?? eligible.find(diverseFamily) ?? eligible[0]
    }
    let candidate = pick()
    // Continue beyond one prefetch cycle when its pages contain only previously
    // delivered recordings. Each queue extension is bounded to 8 x 6 pages.
    for (let cycle = 0; !candidate && cycle < 8 && !this.closing && !signal?.aborted; cycle += 1) {
      this.candidates = this.candidates.filter(item => !this.radioSeen.has(this.group(item.groupKey)) && !excludedGroups.has(this.group(item.groupKey)))
      if ((this.snapshot.retryAt ?? 0) > Date.now() || !this.hasReadyFrontier()) break
      await this.fill(); candidate = pick()
    }
    if (this.closing || !candidate || signal?.aborted || this.reservations.size >= 32) return null
    const group = this.group(candidate.groupKey), token = Symbol(group), reservedTrackKey = keyOf(candidate.track)
    this.reservations.set(group, token)
    let settled = false
    const release = () => {
      if (settled) return
      settled = true
      if (this.reservations.get(group) === token) this.reservations.delete(group)
      clearTimeout(timer)
      signal?.removeEventListener('abort', release)
    }
    signal?.addEventListener('abort', release, { once: true })
    const timer = setTimeout(release, 120_000)
    if (this.candidates.length < LOW_WATER) void this.fill()
    return { track: this.toUnified(candidate.track, 'radio'), trackKey: reservedTrackKey, recordingGroup: group,
      commit: () => {
        if (settled || signal?.aborted) { release(); return }
        this.radioSeen.add(this.group(group))
        this.radioSeen.add(reservedTrackKey)
        this.radioRecent = [...this.radioRecent, structuredClone(candidate!)].slice(-9)
        release()
        this.save()
        if (this.candidates.filter(item => !this.radioSeen.has(this.group(item.groupKey))).length < LOW_WATER) {
          // Home may still consume radio-delivered tracks until bounded pool pressure requires retirement.
          if (this.candidates.length >= FEED_LIMITS.candidates) this.candidates = this.candidates.filter(item => !this.radioSeen.has(this.group(item.groupKey)))
          this.save()
          void this.fill()
        }
      }, release }
  }
  private isReserved(groupKey: string) { return [...this.reservations.keys()].some(key => this.group(key) === groupKey) }
  private cooldownUntil(key: string) {
    return Math.max(this.cooldowns.get(key) ?? 0,
      this.homeCooldownOverflowUntil > Date.now() && this.homeCooldownOverflow.has(key) ? this.homeCooldownOverflowUntil : 0)
  }
  private skipCooldownUntil(key: string) {
    return Math.max(this.skipCooldowns.get(key) ?? 0,
      this.skipCooldownOverflowUntil > Date.now() && this.skipCooldownOverflow.has(key) ? this.skipCooldownOverflowUntil : 0)
  }
  private capCooldowns(values: Map<string, number>, summary: RecommendationReceipts, until: number): number {
    if (until <= Date.now()) { summary.clear(); until = 0 }
    if (values.size > 2048) {
      const oldest = [...values].sort((a, b) => a[1] - b[1])
      for (const [key, expiry] of oldest.slice(0, values.size - 2048)) {
        summary.add(key)
        until = Math.max(until, expiry)
        values.delete(key)
      }
    }
    return until
  }
  private migrateGroups(inputRoots: string[], canonical: string) {
    const roots = new Set([...inputRoots, ...inputRoots.map(key => this.group(key)), canonical])
    const homeSeen = [...roots].some(key => this.sessionSeen.has(key))
    const radioSeen = [...roots].some(key => this.radioSeen.has(key))
    let cooldown = 0, skipCooldown = 0
    for (const root of roots) {
      cooldown = Math.max(cooldown, this.cooldownUntil(root))
      skipCooldown = Math.max(skipCooldown, this.skipCooldownUntil(root))
      if (root !== canonical) { this.cooldowns.delete(root); this.skipCooldowns.delete(root) }
    }
    if (homeSeen) this.sessionSeen.add(canonical)
    if (radioSeen) this.radioSeen.add(canonical)
    if (cooldown > Date.now()) {
      this.cooldowns.set(canonical, cooldown)
      this.homeCooldownOverflow.add(canonical)
      this.homeCooldownOverflowUntil = Math.max(this.homeCooldownOverflowUntil, cooldown)
    }
    if (skipCooldown > Date.now()) {
      this.skipCooldowns.set(canonical, skipCooldown)
      this.skipCooldownOverflow.add(canonical)
      this.skipCooldownOverflowUntil = Math.max(this.skipCooldownOverflowUntil, skipCooldown)
    }
    for (const [key, group] of this.aliases) if (roots.has(key) || roots.has(group)) this.aliases.set(key, canonical)
    for (const root of roots) this.aliases.set(root, canonical)
    for (const candidate of [...this.candidates, ...this.published]) if (roots.has(candidate.groupKey)) candidate.groupKey = canonical
  }
  recordImpression = (trackKey: string) => {
    if (this.closing) return
    const candidate = this.published.find(item => keyOf(item.track) === trackKey)
    if (!candidate || !this.initialized) return
    const group = this.group(candidate.groupKey)
    if (this.cooldownUntil(group) > Date.now()) return
    const shownAt = Date.now()
    this.cooldowns.set(group, shownAt + 7 * DAY)
    if (this.impressions.length >= MAX_PENDING_RECOMMENDATION_WRITES) {
      this.impressions.shift()
      this.reportPersistenceError('Impressions', new Error('Impression write backlog is full; oldest unsaved view was dropped'))
    }
    this.impressions.push({ id: crypto.randomUUID(), trackKey, recordingGroup: group, shownAt, surface: 'home' })
    this.pruneMetadata()
    this.save()
    if (this.impressionsFailed) return
    if (this.impressions.length >= 50) void this.flushImpressions().catch(() => undefined)
    else if (!this.impressionTimer) this.impressionTimer = setTimeout(() => { this.impressionTimer = null; void this.flushImpressions().catch(() => undefined) }, 500)
  }
  private async flushImpressions(): Promise<void> {
    if (this.impressionTimer) clearTimeout(this.impressionTimer)
    this.impressionTimer = null
    if (this.impressionFlight) { await this.impressionFlight; return this.flushImpressions() }
    if (!this.impressions.length) return
    this.impressionsFailed = false
    const flight = (async () => {
      while (this.impressions.length) {
        const batch = this.impressions.splice(0, WRITE_BATCH), generation = this.generation, epoch = this.epoch
        try { await api.recordRecommendationImpressions(batch, generation) }
        catch (cause) {
          if (epoch !== this.epoch || generation !== this.generation) continue
          this.impressions.unshift(...batch)
          this.impressionsFailed = true
          if (this.impressionTimer) clearTimeout(this.impressionTimer)
          this.impressionTimer = null
          this.reportPersistenceError('Impressions', cause)
          throw cause
        }
      }
    })().finally(() => { if (this.impressionFlight === flight) this.impressionFlight = null })
    this.impressionFlight = flight
    await flight
    await this.flushImpressions()
  }
  reportVisibleIds = (ids: string[]) => { this.visibleIds = new Set(ids.slice(0, 40)); void this.queryCacheFlags() }
  private emitCacheFlags() {
    const ids = new Set([...this.cacheFlags].filter(([, flag]) => flag.cached).map(([id]) => id))
    this.emit({ cachedTrackIds: ids })
  }
  private async queryCacheFlags(): Promise<void> {
    if (this.cacheFlight) return this.cacheFlight
    const now = Date.now(), epoch = this.cacheEpoch
    const ids = [...new Set([...this.visibleIds, ...this.published.map(item => item.track.id)])]
      .filter(id => !this.cacheFlags.has(id) || (this.visibleIds.has(id) && now - this.cacheFlags.get(id)!.checkedAt >= CACHE_FLAG_TTL))
      .slice(0, 100)
    if (!ids.length) return
    let successful = false
    this.cacheFlight = (async () => {
      for (let start = 0; start < ids.length; start += 50) {
        const batch = ids.slice(start, start + 50), result = new Set(await api.scGetCachedTrackIds(batch))
        if (epoch !== this.cacheEpoch) return
        for (const id of batch) this.cacheFlags.set(id, { cached: result.has(id), checkedAt: Date.now() })
      }
      this.pruneMetadata()
      this.emitCacheFlags()
      successful = true
    })().catch(() => undefined).finally(() => {
      this.cacheFlight = null
      if (successful && this.published.some(item => !this.cacheFlags.has(item.track.id))) void this.queryCacheFlags()
    })
    return this.cacheFlight
  }
  private pruneMetadata() {
    const now = Date.now()
    for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key)
    for (const [key, until] of this.skipCooldowns) if (until <= now) this.skipCooldowns.delete(key)
    const keys = new Set([...this.candidates, ...this.published].flatMap(item => [keyOf(item.track), item.groupKey]))
    // Keep bounded historical identities and playable alternates across DOM trims.
    if (this.features.size > 5000) {
      const oldest = [...this.features.values()].sort((a, b) => a.updatedAt - b.updatedAt)
      for (const feature of oldest) {
        if (this.features.size <= 5000) break
        if (!keys.has(feature.trackKey)) this.features.delete(feature.trackKey)
      }
    }
    for (const seed of this.frontier) { keys.add(seed.seed.track.trackKey); keys.add(this.group(seed.seed.track.trackKey)) }
    for (const key of [...this.sessionSeen.keys(), ...this.radioSeen.keys(), ...this.reservations.keys()]) { keys.add(key); keys.add(this.group(key)) }
    for (const feature of this.features.values()) {
      keys.add(feature.trackKey)
      if (typeof catalogOf(feature).recordingGroup === 'string') keys.add(catalogOf(feature).recordingGroup as string)
    }
    for (const impression of this.impressions) { keys.add(impression.trackKey); if (impression.recordingGroup) keys.add(impression.recordingGroup) }
    // Receipts in the fixed summary do not pin aliases. Relevant missing keys are
    // resolved against durable membership again, rather than growing a lifetime map.
    for (const key of this.aliases.keys()) if (!keys.has(key)) this.aliases.delete(key)
    if (this.aliases.size > 8192) {
      const live = new Set([...this.candidates, ...this.published].flatMap(item => [keyOf(item.track), item.groupKey]))
      for (const key of this.aliases.keys()) {
        if (this.aliases.size <= 8192) break
        if (!live.has(key)) this.aliases.delete(key)
      }
    }
    // Context has <=5000 impressions/500 sessions; fixed conservative cooldown
    // overflow summaries suppress future eligibility without dropping known blocks.
    this.homeCooldownOverflowUntil = this.capCooldowns(this.cooldowns, this.homeCooldownOverflow, this.homeCooldownOverflowUntil)
    this.skipCooldownOverflowUntil = this.capCooldowns(this.skipCooldowns, this.skipCooldownOverflow, this.skipCooldownOverflowUntil)
    const publishedIds = new Set(this.published.map(item => item.track.id))
    for (const id of this.cacheFlags.keys()) if (!publishedIds.has(id) && !this.visibleIds.has(id)) this.cacheFlags.delete(id)
  }
}

export const recommendationService = new RecommendationService()

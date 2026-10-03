import { api } from '../../api/client'
import { onSoundcloudCacheReady } from '../../api/events'
import { libraryVersion } from '../../utils/libraryVersion'
import { scTrackToUnified } from '../../utils/unified'
import type { ScTrack, UnifiedTrack } from '../../types/models'
import { chooseRepresentative, duplicateConfidence, normalizeRecordingText, recordingIdentity } from './identity'
import { compactScTrack, FEED_CACHE_TTL_MS, FEED_LIMITS, hydrateRecommendationState, RecommendationStorage,
  type FeedCandidate, type SeedFrontier, type StoredRecommendationState } from './storage'
import type { RecordingIdentity, RecommendationContext, RecommendationFeature, RecommendationImpression, RecommendationSeed } from './types'
import { RecommendationReceipts } from './receipts'

const DAY = 86400_000
const PUBLISH_SIZE = 20
const LOW_WATER = 30
const PAGE_BUDGET = 6
const CACHE_FLAG_TTL = 60_000
const keyOf = (track: ScTrack) => `soundcloud:${track.id}`
const playable = (track: ScTrack) => track.streamable && (track.hasProgressive || track.hasHls)
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
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
  loading: boolean
  error: string | null
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
  private snapshot: RecommendationSnapshot = { tracks: [], loading: false, error: null, hasLoaded: false,
    hasMore: true, exhausted: false, retryAt: null, revision: 0, cachedTrackIds: new Set() }
  private candidates: FeedCandidate[] = []
  private published: FeedCandidate[] = []
  private frontier: SeedFrontier[] = []
  private usedCursors = new Set<string>()
  private sessionSeen = new RecommendationReceipts()
  private radioSeen = new RecommendationReceipts()
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
  private storage = new RecommendationStorage(error => this.emit({ error }))

  constructor() {
    if (typeof window === 'undefined') return
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
      if (this.active && this.initialized) void this.refreshContext()
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
      this.frontier = []
      this.usedCursors.clear()
      this.cooldowns.clear()
      this.impressions = []
      this.sessionSeen.clear()
      this.radioSeen.clear()
      this.skipCooldowns.clear()
      this.homeCooldownOverflow.clear()
      this.skipCooldownOverflow.clear()
      this.homeCooldownOverflowUntil = 0
      this.skipCooldownOverflowUntil = 0
      this.aliases.clear()
      for (const item of this.published) { this.sessionSeen.add(item.groupKey); this.sessionSeen.add(keyOf(item.track)) }
      this.pendingFeatures.clear()
      this.featuresFailed = false
      this.impressionsFailed = false
      this.emit({ error: null, hasMore: true, exhausted: false })
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
  private save(immediate = false) {
    if (!this.initialized) return
    const relevant = new Set([...this.published, ...this.candidates].flatMap(item => [item.groupKey, keyOf(item.track)]))
    const state: StoredRecommendationState = { version: 1, revision: this.snapshot.revision,
      candidates: this.candidates.slice(), published: this.published.slice(), seedFrontier: structuredClone(this.frontier),
      usedCursors: [...this.usedCursors], sessionSeen: this.sessionSeen.keys(),
      receipts: { home: this.sessionSeen.snapshot(), radio: this.radioSeen.snapshot() },
      cooldownReceipts: {
        home: { state: this.homeCooldownOverflow.snapshot(), until: this.homeCooldownOverflowUntil },
        skip: { state: this.skipCooldownOverflow.snapshot(), until: this.skipCooldownOverflowUntil },
      },
      groups: [...this.aliases].filter(([key, group]) => relevant.has(key) || relevant.has(group))
        .slice(0, FEED_LIMITS.groups).map(([key, groupKey]) => ({ key, groupKey })),
      createdAt: this.createdAt, updatedAt: Date.now(), retryAt: this.snapshot.retryAt, contextKey: this.contextKey }
    this.storage.schedule(state, this.generation)
    if (immediate) void this.storage.flush().catch(() => undefined)
  }
  private hasPendingWrites() {
    return this.impressions.length > 0 || this.pendingFeatures.size > 0 || this.impressionFlight !== null
      || this.featuresFlight !== null || this.storage.hasPendingWrites()
  }
  flush = async (): Promise<void> => {
    if (this.drainFlight) {
      await this.drainFlight
      if (this.hasPendingWrites()) await this.flush()
      return
    }
    const flight = (async () => {
      do {
        await this.flushImpressions()
        await this.flushFeatures()
        await this.storage.flush()
      } while (this.hasPendingWrites())
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
      ...context.impressions.map(impression => impression.trackKey), ...context.features.map(feature => feature.trackKey),
      ...this.published.map(item => keyOf(item.track)), ...this.candidates.map(item => keyOf(item.track))],
    [...context.impressions.flatMap(impression => impression.recordingGroup ? [impression.recordingGroup] : []),
      ...this.sessionSeen.keys(), ...this.radioSeen.keys(), ...this.published.map(item => item.groupKey), ...this.candidates.map(item => item.groupKey),
      ...context.features.flatMap(feature => typeof feature.data.recordingGroup === 'string' ? [feature.data.recordingGroup] : [])])
    if (epoch !== this.epoch) return
    for (const key of this.sessionSeen.keys()) this.sessionSeen.add(this.group(key))
    for (const key of this.radioSeen.keys()) this.radioSeen.add(this.group(key))
    this.features = new Map(context.features.map(feature => [feature.trackKey, feature]))
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
    this.setSeedPlan(context.seedTracks)
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
        this.frontier = stored.seedFrontier
        this.usedCursors = new Set(stored.usedCursors)
        this.contextKey = stored.contextKey
        this.createdAt = stored.createdAt
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
      this.candidates = this.candidates.filter(item => this.cooldownUntil(this.group(item.groupKey)) <= Date.now())
      this.published = this.published.filter(item => this.cooldownUntil(this.group(item.groupKey)) <= Date.now())
      for (const item of this.published) { this.sessionSeen.add(this.group(item.groupKey)); this.sessionSeen.add(keyOf(item.track)) }
      this.initialized = true
      this.emit({ tracks: this.published.map(item => item.track), hasLoaded: this.published.length > 0 })
      void this.queryCacheFlags()
    })().finally(() => { if (epoch === this.epoch) this.initializeFlight = null })
    return this.initializeFlight
  }
  refreshContext = async () => {
    if (!this.initialized || this.contextFlight) return this.contextFlight
    const epoch = this.epoch
    this.contextFlight = (async () => {
      const context = await api.getRecommendationContext()
      if (epoch !== this.epoch) return
      await this.applyContext(context)
      this.save()
      if (!this.snapshot.error && this.candidates.length < LOW_WATER) void this.fill()
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
    const sorted = [...unique.values()].sort((a, b) => b.weight * b.confidence - a.weight * a.confidence || b.at - a.at)
    const artists = new Map<string, number>()
    const selected = sorted.filter(seed => {
      const artist = normalizeRecordingText(seed.track.artists[0] ?? '')
      const count = artists.get(artist) ?? 0
      if (artist && count >= 3) return false
      artists.set(artist, count + 1)
      return true
    }).slice(0, FEED_LIMITS.seeds)
    const contextKey = selected.map(seed => seed.track.trackKey).sort().join('|')
    this.contextKey = contextKey
    const previous = new Map(this.frontier.map(seed => [seed.seed.track.trackKey, seed]))
    this.frontier = selected.map(seed => {
      const old = previous.get(seed.track.trackKey)
      if (old && Date.now() - old.updatedAt < FEED_CACHE_TTL_MS) { old.seed = seed; return old }
      return { seed, seedId: null, resolved: false, source: 'related', cursor: null,
        emptyPages: 0, exhausted: false, retryAt: null, pages: 0, updatedAt: Date.now() }
    })
    const scopes = new Set(this.frontier.filter(frontier => previous.get(frontier.seed.track.trackKey) === frontier)
      .flatMap(frontier => ['related', 'station', 'search'].map(source => signature(`${frontier.seed.track.trackKey}:${frontier.seedId}:${source}`))))
    this.usedCursors = new Set([...this.usedCursors].filter(key => scopes.has(key.slice(0, 16))))
    if (this.initialized) { this.emit({ exhausted: false, hasMore: true }); this.save() }
  }
  setCandidateRanker = (ranker: CandidateRanker) => { this.ranker = ranker }

  activate = async () => {
    this.active = true
    try {
      await this.initialize()
      this.wantsPublish ||= this.published.length === 0
      this.publish()
      if (!this.snapshot.error && this.candidates.length < LOW_WATER) await this.fill()
    } catch (cause) { this.emit({ error: message(cause), hasLoaded: true }) }
  }
  loadMore = async () => {
    if (this.snapshot.loading || this.snapshot.error || (this.snapshot.retryAt ?? 0) > Date.now()) return
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
    try { await this.flush() } catch { return }
    this.wantsPublish = this.published.length === 0 || this.wantsPublish
    await this.activate()
  }
  private nextFrontier(): SeedFrontier | undefined {
    const now = Date.now()
    const primaryRemaining = this.frontier.some(seed => !seed.exhausted && seed.source !== 'search')
    for (let offset = 0; offset < this.frontier.length; offset += 1) {
      const index = (this.nextSeed + offset) % this.frontier.length
      const frontier = this.frontier[index]
      if (!frontier.exhausted && (!primaryRemaining || frontier.source !== 'search') && (frontier.retryAt ?? 0) <= now) { this.nextSeed = (index + 1) % this.frontier.length; return frontier }
    }
  }
  private async resolveSeed(frontier: SeedFrontier): Promise<string | null> {
    const track = frontier.seed.track
    if (track.source === 'soundcloud' && /^\d+$/u.test(track.sourceId)) return track.sourceId
    const artist = track.artists.find(value => normalizeRecordingText(value))
    if (!artist || !track.durationSec || track.durationSec <= 0) return null
    const result = await api.scRecommendationSearch(`${artist} ${track.title}`.slice(0, 256), 8)
    if (result.error) {
      throw Object.assign(new Error(result.error), { retryAt: result.retryAt })
    }
    const hits = result.tracks
    const reference: ScTrack = { id: '0', title: track.title, artist, metadataArtist: artist,
      durationMs: track.durationSec * 1000, artworkUrl: null, artistAvatarUrl: null, permalinkUrl: null,
      streamable: true, hasProgressive: true, hasHls: false }
    const identity = recordingIdentity(reference, track.artists)
    const matches = hits.filter(hit => playable(hit) && duplicateConfidence(identity, recordingIdentity(hit, track.artists)) >= 0.95)
    return matches.length ? chooseRepresentative(matches).id : null
  }
  private fallback(frontier: SeedFrontier) {
    frontier.cursor = null
    frontier.emptyPages = 0
    frontier.pages = 0
    if (frontier.source === 'related') frontier.source = 'station'
    else if (frontier.source === 'station' && frontier.seed.confidence >= 0.65 && frontier.seed.evidence !== 'legacy' && frontier.seed.track.artists.length) frontier.source = 'search'
    else frontier.exhausted = true
  }
  private fill = async (): Promise<void> => {
    if (!this.initialized || this.snapshot.error || (this.snapshot.retryAt ?? 0) > Date.now()) return
    if (this.fillFlight) return this.fillFlight
    const epoch = this.epoch
    this.emit({ loading: true })
    this.fillFlight = (async () => {
      for (let page = 0; page < PAGE_BUDGET && this.candidates.length < FEED_LIMITS.candidates && !this.snapshot.error; page += 1) {
        const frontier = this.nextFrontier()
        if (!frontier) break
        try {
          if (!frontier.resolved) {
            frontier.seedId = await this.resolveSeed(frontier)
            if (epoch !== this.epoch) return
            if (!this.frontier.includes(frontier)) continue
            frontier.resolved = true
            if (!frontier.seedId) { frontier.exhausted = true; continue }
          }
          const signature = cursorKey(frontier)
          if (this.usedCursors.has(signature)) {
            this.fallback(frontier); continue
          }
          const inputCursor = frontier.cursor
          const result = frontier.source === 'search'
            ? await api.scRecommendationSearch(frontier.seed.track.artists[0].slice(0, 128), 20)
            : await api.scRecommendationPage(frontier.seedId!, inputCursor, 30, frontier.source)
          if (epoch !== this.epoch) return
          if (!this.frontier.includes(frontier)) continue
          const knownArtists = this.frontier.flatMap(seed => seed.seed.track.artists)
          const tracks = frontier.source === 'search' ? result.tracks.filter(track => {
            const identity = recordingIdentity(track, knownArtists)
            return identity.artist !== null && frontier.seed.track.artists.some(artist => normalizeRecordingText(artist) === identity.artist)
          }) : result.tracks
          const accepted = await this.accept(tracks, frontier, inputCursor, epoch)
          if (epoch !== this.epoch) return
          if (!this.frontier.includes(frontier)) continue
          frontier.updatedAt = Date.now()
          if (result.error) {
            // Partial tracks are useful; failed pages retain the INPUT cursor.
            frontier.retryAt = result.retryAt ?? Date.now() + 30_000
            this.emit({ error: result.error, retryAt: frontier.retryAt })
            this.publish()
            this.save(true)
            break
          }
          this.usedCursors.add(signature)
          // Remember recent cursors per source, retaining valid continuation beyond
          // this window. Old cycles still encounter canonical/session exclusions.
          const scope = signature.slice(0, 17)
          const recent = [...this.usedCursors].filter(key => key.startsWith(scope))
          for (const old of recent.slice(0, Math.max(0, recent.length - 32))) this.usedCursors.delete(old)
          while (this.usedCursors.size > FEED_LIMITS.cursors) this.usedCursors.delete(this.usedCursors.values().next().value!)
          frontier.pages += 1
          frontier.retryAt = null
          frontier.emptyPages = accepted ? 0 : frontier.emptyPages + 1
          frontier.cursor = result.nextCursor
          if (!result.nextCursor || frontier.emptyPages >= 3) this.fallback(frontier)
          if (this.wantsPublish && page >= 1) this.publish()
          this.save()
        } catch (cause) {
          if (epoch !== this.epoch) return
          if (!this.frontier.includes(frontier)) continue
          const retryAt = typeof cause === 'object' && cause !== null && 'retryAt' in cause ? Number(cause.retryAt) : 0
          frontier.retryAt = Math.max(Number.isFinite(retryAt) ? retryAt : 0, this.snapshot.retryAt ?? 0, Date.now() + 30_000)
          this.emit({ error: message(cause), retryAt: frontier.retryAt })
          this.save(true)
          break
        }
      }
      if (epoch !== this.epoch) return
      this.publish()
      const exhausted = !this.frontier.some(seed => !seed.exhausted)
      this.emit({ loading: false, hasLoaded: true, exhausted: exhausted && this.candidates.length === 0,
        hasMore: this.candidates.length > 0 || !exhausted })
      this.save()
    })().finally(() => {
      this.fillFlight = null
      if (epoch !== this.epoch) { this.emit({ loading: false }); if (this.active) void this.activate(); return }
      // A successful bounded cycle can continue filling; failures require retry.
      if (!this.snapshot.error && this.candidates.length < FEED_LIMITS.candidates && this.frontier.some(seed => !seed.exhausted)) {
        if (this.cycleTimer) clearTimeout(this.cycleTimer)
        this.cycleTimer = setTimeout(() => { this.cycleTimer = null; void this.fill() }, 800)
      }
    })
    return this.fillFlight
  }
  private async accept(tracks: ScTrack[], frontier: SeedFrontier, cursor: string | null, epoch: number): Promise<number> {
    const incoming = tracks.filter(playable)
    await this.resolveKeys(incoming.map(keyOf))
    if (epoch !== this.epoch || !this.frontier.includes(frontier)) return 0
    let accepted = 0
    const knownArtists = this.frontier.flatMap(seed => seed.seed.track.artists)
    for (const track of incoming) {
      if (epoch !== this.epoch || !this.frontier.includes(frontier)) return accepted
      const identity = recordingIdentity(track, knownArtists)
      let groupKey = this.group(identity.trackKey)
      const currentDuplicate = [...this.published, ...this.candidates].find(item => this.group(item.groupKey) === groupKey || duplicateConfidence(item.identity, identity) >= 0.95)
      const feature = !currentDuplicate ? [...this.features.values()].find(item => {
        const previous = item.data.identity as RecordingIdentity | undefined
        return previous?.featureVersion === 1 && duplicateConfidence(previous, identity) >= 0.95
      }) : undefined
      const savedTrack = feature?.data.playable as ScTrack | undefined
      const historicalDuplicate: FeedCandidate | undefined = feature && savedTrack?.id && playable(savedTrack) ? {
        track: savedTrack, identity: feature.data.identity as RecordingIdentity,
        groupKey: this.group(feature.trackKey), seedTrackKey: frontier.seed.track.trackKey, cursor,
        alternates: (feature.data.alternates as ScTrack[] | undefined)?.slice(0, 3) ?? [], addedAt: Date.now(),
      } : undefined
      const duplicate = currentDuplicate ?? historicalDuplicate
      if (duplicate) {
        if (keyOf(duplicate.track) !== identity.trackKey) {
          try {
            const roots = [duplicate.groupKey, this.group(duplicate.groupKey), groupKey, this.group(identity.trackKey)]
            const group = await api.mergeRecommendationGroups([duplicate.groupKey, groupKey], [keyOf(duplicate.track), identity.trackKey], this.generation)
            if (epoch !== this.epoch || !this.frontier.includes(frontier)) return accepted
            groupKey = group.groupKey
            this.migrateGroups(roots, groupKey)
            this.aliases.set(identity.trackKey, groupKey)
            this.aliases.set(keyOf(duplicate.track), groupKey)
            duplicate.groupKey = groupKey
          } catch (cause) {
            if (epoch !== this.epoch || !this.frontier.includes(frontier)) return accepted
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
        }
        continue
      }
      if (this.sessionSeen.has(groupKey) || this.sessionSeen.has(identity.trackKey) || this.radioSeen.has(groupKey) || this.radioSeen.has(identity.trackKey)
        || this.cooldownUntil(groupKey) > Date.now() || this.candidates.length >= FEED_LIMITS.candidates) continue
      const item: FeedCandidate = { track, identity, groupKey, seedTrackKey: frontier.seed.track.trackKey, cursor, alternates: [], addedAt: Date.now() }
      this.candidates.push(item)
      accepted += 1
      this.persistFeature(item)
    }
    this.pruneMetadata()
    return accepted
  }
  private persistFeature(candidate: FeedCandidate) {
    this.pendingFeatures.set(keyOf(candidate.track), structuredClone(candidate))
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
        const entries = [...this.pendingFeatures.entries()].slice(0, 100)
        for (const [key, candidate] of entries) if (this.pendingFeatures.get(key) === candidate) this.pendingFeatures.delete(key)
        const epoch = this.epoch, generation = this.generation
        try {
          const context = await api.getRecommendationContext()
          if (epoch !== this.epoch || context.generation !== generation) continue
          const features: RecommendationFeature[] = entries.map(([key, candidate]) => {
            const previous = context.features.find(feature => feature.trackKey === key)
            const data = { ...previous?.data, identity: candidate.identity, recordingGroup: candidate.groupKey,
              playable: compactScTrack(candidate.track), alternates: candidate.alternates.map(compactScTrack) }
            if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 16 * 1024) throw new Error('Recommendation feature exceeds storage budget')
            return { trackKey: key, revision: (previous?.revision ?? 0) + 1, updatedAt: Date.now(), data }
          })
          await api.saveRecommendationFeatures(features)
          if (epoch === this.epoch) for (const feature of features) this.features.set(feature.trackKey, feature)
        } catch (cause) {
          if (epoch !== this.epoch) continue
          for (const [key, candidate] of entries) if (!this.pendingFeatures.has(key)) this.pendingFeatures.set(key, candidate)
          this.featuresFailed = true
          if (this.featureTimer) clearTimeout(this.featureTimer)
          this.featureTimer = null
          this.emit({ error: message(cause) })
          throw cause
        }
      }
    })().finally(() => { if (this.featuresFlight === flight) this.featuresFlight = null })
    this.featuresFlight = flight
    await flight
    await this.flushFeatures()
  }
  private publish() {
    if (!this.wantsPublish || this.published.length >= FEED_LIMITS.published) return
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
      [feature.data.playable, ...((feature.data.alternates as ScTrack[] | undefined) ?? [])])]
    const ids = new Set<string>()
    return raw.filter((track): track is ScTrack => !!track && typeof (track as ScTrack).id === 'string' && playable(track as ScTrack))
      .filter(track => { if (keyOf(track) === trackKey || ids.has(track.id)) return false; ids.add(track.id); return true })
      .slice(0, 3).map(track => ({ ...this.toUnified(track), provenance: { origin: 'radio', recordingGroup: group, seedTrackKey: item?.seedTrackKey, cursor: item?.cursor ?? undefined } }))
  }
  reserveForRadio = async (excludedKeys: Iterable<string>, signal?: AbortSignal): Promise<RadioReservation | null> => {
    if (signal?.aborted) return null
    this.active = true
    try { await this.initialize() } catch (cause) { this.emit({ error: message(cause) }); return null }
    const excluded = [...excludedKeys]
    await this.resolveKeys(excluded.filter(key => /^(soundcloud|youtube|local):/u.test(key)), excluded.filter(key => !/^(soundcloud|youtube|local):/u.test(key)))
    const excludedGroups = new Set(excluded.map(key => this.group(key)))
    const pick = () => [...this.candidates, ...this.published].find(item => {
      const group = this.group(item.groupKey)
      return !excludedGroups.has(group) && !this.radioSeen.has(group) && !this.radioSeen.has(keyOf(item.track)) && !this.isReserved(group)
        && this.skipCooldownUntil(group) <= Date.now() && playable(item.track)
    })
    let candidate = pick()
    if (!candidate && !this.snapshot.error) {
      this.candidates = this.candidates.filter(item => !this.radioSeen.has(this.group(item.groupKey)) && !excludedGroups.has(this.group(item.groupKey)))
      await this.fill(); candidate = pick()
    }
    if (!candidate || signal?.aborted) return null
    const group = this.group(candidate.groupKey), token = Symbol(group), reservedTrackKey = keyOf(candidate.track)
    this.reservations.set(group, token)
    let settled = false
    const release = () => {
      if (settled) return
      settled = true
      if (this.reservations.get(group) === token) this.reservations.delete(group)
      signal?.removeEventListener('abort', release)
    }
    signal?.addEventListener('abort', release, { once: true })
    if (!this.snapshot.error && this.candidates.length < LOW_WATER) void this.fill()
    return { track: this.toUnified(candidate.track, 'radio'), trackKey: reservedTrackKey, recordingGroup: group,
      commit: () => {
        if (settled || signal?.aborted) { release(); return }
        this.radioSeen.add(this.group(group))
        this.radioSeen.add(reservedTrackKey)
        release()
        this.save()
        if (this.candidates.filter(item => !this.radioSeen.has(this.group(item.groupKey))).length < LOW_WATER) {
          this.candidates = this.candidates.filter(item => !this.radioSeen.has(this.group(item.groupKey)))
          this.save()
          if (!this.snapshot.error) void this.fill()
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
    const candidate = this.published.find(item => keyOf(item.track) === trackKey)
    if (!candidate || !this.initialized) return
    const group = this.group(candidate.groupKey)
    if (this.cooldownUntil(group) > Date.now()) return
    const shownAt = Date.now()
    this.cooldowns.set(group, shownAt + 7 * DAY)
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
        const batch = this.impressions.splice(0, 100), generation = this.generation, epoch = this.epoch
        try { await api.recordRecommendationImpressions(batch, generation) }
        catch (cause) {
          if (epoch !== this.epoch || generation !== this.generation) continue
          this.impressions.unshift(...batch)
          this.impressionsFailed = true
          if (this.impressionTimer) clearTimeout(this.impressionTimer)
          this.impressionTimer = null
          this.emit({ error: message(cause) })
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
      if (typeof feature.data.recordingGroup === 'string') keys.add(feature.data.recordingGroup)
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

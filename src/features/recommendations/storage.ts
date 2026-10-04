import { api } from '../../api/client'
import type { ScTrack } from '../../types/models'
import type { RecordingIdentity, RecommendationContext, RecommendationSeed } from './types'
import { RECEIPT_RECENT_LIMIT, RecommendationReceipts, type ReceiptState } from './receipts'

export const FEED_CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const FEED_LIMITS = { candidates: 100, published: 300, seeds: 40, cursors: 2560, seen: 5000, groups: 400 } as const
export const MAX_PENDING_RECOMMENDATION_WRITES = 4900
export interface FeedCandidate {
  track: ScTrack
  identity: RecordingIdentity
  groupKey: string
  seedTrackKey: string
  cursor: string | null
  alternates: ScTrack[]
  addedAt: number
}
export interface SeedFrontier {
  seed: RecommendationSeed
  seedId: string | null
  resolved: boolean
  source: 'related' | 'station' | 'search'
  cursor: string | null
  emptyPages: number
  exhausted: boolean
  retryAt: number | null
  pages: number
  updatedAt: number
  limitedAccepted?: number
}
export interface StoredRecommendationState {
  version: 1
  revision: number
  candidates: FeedCandidate[]
  published: FeedCandidate[]
  seedFrontier: SeedFrontier[]
  usedCursors: string[]
  sessionSeen: string[]
  receipts?: { home: ReceiptState; radio: ReceiptState }
  cooldownReceipts?: { home: { state: ReceiptState; until: number }; skip: { state: ReceiptState; until: number } }
  groups: { key: string; groupKey: string }[]
  radioRecent?: FeedCandidate[]
  createdAt: number
  updatedAt: number
  retryAt: number | null
  contextKey: string
}

/** Bounded provider metadata: no lyrics, provider payloads, or library writes. */
export function compactScTrack(track: ScTrack): ScTrack {
  const text = (value: string | null | undefined, max: number) => value ? value.slice(0, max) : null
  return {
    id: track.id.slice(0, 64), title: track.title.slice(0, 256), artist: track.artist.slice(0, 128),
    durationMs: track.durationMs, artworkUrl: text(track.artworkUrl, 512),
    artistAvatarUrl: text(track.artistAvatarUrl, 512), permalinkUrl: text(track.permalinkUrl, 512),
    streamable: track.streamable, hasProgressive: track.hasProgressive, hasHls: track.hasHls,
    uploaderId: text(track.uploaderId, 64), uploaderName: text(track.uploaderName, 128),
    metadataArtist: text(track.metadataArtist, 128), genre: text(track.genre, 96), isrc: text(track.isrc, 32),
    tags: track.tags?.slice(0, 16).map(tag => tag.slice(0, 64)) ?? null,
    bpm: Number.isFinite(track.bpm) && track.bpm! >= 30 && track.bpm! <= 300 ? track.bpm : null,
  }
}

function validCandidate(value: unknown): value is FeedCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as FeedCandidate
  return typeof candidate.track?.id === 'string' && /^\d{1,64}$/u.test(candidate.track.id)
    && typeof candidate.track.title === 'string' && typeof candidate.track.artist === 'string'
    && Number.isFinite(candidate.track.durationMs) && typeof candidate.groupKey === 'string'
    && typeof candidate.seedTrackKey === 'string' && typeof candidate.identity?.trackKey === 'string'
    && Array.isArray(candidate.alternates) && candidate.alternates.length <= 3
}

export function hydrateRecommendationState(context: RecommendationContext): StoredRecommendationState | null {
  const stored = context.storedState
  if (!stored || stored.data.version !== 1) return null
  const data = stored.data as unknown as StoredRecommendationState
  if (!Array.isArray(data.candidates) || data.candidates.length > FEED_LIMITS.candidates
    || !Array.isArray(data.published) || data.published.length > FEED_LIMITS.published
    || !Array.isArray(data.seedFrontier) || data.seedFrontier.length > FEED_LIMITS.seeds
    || !Array.isArray(data.usedCursors) || data.usedCursors.length > FEED_LIMITS.cursors
    || !Array.isArray(data.sessionSeen) || data.sessionSeen.length > FEED_LIMITS.seen
    || !Array.isArray(data.groups) || data.groups.length > FEED_LIMITS.groups
    || !data.candidates.every(validCandidate) || !data.published.every(validCandidate)
    || !data.usedCursors.every(key => typeof key === 'string')
    || !data.sessionSeen.every(key => typeof key === 'string')
    || !Number.isFinite(data.createdAt) || !Number.isFinite(data.updatedAt)
    || typeof data.contextKey !== 'string') return null
  if (!data.seedFrontier.every(frontier => typeof frontier.seed?.track?.trackKey === 'string'
    && ['related', 'station', 'search'].includes(frontier.source)
    && (frontier.cursor === null || typeof frontier.cursor === 'string')
    && (frontier.seedId === null || /^\d+$/u.test(frontier.seedId)))) return null
  if (data.radioRecent && (!Array.isArray(data.radioRecent) || data.radioRecent.length > 9 || !data.radioRecent.every(validCandidate))) return null
  return { ...data, revision: stored.revision }
}

function encode(state: StoredRecommendationState): Record<string, unknown> {
  const candidate = (item: FeedCandidate): FeedCandidate => ({ ...item,
    // Keep ISRC: later pages use it to confirm generic titles after restart.
    // The original title, uploader details, and familyKey are derivable or unused.
    identity: { ...item.identity, originalTitle: '', uploaderId: null, uploaderName: null, familyKey: '' },
    track: compactScTrack(item.track), alternates: item.alternates.slice(0, 3).map(compactScTrack),
  })
  const data = { ...state, candidates: state.candidates.map(candidate), published: state.published.map(candidate), radioRecent: state.radioRecent?.map(candidate) }
  // `receipts.home.recent` plus its Bloom summary supersede this legacy list.
  // Omitting the duplicate list keeps old snapshots readable and saves space.
  if (data.receipts) data.sessionSeen = []
  const size = () => new TextEncoder().encode(JSON.stringify(data)).byteLength
  const allCandidates = () => [...data.candidates, ...data.published, ...(data.radioRecent ?? [])]
  // Radio history only affects short-term diversity and is less important than
  // preserving the active candidate frontier and current Home cards.
  while (size() > 500 * 1024 && (data.radioRecent?.length ?? 0) > 3) data.radioRecent!.shift()
  // Unpublished candidates can be fetched again from the persisted frontier.
  while (size() > 500 * 1024 && data.candidates.length > 20) data.candidates.shift()
  // Remove optional fallback metadata before sacrificing artwork on visible cards.
  if (size() > 500 * 1024) for (const item of allCandidates()) item.alternates = []
  if (size() > 500 * 1024) {
    for (const item of [...data.candidates, ...(data.radioRecent ?? [])]) {
      item.track = { ...item.track, artworkUrl: null, artistAvatarUrl: null, permalinkUrl: null }
    }
  }
  // Keep published IDs/order for no-repeat behavior. Drop secondary artwork
  // metadata first, then covers on the oldest cards only if the payload is full.
  if (size() > 500 * 1024) {
    for (const item of data.published) {
      item.track = { ...item.track, artistAvatarUrl: null, permalinkUrl: null }
    }
  }
  if (size() > 500 * 1024) {
    for (let start = 0; start < data.published.length && size() > 500 * 1024; start += 12) {
      for (const item of data.published.slice(start, start + 12)) {
        item.track = { ...item.track, artworkUrl: null }
      }
    }
  }
  if (size() > 512 * 1024) throw new Error('Recommendation state exceeds storage budget')
  return data as unknown as Record<string, unknown>
}

function mergeReceipts(preferred: ReceiptState | undefined, other: ReceiptState | undefined): ReceiptState | undefined {
  if (!preferred) return other
  if (!other) return preferred
  try {
    const left = atob(preferred.summary), right = atob(other.summary)
    if (left.length !== right.length) return preferred
    const chars = new Array<string>(left.length)
    for (let index = 0; index < left.length; index += 1) {
      const value = left.charCodeAt(index) | right.charCodeAt(index)
      chars[index] = String.fromCharCode(value)
    }
    const bloom = new RecommendationReceipts()
    bloom.restore({ recent: [], summary: btoa(chars.join('')) })
    const recent = [...new Set([...other.recent, ...preferred.recent])].slice(-RECEIPT_RECENT_LIMIT)
    recent.forEach(key => bloom.add(key))
    return bloom.snapshot()
  } catch {
    return preferred
  }
}

function mergeUnique<T>(preferred: readonly T[], other: readonly T[], key: (item: T) => string, limit: number): T[] {
  const merged = new Map<string, T>()
  for (const item of [...preferred, ...other]) if (!merged.has(key(item))) merged.set(key(item), item)
  return [...merged.values()].slice(0, limit)
}

function mergeFeedStates(latest: StoredRecommendationState, local: StoredRecommendationState): StoredRecommendationState {
  const preferred = local.updatedAt >= latest.updatedAt ? local : latest
  const other = preferred === local ? latest : local
  const merged = structuredClone(preferred)

  // If the recommendation profile changed between writers, retain the newer
  // feed itself but still combine no-repeat receipts and recording aliases.
  if (latest.contextKey === local.contextKey) {
    merged.published = mergeUnique(preferred.published, other.published, item => item.identity.trackKey, FEED_LIMITS.published)
    const publishedKeys = new Set(merged.published.map(item => item.identity.trackKey))
    merged.candidates = mergeUnique(preferred.candidates, other.candidates, item => item.identity.trackKey, FEED_LIMITS.candidates)
      .filter(item => !publishedKeys.has(item.identity.trackKey))
    const frontiers = new Map(preferred.seedFrontier.map(item => [item.seed.track.trackKey, item]))
    for (const item of other.seedFrontier) {
      const current = frontiers.get(item.seed.track.trackKey)
      if (!current || item.updatedAt > current.updatedAt || (item.updatedAt === current.updatedAt && item.pages > current.pages)) {
        frontiers.set(item.seed.track.trackKey, item)
      }
    }
    merged.seedFrontier = [...frontiers.values()].slice(0, FEED_LIMITS.seeds)
    merged.usedCursors = [...new Set([...other.usedCursors, ...preferred.usedCursors])].slice(-FEED_LIMITS.cursors)
    merged.radioRecent = mergeUnique(preferred.radioRecent ?? [], other.radioRecent ?? [], item => item.identity.trackKey, 9)
  }

  const groups = new Map(preferred.groups.map(item => [item.key, item]))
  for (const item of other.groups) if (!groups.has(item.key)) groups.set(item.key, item)
  merged.groups = [...groups.values()].slice(0, FEED_LIMITS.groups)
  merged.sessionSeen = [...new Set([...other.sessionSeen, ...preferred.sessionSeen])].slice(-FEED_LIMITS.seen)
  if (preferred.receipts || other.receipts) {
    merged.receipts = {
      home: mergeReceipts(preferred.receipts?.home, other.receipts?.home)!,
      radio: mergeReceipts(preferred.receipts?.radio, other.receipts?.radio)!,
    }
  }
  if (preferred.cooldownReceipts || other.cooldownReceipts) {
    const mergeCooldown = (left: { state: ReceiptState; until: number } | undefined, right: { state: ReceiptState; until: number } | undefined) => {
      if (!left) return right
      if (!right) return left
      return { state: mergeReceipts(left.state, right.state)!, until: Math.max(left.until, right.until) }
    }
    const home = mergeCooldown(preferred.cooldownReceipts?.home, other.cooldownReceipts?.home)
    const skip = mergeCooldown(preferred.cooldownReceipts?.skip, other.cooldownReceipts?.skip)
    if (home && skip) merged.cooldownReceipts = { home, skip }
  }
  const retries = [preferred.retryAt, other.retryAt].filter((value): value is number => value !== null)
  merged.retryAt = retries.length ? Math.max(...retries) : null
  merged.updatedAt = Math.max(preferred.updatedAt, other.updatedAt)
  merged.revision = Math.max(preferred.revision, other.revision)
  return merged
}

function isFeedRevisionConflict(cause: unknown): boolean {
  return (cause instanceof Error ? cause.message : String(cause)).includes('Feed revision conflict')
}

/** One serialized debounced writer; each write retains its captured generation. */
export class RecommendationStorage {
  private expectedRevision = 0
  private pending: { state: StoredRecommendationState; generation: number } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private epoch = 0
  private failed = false
  constructor(private readonly onError: (message: string) => void) {}
  initialize(revision: number) { this.expectedRevision = revision }
  reset() {
    this.epoch += 1
    this.pending = null
    this.expectedRevision = 0
    this.failed = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
  schedule(state: StoredRecommendationState, generation: number) {
    this.pending = { state: structuredClone(state), generation }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.failed) this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined) }, 400)
  }
  hasPendingWrites() { return this.pending !== null || this.running !== null }
  private queuedPending(): { state: StoredRecommendationState; generation: number } | null { return this.pending }
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    while (this.running || this.pending) {
      if (!this.running) {
        this.failed = false
        const flight = this.drain().finally(() => { if (this.running === flight) this.running = null })
        this.running = flight
      }
      await this.running
    }
  }
  private async drain() {
    while (this.pending) {
      let pending = this.pending
      const epoch = this.epoch
      this.pending = null
      let conflicts = 0
      while (true) {
        try {
          const revision = Math.max(pending.state.revision, this.expectedRevision + 1)
          await api.saveRecommendationState({ revision, data: encode({ ...pending.state, revision }) }, pending.generation, this.expectedRevision)
          if (epoch === this.epoch) {
            this.expectedRevision = revision
            const queued = this.queuedPending()
            if (queued?.generation === pending.generation) {
              this.pending = { ...queued, state: mergeFeedStates(pending.state, queued.state) }
            }
          }
          break
        } catch (cause) {
          let failure = cause
          if (epoch === this.epoch && isFeedRevisionConflict(cause) && conflicts < 4) {
            try {
              const context = await api.getRecommendationContext()
              if (context.generation !== pending.generation) throw new Error('Recommendation feedback was cleared')
              const latestRevision = context.storedState?.revision ?? 0
              const latest = hydrateRecommendationState(context)
              const rebased = latest ? mergeFeedStates(latest, pending.state) : pending.state
              pending = { ...pending, state: { ...rebased, revision: Math.max(rebased.revision, latestRevision + 1) } }
              this.expectedRevision = latestRevision
              const queued = this.queuedPending()
              if (queued?.generation === pending.generation) {
                this.pending = { ...queued, state: mergeFeedStates(rebased, queued.state) }
              }
              conflicts += 1
              await new Promise(resolve => setTimeout(resolve, 50 * 2 ** (conflicts - 1)))
              continue
            } catch (rebaseCause) {
              failure = rebaseCause
            }
          }
          if (epoch === this.epoch) {
            // Newer state coalesces the failed payload; never replace it with old data.
            this.pending ??= pending
            this.failed = true
            if (this.timer) clearTimeout(this.timer)
            this.timer = null
            this.onError(failure instanceof Error ? failure.message : String(failure))
            throw failure
          }
          break
        }
      }
    }
  }
}

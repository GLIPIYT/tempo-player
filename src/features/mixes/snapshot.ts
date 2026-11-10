import type {
  CustomMixGenerationReason,
  CustomMixRule,
  CustomMixSnapshot,
} from './types'
import { normalizeCustomMixRule } from './types'

/** A stable fingerprint of the criteria that determine a generated selection. */
export function customMixRuleFingerprint(rule: CustomMixRule): string {
  const value = normalizeCustomMixRule(rule)
  const usesSelectedArtistShares = value.artistMode === 'allow'
    && value.artistIds.length > 0
    && !(value.artistPercent[0] === 0 && value.artistPercent[1] === 100)
  return JSON.stringify({
    name: value.name,
    description: value.description,
    trackCount: value.trackCount,
    refreshIntervalMinutes: value.refreshIntervalMinutes,
    artistMode: value.artistMode,
    artistIds: value.artistIds,
    ...(value.artistPercent[0] === 0 && value.artistPercent[1] === 100
      ? {}
      : { artistPercent: value.artistPercent }),
    ...(usesSelectedArtistShares ? { artistQuotaVersion: 2 } : {}),
    timeWindow: value.timeWindow,
    completionPercent: value.completionPercent,
    genreMode: value.genreMode,
    genres: value.genres,
    genrePercent: value.genrePercent,
    sources: value.sources,
    specials: value.specials,
    forgottenPercent: value.forgottenPercent,
    forgottenDays: value.forgottenDays,
  })
}

/** Unix seconds when a positive-interval snapshot is due, or null when unavailable. */
export function customMixSnapshotDueAt(
  rule: CustomMixRule,
  snapshot: CustomMixSnapshot | null | undefined,
): number | null {
  const normalized = normalizeCustomMixRule(rule)
  if (!snapshot || normalized.refreshIntervalMinutes === 0
    || snapshot.ruleFingerprint !== customMixRuleFingerprint(normalized)
    || !Number.isFinite(snapshot.generatedAt)) return null
  return snapshot.generatedAt + normalized.refreshIntervalMinutes * 60
}

export function shouldRegenerateCustomMixSnapshot(
  rule: CustomMixRule,
  snapshot: CustomMixSnapshot | null | undefined,
  reason: CustomMixGenerationReason,
  nowSeconds = Date.now() / 1000,
): boolean {
  if (reason === 'refresh') return true
  const fingerprint = customMixRuleFingerprint(rule)
  if (!snapshot || snapshot.ruleFingerprint !== fingerprint || snapshot.tracks.length === 0
    || !Number.isFinite(snapshot.generatedAt)) return true
  const normalized = normalizeCustomMixRule(rule)
  if (normalized.refreshIntervalMinutes === 0) return reason === 'open'
  const dueAt = customMixSnapshotDueAt(normalized, snapshot)
  return dueAt == null || nowSeconds >= dueAt
}

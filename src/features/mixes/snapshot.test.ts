import { describe, expect, it } from 'vitest'
import { createCustomMixRule, normalizeCustomMixRule, type CustomMixGeneratedSelection, type CustomMixSnapshot } from './types'
import { customMixRuleFingerprint, customMixSnapshotDueAt, shouldRegenerateCustomMixSelection, shouldRegenerateCustomMixSnapshot } from './snapshot'

const track = {
  id: 1, path: 'C:/music/1.mp3', title: 'Track', artistId: null, artistName: null,
  albumId: null, albumTitle: null, trackNumber: null, discNumber: null, durationSec: 180,
  year: null, genre: null, coverPath: null, fileSize: 0, modifiedAt: 0, addedAt: 0,
  source: 'local' as const, externalId: null, lastPlayedAt: null, playCount: 0, skipCount: 0,
  gainDb: null, peakDb: null,
}

function snapshot(rule = createCustomMixRule('Set'), generatedAt = 1_000): CustomMixSnapshot {
  return {
    ruleFingerprint: customMixRuleFingerprint(rule), generatedAt, tracks: [track], warnings: [],
  }
}

function selection(generatedAt: number): CustomMixGeneratedSelection {
  return { tracks: [track], warnings: [], generatedAt, fromCache: true }
}

describe('custom mix snapshot cadence', () => {
  it('normalizes legacy saved rules to the new defaults', () => {
    const legacy = { ...createCustomMixRule('Old'), description: undefined, trackCount: undefined,
      refreshIntervalMinutes: undefined, artistPercent: undefined } as unknown as Parameters<typeof normalizeCustomMixRule>[0]

    expect(normalizeCustomMixRule(legacy)).toMatchObject({
      description: '', trackCount: 24, refreshIntervalMinutes: 0, artistPercent: [0, 100],
    })
  })

  it('includes artist shares in snapshot identity while retaining the legacy full-range default', () => {
    const rule = createCustomMixRule('By artist')
    const legacy = { ...rule, artistPercent: undefined } as unknown as typeof rule
    const changed = { ...rule, artistPercent: [20, 25] as [number, number] }

    expect(customMixRuleFingerprint(legacy)).toBe(customMixRuleFingerprint(rule))
    expect(customMixRuleFingerprint(changed)).not.toBe(customMixRuleFingerprint(rule))
  })

  it('invalidates restrictive allow-list snapshots generated with permissive shares', () => {
    const rule = createCustomMixRule('Strict artist shares')
    rule.refreshIntervalMinutes = 30
    rule.artistIds = [1, 2, 3]
    rule.artistPercent = [25, 25]
    const currentFingerprint = JSON.parse(customMixRuleFingerprint(rule)) as Record<string, unknown>
    expect(currentFingerprint.artistQuotaVersion).toBe(2)

    const previousFingerprint = JSON.stringify(Object.fromEntries(
      Object.entries(currentFingerprint).filter(([key]) => key !== 'artistQuotaVersion'),
    ))
    const stale = { ...snapshot(rule), ruleFingerprint: previousFingerprint }

    expect(shouldRegenerateCustomMixSnapshot(rule, stale, 'scheduled', 1_001)).toBe(true)
  })

  it('reuses an unexpired snapshot with the exact pre-artist-share fingerprint', () => {
    const rule = createCustomMixRule('Legacy cached')
    rule.refreshIntervalMinutes = 30
    const preFeatureFingerprint = JSON.stringify({
      name: rule.name,
      description: rule.description,
      trackCount: rule.trackCount,
      refreshIntervalMinutes: rule.refreshIntervalMinutes,
      artistMode: rule.artistMode,
      artistIds: rule.artistIds,
      timeWindow: rule.timeWindow,
      completionPercent: rule.completionPercent,
      genreMode: rule.genreMode,
      genres: rule.genres,
      genrePercent: rule.genrePercent,
      sources: rule.sources,
      specials: rule.specials,
      forgottenPercent: rule.forgottenPercent,
      forgottenDays: rule.forgottenDays,
    })
    const saved = { ...snapshot(rule, 1_000), ruleFingerprint: preFeatureFingerprint }

    expect(customMixRuleFingerprint(rule)).toBe(preFeatureFingerprint)
    expect(shouldRegenerateCustomMixSnapshot(rule, saved, 'open', 2_799)).toBe(false)
  })

  it('regenerates interval-zero mixes on open but not on background checks', () => {
    const rule = createCustomMixRule('Every open')
    const saved = snapshot(rule)

    expect(shouldRegenerateCustomMixSnapshot(rule, saved, 'open', 1_001)).toBe(true)
    expect(shouldRegenerateCustomMixSnapshot(rule, saved, 'scheduled', 1_001)).toBe(false)
    expect(shouldRegenerateCustomMixSnapshot(rule, saved, 'refresh', 1_001)).toBe(true)
  })

  it('keeps interval snapshots until due and detects edited criteria', () => {
    const rule = createCustomMixRule('Timed')
    rule.refreshIntervalMinutes = 30
    const saved = snapshot(rule, 1_000)

    expect(customMixSnapshotDueAt(rule, saved)).toBe(2_800)
    expect(shouldRegenerateCustomMixSnapshot(rule, saved, 'open', 2_799)).toBe(false)
    expect(shouldRegenerateCustomMixSnapshot(rule, saved, 'scheduled', 2_800)).toBe(true)
    rule.trackCount = 25
    expect(shouldRegenerateCustomMixSnapshot(rule, saved, 'open', 1_001)).toBe(true)
  })

  it('skips candidate scans for valid cadence snapshots and preserves open regeneration for interval zero', () => {
    const timed = createCustomMixRule('Timed selection')
    timed.refreshIntervalMinutes = 30
    expect(shouldRegenerateCustomMixSelection(timed, selection(1_000), 'open', 2_799)).toBe(false)
    expect(shouldRegenerateCustomMixSelection(timed, selection(1_000), 'open', 2_800)).toBe(true)
    expect(shouldRegenerateCustomMixSelection(timed, null, 'open', 1_001)).toBe(true)

    const everyOpen = createCustomMixRule('Every open selection')
    expect(shouldRegenerateCustomMixSelection(everyOpen, selection(1_000), 'open', 1_001)).toBe(true)
    expect(shouldRegenerateCustomMixSelection(everyOpen, selection(1_000), 'scheduled', 1_001)).toBe(false)
  })
})

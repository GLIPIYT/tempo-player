import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HourMix } from '../../utils/hourMixes'
import { createCustomMixRule } from './types'
import { customMixRuleFingerprint } from './snapshot'
import { applyMixOrder, isMixGenerationHidden, mergeMixOrder } from './presentation'

function customMix(generatedAt: number, rule = createCustomMixRule('Timed mix')): HourMix {
  rule.id = 12
  rule.refreshIntervalMinutes = 30
  return {
    key: `custom:${rule.id}`,
    kind: 'custom',
    title: rule.name,
    description: rule.description,
    tracks: [],
    rule,
    generatedAt,
  } as HourMix
}

describe('mix presentation order', () => {
  it('applies saved keys first and keeps new mixes in their current order', () => {
    const mixes = [
      { key: 'new' },
      { key: 'second' },
      { key: 'first' },
      { key: 'also-new' },
    ]

    expect(applyMixOrder(mixes, ['first', 'second', 'missing'])).toEqual([
      { key: 'first' },
      { key: 'second' },
      { key: 'new' },
      { key: 'also-new' },
    ])
  })

  it('keeps absent keys in their previous slots while reordering visible keys', () => {
    expect(mergeMixOrder(
      ['hour', 'temporarily-hidden', 'artist', 'deleted', 'custom'],
      ['custom', 'hour', 'artist'],
    )).toEqual(['custom', 'temporarily-hidden', 'hour', 'deleted', 'artist'])
  })

  it('appends new visible keys without moving absent slots', () => {
    expect(mergeMixOrder(['first', 'hidden', 'second'], ['second', 'first', 'new']))
      .toEqual(['second', 'hidden', 'first', 'new'])
  })
})

describe('custom mix hide generation token', () => {
  it('keeps a cached fallback hidden and reveals a successful next generation', () => {
    const mix = customMix(1_000)
    const hiddenGenerations = {
      [mix.key]: {
        generatedAt: 1_000,
        ruleFingerprint: customMixRuleFingerprint(mix.rule!),
      },
    }

    expect(isMixGenerationHidden(mix, hiddenGenerations)).toBe(true)
    expect(isMixGenerationHidden({ ...mix, generatedAt: 1_001 } as HourMix, hiddenGenerations)).toBe(false)
  })

  it('reveals a mix when its rule changes or its refresh interval is zero', () => {
    const mix = customMix(1_000)
    const hiddenGenerations = {
      [mix.key]: {
        generatedAt: 1_000,
        ruleFingerprint: customMixRuleFingerprint(mix.rule!),
      },
    }
    const editedRule = { ...mix.rule!, trackCount: mix.rule!.trackCount + 1 }
    const intervalZeroRule = { ...mix.rule!, refreshIntervalMinutes: 0 }

    expect(isMixGenerationHidden({ ...mix, rule: editedRule }, hiddenGenerations)).toBe(false)
    expect(isMixGenerationHidden({ ...mix, rule: intervalZeroRule }, hiddenGenerations)).toBe(false)
  })
})

describe('mix presentation persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('persists order and only stores hide tokens for positive-cadence custom mixes', async () => {
    const values = new Map<string, string>()
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    } as unknown as Storage
    vi.stubGlobal('window', {
      localStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window)
    vi.resetModules()

    const { hideMixUntilNextGeneration, saveMixOrder } = await import('./presentation')
    const mix = customMix(1_000)
    saveMixOrder(['hour', 'custom:12'])
    hideMixUntilNextGeneration(mix)
    hideMixUntilNextGeneration({ ...mix, rule: { ...mix.rule!, refreshIntervalMinutes: 0 } })

    const stored = JSON.parse(values.get('tempo.mixPresentation.v1') ?? '{}') as {
      order: string[]
      hiddenGenerations: Record<string, { generatedAt: number; ruleFingerprint: string }>
    }
    expect(stored.order).toEqual(['hour', 'custom:12'])
    expect(stored.hiddenGenerations['custom:12']).toEqual({
      generatedAt: 1_000,
      ruleFingerprint: customMixRuleFingerprint(mix.rule!),
    })
  })

  it('keeps the pure storage actions safe without a browser localStorage', async () => {
    vi.stubGlobal('window', undefined)
    vi.resetModules()

    const { hideMixUntilNextGeneration, saveMixOrder } = await import('./presentation')
    expect(() => saveMixOrder(['hour'])).not.toThrow()
    expect(() => hideMixUntilNextGeneration(customMix(1_000))).not.toThrow()
  })
})

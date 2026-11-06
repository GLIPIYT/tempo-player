import { describe, expect, it } from 'vitest'
import { hasSupportedRecommendationTitle } from './title'

describe('recommendation title scripts', () => {
  it('rejects titles predominantly written outside Latin and Cyrillic', () => {
    expect(hasSupportedRecommendationTitle('مرحبا بالعالم')).toBe(false)
    expect(hasSupportedRecommendationTitle('東京の夜')).toBe(false)
    expect(hasSupportedRecommendationTitle('Αθήνα')).toBe(false)
  })

  it('allows English and Russian titles with small fragments from other scripts', () => {
    expect(hasSupportedRecommendationTitle('English title مرحبا')).toBe(true)
    expect(hasSupportedRecommendationTitle('Русское название 東京')).toBe(true)
    expect(hasSupportedRecommendationTitle('English Русский title')).toBe(true)
  })

  it('allows titles without letters', () => {
    expect(hasSupportedRecommendationTitle('🎵 2026')).toBe(true)
  })
})

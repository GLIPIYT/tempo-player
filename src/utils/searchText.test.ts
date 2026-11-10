import { describe, expect, it } from 'vitest'
import { normalizeProviderSearchQuery, normalizeSearchText } from './searchText'

describe('normalizeSearchText', () => {
  it('folds ё to е and lowercases text', () => {
    expect(normalizeSearchText('ЁЩЁ')).toBe('еще')
  })

  it('applies NFKC before case folding', () => {
    expect(normalizeSearchText('ＦＵＬＬ Ｔｅｓｔ')).toBe('full test')
  })

  it('preserves provider query syntax and case-sensitive URL identifiers', () => {
    expect(normalizeProviderSearchQuery('Ёлка OR Чёрный')).toBe('Елка OR Черный')
    expect(normalizeProviderSearchQuery(' https://youtu.be/AbCdEF12345 ')).toBe('https://youtu.be/AbCdEF12345')
  })
})

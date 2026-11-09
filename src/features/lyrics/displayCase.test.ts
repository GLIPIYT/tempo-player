import { expect, it } from 'vitest'
import { capitalizeLyricLines } from './displayCase'
it('capitalizes each visible line after punctuation without lowercasing artist spelling or changing spacing', () => {
  expect(capitalizeLyricLines('  «только не домой»\n\n(hello WORLD)\n123 всё ещё здесь')).toBe('  «Только не домой»\n\n(Hello WORLD)\n123 Всё ещё здесь')
})

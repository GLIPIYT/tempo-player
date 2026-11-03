import { afterEach, describe, expect, it, vi } from 'vitest'
import { lyricsPaneWidthAtPointer, readLyricsPaneWidth, writeLyricsPaneWidth } from './lyricsPaneWidth'

afterEach(() => vi.unstubAllGlobals())

describe('lyrics pane width', () => {
  it('keeps the divider aligned with the pointer at different zoom levels', () => {
    expect(lyricsPaneWidthAtPointer(402.4, 0, 1000, 1000)).toBeCloseTo(40)
    expect(lyricsPaneWidthAtPointer(603.6, 0, 1500, 1000)).toBeCloseTo(40)
    expect(lyricsPaneWidthAtPointer(0, 0, 1000, 1000)).toBe(25)
    expect(lyricsPaneWidthAtPointer(1000, 0, 1000, 1000)).toBe(65)
  })

  it('tracks sub-percent pointer movement and preserves fractional width', () => {
    const first = lyricsPaneWidthAtPointer(402.4, 0, 1000, 1000)
    const next = lyricsPaneWidthAtPointer(403.4, 0, 1000, 1000)
    expect(next).toBeGreaterThan(first)
    expect(next - first).toBeCloseTo(100 / 976)
    const values = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } })
    writeLyricsPaneWidth(next)
    expect(readLyricsPaneWidth()).toBe(next)
  })

  it('persists and validates its own setting', () => {
    const values = new Map<string, string>([['other-setting', 'untouched']])
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    vi.stubGlobal('window', { localStorage })
    expect(readLyricsPaneWidth()).toBe(40)
    writeLyricsPaneWidth(53)
    expect(readLyricsPaneWidth()).toBe(53)
    values.set('tempo.lyrics-pane-width.v1', 'broken')
    expect(readLyricsPaneWidth()).toBe(40)
    values.set('tempo.lyrics-pane-width.v1', '999')
    expect(readLyricsPaneWidth()).toBe(65)
    expect(values.get('other-setting')).toBe('untouched')
  })

  it('works when storage is unavailable', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('unavailable') } })
    expect(readLyricsPaneWidth()).toBe(40)
    expect(() => writeLyricsPaneWidth(50)).not.toThrow()
  })
})

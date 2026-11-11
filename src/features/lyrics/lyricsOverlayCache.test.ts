import { beforeEach, describe, expect, it } from 'vitest'
import { clearLyricsOverlayCache, getLyricsOverlayCache, setLyricsOverlayCache } from './lyricsOverlayCache'

beforeEach(clearLyricsOverlayCache)

describe('lyrics overlay cache', () => {
  it('keeps the 32 most recently used entries', () => {
    for (let index = 0; index < 32; index++) {
      setLyricsOverlayCache(`track-${index}`, { candidates: [], selectedIndex: 0 })
    }
    expect(getLyricsOverlayCache('track-0')).toBeDefined()
    setLyricsOverlayCache('track-32', { candidates: [], selectedIndex: 0 })

    expect(getLyricsOverlayCache('track-0')).toBeDefined()
    expect(getLyricsOverlayCache('track-1')).toBeUndefined()
    expect(getLyricsOverlayCache('track-32')).toBeDefined()
  })

  it('refreshes existing values without increasing the entry count', () => {
    const value = { candidates: [], selectedIndex: 2 }
    setLyricsOverlayCache('same-track', value)
    setLyricsOverlayCache('same-track', { candidates: [], selectedIndex: 3 })
    expect(getLyricsOverlayCache('same-track')).toMatchObject({ selectedIndex: 3 })
  })
})

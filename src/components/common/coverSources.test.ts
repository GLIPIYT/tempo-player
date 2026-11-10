import { describe, expect, it } from 'vitest'
import { buildCoverSources } from './coverSources'
import { firstAvailableArtwork } from './artworkFallback'

describe('buildCoverSources', () => {
  it('tries the original YouTube Music artwork before the reported thumbnail', () => {
    const thumbnail = 'https://lh3.googleusercontent.com/artwork-id=w544-h544-l90-rj'

    expect(buildCoverSources(thumbnail, true)).toEqual([
      'https://lh3.googleusercontent.com/artwork-id=s0',
      thumbnail,
    ])
  })

  it('falls back to the reported thumbnail when the original rendition fails', () => {
    const thumbnail = 'https://lh3.googleusercontent.com/artwork-id=w544-h544-l90-rj'
    const sources = buildCoverSources(thumbnail, true)

    expect(firstAvailableArtwork(sources, [sources[0]])).toBe(thumbnail)
  })

  it('preserves query parameters and fragments on original candidates', () => {
    const thumbnail = 'https://lh3.googleusercontent.com/artwork-id=w544-h544-l90-rj?authuser=0#cover'

    expect(buildCoverSources(thumbnail, true)).toEqual([
      'https://lh3.googleusercontent.com/artwork-id=s0?authuser=0#cover',
      thumbnail,
    ])
  })

  it('keeps the original source when no safe YouTube upgrade is available', () => {
    expect(buildCoverSources('C:/music/cover.jpg', true)).toEqual(['C:/music/cover.jpg'])
    expect(buildCoverSources('https://images.example/cover.jpg', true)).toEqual(['https://images.example/cover.jpg'])
    expect(buildCoverSources('https://lh3.googleusercontent.com/artwork-id=w544-h544-l90-rj')).toEqual([
      'https://lh3.googleusercontent.com/artwork-id=w544-h544-l90-rj',
    ])
  })

  it('returns no candidates when a cover path is missing', () => {
    expect(buildCoverSources(null, true)).toEqual([])
  })
})

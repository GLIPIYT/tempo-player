import { describe, expect, it } from 'vitest'
import { buildCoverSources, coverSourceRetryDelay, nextCoverSourceRetry } from './coverSources'
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

  it('keeps the SoundCloud cover first and offers its large sibling as fallback', () => {
    const cover = 'https://i1.sndcdn.com/artworks-abc-t500x500.jpg'

    expect(buildCoverSources(cover)).toEqual([
      cover,
      'https://i1.sndcdn.com/artworks-abc-large.jpg',
    ])
  })

  it('returns no candidates when a cover path is missing', () => {
    expect(buildCoverSources(null, true)).toEqual([])
  })
})

describe('cover source retries', () => {
  it('retries transient failures twice, then allows the next fallback source', () => {
    const first = nextCoverSourceRetry('/covers/track.jpg', null)
    const second = nextCoverSourceRetry('/covers/track.jpg', first)

    expect(first).toEqual({ source: '/covers/track.jpg', attempt: 1 })
    expect(second).toEqual({ source: '/covers/track.jpg', attempt: 2 })
    expect(nextCoverSourceRetry('/covers/track.jpg', second)).toBeNull()
    expect(nextCoverSourceRetry('/covers/fallback.jpg', second)).toEqual({ source: '/covers/fallback.jpg', attempt: 1 })
  })

  it('uses bounded backoff delays', () => {
    expect([1, 2, 3, 8].map(coverSourceRetryDelay)).toEqual([160, 320, 640, 800])
  })
})

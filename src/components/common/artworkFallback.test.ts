import { describe, expect, it } from 'vitest'
import { buildArtworkSources, firstAvailableArtwork } from './artworkFallback'

describe('firstAvailableArtwork', () => {
  it('moves to the next thumbnail after the current image fails', async () => {
    expect(
      firstAvailableArtwork(
        ['https://img.test/maxresdefault.jpg', 'https://img.test/sddefault.jpg'],
        ['https://img.test/maxresdefault.jpg'],
      ),
    ).toBe('https://img.test/sddefault.jpg')
  })

  it('returns no image when every candidate has failed', () => {
    expect(firstAvailableArtwork(['https://img.test/cover.jpg'], ['https://img.test/cover.jpg'])).toBeNull()
  })
})

describe('buildArtworkSources', () => {
  it('prefers a 300px SoundCloud image for cards and retains full and small fallbacks', () => {
    expect(buildArtworkSources('https://i1.sndcdn.com/artworks-test-t500x500.jpg?token=1', [], false, 'card'))
      .toEqual([
        'https://i1.sndcdn.com/artworks-test-t300x300.jpg?token=1',
        'https://i1.sndcdn.com/artworks-test-t500x500.jpg?token=1',
        'https://i1.sndcdn.com/artworks-test-large.jpg?token=1',
      ])
  })

  it('preserves compact source ordering and leaves non-SoundCloud URLs unchanged', () => {
    expect(buildArtworkSources('https://i1.sndcdn.com/artworks-test-t500x500.jpg', [], true))
      .toEqual([
        'https://i1.sndcdn.com/artworks-test-large.jpg',
        'https://i1.sndcdn.com/artworks-test-t500x500.jpg',
      ])
    expect(buildArtworkSources('https://images.test/cover.jpg', [], false, 'card'))
      .toEqual(['https://images.test/cover.jpg'])
  })

  it('prefers a 200px thumbnail for smaller recommendation cards', () => {
    expect(buildArtworkSources('https://i1.sndcdn.com/avatars-test-t500x500.png', [], false, 'small-card')).toEqual([
      'https://i1.sndcdn.com/avatars-test-t200x200.png',
      'https://i1.sndcdn.com/avatars-test-t300x300.png',
      'https://i1.sndcdn.com/avatars-test-t500x500.png',
      'https://i1.sndcdn.com/avatars-test-large.png',
    ])
  })
})

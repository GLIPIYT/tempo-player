import { describe, expect, it } from 'vitest'
import { firstAvailableArtwork } from './artworkFallback'

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

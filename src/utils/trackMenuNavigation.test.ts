import { describe, expect, it } from 'vitest'
import type { Track } from '../types/models'
import { rememberSoundCloudTrack } from '../soundcloud/cacheMetadata'
import { trackToUnified } from './unified'
import { trackMenuNavigationVisibility } from './trackMenuNavigation'

const track = (patch: Partial<Track> = {}): Track => ({
  id: 1, path: 'C:/music/1.mp3', title: 'Song', artistId: 7, artistName: 'Artist',
  albumId: 11, albumTitle: 'Album', trackNumber: null, discNumber: null, durationSec: 180,
  year: null, genre: null, coverPath: null, fileSize: 0, modifiedAt: 0, addedAt: 0,
  source: 'local', externalId: null, lastPlayedAt: null, playCount: 0, skipCount: 0,
  gainDb: null, peakDb: null, ...patch,
})

describe('track menu navigation visibility', () => {
  it('hides links back to the current local artist and album', () => {
    expect(trackMenuNavigationVisibility({ name: 'artist', id: 7 }, track())).toEqual({ artist: false, album: true })
    expect(trackMenuNavigationVisibility({ name: 'album', id: 11 }, track())).toEqual({ artist: true, album: false })
  })

  it('compares local fallback artist names without changing ё/е identity', () => {
    expect(trackMenuNavigationVisibility({ name: 'local-artist', artistName: 'Artist', imagePath: null }, track()).artist).toBe(false)
    expect(trackMenuNavigationVisibility({ name: 'local-artist', artistName: 'Ёлка', imagePath: null }, track({ artistName: 'Елка' })).artist).toBe(true)
  })

  it('matches SoundCloud artist identity by uploader ID or its page name', () => {
    rememberSoundCloudTrack({
      id: '42', title: 'Song', artist: 'Uploader', durationMs: 180_000, artworkUrl: null,
      artistAvatarUrl: null, permalinkUrl: null, streamable: true, hasProgressive: true,
      hasHls: false, uploaderId: 'sc-artist-1', uploaderName: 'Uploader',
    })
    const soundcloudTrack = track({ source: 'soundcloud', externalId: '42' })
    expect(trackMenuNavigationVisibility({ name: 'sc-artist', id: 'sc-artist-1' }, soundcloudTrack).artist).toBe(false)
    expect(trackMenuNavigationVisibility({ name: 'sc-artist', id: 'different', artistName: 'Artist' }, soundcloudTrack).artist).toBe(false)
  })

  it('hides the current YouTube artist link but preserves navigation on the separate track page', () => {
    const youtubeTrack = track({ source: 'youtube', artistName: 'Artist' })
    expect(trackMenuNavigationVisibility({ name: 'yt-collection', kind: 'artist', id: 'UC1', artistName: 'Artist' }, youtubeTrack).artist).toBe(false)
    expect(trackMenuNavigationVisibility({ name: 'track-details', track: trackToUnified(track()), previous: { name: 'album', id: 11 } }, track())).toEqual({ artist: true, album: true })
  })
})

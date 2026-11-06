import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScTrack, UnifiedTrack } from '../types/models'

const mocks = vi.hoisted(() => ({ listArtists: vi.fn(), scGetArtist: vi.fn() }))
vi.mock('../api/client', () => ({ api: mocks }))
import { resolveArtistView } from './artistNavigation'
import { getKnownSoundCloudTrack, rememberSoundCloudSourceTrack, rememberSoundCloudTrack } from '../soundcloud/cacheMetadata'

const track = (overrides: Partial<UnifiedTrack> = {}): UnifiedTrack => ({
  source: 'soundcloud', sourceId: '12345', dbId: null, title: 'Song', artists: ['Artist'],
  album: null, durationSec: 180, coverPath: null, playable: true, localPath: null,
  externalUrl: null, gainDb: null, ...overrides,
})

describe('artist navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listArtists.mockResolvedValue([{ id: 7, name: 'Artist' }])
    mocks.scGetArtist.mockResolvedValue({ id: '42', username: 'Artist' })
    vi.stubGlobal('navigator', { onLine: true })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('prefers a known available SoundCloud profile over an existing local artist', async () => {
    await expect(resolveArtistView(track({ artistSourceId: '42' }), 'Artist')).resolves.toEqual({ name: 'sc-artist', id: '42' })
    expect(mocks.scGetArtist).toHaveBeenCalledWith('42')
  })

  it('uses the local artist when SoundCloud is unreachable', async () => {
    mocks.scGetArtist.mockRejectedValue(new Error('Offline'))
    await expect(resolveArtistView(track({ artistSourceId: '42' }), 'Artist')).resolves.toEqual({ name: 'artist', id: 7 })
  })

  it('does not query SoundCloud without artist identity or while offline', async () => {
    await resolveArtistView(track(), 'Artist')
    vi.stubGlobal('navigator', { onLine: false })
    await expect(resolveArtistView(track({ artistSourceId: '42' }), 'Artist')).resolves.toEqual({ name: 'artist', id: 7 })
    expect(mocks.scGetArtist).not.toHaveBeenCalled()
  })

  it('opens a local artist page even if the performer has no stored artist row', async () => {
    mocks.listArtists.mockResolvedValue([])
    await expect(resolveArtistView(track(), 'Other')).resolves.toEqual({ name: 'local-artist', artistName: 'Other', imagePath: null })
  })

  it('does not link a second credited artist to the first artist profile', async () => {
    await resolveArtistView(track({ artistSourceId: '42', artists: ['First', 'Artist'] }), 'Artist')
    expect(mocks.scGetArtist).not.toHaveBeenCalled()
  })

  it('falls back locally after the online lookup timeout', async () => {
    vi.useFakeTimers()
    mocks.scGetArtist.mockReturnValue(new Promise(() => {}))
    const result = resolveArtistView(track({ artistSourceId: '42' }), 'Artist')
    await vi.advanceTimersByTimeAsync(2500)
    await expect(result).resolves.toEqual({ name: 'artist', id: 7 })
  })

  it('keeps the known uploader identity when a saved-track update has less metadata', async () => {
    const source: ScTrack = { id: '54321', title: 'Song', artist: 'Artist', durationMs: 180000,
      artworkUrl: null, artistAvatarUrl: null, permalinkUrl: null, streamable: true,
      hasProgressive: true, hasHls: false, uploaderId: '42', uploaderName: 'Artist' }
    rememberSoundCloudTrack(source)
    const saved = track({ sourceId: source.id })
    rememberSoundCloudSourceTrack(saved)
    expect(getKnownSoundCloudTrack(source.id)?.uploaderId).toBe('42')
    await expect(resolveArtistView(saved, 'Artist')).resolves.toEqual({ name: 'sc-artist', id: '42' })
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { Track } from '../types/models'
vi.mock('../api/client', () => ({
  api: { scImportTrack: vi.fn().mockResolvedValue(517) },
}))
import { api } from '../api/client'
import { ensureLibraryTrackId, savedTrackId } from './transientTracks'

describe('explicitly saving a temporary mix result', () => {
  it('imports once for concurrent actions and keeps the provider identity', async () => {
    const track = {
      id: -517,
      source: 'soundcloud',
      externalId: '123456',
      title: 'Song',
      artistName: 'Artist',
      genre: 'Indie',
      durationSec: 180,
      coverPath: null,
    } as Track
    const first = ensureLibraryTrackId(track)
    const second = ensureLibraryTrackId(track)
    expect(first).toBe(second)
    expect(await first).toBe(517)
    expect(api.scImportTrack).toHaveBeenCalledOnce()
    expect(api.scImportTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: '123456', title: 'Song', genre: 'Indie' }),
    )
    expect(savedTrackId(-517)).toBe(517)
    expect(await ensureLibraryTrackId(track)).toBe(517)
    expect(api.scImportTrack).toHaveBeenCalledOnce()
  })
  it('does not import existing library tracks', async () => {
    expect(await ensureLibraryTrackId({ id: 88 } as Track)).toBe(88)
  })
})

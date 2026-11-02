import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import type { OnlineLyricsCandidateData, UnifiedTrack } from '../../types/models'
import { clearOnlineLyricsCandidateCache, fetchOnlineLyricsCandidates } from './onlineProvider'

vi.mock('../../api/client', () => ({
  api: { fetchOnlineLyricsAll: vi.fn(), fetchOnlineLyrics: vi.fn() },
}))

const track = {
  source: 'local',
  sourceId: 'saved-track',
  dbId: 42,
  title: 'Original title',
  artists: ['Original artist'],
  album: 'Original album',
  durationSec: 214,
} as UnifiedTrack

function result(plain: string): OnlineLyricsCandidateData {
  return {
    provider: 'lrclib',
    plain,
    syncedLrc: null,
    id: 7,
    trackName: 'Search title',
    artistName: 'Search artist',
    albumName: 'Original album',
    duration: 214,
    instrumental: false,
    copyright: null,
  }
}

describe('online lyrics candidate lookup', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clearOnlineLyricsCandidateCache()
  })

  it('includes saved-track album and duration metadata in a search request', async () => {
    vi.mocked(api.fetchOnlineLyricsAll).mockResolvedValue([result('Fetched lyrics')])

    const candidates = await fetchOnlineLyricsCandidates('Search artist', 'Search title', track)

    expect(api.fetchOnlineLyricsAll).toHaveBeenCalledWith('Search artist', 'Search title', 'Original album', 214)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].result).toEqual({ kind: 'plain', text: 'Fetched lyrics' })
  })

  it('does not cache an empty result, so a later lookup can recover', async () => {
    vi.mocked(api.fetchOnlineLyricsAll)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([result('Lyrics available on retry')])

    expect(await fetchOnlineLyricsCandidates('Search artist', 'Search title', track)).toEqual([])
    const recovered = await fetchOnlineLyricsCandidates('Search artist', 'Search title', track)

    expect(api.fetchOnlineLyricsAll).toHaveBeenCalledTimes(2)
    expect(recovered[0]?.result).toEqual({ kind: 'plain', text: 'Lyrics available on retry' })
  })

  it('lets manual re-search bypass and refresh a cached candidate list', async () => {
    vi.mocked(api.fetchOnlineLyricsAll)
      .mockResolvedValueOnce([result('Previously cached lyrics')])
      .mockResolvedValueOnce([result('Updated search result')])

    await fetchOnlineLyricsCandidates('Search artist', 'Search title', track)
    const refreshed = await fetchOnlineLyricsCandidates('Search artist', 'Search title', track, { forceRefresh: true })
    const cachedRefresh = await fetchOnlineLyricsCandidates('Search artist', 'Search title', track)

    expect(api.fetchOnlineLyricsAll).toHaveBeenCalledTimes(2)
    expect(refreshed[0]?.result).toEqual({ kind: 'plain', text: 'Updated search result' })
    expect(cachedRefresh[0]?.result).toEqual({ kind: 'plain', text: 'Updated search result' })
  })

  it('does not retain stale results when an explicit re-search returns no candidates', async () => {
    vi.mocked(api.fetchOnlineLyricsAll)
      .mockResolvedValueOnce([result('Previously cached lyrics')])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([result('Recovered after re-search')])

    await fetchOnlineLyricsCandidates('Search artist', 'Search title', track)
    expect(await fetchOnlineLyricsCandidates('Search artist', 'Search title', track, { forceRefresh: true })).toEqual([])
    const recovered = await fetchOnlineLyricsCandidates('Search artist', 'Search title', track)

    expect(api.fetchOnlineLyricsAll).toHaveBeenCalledTimes(3)
    expect(recovered[0]?.result).toEqual({ kind: 'plain', text: 'Recovered after re-search' })
  })
})

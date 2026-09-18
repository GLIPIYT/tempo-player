import { describe, expect, it } from 'vitest'
import { localTrackToUnified } from './localProvider'
import type { Track } from '../types/models'

function row(patch: Partial<Track>): Track {
  return {
    id: 1,
    path: '',
    title: 'a track',
    artistId: null,
    artistName: null,
    albumId: null,
    albumTitle: null,
    trackNumber: null,
    discNumber: null,
    durationSec: null,
    year: null,
    genre: null,
    coverPath: null,
    fileSize: 0,
    modifiedAt: 0,
    addedAt: 0,
    source: 'local',
    externalId: null,
    lastPlayedAt: null,
    playCount: 0,
    skipCount: 0,
    gainDb: null,
    peakDb: null,
    ...patch,
  }
}

describe('localTrackToUnified', () => {
  it('keeps a local track pointing at its file', () => {
    const track = localTrackToUnified(row({ source: 'local', path: 'C:/music/a.mp3' }))
    expect(track.source).toBe('local')
    expect(track.localPath).toBe('C:/music/a.mp3')
  })

  it('never passes a youtube:// path on as a file', () => {
    // The row's path is an identifier rather than a file. Passing it through
    // sends `youtube://<id>` to convertFileSrc, which resolves to nothing - and
    // a track that played perfectly from a search result would not play at all
    // once it was in the library. That is exactly what happened.
    const track = localTrackToUnified(
      row({ source: 'youtube', path: 'youtube://abc123', externalId: 'abc123' }),
    )
    expect(track.source).toBe('youtube')
    expect(track.sourceId).toBe('abc123')
    expect(track.localPath).toBeNull()
  })

  it('does the same for soundcloud', () => {
    const track = localTrackToUnified(
      row({ source: 'soundcloud', path: 'soundcloud://42', externalId: '42' }),
    )
    expect(track.source).toBe('soundcloud')
    expect(track.localPath).toBeNull()
  })

  it('falls back to the row id when an external track has no external id', () => {
    const track = localTrackToUnified(row({ source: 'youtube', id: 7, externalId: null }))
    expect(track.sourceId).toBe('7')
  })
})

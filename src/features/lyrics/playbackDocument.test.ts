import { describe, expect, it } from 'vitest'
import { activeOverrideDocument, candidatePlaybackDocument } from './playbackDocument'
import { toPlaybackLines } from './editorDocument'
import type { LyricsOverride } from '../../types/models'

const pinned: LyricsOverride = {
  provider: 'manual', sourceArtist: 'artist', sourceTitle: 'song', lrc: '[00:01.00]one', offsetMs: 1500, updatedAt: 1,
  editorDocument: { mode: 'synced', lines: [{ text: 'one', startMs: 1000, endMs: 3000 }] },
  editedVersion: { provider: 'manual', sourceArtist: 'artist', sourceTitle: 'song', lrc: '[00:01.00]one', offsetMs: 0, updatedAt: 1 },
}

describe('activeOverrideDocument', () => {
  it('keeps source words and authored ends on embedded candidate import; derived ends stay automatic', () => {
    const document = candidatePlaybackDocument({ provider: 'embedded', syncedLrc: null, plain: null,
      result: { kind: 'synced', lines: [
        { text: 'exact', timeSec: 1.123, endTimeSec: 3.456, endSource: 'source', words: [{ text: 'exact', timeSec: 1.123, endTimeSec: 3.456 }] },
        { text: 'estimated', timeSec: 8 },
      ] } }, 40000)
    expect(toPlaybackLines(document)).toEqual([
      { text: 'exact', timeSec: 1.123, endTimeSec: 3.456, endSource: 'source', words: [{ text: 'exact', timeSec: 1.123, endTimeSec: 3.456 }] },
      { text: 'estimated', timeSec: 8 },
    ])
  })
  it('does not replace a rich candidate with its lossy compatibility LRC', () => {
    const document = candidatePlaybackDocument({ provider: 'manual', plain: null, syncedLrc: '[00:01.00]one',
      result: { kind: 'synced', lines: [{ text: 'one', timeSec: 1, endTimeSec: 4, endSource: 'manual',
        words: [{ text: 'one', timeSec: 1, endTimeSec: 3 }] }] } }, 40000)
    expect(toPlaybackLines(document)?.[0]).toEqual({ text: 'one', timeSec: 1, endTimeSec: 4, endSource: 'manual',
      words: [{ text: 'one', timeSec: 1, endTimeSec: 3 }] })
  })
  it('uses saved endpoints for the active saved version even after an offset nudge', () => {
    expect(activeOverrideDocument(pinned)).toEqual(pinned.editorDocument)
  })
  it.each([
    { provider: 'lrclib' }, { lrc: '[00:01.00]different' }, { sourceArtist: 'different' }, { sourceTitle: 'different' },
    { sourceArtist: null }, { sourceTitle: null }, { sourceArtist: null, sourceTitle: null },
  ])('rejects an unrelated active pin: %j', (different) => {
    expect(activeOverrideDocument({ ...pinned, ...different })).toBeNull()
  })
  it('rejects retained endpoints when the native active pin has null source metadata', () => {
    const nativePin: LyricsOverride = { ...pinned, sourceArtist: null, sourceTitle: null }
    expect(nativePin.editedVersion?.sourceArtist).toBe('artist')
    expect(activeOverrideDocument(nativePin)).toBeNull()
    expect(activeOverrideDocument({ ...nativePin, isActive: false })).toBeNull()
  })
  it('rejects inactive documents and supports exact legacy LRC identity', () => {
    expect(activeOverrideDocument({ ...pinned, isActive: false })).toBeNull()
    expect(activeOverrideDocument({ ...pinned, editedVersion: null })).toEqual(pinned.editorDocument)
    expect(activeOverrideDocument({ ...pinned, editedVersion: null, lrc: '[00:02.00]one' })).toBeNull()
  })
})

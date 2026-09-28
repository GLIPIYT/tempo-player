import { describe, expect, it } from 'vitest'
import { activeOverrideDocument } from './playbackDocument'
import type { LyricsOverride } from '../../types/models'

const pinned: LyricsOverride = {
  provider: 'manual', sourceArtist: 'artist', sourceTitle: 'song', lrc: '[00:01.00]one', offsetMs: 1500, updatedAt: 1,
  editorDocument: { mode: 'synced', lines: [{ text: 'one', startMs: 1000, endMs: 3000 }] },
  editedVersion: { provider: 'manual', sourceArtist: 'artist', sourceTitle: 'song', lrc: '[00:01.00]one', offsetMs: 0, updatedAt: 1 },
}

describe('activeOverrideDocument', () => {
  it('uses saved endpoints for the active saved version even after an offset nudge', () => {
    expect(activeOverrideDocument(pinned)).toEqual(pinned.editorDocument)
  })
  it.each([
    { provider: 'lrclib' }, { lrc: '[00:01.00]different' }, { sourceArtist: 'different' }, { sourceTitle: 'different' },
  ])('rejects an unrelated active pin: %j', (different) => {
    expect(activeOverrideDocument({ ...pinned, ...different })).toBeNull()
  })
  it('rejects inactive documents and supports exact legacy LRC identity', () => {
    expect(activeOverrideDocument({ ...pinned, isActive: false })).toBeNull()
    expect(activeOverrideDocument({ ...pinned, editedVersion: null })).toEqual(pinned.editorDocument)
    expect(activeOverrideDocument({ ...pinned, editedVersion: null, lrc: '[00:02.00]one' })).toBeNull()
  })
})

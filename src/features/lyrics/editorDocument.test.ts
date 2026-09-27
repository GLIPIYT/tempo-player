import { describe, expect, it } from 'vitest'
import { setSyncedLineTimeAtPlaybackPosition } from './editorDocument'
import type { SyncedLyricsDocument } from './editorDocument'

describe('setSyncedLineTimeAtPlaybackPosition', () => {
  it('can capture the current playback position as a line end', () => {
    const document: SyncedLyricsDocument = {
      mode: 'synced',
      lines: [
        { text: 'first line', startMs: 12_000, endMs: 18_000 },
        { text: 'second line', startMs: 18_000, endMs: null },
      ],
    }

    expect(setSyncedLineTimeAtPlaybackPosition(document, 0, 'endMs', 19_000)).toEqual({
      mode: 'synced',
      lines: [
        { text: 'first line', startMs: 12_000, endMs: 19_000 },
        { text: 'second line', startMs: 18_000, endMs: null },
      ],
    })
  })

  it('does not accept an end time at or before the line start', () => {
    const document: SyncedLyricsDocument = {
      mode: 'synced',
      lines: [{ text: 'line', startMs: 19_000, endMs: null }],
    }

    expect(setSyncedLineTimeAtPlaybackPosition(document, 0, 'endMs', 19_000)).toBe(document)
  })

  it('clears an old end time when the captured start moves past it', () => {
    const document: SyncedLyricsDocument = {
      mode: 'synced',
      lines: [{ text: 'line', startMs: 12_000, endMs: 18_000 }],
    }

    expect(setSyncedLineTimeAtPlaybackPosition(document, 0, 'startMs', 19_000).lines[0]).toEqual({
      text: 'line',
      startMs: 19_000,
      endMs: null,
    })
  })
})

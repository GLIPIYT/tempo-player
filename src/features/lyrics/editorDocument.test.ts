import { describe, expect, it } from 'vitest'
import { cloneLyricsDocument, fromLrc, editSyncedLineTime, setSyncedLineText, setSyncedLineTimeAtPlaybackPosition, sortSyncedLines, toPlaybackLines, validateLyricsDocument } from './editorDocument'
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
        { text: 'first line', startMs: 12_000, endMs: 19_000, endOrigin: 'manual' },
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

describe('timing provenance', () => {
  it('imports crossing-zero source offsets into a saveable rich document', () => {
    const document = fromLrc('[offset:2000]\n[00:01]<00:01>one <00:02>two<00:03>', 10_000)
    expect(validateLyricsDocument(document, 10_000)).toEqual([])
    expect(toPlaybackLines(document)?.[0].words).toEqual([
      { text: 'one ', timeSec: 0, endTimeSec: null }, { text: 'two', timeSec: 0, endTimeSec: 1 },
    ])
    const original = fromLrc('[00:01]<00:01>one <00:02>two<00:03>', 10_000)
    expect(toPlaybackLines(original, -2000)?.[0].words?.[0].endTimeSec).toBeNull()
    if (original.mode !== 'synced') throw new Error('expected synced')
    expect(original.lines[0].words?.[0].endMs).toBe(2000)
  })

  it('marks manually typed ends and clears their origin when emptied', () => {
    const document: SyncedLyricsDocument = { mode: 'synced', lines: [{ text: 'one', startMs: 1000, endMs: 3000, endOrigin: 'auto' }] }
    const edited = editSyncedLineTime(document, 0, 'endMs', 4000)
    expect(toPlaybackLines(edited)?.[0].endSource).toBe('manual')
    expect(editSyncedLineTime(edited, 0, 'endMs', null).lines[0].endOrigin).toBeUndefined()
  })

  it('clones timing metadata and discards source timings when its text changes', () => {
    const document: SyncedLyricsDocument = { mode: 'synced', lines: [{ text: 'one', startMs: 1000, endMs: 3000,
      endOrigin: 'source', words: [{ text: 'one', startMs: 1000, endMs: 3000 }],
    }] }
    const cloned = cloneLyricsDocument(document)
    expect(cloned).toEqual(document)
    if (cloned.mode !== 'synced') throw new Error('expected synced')
    cloned.lines[0].words![0].text = 'changed'
    expect(document.lines[0].words![0].text).toBe('one')
    const edited = setSyncedLineText(document, 0, 'different')
    expect(edited.lines[0].words).toBeUndefined()
    expect(toPlaybackLines(edited)?.[0].endTimeSec).toBeUndefined()
    expect(setSyncedLineText({ mode: 'synced', lines: [{ text: 'one', startMs: 1000, endMs: 3000 }] }, 0, 'changed').lines[0].endMs).toBe(3000)
  })

  it('marks inferred import ends auto so they do not override the resolver', () => {
    const document = fromLrc('[00:01]short\n[00:41]next', 60_000)
    expect(document.mode).toBe('synced')
    if (document.mode !== 'synced') throw new Error('expected synced')
    expect(document.lines[0].endOrigin).toBe('auto')
    expect(toPlaybackLines(document)?.[0].endTimeSec).toBeUndefined()
  })

  it('preserves source word timings and exact endpoints during import and projection', () => {
    const document = fromLrc('[00:01]<00:01>Stay <00:02>here<00:03>', 10_000)
    if (document.mode !== 'synced') throw new Error('expected synced')
    expect(document.lines[0]).toEqual({ text: 'Stay here', startMs: 1000, endMs: 3000, endOrigin: 'source',
      words: [{ text: 'Stay ', startMs: 1000, endMs: 2000 }, { text: 'here', startMs: 2000, endMs: 3000 }],
    })
    expect(toPlaybackLines(document, 500)?.[0].endTimeSec).toBe(3.5)
    expect(toPlaybackLines(document, -500)?.[0].words?.[0].timeSec).toBe(0.5)
  })

  it('treats legacy saved ends as manual and retains them through sorting', () => {
    const document: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'later', startMs: 5000, endMs: 8000 }, { text: 'earlier', startMs: 1000, endMs: 7000 },
    ] }
    const sorted = sortSyncedLines(document)
    expect(toPlaybackLines(sorted)?.[0]).toEqual({ timeSec: 1, text: 'earlier', endTimeSec: 7, endSource: 'manual' })
  })

  it('discards stale source words and end provenance when the start invalidates the end', () => {
    const document: SyncedLyricsDocument = { mode: 'synced', lines: [{ text: 'line', startMs: 1000, endMs: 2000,
      endOrigin: 'source', words: [{ text: 'line', startMs: 1000, endMs: 2000 }],
    }] }
    const changed = setSyncedLineTimeAtPlaybackPosition(document, 0, 'startMs', 3000).lines[0]
    expect(changed.endMs).toBeNull()
    expect(changed.endOrigin).toBeUndefined()
    expect(changed.words).toBeUndefined()
  })

  it('rejects malformed word bounds without rejecting a manual overlap', () => {
    const document: SyncedLyricsDocument = { mode: 'synced', lines: [
      { text: 'one', startMs: 1000, endMs: 6000, endOrigin: 'manual', words: [{ text: 'one', startMs: 1000, endMs: 900 }] },
      { text: 'two', startMs: 4000, endMs: 7000, endOrigin: 'manual' },
    ] }
    expect(validateLyricsDocument(document, 10_000).map((i) => i.code)).toContain('invalid_line')
    delete document.lines[0].words
    expect(validateLyricsDocument(document, 10_000)).toEqual([])
  })
})

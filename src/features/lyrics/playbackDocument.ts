import type { LyricsOverride } from '../../types/models'
import type { LyricsEditorDocument } from './editorDocument'
import { fromLrc, fromPlainLyrics, toPlaybackLines, toPlaybackLrc, toPlainText } from './editorDocument'
import { parseLrc } from './lrc'
import type { LyricsResult } from './types'
import type { LyricsCandidate } from './onlineProvider'

/** The retained editor snapshot may belong to a different active provider pin. */
export function activeOverrideDocument(pinned: LyricsOverride): LyricsEditorDocument | null {
  if (pinned.isActive === false || !pinned.editorDocument) return null
  const edited = pinned.editedVersion
  if (edited) {
    return edited.provider === pinned.provider && edited.lrc.trim() === pinned.lrc.trim()
      && edited.sourceArtist === pinned.sourceArtist && edited.sourceTitle === pinned.sourceTitle
      ? pinned.editorDocument : null
  }
  return toPlaybackLrc(pinned.editorDocument).trim() === pinned.lrc.trim() ? pinned.editorDocument : null
}

/** Preserve rich endpoints/words; the plain LRC is only a compatibility copy. */
export function overridePlaybackResult(pinned: LyricsOverride): LyricsResult {
  const document = activeOverrideDocument(pinned)
  const lines = document ? toPlaybackLines(document) : parseLrc(pinned.lrc)
  return lines?.length ? { kind: 'synced', lines } : { kind: 'plain', text: document ? toPlainText(document) : pinned.lrc.trim() }
}

export function candidatePlaybackDocument(candidate: LyricsCandidate, durationMs?: number | null,
  mode: 'synced' | 'plain' = candidate.result.kind): LyricsEditorDocument {
  if (mode === 'plain') return fromPlainLyrics(candidate.plain ?? (candidate.result.kind === 'plain' ? candidate.result.text : ''))
  if (candidate.result.kind !== 'synced') return candidate.syncedLrc?.trim()
    ? fromLrc(candidate.syncedLrc, durationMs) : fromPlainLyrics(candidate.result.text)
  const lines = candidate.result.lines
  return { mode: 'synced', lines: lines.map((line, index) => {
    const next = lines.slice(index + 1).find(other => other.timeSec > line.timeSec)
    return { text: line.text, startMs: Math.round(line.timeSec * 1000),
      endMs: line.endTimeSec === undefined ? next ? Math.round(next.timeSec * 1000) : durationMs ?? null : Math.round(line.endTimeSec * 1000),
      endOrigin: line.endTimeSec === undefined ? 'auto' : line.endSource ?? 'source',
      ...(line.words ? { words: line.words.map(word => ({ text: word.text, startMs: Math.round(word.timeSec * 1000),
        endMs: word.endTimeSec == null ? null : Math.round(word.endTimeSec * 1000) })) } : {}),
    }
  }) }
}

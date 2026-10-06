import { parseLrcLines, shiftLyricsLines } from './lrc'
import type { LyricsLine } from './types'

/**
 * Canonical document model for the lyric editor.
 *
 * Ordinary LRC carries line starts; enhanced LRC may also carry word timing.
 * The canonical document preserves endpoints, their origin, and source words.
 * Playback LRC remains a compatibility projection with line starts only.
 */
export type LyricsEditorDocument = PlainLyricsDocument | SyncedLyricsDocument

export interface PlainLyricsDocument {
  mode: 'plain'
  lines: PlainLyricsLine[]
}

export interface PlainLyricsLine {
  text: string
}

export interface SyncedLyricsDocument {
  mode: 'synced'
  lines: SyncedLyricsLine[]
}

export interface SyncedLyricsLine {
  text: string
  startMs: number
  /** Null means playback should estimate the phrase end automatically. */
  endMs: number | null
  /** Blank rows create pauses only when the editor explicitly marks them. */
  explicitPause?: boolean
  /** Missing on saved legacy documents means an authored end. */
  endOrigin?: 'auto' | 'source' | 'manual'
  words?: SyncedLyricsWord[]
}

export interface SyncedLyricsWord {
  text: string
  startMs: number
  endMs: number | null
}

export type SyncedLyricsTimeField = 'startMs' | 'endMs'

export function cloneLyricsDocument(document: LyricsEditorDocument): LyricsEditorDocument {
  return document.mode === 'plain'
    ? { mode: 'plain', lines: document.lines.map((line) => ({ ...line })) }
    : { mode: 'synced', lines: document.lines.map((line) => ({ ...line,
      ...(line.words ? { words: line.words.map((word) => ({ ...word })) } : {}),
    })) }
}

/** A changed text invalidates source words, while authored ends stay authored. */
export function setSyncedLineText(document: SyncedLyricsDocument, lineIndex: number, text: string): SyncedLyricsDocument {
  return { mode: 'synced', lines: document.lines.map((line, index) => {
    if (index !== lineIndex || line.text === text) return line
    const updated = { ...line, text }
    if (text.trim()) delete updated.explicitPause
    else updated.explicitPause = true
    delete updated.words
    if (updated.endOrigin === 'source') updated.endOrigin = 'auto'
    return updated
  }) }
}

/** Keeps invalid typed drafts for validation; playback capture validates first. */
export function editSyncedLineTime(
  document: SyncedLyricsDocument, lineIndex: number, field: SyncedLyricsTimeField, timeMs: number | null,
): SyncedLyricsDocument {
  return { mode: 'synced', lines: document.lines.map((line, index) => {
    if (index !== lineIndex) return line
    const updated = { ...line }
    delete updated.words
    if (field === 'startMs') {
      updated.startMs = timeMs ?? Number.NaN
      if (updated.endMs !== null && updated.endMs <= updated.startMs) {
        updated.endMs = null
        delete updated.endOrigin
      }
    } else {
      updated.endMs = timeMs
      if (timeMs === null) delete updated.endOrigin
      else updated.endOrigin = 'manual'
    }
    return updated
  }) }
}

/** Capture a playback position into one synced line, keeping timing valid. */
export function setSyncedLineTimeAtPlaybackPosition(
  document: SyncedLyricsDocument,
  lineIndex: number,
  field: SyncedLyricsTimeField,
  timeMs: number,
): SyncedLyricsDocument {
  if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || !Number.isSafeInteger(timeMs) || timeMs < 0) {
    return document
  }

  const target = document.lines[lineIndex]
  if (!target || (field === 'endMs' && timeMs <= target.startMs)) return document

  return editSyncedLineTime(document, lineIndex, field, timeMs)
}

export type LyricsEditorIssueCode =
  | 'empty_document'
  | 'invalid_line'
  | 'invalid_start'
  | 'invalid_end'
  | 'end_before_start'
  | 'start_after_duration'
  | 'end_after_duration'
  | 'lines_not_sorted'

export interface LyricsEditorIssue {
  code: LyricsEditorIssueCode
  /** Zero-based line index. Omitted for document-wide problems. */
  lineIndex?: number
}

export interface LrclibLyricsfileMetadata {
  title: string
  artist: string
  album: string
  durationMs?: number | null
}

const LRC_METADATA = /^\[(?:ar|ti|al|by|re|ve|length|la|au):[^\]]*\]$/i

/** Make an editable plain-text document without changing line breaks. */
export function fromPlainLyrics(text: string): PlainLyricsDocument {
  return { mode: 'plain', lines: text.split(/\r\n|\n|\r/).map((line) => ({ text: line })) }
}

/**
 * Import source words and exact endpoints from enhanced LRC. Missing ends stay
 * empty in the editor and are estimated from text and neighboring starts at playback.
 */
export function fromLrc(
  lrc: string,
  _durationMs?: number | null,
): LyricsEditorDocument {
  const parsed = parseLrcLines(lrc)

  if (parsed.length === 0) {
    const plain = lrc
      .split(/\r\n|\n|\r/)
      .filter((line) => !LRC_METADATA.test(line.trim()) && !/^\[offset:\s*[+-]?\d+\s*\]$/i.test(line.trim()))
      .join('\n')
    return fromPlainLyrics(plain)
  }

  const lines = new Array<SyncedLyricsLine>(parsed.length)
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const source = parsed[index]
    const line: SyncedLyricsLine = { text: source.text, startMs: Math.round(source.timeSec * 1000),
      endMs: source.endTimeSec === undefined ? null : Math.round(source.endTimeSec * 1000),
      endOrigin: source.endTimeSec === undefined ? 'auto' : 'source',
      ...(source.text.trim() || source.explicitPause !== true ? {} : { explicitPause: true }),
      ...(source.words ? { words: source.words.map((word) => ({ text: word.text, startMs: Math.round(word.timeSec * 1000),
        endMs: word.endTimeSec == null ? null : Math.round(word.endTimeSec * 1000),
      })) } : {}),
    }
    lines[index] = line
  }
  return { mode: 'synced', lines }
}

/** Rich playback projection; automatic editor hints are never authoritative. */
export function toPlaybackLines(document: LyricsEditorDocument, extraOffsetMs = 0): LyricsLine[] | null {
  if (document.mode !== 'synced') return null
  return shiftLyricsLines(document.lines.map((line) => {
    const valid = line.endMs !== null && Number.isSafeInteger(line.endMs) && line.endMs > line.startMs
    const origin = line.endOrigin ?? 'manual'
    return { timeSec: line.startMs / 1000, text: line.text,
      ...(line.text.trim() || line.explicitPause !== true ? {} : { explicitPause: true }),
      ...(valid && origin !== 'auto' ? { endTimeSec: line.endMs! / 1000, endSource: origin } : {}),
      ...(line.words ? { words: line.words.map((word) => ({ text: word.text, timeSec: word.startMs / 1000,
        endTimeSec: word.endMs === null ? null : word.endMs / 1000,
      })) } : {}),
    }
  }), extraOffsetMs)
}

/** Flatten either editor mode to newline-separated lyric text. */
export function toPlainText(document: LyricsEditorDocument): string {
  return document.lines.map((line) => line.text).join('\n')
}

/**
 * Convert to the LRC/text representation consumed by the existing player.
 * Synced output records start timestamps only, as required by LRC; the canonical
 * input document retains every `endMs` unchanged.
 */
export function toPlaybackLrc(document: LyricsEditorDocument): string {
  if (document.mode === 'plain') return toPlainText(document)
  return document.lines
    .map((line) => `[${formatLrcTime(line.startMs)}]${line.text}`)
    .join('\n')
}

/**
 * Serialize the richer LRCLIB Lyricsfile v1 document. Unlike playback LRC, this
 * keeps edited end times in the uploaded representation.
 */
export function toLrclibLyricsfile(
  document: LyricsEditorDocument,
  metadata: LrclibLyricsfileMetadata,
): string {
  const lines = document.mode === 'synced' && document.lines.length > 0
    ? [
        'lines:',
        ...document.lines.flatMap((line) => {
          const row = [`  - text: ${JSON.stringify(line.text)}`, `    start_ms: ${line.startMs}`]
          if (line.endMs !== null) row.push(`    end_ms: ${line.endMs}`)
          return row
        }),
      ]
    : ['lines: []']
  const duration = Number.isFinite(metadata.durationMs) && (metadata.durationMs ?? 0) > 0
    ? `  duration_ms: ${Math.round(metadata.durationMs!)}`
    : null
  const plain = document.mode === 'plain'
    ? toPlainText(document)
    : document.lines.map((line) => line.text).join('\n')
  return [
    'version: "1.0"',
    'metadata:',
    `  title: ${JSON.stringify(metadata.title)}`,
    `  artist: ${JSON.stringify(metadata.artist)}`,
    `  album: ${JSON.stringify(metadata.album)}`,
    ...(duration ? [duration] : []),
    '  instrumental: false',
    ...lines,
    `plain: ${JSON.stringify(plain)}`,
    '',
  ].join('\n')
}

/** Return a copy sorted by start time, keeping text and end time attached. */
export function sortSyncedLines(document: SyncedLyricsDocument): SyncedLyricsDocument {
  return {
    mode: 'synced',
    lines: document.lines
      .map((line, index) => ({ line, index }))
      .sort((a, b) => a.line.startMs - b.line.startMs || a.index - b.index)
      .map(({ line }) => ({ ...line, ...(line.words ? { words: line.words.map((word) => ({ ...word })) } : {}) })),
  }
}

/** Check timestamp values, duration bounds, and ascending line order. */
export function validateLyricsDocument(
  document: LyricsEditorDocument,
  durationMs?: number | null,
): LyricsEditorIssue[] {
  const issues: LyricsEditorIssue[] = []
  if (!document || (document.mode !== 'plain' && document.mode !== 'synced') || !Array.isArray(document.lines)) {
    return [{ code: 'invalid_line' }]
  }
  if (document.lines.length === 0) issues.push({ code: 'empty_document' })
  let hasText = false
  if (document.mode === 'plain') {
    document.lines.forEach((line, lineIndex) => {
      if (!line || typeof line.text !== 'string') issues.push({ code: 'invalid_line', lineIndex })
      else if (line.text.trim().length > 0) hasText = true
    })
    if (!hasText && document.lines.length > 0) issues.push({ code: 'empty_document' })
    return issues
  }

  const knownDuration = Number.isFinite(durationMs) && (durationMs ?? 0) > 0 ? durationMs! : null
  let previousStart = -1
  document.lines.forEach((line, lineIndex) => {
    if (!line || typeof line.text !== 'string') {
      issues.push({ code: 'invalid_line', lineIndex })
      return
    }
    if (line.text.trim().length > 0) hasText = true
    if (!Number.isSafeInteger(line.startMs) || line.startMs < 0) {
      issues.push({ code: 'invalid_start', lineIndex })
    } else {
      if (line.startMs < previousStart) issues.push({ code: 'lines_not_sorted', lineIndex })
      previousStart = line.startMs
      if (knownDuration !== null && line.startMs > knownDuration) {
        issues.push({ code: 'start_after_duration', lineIndex })
      }
    }
    if (line.endMs !== null) {
      if (!Number.isSafeInteger(line.endMs) || line.endMs < 0) {
        issues.push({ code: 'invalid_end', lineIndex })
      } else {
        if (Number.isSafeInteger(line.startMs) && line.endMs <= line.startMs) {
          issues.push({ code: 'end_before_start', lineIndex })
        }
        if (knownDuration !== null && line.endMs > knownDuration) {
          issues.push({ code: 'end_after_duration', lineIndex })
        }
      }
    }
    if (line.endOrigin !== undefined && !['auto', 'source', 'manual'].includes(line.endOrigin)) {
      issues.push({ code: 'invalid_line', lineIndex })
    }
    if (line.words !== undefined) {
      let previousWordStart = line.startMs
      if (!Array.isArray(line.words) || line.words.some((word) => {
        if (!word || typeof word.text !== 'string' || !word.text.trim() || !Number.isSafeInteger(word.startMs)
          || word.startMs < previousWordStart || (knownDuration !== null && word.startMs > knownDuration)
          || (line.endMs !== null && word.startMs > line.endMs)
          || (word.endMs !== null && (!Number.isSafeInteger(word.endMs) || word.endMs <= word.startMs
            || (knownDuration !== null && word.endMs > knownDuration) || (line.endMs !== null && word.endMs > line.endMs)))) return true
        previousWordStart = word.startMs
        return false
      })) issues.push({ code: 'invalid_line', lineIndex })
    }
  })
  if (!hasText && document.lines.length > 0) issues.push({ code: 'empty_document' })
  return issues
}

function formatLrcTime(startMs: number): string {
  const centiseconds = Math.max(0, Math.round(startMs / 10))
  const minutes = Math.floor(centiseconds / 6_000)
  const seconds = Math.floor((centiseconds % 6_000) / 100)
  const fraction = centiseconds % 100
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`
}

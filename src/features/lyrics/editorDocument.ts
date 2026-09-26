/**
 * Canonical document model for the lyric editor.
 *
 * LRC only carries line start times. `endMs` therefore stays in this editor
 * document and is never discarded by import/sort/save helpers. Playback LRC is a
 * compatibility projection: end times are intentionally omitted there.
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
  /** Null means that the source did not provide an end and no duration was known. */
  endMs: number | null
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

const LRC_TIMESTAMP = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/
const LRC_OFFSET = /\[offset:\s*([+-]?\d+)\s*\]/i
const LRC_METADATA = /^\[(?:ar|ti|al|by|re|ve|length|la|au):[^\]]*\]$/i
const INLINE_WORD_TIMESTAMP = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g

/** Make an editable plain-text document without changing line breaks. */
export function fromPlainLyrics(text: string): PlainLyricsDocument {
  return { mode: 'plain', lines: text.split(/\r\n|\n|\r/).map((line) => ({ text: line })) }
}

/**
 * Import LRC into the editor model. LRC stores starts only, so each end is
 * inferred from the next later start; the last end uses `durationMs` when known.
 * If there are no timed lines, the input is treated as plain text.
 */
export function fromLrc(lrc: string, durationMs?: number | null): LyricsEditorDocument {
  const offsetMatch = lrc.match(LRC_OFFSET)
  const offsetMs = offsetMatch ? Number.parseInt(offsetMatch[1], 10) : 0
  const parsed: Array<{ line: SyncedLyricsLine; sourceIndex: number }> = []

  for (const [sourceIndex, sourceLine] of lrc.split(/\r\n|\n|\r/).entries()) {
    let rest = sourceLine.trim()
    const starts: number[] = []
    for (;;) {
      const match = rest.match(LRC_TIMESTAMP)
      if (!match) break
      const minutes = Number.parseInt(match[1], 10)
      const seconds = Number.parseInt(match[2], 10)
      const fractionText = match[3] ?? ''
      const fractionMs = fractionText
        ? Math.round(Number.parseInt(fractionText, 10) * (1000 / 10 ** fractionText.length))
        : 0

      // Seconds outside the normal 0..59 range are malformed LRC, not a time.
      if (seconds >= 60) {
        starts.length = 0
        break
      }
      starts.push(Math.max(0, minutes * 60_000 + seconds * 1000 + fractionMs - offsetMs))
      rest = rest.slice(match[0].length)
    }
    if (starts.length === 0) continue

    const text = rest.replace(INLINE_WORD_TIMESTAMP, '').trim()
    for (const startMs of starts) {
      parsed.push({ line: { text, startMs, endMs: null }, sourceIndex })
    }
  }

  if (parsed.length === 0) {
    const plain = lrc
      .split(/\r\n|\n|\r/)
      .filter((line) => !LRC_METADATA.test(line.trim()) && !/^\[offset:\s*[+-]?\d+\s*\]$/i.test(line.trim()))
      .join('\n')
    return fromPlainLyrics(plain)
  }

  parsed.sort((a, b) => a.line.startMs - b.line.startMs || a.sourceIndex - b.sourceIndex)
  const knownDuration = Number.isFinite(durationMs) && (durationMs ?? 0) > 0 ? Math.round(durationMs!) : null
  let nextDistinctStart: number | null = null
  const lines = new Array<SyncedLyricsLine>(parsed.length)
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const line = parsed[index].line
    // Repeated timestamps are valid in LRC. Use the next strictly later start so
    // repeated lines keep a useful interval rather than becoming zero-length.
    lines[index] = { ...line, endMs: nextDistinctStart ?? knownDuration }
    if (index === 0 || parsed[index - 1].line.startMs < line.startMs) {
      nextDistinctStart = line.startMs
    }
  }
  return { mode: 'synced', lines }
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
      .map(({ line }) => ({ ...line })),
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

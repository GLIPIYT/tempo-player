import type { LyricsLine, LyricsWord } from './types'

const LINE_TIME = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g

function timestamp(minutes: string, seconds: string, fraction = ''): number | null {
  const sec = Number.parseInt(seconds, 10)
  if (sec >= 60) return null
  return Number.parseInt(minutes, 10) * 60 + sec + (fraction ? Number.parseInt(fraction, 10) / 10 ** fraction.length : 0)
}

function enhancedTiming(rest: string): Pick<LyricsLine, 'words' | 'endTimeSec' | 'endSource'> {
  const tags = [...rest.matchAll(WORD_TAG)]
  if (tags.length === 0) return {}
  const times = tags.map((tag) => timestamp(tag[1], tag[2], tag[3]))
  if (times.some((time, index) => time === null || (index > 0 && time <= times[index - 1]!))) return {}
  const words: LyricsWord[] = []
  let endTimeSec: number | undefined
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i]
    const next = tags[i + 1]
    const text = rest.slice(tag.index! + tag[0].length, next?.index ?? rest.length)
    if (text.trim()) {
      words.push({ text, timeSec: times[i]!, endTimeSec: next ? times[i + 1]! : null })
    } else if (i === tags.length - 1 && words.length > 0) {
      // An empty final tag is the only exact final endpoint provided by eLRC.
      endTimeSec = times[i]!
    }
  }
  return words.length > 0
    ? { words, ...(endTimeSec === undefined ? {} : { endTimeSec, endSource: 'source' as const }) }
    : {}
}

/** Shift every timing field together without a lossy LRC serialization. */
export function shiftLyricsLines(lines: readonly LyricsLine[], offsetMs: number): LyricsLine[] {
  const offset = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0
  const shift = (time: number): number => Math.max(0, time + offset)
  return lines.map((line) => ({
    ...line,
    timeSec: shift(line.timeSec),
    ...(line.endTimeSec === undefined ? {} : { endTimeSec: shift(line.endTimeSec) }),
    ...(line.words ? { words: line.words.map((word) => {
      const start = shift(word.timeSec)
      if (word.endTimeSec == null) return { ...word, timeSec: start }
      const end = shift(word.endTimeSec)
      // Only normalize a formerly positive valid interval collapsed by clipping.
      // Genuinely invalid source durations still reach document validation.
      const clipped = Number.isFinite(word.timeSec) && Number.isFinite(word.endTimeSec)
        && word.endTimeSec > word.timeSec && end <= start
      return { ...word, timeSec: start, endTimeSec: clipped ? null : end }
    }) } : {}),
  }))
}

/**
 * Parses an LRC body into sorted lines.
 *
 * `extraOffsetMs` is the user's own nudge from a pinned selection, on top of any
 * `[offset:]` tag the file carries. Positive means later: the line shows up
 * `extraOffsetMs` further into the song. It is baked into the timings here rather
 * than applied when rendering, so everything downstream - the overlay, the Discord
 * presence - reads the same shifted lines.
 */
export function parseLrc(raw: string, extraOffsetMs = 0): LyricsLine[] | null {
  const lines = parseLrcLines(raw, extraOffsetMs)
  // An all-empty playback body is padding, while the editor can still import it.
  return lines.some((line) => line.text.length > 0) ? lines : null
}

export function parseLrcLines(raw: string, extraOffsetMs = 0): LyricsLine[] {
  if (!raw) return []
  const offsetMatch = raw.match(OFFSET_TAG)
  const offsetMs = offsetMatch ? Number.parseInt(offsetMatch[1], 10) : 0
  const offsetSec = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0
  const extraSec = Number.isFinite(extraOffsetMs) ? extraOffsetMs / 1000 : 0
  const out: LyricsLine[] = []
  for (const rawLine of raw.split(/\r\n|\n|\r/)) {
    let rest = rawLine.trim()
    const times: number[] = []
    for (;;) {
      const m = rest.match(LINE_TIME)
      if (!m) break
      const time = timestamp(m[1], m[2], m[3])
      if (time === null) { times.length = 0; break }
      times.push(time)
      rest = rest.slice(m[0].length)
    }
    if (times.length === 0) continue
    // Keep empty timecodes in the parsed source. The editor marks intentional
    // blank rows as pauses; external empty rows do not pause playback by themselves.
    const text = rest.replace(WORD_TAG, '').trim()
    const enhanced = enhancedTiming(rest)
    for (const time of times) {
      const occurrenceOffset = time - times[0]
      const timing = shiftLyricsLines([{ timeSec: times[0], text, ...enhanced }],
        (occurrenceOffset - offsetSec + extraSec) * 1000)[0]
      out.push(timing)
    }
  }
  out.sort((a, b) => a.timeSec - b.timeSec)
  return out
}

/** trailing punctuation and dashes, the only difference between many repeats */
const TRAILING_PUNCT = /[\s.,!?;:…\-–—"'’)\]]+$/u

/**
 * Comparison form of a lyric line: case-folded, repeated whitespace collapsed,
 * trailing punctuation dropped. "Ла ла ла", "Ла ла ла." and "ЛА ЛА ЛА" become one
 * line rather than three, which is what stops a repeated chorus from spending
 * three of Discord's five updates per 20s. Only ever compared - the text that
 * goes out stays verbatim.
 */
export function normalizeLyricText(text: string | null | undefined): string {
  if (!text) return ''
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(TRAILING_PUNCT, '')
}

/**
 * Serializes parsed lines back to LRC. Pinning stores raw text, but a candidate
 * that came from embedded tags only ever existed as parsed lines, so it has to be
 * written back out before it can be pinned.
 */
export function formatLrc(lines: LyricsLine[]): string {
  return lines
    .map((l) => {
      let body = l.text
      const words = l.words
      const enhancedBody = words?.length ? formatWords(l.text, words) : null
      if (enhancedBody !== null && words?.length) {
        body = enhancedBody
        const end = l.endTimeSec ?? words.at(-1)?.endTimeSec
        if (end != null && Number.isFinite(end) && end > words[words.length - 1].timeSec) body += `<${formatTimestamp(end)}>`
      } else if (l.endTimeSec !== undefined && Number.isFinite(l.endTimeSec) && l.endTimeSec > l.timeSec) {
        body = `<${formatTimestamp(l.timeSec)}>${l.text}<${formatTimestamp(l.endTimeSec)}>`
      }
      return `[${formatTimestamp(l.timeSec)}]${body}`
    })
    .join('\n')
}

function formatWords(text: string, words: LyricsWord[]): string | null {
  const fragments: string[] = []
  let cursor = 0
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (!Number.isFinite(word.timeSec)) return null
    let piece = word.text
    if (index === 0) piece = piece.trimStart()
    if (index === words.length - 1) piece = piece.trimEnd()
    const at = text.indexOf(piece, cursor)
    if (!piece || at < 0) return null
    fragments.push(text.slice(cursor, at), `<${formatTimestamp(word.timeSec)}>`, piece)
    cursor = at + piece.length
  }
  fragments.push(text.slice(cursor))
  return fragments.join('')
}

function formatTimestamp(timeSec: number): string {
  const total = Math.max(0, timeSec)
  const minutes = Math.floor(total / 60)
  const seconds = Math.floor(total % 60)
  const hundredths = Math.min(99, Math.round((total - Math.floor(total)) * 100))
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
}

import type { LyricsLine } from './types'

const LINE_TIME = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g

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
  if (!raw) return null
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
      const minutes = Number.parseInt(m[1], 10)
      const seconds = Number.parseInt(m[2], 10)
      const fracStr = m[3] ?? ''
      const frac = fracStr ? Number.parseInt(fracStr, 10) / 10 ** fracStr.length : 0
      times.push(minutes * 60 + seconds + frac)
      rest = rest.slice(m[0].length)
    }
    if (times.length === 0) continue
    const text = rest.replace(WORD_TAG, '').trim()
    if (!text) continue
    for (const time of times) {
      out.push({ timeSec: Math.max(0, time - offsetSec + extraSec), text })
    }
  }
  if (out.length === 0) return null
  out.sort((a, b) => a.timeSec - b.timeSec)
  return out
}

/**
 * Serializes parsed lines back to LRC. Pinning stores raw text, but a candidate
 * that came from embedded tags only ever existed as parsed lines, so it has to be
 * written back out before it can be pinned.
 */
export function formatLrc(lines: LyricsLine[]): string {
  return lines
    .map((l) => {
      const total = Math.max(0, l.timeSec)
      const minutes = Math.floor(total / 60)
      const seconds = Math.floor(total % 60)
      const hundredths = Math.min(99, Math.round((total - Math.floor(total)) * 100))
      const mm = String(minutes).padStart(2, '0')
      const ss = String(seconds).padStart(2, '0')
      const cc = String(hundredths).padStart(2, '0')
      return `[${mm}:${ss}.${cc}]${l.text}`
    })
    .join('\n')
}

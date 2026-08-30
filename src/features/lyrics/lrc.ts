import type { LyricsLine } from './types'

const LINE_TIME = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g

export function parseLrc(raw: string): LyricsLine[] | null {
  if (!raw) return null
  const offsetMatch = raw.match(OFFSET_TAG)
  const offsetMs = offsetMatch ? Number.parseInt(offsetMatch[1], 10) : 0
  const offsetSec = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0
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
      out.push({ timeSec: Math.max(0, time - offsetSec), text })
    }
  }
  if (out.length === 0) return null
  out.sort((a, b) => a.timeSec - b.timeSec)
  return out
}

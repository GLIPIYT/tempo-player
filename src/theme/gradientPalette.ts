export interface GradientAnchors {
  first: string
  second: string
}

function normalizeHex(value: string, fallback: string): string {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim())
  if (!match) return fallback
  const raw = match[1]
  const full = raw.length === 3 ? raw.split('').map((part) => part + part).join('') : raw
  return `#${full.toLowerCase()}`
}

/** Keep the two selected colors intact so CSS can use them as real gradient stops. */
export function normalizeGradientAnchors(anchors: GradientAnchors): GradientAnchors {
  return {
    first: normalizeHex(anchors.first, '#6c8cff'),
    second: normalizeHex(anchors.second, '#4fd6be'),
  }
}

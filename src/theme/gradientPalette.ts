import type { ThemeTokens } from '../types/theme'

export interface GradientAnchors {
  first: string
  second: string
}

interface Rgb {
  r: number
  g: number
  b: number
}

function parseHex(value: string): Rgb | null {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim())
  if (!match) return null
  const raw = match[1]
  const hex = raw.length === 3 ? raw.split('').map((part) => part + part).join('') : raw
  const number = Number.parseInt(hex, 16)
  return { r: number >> 16, g: (number >> 8) & 255, b: number & 255 }
}

function toHex(rgb: Rgb): string {
  const hex = (channel: number) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  }
}

function luminance(rgb: Rgb): number {
  const linear = (channel: number) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b)
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const values = [luminance(a), luminance(b)].sort((left, right) => right - left)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

function ensureReadable(anchor: Rgb, background: Rgb, minimumContrast = 3): Rgb {
  if (contrastRatio(anchor, background) >= minimumContrast) return anchor
  const destination: Rgb = luminance(background) > 0.45
    ? { r: 12, g: 14, b: 20 }
    : { r: 255, g: 255, b: 255 }
  let result = anchor
  for (let amount = 0.08; amount <= 1; amount += 0.08) {
    result = mix(anchor, destination, amount)
    if (contrastRatio(result, background) >= minimumContrast) return result
  }
  return destination
}

function colorWithAlpha(rgb: Rgb, alpha: number): string {
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${alpha})`
}

/**
 * Derive Tempo's complete UI token set from two user-selected color anchors.
 * The first anchors interactive accents, the second anchors playback controls,
 * and their blend tints every surface and border in the theme.
 */
export function deriveGradientPalette(anchors: GradientAnchors): ThemeTokens {
  const first = parseHex(anchors.first) ?? { r: 108, g: 140, b: 255 }
  const second = parseHex(anchors.second) ?? { r: 79, g: 214, b: 190 }
  const blend = mix(first, second, 0.5)
  const neutral = { r: 9, g: 12, b: 18 }
  const bg = mix(neutral, blend, 0.1)
  const bgElevated = mix(bg, blend, 0.16)
  const surface = mix(bg, blend, 0.25)
  const surfaceHover = mix(bg, blend, 0.38)
  const border = mix(bg, blend, 0.52)
  const accent = ensureReadable(first, bg)
  const playButton = ensureReadable(second, bg)
  const text = ensureReadable(mix({ r: 237, g: 240, b: 247 }, blend, 0.06), bg, 4.5)
  const textMuted = ensureReadable(mix({ r: 155, g: 165, b: 184 }, blend, 0.2), bg, 3)
  const accentStrong = ensureReadable(mix(accent, { r: 255, g: 255, b: 255 }, 0.2), bg)
  const danger = ensureReadable(mix({ r: 255, g: 113, b: 132 }, blend, 0.08), bg)

  return {
    bg: toHex(bg),
    bgElevated: toHex(bgElevated),
    surface: toHex(surface),
    surfaceHover: toHex(surfaceHover),
    border: toHex(border),
    text: toHex(text),
    textMuted: toHex(textMuted),
    accent: toHex(accent),
    accentStrong: toHex(accentStrong),
    accentSoft: colorWithAlpha(accent, 0.16),
    danger: toHex(danger),
    playButton: toHex(playButton),
  }
}

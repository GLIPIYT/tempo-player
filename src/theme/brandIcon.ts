import pulseCreamCoral from '../../docs/brand/icon-concepts/variants/pulse-cream-coral.png'
import pulseForestLime from '../../docs/brand/icon-concepts/variants/pulse-forest-lime.png'
import pulseVioletCyan from '../../docs/brand/icon-concepts/variants/pulse-violet-cyan.png'
import orbitIvoryCoral from '../../docs/brand/icon-concepts/variants/orbit-ivory-coral.png'
import orbitIndigoCyan from '../../docs/brand/icon-concepts/variants/orbit-indigo-cyan.png'
import orbitPlumLime from '../../docs/brand/icon-concepts/variants/orbit-plum-lime.png'
import type { BrandIconStyle } from '../state/settings'
import type { ActiveTheme } from '../types/theme'
import { getPreset } from './presets'

type IconVariant = {
  src: string
  paletteHues: readonly number[]
}

const ICON_VARIANTS: Record<BrandIconStyle, readonly IconVariant[]> = {
  pulse: [
    { src: pulseCreamCoral, paletteHues: [43, 10] },
    { src: pulseForestLime, paletteHues: [138, 86] },
    { src: pulseVioletCyan, paletteHues: [264, 185] },
  ],
  orbit: [
    { src: orbitIvoryCoral, paletteHues: [43, 10] },
    { src: orbitIndigoCyan, paletteHues: [226, 185] },
    { src: orbitPlumLime, paletteHues: [296, 86] },
  ],
}

interface Hsl {
  hue: number
  saturation: number
}

function parseHexColor(input: string): Hsl | null {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(input.trim())
  if (!match) return null
  const chars = match[1].length === 3 ? [...match[1]].map((char) => char + char).join('') : match[1]
  const red = Number.parseInt(chars.slice(0, 2), 16) / 255
  const green = Number.parseInt(chars.slice(2, 4), 16) / 255
  const blue = Number.parseInt(chars.slice(4, 6), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0

  if (delta !== 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6)
    else if (max === green) hue = 60 * ((blue - red) / delta + 2)
    else hue = 60 * ((red - green) / delta + 4)
  }

  return { hue: (hue + 360) % 360, saturation: max === 0 ? 0 : delta / max }
}

function themeColors(theme: ActiveTheme): Hsl[] {
  if (theme.kind === 'custom') {
    const custom = theme.custom
    if (custom.gradientAnchors) {
      return [custom.gradientAnchors.first, custom.gradientAnchors.second]
      .map(parseHexColor)
      .filter((value): value is Hsl => value !== null && value.saturation >= 0.12)
    }
    const solid = parseHexColor(custom.base.accent)
    return solid && solid.saturation >= 0.12 ? [solid] : []
  }

  const preset = getPreset(theme.presetId) ?? getPreset('tempo')
  if (!preset) return []
  const colors = preset.gradientAnchors
    ? [preset.gradientAnchors.first, preset.gradientAnchors.second]
    : [preset.tokens.accent]
  return colors
    .map(parseHexColor)
    .filter((value): value is Hsl => value !== null && value.saturation >= 0.12)
}

function hueDistance(a: number, b: number): number {
  const distance = Math.abs(a - b) % 360
  return Math.min(distance, 360 - distance)
}

function variantScore(variant: IconVariant, colors: Hsl[]): number {
  if (colors.length === 0) return 0
  const distances = colors.map((color) =>
    Math.min(...variant.paletteHues.map((hue) => hueDistance(color.hue, hue))),
  )
  return distances.reduce((sum, distance) => sum + distance, 0) / distances.length
}

function signedHueDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}

/** Select a real generated mark, then nudge its hues toward the active theme accent. */
export function resolveBrandIcon(style: BrandIconStyle, theme: ActiveTheme): { src: string; filter?: string } {
  const variants = ICON_VARIANTS[style] ?? ICON_VARIANTS.pulse
  const colors = themeColors(theme)
  let selected = variants[0]
  let selectedScore = Number.POSITIVE_INFINITY

  for (const variant of variants) {
    const score = variantScore(variant, colors)
    if (score < selectedScore) {
      selected = variant
      selectedScore = score
    }
  }

  if (colors.length === 0) return { src: selected.src }
  let nearest = { paletteHue: selected.paletteHues[0], color: colors[0], distance: Number.POSITIVE_INFINITY }
  for (const color of colors) {
    for (const paletteHue of selected.paletteHues) {
      const distance = hueDistance(color.hue, paletteHue)
      if (distance < nearest.distance) nearest = { paletteHue, color, distance }
    }
  }
  const delta = signedHueDelta(nearest.paletteHue, nearest.color.hue)
  return {
    src: selected.src,
    ...(Math.abs(delta) >= 1 ? { filter: `hue-rotate(${delta.toFixed(1)}deg)` } : {}),
  }
}

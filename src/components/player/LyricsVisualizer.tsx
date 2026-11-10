import { useEffect, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { usePlayer } from '../../player'
import { LYRICS_VISUALIZER_BARS_MAX, useSettings } from '../../state/settings'
import Visualizer from './Visualizer'

type Rgb = { r: number; g: number; b: number }
type Palette = { start: Rgb; end: Rgb }

const FALLBACK_ACCENT: Rgb = { r: 108, g: 140, b: 255 }
const FALLBACK_PLAIN: Rgb = { r: 232, g: 235, b: 242 }
const FALLBACK_BACKGROUND: Rgb = { r: 13, g: 16, b: 23 }

function parseCssColor(raw: string): Rgb | null {
  const value = raw.trim()
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const digits = hex[1]
    const full = digits.length === 3 ? digits.split('').map((char) => char + char).join('') : digits
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    }
  }
  const parts = value.match(/-?\d*\.?\d+/g)
  if (!parts || parts.length < 3) return null
  const scale = value.startsWith('color(') ? 255 : 1
  return {
    r: Math.max(0, Math.min(255, Math.round(Number(parts[0]) * scale))),
    g: Math.max(0, Math.min(255, Math.round(Number(parts[1]) * scale))),
    b: Math.max(0, Math.min(255, Math.round(Number(parts[2]) * scale))),
  }
}

/** Resolve custom properties whose computed value still contains var() or color-mix(). */
function resolveThemeColor(name: string, fallback: Rgb): Rgb {
  try {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;color:var(' + name + ')'
    document.body.appendChild(probe)
    const color = parseCssColor(getComputedStyle(probe).color) ?? fallback
    probe.remove()
    return color
  } catch {
    return fallback
  }
}

function srgbToLinear(value: number): number {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function luminance(color: Rgb): number {
  return 0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b)
}

function rgbToHsl(color: Rgb): { h: number; s: number; l: number } {
  const r = color.r / 255
  const g = color.g / 255
  const b = color.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  const l = (max + min) / 2
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1))
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s, l }
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const section = h / 60
  const x = chroma * (1 - Math.abs((section % 2) - 1))
  const [r, g, b] = section < 1 ? [chroma, x, 0]
    : section < 2 ? [x, chroma, 0]
      : section < 3 ? [0, chroma, x]
        : section < 4 ? [0, x, chroma]
          : section < 5 ? [x, 0, chroma]
            : [chroma, 0, x]
  const m = l - chroma / 2
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

function blend(a: Rgb, b: Rgb, amount: number): Rgb {
  return {
    r: Math.round(a.r * (1 - amount) + b.r * amount),
    g: Math.round(a.g * (1 - amount) + b.g * amount),
    b: Math.round(a.b * (1 - amount) + b.b * amount),
  }
}

/** Find a dominant cover color at thumbnail scale; CORS failures fall back to the theme background. */
function sampleArtwork(path: string | null): Promise<Rgb | null> {
  if (!path) return Promise.resolve(null)
  return new Promise((resolve) => {
    const image = new Image()
    if (/^https?:\/\//i.test(path)) image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 24
        canvas.height = 24
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return resolve(null)
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const buckets = new Map<number, { r: number; g: number; b: number; count: number }>()
        for (let i = 0; i < pixels.length; i += 16) {
          if (pixels[i + 3] < 128) continue
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
          const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)
          const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0 }
          bucket.r += r
          bucket.g += g
          bucket.b += b
          bucket.count += 1
          buckets.set(key, bucket)
        }
        const dominant = [...buckets.values()].sort((a, b) => b.count - a.count)[0]
        resolve(dominant ? {
          r: Math.round(dominant.r / dominant.count),
          g: Math.round(dominant.g / dominant.count),
          b: Math.round(dominant.b / dominant.count),
        } : null)
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    try {
      image.src = /^https?:\/\//i.test(path) ? path : convertFileSrc(path)
    } catch {
      resolve(null)
    }
  })
}

function scale(color: Rgb, amount: number): Rgb {
  return { r: Math.round(color.r * amount), g: Math.round(color.g * amount), b: Math.round(color.b * amount) }
}

function lyricsBackdropColor(artwork: Rgb | null, themeBackground: Rgb): Rgb {
  if (!artwork) return themeBackground
  // Match the bottom of the current lyrics backdrop: its cover is rendered at
  // 40% brightness, then the shade blends 88% of the theme background there.
  return blend(scale(artwork, 0.4), themeBackground, 0.88)
}

function adaptToBackground(background: Rgb, artwork: Rgb | null, hueOffset = 0): Rgb {
  const { h, s, l } = rgbToHsl(background)
  const artworkHsl = rgbToHsl(artwork ?? FALLBACK_ACCENT)
  const hue = ((s > 0.12 ? h : artworkHsl.h) + hueOffset + 360) % 360
  const saturation = Math.max(0.22, Math.min(0.48, s > 0.12 ? s : artworkHsl.s * 0.45))
  // Keep the adaptive shift bounded so artwork-derived shades remain distinct
  // without turning into white/black strokes over the backdrop.
  const targetLightness = Math.max(0.08, Math.min(0.9, l + (luminance(background) < 0.43 ? 0.24 : -0.24)))
  return hslToRgb(hue, saturation, targetLightness)
}

export default function LyricsVisualizer({ coverPath }: { coverPath: string | null }) {
  const player = usePlayer()
  const { settings } = useSettings()
  const visualizer = settings.lyricsVisualizer
  const hasCurrentTrack = player.currentTrack !== null
  const [colors, setColors] = useState<Palette>({ start: FALLBACK_ACCENT, end: FALLBACK_ACCENT })

  useEffect(() => {
    if (!hasCurrentTrack || visualizer.style === 'off') return
    const gradient = document.documentElement.classList.contains('theme-gradient')
    const accent = resolveThemeColor('--accent', FALLBACK_ACCENT)
    const accentEnd = gradient ? resolveThemeColor('--t-gradient-second', accent) : accent
    const plain = resolveThemeColor('--text', FALLBACK_PLAIN)
    const baseStart = visualizer.useThemeColor ? accent : plain
    const baseEnd = visualizer.useThemeColor ? accentEnd : plain

    if (!visualizer.useBackgroundColor) {
      setColors({ start: baseStart, end: baseEnd })
      return
    }

    let current = true
    const themeBackground = resolveThemeColor('--bg', FALLBACK_BACKGROUND)
    const initialBackground = lyricsBackdropColor(null, themeBackground)
    setColors({
      start: adaptToBackground(initialBackground, null),
      end: adaptToBackground(initialBackground, null, 26),
    })
    void sampleArtwork(coverPath).then((artwork) => {
      if (!current) return
      const background = lyricsBackdropColor(artwork, themeBackground)
      setColors({
        start: adaptToBackground(background, artwork),
        end: adaptToBackground(background, artwork, 26),
      })
    })
    return () => { current = false }
  }, [coverPath, hasCurrentTrack, settings.theme, visualizer.style, visualizer.useBackgroundColor, visualizer.useThemeColor])

  if (!hasCurrentTrack || visualizer.style === 'off') return null

  return (
    <div className="lyr-visualizer" aria-hidden="true">
      <Visualizer
        style={visualizer.style}
        bars={visualizer.bars}
        maxBars={LYRICS_VISUALIZER_BARS_MAX}
        smoothing={visualizer.smoothing}
        opacityPct={visualizer.opacityPct}
        maxAmplitudePx={visualizer.heightPx}
        mirror={visualizer.mirror}
        rgb={colors.start}
        rgbEnd={colors.end}
      />
    </div>
  )
}

import { useEffect, type ReactElement } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { ActiveTheme, ThemeTokens } from '../types/theme'
import { TOKEN_VARS } from '../types/theme'
import type { AppSettings } from '../state/settings'
import { useSettings } from '../state/settings'
import { CUSTOM_DEFAULT_BASE, getPreset } from './presets'
import BackgroundLayer from '../components/layout/BackgroundLayer'
import { normalizeGradientAnchors } from './gradientPalette'
import '../styles/theme.css'

const DEFAULT_STACK =
  "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, Roboto, 'Helvetica Neue', sans-serif"

const BASE_VARS = ['--t-base-accent', '--t-base-bg', '--t-base-surface', '--t-base-play-btn'] as const

const TOKEN_KEYS = Object.keys(TOKEN_VARS) as (keyof ThemeTokens)[]

interface Rgb {
  r: number
  g: number
  b: number
}

export function parseHex(input: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim())
  if (!m) return null
  const hex = m[1]
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
  const n = parseInt(full, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function relLuminance(c: Rgb): number {
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

export function toHex(c: Rgb): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return '#' + h(c.r) + h(c.g) + h(c.b)
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  }
}

function deriveText(bg: Rgb): string {
  const anchor: Rgb = relLuminance(bg) > 0.4 ? { r: 18, g: 19, b: 22 } : { r: 237, g: 239, b: 244 }
  return toHex(mix(anchor, bg, 0.1))
}

function safeColor(value: string | undefined, fallback: string): string {
  if (typeof value === 'string' && parseHex(value)) return value.trim().toLowerCase()
  return fallback
}

export function applyTheme(active: ActiveTheme | null | undefined): void {
  const root = document.documentElement
  const custom = active?.kind === 'custom' ? active.custom : undefined
  const preset = active?.kind === 'preset' ? getPreset(active.presetId) : undefined
  const anchors = custom?.gradientAnchors ?? preset?.gradientAnchors
  const isGradient = anchors !== undefined
  const wasGradient = root.classList.contains('theme-gradient')

  const clearInlineTheme = () => {
    for (const k of TOKEN_KEYS) root.style.removeProperty(TOKEN_VARS[k])
    for (const v of BASE_VARS) root.style.removeProperty(v)
    root.style.removeProperty('--t-text')
    root.style.removeProperty('--t-gradient-first')
    root.style.removeProperty('--t-gradient-second')
  }

  if (isGradient) {
    const gradientSource = custom ? 'custom' : 'preset'
    const sourceChanged = root.dataset.themeGradientSource !== gradientSource
    if (!wasGradient || sourceChanged) clearInlineTheme()
    root.classList.toggle('theme-custom', custom !== undefined)
    root.classList.add('theme-gradient')
    // Drop the previous theme's inline tokens once. During color picking the
    // app then changes only two CSS variables instead of rebuilding all tokens.
    const normalized = normalizeGradientAnchors(anchors)
    root.style.setProperty('--t-gradient-first', normalized.first)
    root.style.setProperty('--t-gradient-second', normalized.second)
    const needsOutline = [normalized.first, normalized.second].some((color) => {
      const rgb = parseHex(color)
      return rgb !== null && 1.05 / (relLuminance(rgb) + 0.05) < 4.5
    })
    if (needsOutline) root.dataset.brightGradient = 'true'
    else delete root.dataset.brightGradient
    root.dataset.themeGradientSource = gradientSource

    // Presets keep their own background and surface palette; gradient colors
    // are supplied by the shared accent variables in theme.css.
    if (preset) {
      for (const k of TOKEN_KEYS) {
        if (k === 'accent' || k === 'accentStrong' || k === 'accentSoft' || k === 'playButton') continue
        root.style.setProperty(TOKEN_VARS[k], preset.tokens[k])
      }
    }
    return
  }

  root.classList.toggle('theme-custom', custom !== undefined)
  root.classList.remove('theme-gradient')
  delete root.dataset.themeGradientSource
  delete root.dataset.brightGradient
  clearInlineTheme()
  if (!custom) {
    const presetId = active && active.kind === 'preset' ? active.presetId : 'tempo'
    const preset = getPreset(presetId) ?? getPreset('tempo')
    if (preset) {
      for (const k of TOKEN_KEYS) root.style.setProperty(TOKEN_VARS[k], preset.tokens[k])
    }
    return
  }
  const base = custom.base
  const accent = safeColor(base.accent, CUSTOM_DEFAULT_BASE.accent)
  const bg = safeColor(base.background, CUSTOM_DEFAULT_BASE.background)
  const surface = safeColor(base.surface, CUSTOM_DEFAULT_BASE.surface)
  root.style.setProperty('--t-base-accent', accent)
  root.style.setProperty('--t-base-bg', bg)
  root.style.setProperty('--t-base-surface', surface)
  const playBtn = safeColor(base.playButton, '')
  if (playBtn !== '') root.style.setProperty('--t-base-play-btn', playBtn)
  const bgRgb = parseHex(bg)
  root.style.setProperty('--t-text', bgRgb ? deriveText(bgRgb) : '#e8ebf2')
  const overrides = custom.overrides
  for (const k of TOKEN_KEYS) {
    const v = overrides[k]
    if (v) root.style.setProperty(TOKEN_VARS[k], v)
  }
}

const loadedFaces = new Map<string, FontFace>()

async function ensureImportedFace(path: string): Promise<boolean> {
  if (loadedFaces.has(path)) return true
  try {
    const res = await fetch(convertFileSrc(path))
    const buf = await res.arrayBuffer()
    const face = new FontFace('TempoCustom', buf)
    await face.load()
    document.fonts.add(face)
    loadedFaces.set(path, face)
    return true
  } catch {
    return false
  }
}

function pruneFaces(keepPath: string | null): void {
  for (const [path, face] of Array.from(loadedFaces.entries())) {
    if (path === keepPath) continue
    try {
      document.fonts.delete(face)
    } catch {
    }
    loadedFaces.delete(path)
  }
}

function buildStack(family: string | null): string {
  const t = family !== null ? family.trim() : ''
  if (!t || t.toLowerCase() === 'default') return DEFAULT_STACK
  if (t.includes(',') || t.includes('"') || t.includes("'")) return t
  return `"${t.replace(/"/g, '')}", ${DEFAULT_STACK}`
}

export function applyFont(font: AppSettings['font']): void {
  pruneFaces(font.importedPath)
  let stack = buildStack(font.family)
  if (font.importedPath) {
    stack = `'TempoCustom', ${DEFAULT_STACK}`
    void ensureImportedFace(font.importedPath)
  }
  document.documentElement.style.setProperty('--font-base', stack)
  document.body.style.fontSize = `${font.sizePx}px`
  try {
    const el = document.querySelector('.app-root')
    if (el instanceof HTMLElement) {
      el.style.zoom = String(Math.max(50, Math.min(200, font.uiScalePct)) / 100)
    }
  } catch {
  }
}

export function applyBackground(background: AppSettings['background']): void {
  document.documentElement.classList.toggle('has-bg', background.path !== null)
}

export function useThemeEffect(): void {
  const { settings } = useSettings()
  useEffect(() => {
    applyTheme(settings.theme)
    applyFont(settings.font)
    applyBackground(settings.background)
  }, [settings])
}

export function ThemeApply(): ReactElement {
  useThemeEffect()
  return (
    <>
      <BackgroundLayer />
    </>
  )
}

import { useEffect } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useSettings } from '../../state/settings'

function colorLuminance(color: string): number | null {
  const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i)
  if (hex) {
    const chars = hex[1].length === 3 ? [...hex[1]].map((char) => char + char).join('') : hex[1]
    const values = [0, 2, 4].map((start) => Number.parseInt(chars.slice(start, start + 2), 16))
    if (values.some((value) => !Number.isFinite(value))) return null
    const channel = (value: number) => {
      const normalized = value / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(values[0]) + 0.7152 * channel(values[1]) + 0.0722 * channel(values[2])
  }
  const match = color.match(/rgba?\(([^)]+)\)/i)
  if (!match) return null
  const values = match[1].split(',').map((value) => Number.parseFloat(value.trim()))
  if (values.length < 3 || values.some((value) => !Number.isFinite(value))) return null
  if (values.length > 3 && values[3] < 0.1) return null
  const channel = (value: number) => {
    const normalized = Math.max(0, Math.min(255, value)) / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(values[0]) + 0.7152 * channel(values[1]) + 0.0722 * channel(values[2])
}

function colorSample(color: string): { luminance: number; alpha: number } | null {
  const match = color.match(/^rgba?\(([^)]+)\)$/i)
  if (!match) {
    const luminance = colorLuminance(color)
    return luminance == null ? null : { luminance, alpha: 1 }
  }
  const raw = match[1].split(/[,/\s]+/).filter(Boolean).map((value) => Number.parseFloat(value))
  if (raw.length < 3 || raw.slice(0, 3).some((value) => !Number.isFinite(value))) return null
  const channel = (value: number) => {
    const normalized = Math.max(0, Math.min(255, value)) / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  const alpha = raw.length > 3 && Number.isFinite(raw[3]) ? Math.max(0, Math.min(1, raw[3])) : 1
  return {
    luminance: 0.2126 * channel(raw[0]) + 0.7152 * channel(raw[1]) + 0.0722 * channel(raw[2]),
    alpha,
  }
}

const OUTLINE_EXCLUDED_TAGS = new Set(['SVG', 'PATH', 'CIRCLE', 'RECT', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE'])

function hasVisibleDirectText(element: Element): boolean {
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
  )
}

function updateOutlineForText(element: Element): void {
  if (OUTLINE_EXCLUDED_TAGS.has(element.tagName) || element.closest('[aria-hidden="true"]') || !hasVisibleDirectText(element)) {
    element.classList.remove('adaptive-text-outline')
    return
  }
  const style = getComputedStyle(element)
  const fill = style.getPropertyValue('-webkit-text-fill-color')
  const luminance = colorLuminance(fill && fill !== 'currentcolor' ? fill : style.color)
  if (luminance === null || luminance < 0.62) {
    element.classList.remove('adaptive-text-outline')
    return
  }

  // A bright wallpaper should not add an outline to text already sitting on an
  // opaque dark card. Conversely, a light surface can need an outline even if
  // most of the wallpaper behind the page is dark.
  let backdropIsBright = document.documentElement.dataset.brightWallpaper === 'true'
  let ancestor: Element | null = element
  while (ancestor && ancestor !== document.body) {
    const background = colorSample(getComputedStyle(ancestor).backgroundColor)
    if (background && background.alpha >= 0.92) {
      backdropIsBright = background.luminance >= 0.43
      break
    }
    ancestor = ancestor.parentElement
  }
  element.classList.toggle('adaptive-text-outline', backdropIsBright)
}

function refreshTextOutlines(): void {
  document.querySelectorAll('body *').forEach(updateOutlineForText)
}

export default function BackgroundLayer() {
  const { settings } = useSettings()
  const bg = settings.background

  useEffect(() => {
    const root = document.documentElement
    let disposed = false
    let observer: MutationObserver | null = null
    let refreshFrame = 0
    root.dataset.brightWallpaper = 'false'

    const scan = () => {
      if (disposed) return
      if (refreshFrame) window.cancelAnimationFrame(refreshFrame)
      refreshFrame = window.requestAnimationFrame(refreshTextOutlines)
    }

    if (!bg.path) {
      const baseBackground = getComputedStyle(root).getPropertyValue('--bg')
      root.dataset.brightWallpaper = String((colorLuminance(baseBackground) ?? 0) >= 0.43)
      scan()
      return () => {
        disposed = true
        if (refreshFrame) window.cancelAnimationFrame(refreshFrame)
      }
    }

    const image = new Image()
    image.onload = () => {
      if (disposed) return
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 24
        canvas.height = 24
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Canvas is unavailable')
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let luminance = 0
        let samples = 0
        for (let index = 0; index < pixels.length; index += 4) {
          const alpha = pixels[index + 3] / 255
          if (alpha < 0.05) continue
          const y = (0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]) / 255
          luminance += y * alpha
          samples += 1
        }
        const visibleLuminance = samples === 0 ? 0 : (luminance / samples) * (1 - bg.dimPct / 100)
        root.dataset.brightWallpaper = visibleLuminance >= 0.43 ? 'true' : 'false'
      } catch {
        root.dataset.brightWallpaper = 'false'
      }
      scan()
    }
    image.onerror = () => {
      root.dataset.brightWallpaper = 'false'
      scan()
    }
    image.crossOrigin = 'anonymous'
    image.src = convertFileSrc(bg.path)

    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData' && record.target.parentElement) {
          updateOutlineForText(record.target.parentElement)
        }
        if (record.type === 'childList' && record.target instanceof Element) {
          updateOutlineForText(record.target)
          record.addedNodes.forEach((node) => {
            if (node instanceof Element) {
              updateOutlineForText(node)
              node.querySelectorAll('*').forEach(updateOutlineForText)
            }
          })
        }
      }
    })
    observer.observe(document.body, { childList: true, characterData: true, subtree: true })
    scan()

    return () => {
      disposed = true
      observer?.disconnect()
      image.onload = null
      image.onerror = null
      if (refreshFrame) window.cancelAnimationFrame(refreshFrame)
      root.dataset.brightWallpaper = 'false'
      document.querySelectorAll('.adaptive-text-outline').forEach((element) => element.classList.remove('adaptive-text-outline'))
    }
  }, [bg.path, bg.dimPct, settings.theme])

  if (bg.path === null) return null
  return (
    <div className="bg-layer" aria-hidden="true">
      <div
        className="bg-layer-img"
        style={{
          backgroundImage: `url("${convertFileSrc(bg.path)}")`,
          filter: bg.blurPx > 0 ? `blur(${bg.blurPx}px)` : undefined,
        }}
      />
      <div className="bg-layer-dim" style={{ opacity: bg.dimPct / 100 }} />
    </div>
  )
}

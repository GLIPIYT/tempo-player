import { useEffect, useState } from 'react'
import { usePlayer } from '../../player'
import { useSettings } from '../../state/settings'
import { useLyrics } from '../../features/lyrics'
import Visualizer from './Visualizer'

/**
 * The spectrum band above the player bar.
 *
 * Decides whether the canvas should exist at all, and resolves the theme
 * colour for it. The band's own height is fixed in CSS: the height setting
 * moves the amplitude inside it, so dragging the slider never makes the bar
 * itself jump.
 */

type Rgb = { r: number; g: number; b: number }

/** Matches the default theme accent, so the first frame is not off-colour. */
const FALLBACK_ACCENT: Rgb = { r: 108, g: 140, b: 255 }
const FALLBACK_PLAIN: Rgb = { r: 232, g: 235, b: 242 }

/**
 * `getComputedStyle` hands back custom properties as they were *specified*, so
 * `--accent` reads as `var(--t-base-accent, #6c8cff)` rather than a colour.
 * Painting the variable onto a throwaway element is what forces the cascade to
 * resolve it, and it keeps working for themes that compute their accent with
 * `color-mix`.
 */
function resolveVar(name: string, fallback: Rgb): Rgb {
  try {
    const probe = document.createElement('span')
    probe.style.display = 'none'
    probe.style.color = `var(${name})`
    document.body.appendChild(probe)
    const raw = getComputedStyle(probe).color
    probe.remove()
    return parseCssColor(raw) ?? fallback
  } catch {
    return fallback
  }
}

function parseCssColor(raw: string): Rgb | null {
  const value = raw.trim()
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const digits = hex[1]
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((c) => c + c)
            .join('')
        : digits
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    }
  }
  // `rgb(1, 2, 3)` and `color(srgb 0.1 0.2 0.3)` differ only in scale
  const parts = value.match(/-?\d*\.?\d+/g)
  if (!parts || parts.length < 3) return null
  const scale = value.startsWith('color(') ? 255 : 1
  return {
    r: Math.round(Number(parts[0]) * scale),
    g: Math.round(Number(parts[1]) * scale),
    b: Math.round(Number(parts[2]) * scale),
  }
}

export default function PlayerVisualizer() {
  const { settings } = useSettings()
  const player = usePlayer()
  const lyrics = useLyrics()
  const viz = settings.visualizer

  const [colors, setColors] = useState({ accent: FALLBACK_ACCENT, plain: FALLBACK_PLAIN })

  // Safe to read the variables in an effect rather than in the render: the
  // theme bridge sits above the shell in the tree, so its effect writes them
  // before this one runs.
  useEffect(() => {
    setColors({
      accent: resolveVar('--accent', FALLBACK_ACCENT),
      plain: resolveVar('--text', FALLBACK_PLAIN),
    })
  }, [settings.theme])

  // Nothing to draw for: switched off, no track, or the lyrics take the screen.
  if (viz.style === 'off' || player.currentTrack === null || lyrics.open) return null

  return (
    <div className="pb-viz" style={{ opacity: Math.max(0.1, Math.min(1, viz.opacityPct / 100)) }}>
      <Visualizer
        style={viz.style}
        bars={viz.bars}
        smoothing={viz.smoothing}
        opacityPct={viz.opacityPct}
        maxAmplitudePx={viz.heightPx}
        mirror={viz.mirror}
        rgb={viz.useThemeColor ? colors.accent : colors.plain}
      />
    </div>
  )
}

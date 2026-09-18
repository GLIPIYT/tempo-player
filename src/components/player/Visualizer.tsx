import { useEffect, useRef } from 'react'
import { SPECTRUM_BINS, subscribeSpectrum } from '../../audio/spectrum'
import {
  VISUALIZER_BARS_MAX,
  VISUALIZER_BARS_MIN,
  type VisualizerStyle,
} from '../../state/settings'

export interface VisualizerProps {
  style: Exclude<VisualizerStyle, 'off'>
  /** Bar count. The 64 incoming bins are interpolated up or down to this. */
  bars: number
  /** 0 is twitchy, 100 is very smooth. */
  smoothing: number
  /** Peak opacity, 10..100. */
  opacityPct: number
  /** How far a peak may rise, in CSS pixels. Does not move the band itself. */
  maxAmplitudePx: number
  mirror: boolean
  rgb: { r: number; g: number; b: number }
}

/**
 * Draws the live spectrum on a canvas.
 *
 * There is no animation loop here: the spectrum bus pushes a frame and this
 * draws it, so a paused player costs nothing and the canvas and the data can
 * never drift apart.
 */
export default function Visualizer(props: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Read through a ref so that dragging a slider redraws without tearing the
  // canvas down and re-subscribing on every step.
  const optsRef = useRef(props)
  optsRef.current = props

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let ctx: CanvasRenderingContext2D | null = null
    let lastWidth = 0
    let lastHeight = 0
    let canRound = false

    /** Per-bar values after the user-controlled lerp. */
    const level = new Float32Array(VISUALIZER_BARS_MAX)
    /** Where each bar is heading this frame, before the lerp. */
    const target = new Float32Array(VISUALIZER_BARS_MAX)
    /** Curve heights for the wave and line styles. */
    const curve = new Float32Array(VISUALIZER_BARS_MAX)

    const unsubscribe = subscribeSpectrum((spectrum) => {
      if (!ctx) {
        ctx = canvas.getContext('2d', { alpha: true })
        if (!ctx) return
        canRound = typeof ctx.roundRect === 'function'
      }

      const o = optsRef.current
      // Measured, never clamped, and nothing is drawn at zero size.
      //
      // A hidden window measures zero. The old clamp turned that into 1 and
      // then wrote it back as an inline width, which overrides the stylesheet -
      // so the canvas stayed one pixel wide for good, and minimising the window
      // made the visualiser disappear and never come back.
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width === 0 || height === 0) return
      // 2 is the ceiling on purpose: a 4K panel at dpr 3 would triple the
      // pixel count for no visible gain.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)

      if (width !== lastWidth || height !== lastHeight) {
        // Only the backing store is set. The element's own size comes from the
        // stylesheet, so it keeps following the window instead of being pinned
        // to whatever it happened to measure on the first frame.
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
        lastWidth = width
        lastHeight = height
        // resizing the backing store resets the transform, so it goes back on
        // here rather than once at mount
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      ctx.clearRect(0, 0, width, height)

      const count = Math.max(VISUALIZER_BARS_MIN, Math.min(VISUALIZER_BARS_MAX, Math.round(o.bars)))
      const ampLimit = Math.min(o.maxAmplitudePx, height)
      const opacity = Math.max(0.1, Math.min(1, o.opacityPct / 100))
      // 100 means "very smooth" to the user, so it has to map to a small step
      const lerp = Math.max(0.05, (100 - o.smoothing) / 100)
      const { r, g, b } = o.rgb

      for (let i = 0; i < count; i += 1) {
        const source = (i / Math.max(1, count - 1)) * (SPECTRUM_BINS - 1)
        const lo = Math.floor(source)
        const hi = Math.min(lo + 1, SPECTRUM_BINS - 1)
        const mix = source - lo
        const value = spectrum[lo] * (1 - mix) + spectrum[hi] * mix
        // High frequencies carry less energy by nature, so they get lifted a
        // little; without this the right half of the picture is always flat.
        const weight = 0.55 + 0.45 * (i / Math.max(1, count - 1))
        target[i] = Math.min(1, value * weight * 1.15)
        level[i] += (target[i] - level[i]) * lerp
      }

      ctx.save()
      if (o.mirror) {
        ctx.translate(width, 0)
        ctx.scale(-1, 1)
      }

      if (o.style === 'bars') {
        const slot = width / count
        const gap = Math.max(1, slot * 0.16)
        const barWidth = Math.max(1, slot - gap)
        // Many thin bars: rounding each cap costs more than it shows.
        const dense = count >= 56 || barWidth <= 6
        for (let i = 0; i < count; i += 1) {
          const value = level[i]
          const barHeight = Math.max(2, value * ampLimit)
          // quiet bars are paler, so the picture has depth without a filter
          const alpha = Math.max(0.14, value * opacity)
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`
          const y = height - barHeight
          const x = i * slot
          if (!dense && canRound && barWidth >= 5) {
            ctx.beginPath()
            ctx.roundRect(x, y, barWidth, barHeight, [3, 3, 0, 0])
            ctx.fill()
          } else {
            ctx.fillRect(x, y, barWidth, barHeight)
          }
        }
      } else {
        // Blur each bar into its neighbours first, otherwise the curve is
        // visibly serrated at low bar counts.
        for (let i = 0; i < count; i += 1) {
          const previous = level[Math.max(0, i - 1)]
          const next = level[Math.min(count - 1, i + 1)]
          const blended = previous * 0.24 + level[i] * 0.52 + next * 0.24
          curve[i] = height - Math.min(blended * ampLimit, ampLimit)
        }

        const step = width / Math.max(1, count - 1)
        const last = count - 1
        ctx.beginPath()
        ctx.moveTo(0, curve[0])
        // Quadratic through the midpoints: smooth without overshooting the way
        // a Catmull-Rom spline would.
        for (let i = 1; i < last; i += 1) {
          const x = i * step
          ctx.quadraticCurveTo(x, curve[i], (x + (i + 1) * step) / 2, (curve[i] + curve[i + 1]) / 2)
        }
        ctx.quadraticCurveTo(last * step, curve[last], last * step, curve[last])

        if (o.style === 'wave') {
          ctx.lineTo(width, height)
          ctx.lineTo(0, height)
          ctx.closePath()
          const gradient = ctx.createLinearGradient(0, 0, 0, height)
          const top = Math.max(0.16, opacity * 0.85)
          gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${top})`)
          gradient.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, ${top * 0.35})`)
          gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
          ctx.fillStyle = gradient
          ctx.fill()
        } else {
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`
          ctx.lineWidth = 2
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          ctx.stroke()
        }
      }

      ctx.restore()
    })

    return () => unsubscribe()
  }, [])

  return <canvas ref={canvasRef} className="pb-viz-canvas" aria-hidden />
}

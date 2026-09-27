import { useEffect, useRef } from 'react'
import { VISUALIZER_BARS_MAX, type AppSettings } from '../../state/settings'

type Props = {
  visualizer: AppSettings['visualizer']
  theme: AppSettings['theme']
  offLabel: string
}

function parseCanvasColor(value: string): { r: number; g: number; b: number } | null {
  const color = value.trim()
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const digits = hex[1]
    const full = digits.length === 3 ? digits.split('').map((part) => part + part).join('') : digits
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    }
  }
  const parts = color.match(/-?\d*\.?\d+/g)
  if (!parts || parts.length < 3) return null
  return { r: Number(parts[0]), g: Number(parts[1]), b: Number(parts[2]) }
}

/** A local sample: it stays animated even when no track is playing. */
export default function VisualizerPreview({ visualizer, theme, offLabel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const levelsRef = useRef(new Float32Array(VISUALIZER_BARS_MAX))

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const levels = levelsRef.current
    let frame = 0
    let lastTime = 0
    let running = true

    const draw = (time: number) => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width === 0 || height === 0) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const pixelWidth = Math.round(width * dpr)
      const pixelHeight = Math.round(height * dpr)
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, width, height)
      if (visualizer.style === 'off') return

      const count = visualizer.bars
      const amplitude = Math.min(visualizer.heightPx, height - 18)
      const phase = motion.matches ? 1.1 : time / 680
      const response = motion.matches ? 1 : Math.max(0.05, (100 - visualizer.smoothing) / 100)
      const rootStyle = getComputedStyle(document.documentElement)
      const fallbackColor = parseCanvasColor(getComputedStyle(canvas).color) ?? { r: 108, g: 140, b: 255 }
      const gradientActive =
        visualizer.useThemeColor && document.documentElement.classList.contains('theme-gradient')
      const firstColor = gradientActive
        ? parseCanvasColor(rootStyle.getPropertyValue('--t-gradient-first')) ?? fallbackColor
        : fallbackColor
      const secondColor = gradientActive
        ? parseCanvasColor(rootStyle.getPropertyValue('--t-gradient-second')) ?? firstColor
        : firstColor
      const accentGradient = context.createLinearGradient(0, 0, width, 0)
      accentGradient.addColorStop(0, `rgb(${firstColor.r}, ${firstColor.g}, ${firstColor.b})`)
      accentGradient.addColorStop(1, `rgb(${secondColor.r}, ${secondColor.g}, ${secondColor.b})`)

      for (let i = 0; i < count; i += 1) {
        const position = i / Math.max(1, count - 1)
        const broad = 0.4 + 0.2 * Math.sin(position * 12 + phase)
        const pulse = 0.16 * Math.sin(position * 31 - phase * 1.3)
        const detail = 0.09 * Math.sin(position * 67 + phase * 0.8)
        const target = Math.max(0.08, Math.min(0.92, broad + pulse + detail))
        levels[i] += (target - levels[i]) * response
      }

      context.save()
      context.globalAlpha = visualizer.opacityPct / 100
      context.fillStyle = accentGradient
      context.strokeStyle = accentGradient
      if (visualizer.mirror) {
        context.translate(width, 0)
        context.scale(-1, 1)
      }

      if (visualizer.style === 'bars') {
        const slot = width / count
        const gap = Math.max(1, slot * 0.16)
        for (let i = 0; i < count; i += 1) {
          const barHeight = Math.max(2, levels[i] * amplitude)
          context.globalAlpha = Math.max(0.14, levels[i] * (visualizer.opacityPct / 100))
          context.fillRect(i * slot, height - barHeight, Math.max(1, slot - gap), barHeight)
        }
      } else {
        context.beginPath()
        const step = width / Math.max(1, count - 1)
        context.moveTo(0, height - levels[0] * amplitude)
        for (let i = 1; i < count; i += 1) {
          const x = i * step
          const y = height - levels[i] * amplitude
          context.lineTo(x, y)
        }
        if (visualizer.style === 'wave') {
          context.lineTo(width, height)
          context.lineTo(0, height)
          context.closePath()
          context.globalAlpha = visualizer.opacityPct / 100
          context.fillStyle = accentGradient
          context.fill()
        } else {
          context.lineWidth = 2
          context.lineJoin = 'round'
          context.stroke()
        }
      }
      context.restore()
    }

    const tick = (time: number) => {
      lastTime = time
      draw(time)
      if (running && !motion.matches && visualizer.style !== 'off') frame = requestAnimationFrame(tick)
    }
    const onMotionChange = () => {
      cancelAnimationFrame(frame)
      if (motion.matches || visualizer.style === 'off') draw(0)
      else frame = requestAnimationFrame(tick)
    }
    const resize = new ResizeObserver(() => draw(lastTime))
    resize.observe(canvas)
    motion.addEventListener('change', onMotionChange)
    if (motion.matches || visualizer.style === 'off') draw(0)
    else frame = requestAnimationFrame(tick)

    return () => {
      running = false
      cancelAnimationFrame(frame)
      resize.disconnect()
      motion.removeEventListener('change', onMotionChange)
    }
  }, [visualizer, theme])

  return (
    <div className="set-viz-preview" aria-hidden="true">
      <canvas
        ref={canvasRef}
        className={visualizer.useThemeColor ? 'set-viz-preview-canvas' : 'set-viz-preview-canvas is-plain'}
        aria-hidden="true"
      />
      {visualizer.style === 'off' ? <span className="set-viz-preview-off">{offLabel}</span> : null}
    </div>
  )
}

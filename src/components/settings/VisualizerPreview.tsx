import { useEffect, useRef } from 'react'
import { VISUALIZER_BARS_MAX, type AppSettings } from '../../state/settings'

type Props = {
  visualizer: AppSettings['visualizer']
  theme: AppSettings['theme']
  offLabel: string
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
      const color = getComputedStyle(canvas).color

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
      context.fillStyle = color
      context.strokeStyle = color
      if (visualizer.mirror) {
        context.translate(width, 0)
        context.scale(-1, 1)
      }

      if (visualizer.style === 'bars') {
        const slot = width / count
        const gap = Math.max(1, slot * 0.16)
        for (let i = 0; i < count; i += 1) {
          const barHeight = Math.max(2, levels[i] * amplitude)
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
          const gradient = context.createLinearGradient(0, 0, 0, height)
          gradient.addColorStop(0, color)
          gradient.addColorStop(1, 'transparent')
          context.fillStyle = gradient
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

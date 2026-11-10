import { useLayoutEffect, useRef } from 'react'
import { interpolateAnimatedValue } from './period'

/** A small DOM-only counter: hover never rerenders the chart on each frame. */
export default function AnimatedValue({ value, format }: { value: number | null; format: (value: number) => string }) {
  const element = useRef<HTMLSpanElement>(null)
  const displayed = useRef(0)
  const formatter = useRef(format)
  const animation = useRef<{ from: number; to: number; startedAt: number; duration: number } | null>(null)
  const frame = useRef<number | null>(null)
  const generation = useRef(0)
  formatter.current = format
  useLayoutEffect(() => {
    const node = element.current
    if (!node) return
    const token = ++generation.current
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    if (value === null) {
      animation.current = null
      node.textContent = '—'
      return () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }
    }

    const now = performance.now()
    const previous = animation.current
    const from = previous
      ? interpolateAnimatedValue(previous.from, previous.to, (now - previous.startedAt) / previous.duration)
      : displayed.current
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      animation.current = null
      displayed.current = value
      node.textContent = formatter.current(value)
      return
    }

    const startedAt = now
    const duration = 360
    animation.current = { from, to: value, startedAt, duration }
    const update = (timestamp: number) => {
      if (generation.current !== token) return
      const progress = Math.min(1, (timestamp - startedAt) / duration)
      displayed.current = interpolateAnimatedValue(from, value, progress)
      const text = formatter.current(displayed.current)
      if (node.textContent !== text) node.textContent = text
      if (progress < 1) frame.current = requestAnimationFrame(update)
      else {
        displayed.current = value
        animation.current = null
        frame.current = null
      }
    }
    displayed.current = from
    node.textContent = formatter.current(from)
    frame.current = requestAnimationFrame(update)
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }
  }, [value])
  return <span ref={element} className="history-animated-value" data-value={value ?? ''}>{value === null ? '—' : format(value)}</span>
}

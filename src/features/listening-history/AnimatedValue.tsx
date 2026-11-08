import { useLayoutEffect, useRef } from 'react'

/** A small DOM-only counter: hover never rerenders the chart on each frame. */
export default function AnimatedValue({ value, format }: { value: number | null; format: (value: number) => string }) {
  const element = useRef<HTMLSpanElement>(null)
  const displayed = useRef(value ?? 0)
  const formatter = useRef(format)
  formatter.current = format
  useLayoutEffect(() => {
    const node = element.current
    if (!node) return
    if (value === null) { node.textContent = '—'; return }
    const from = displayed.current
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    const start = performance.now()
    const update = (now: number) => {
      const progress = reduced ? 1 : Math.min(1, (now - start) / 360)
      displayed.current = from + (value - from) * (1 - (1 - progress) ** 3)
      const text = formatter.current(displayed.current)
      if (node.textContent !== text) node.textContent = text
      if (progress < 1) frame = requestAnimationFrame(update)
    }
    node.textContent = formatter.current(from)
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [value, format])
  return <span ref={element} className="history-animated-value" data-value={value ?? ''}>{value === null ? '—' : format(value)}</span>
}

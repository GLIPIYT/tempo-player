import { useLayoutEffect, useRef } from 'react'
import { Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { useT } from '../../i18n'
import { compareMetric, interpolateAnimatedValue } from './period'

export default function AnimatedDelta({ current, previous, referenceLabel, formatValue }: {
  current: number | null
  previous: number | null
  referenceLabel: string
  formatValue: (value: number) => string
}) {
  const t = useT()
  const comparison = current === null || previous === null ? null : compareMetric(current, previous)
  const target = comparison?.percentChange ?? null
  const displayed = useRef(0)
  const pill = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const label = '—'
  const title = previous === null
    ? referenceLabel
    : `${t('Compared with')} ${referenceLabel} · ${t('Previous value')}: ${formatValue(previous)} · ${t('Current value')}: ${current === null ? '—' : formatValue(current)}`
  useLayoutEffect(() => {
    const node = pill.current, valueNode = text.current
    if (!node || !valueNode) return
    if (target === null) { valueNode.textContent = label; node.dataset.direction = '0'; displayed.current = 0; return }
    const from = displayed.current
    const start = performance.now()
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0, active = true
    const draw = (time: number) => {
      if (!active) return
      const progress = reduced ? 1 : Math.max(0, Math.min(1, (time - start) / 360))
      const value = interpolateAnimatedValue(from, target, progress)
      displayed.current = value
      const rounded = Math.round(value)
      node.dataset.direction = String(Math.sign(rounded))
      valueNode.textContent = `${rounded > 0 ? '+' : ''}${rounded}%`
      if (progress < 1) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => { active = false; cancelAnimationFrame(frame) }
  }, [target, label])
  return <span ref={pill} className="history-delta" data-direction="0" aria-label={title} title={title}>
    <span className="history-delta-icons" aria-hidden="true"><TrendingUp className="is-up" size={11} /><TrendingDown className="is-down" size={11} /><Minus className="is-flat" size={11} /></span>
    <span ref={text}>{target === null ? label : '0%'}</span>
  </span>
}

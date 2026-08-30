import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { fmtTime } from '../../utils/format'
import { useT } from '../../i18n'

interface WaveProgressProps {
  position: number
  duration: number
  seed: string
  onSeek: (sec: number) => void
}

const BAR_COUNT = 90

function hashUnit(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

function bellWeight(t: number): number {
  const sigma = 0.24
  return Math.exp(-((t - 0.5) ** 2) / (2 * sigma * sigma))
}

export default function WaveProgress({ position, duration, seed, onSeek }: WaveProgressProps) {
  const t = useT()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const previewRef = useRef(0)
  const [scrubbing, setScrubbing] = useState(false)
  const [previewFrac, setPreviewFrac] = useState(0)

  const heights = useMemo(() => {
    const arr: number[] = []
    for (let i = 0; i < BAR_COUNT; i++) {
      const u = hashUnit(`${seed}:${i}`)
      const shaped = u ** 1.3 * (0.38 + 0.62 * bellWeight(i / (BAR_COUNT - 1)))
      arr.push(18 + shaped * 82)
    }
    return arr
  }, [seed])

  const commit = useCallback(
    (frac: number) => {
      if (duration > 0 && Number.isFinite(frac)) onSeek(Math.max(0, frac * duration))
    },
    [duration, onSeek],
  )

  useEffect(() => {
    if (!scrubbing) return
    const fracAt = (clientX: number): number => {
      const el = boxRef.current
      if (!el) return previewRef.current
      const rect = el.getBoundingClientRect()
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    }
    const onMove = (e: PointerEvent) => {
      const f = fracAt(e.clientX)
      previewRef.current = f
      setPreviewFrac(f)
    }
    const onUp = () => {
      commit(previewRef.current)
      setScrubbing(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [scrubbing, commit])

  const liveFrac = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0
  const frac = scrubbing ? previewFrac : liveFrac

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = boxRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    previewRef.current = f
    setPreviewFrac(f)
    setScrubbing(true)
  }

  const bars = useMemo(
    () =>
      heights.map((h, i) => <span key={i} className="wave-bar" style={{ height: `${h.toFixed(2)}%` }} />),
    [heights],
  )

  return (
    <div
      className="wave"
      ref={boxRef}
      onPointerDown={onPointerDown}
      role="slider"
      aria-label={t('Seek')}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(frac * duration)}
    >
      <div className="wave-row" aria-hidden="true">
        {bars}
      </div>
      <div
        className="wave-row wave-accent"
        aria-hidden="true"
        style={{ clipPath: `inset(0 ${((1 - frac) * 100).toFixed(3)}% 0 0)` }}
      >
        {bars}
      </div>
      {scrubbing && duration > 0 && (
        <span className="wave-tip" style={{ left: `${(frac * 100).toFixed(2)}%` }}>
          {fmtTime(frac * duration)}
        </span>
      )}
    </div>
  )
}

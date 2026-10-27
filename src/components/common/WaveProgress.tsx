import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../../api/client'
import { fmtTime } from '../../utils/format'
import { useT } from '../../i18n'
import { cachedWaveformRequest, fallbackWaveformHeights, soundCloudWaveformHeights } from './waveform'

interface WaveProgressProps {
  position: number
  duration: number
  seed: string
  soundCloudTrackId: string | null
  waveformEnabled: boolean
  onSeek: (sec: number) => void
}

const BAR_COUNT = 90
/** each bar needs a 2px body plus the 2px gap after it to stay readable */
const BAR_SLOT_PX = 4
/** below this many bars the waveform stops reading as one, so it is the floor */
const BAR_COUNT_MIN = 24
const WAVEFORM_REQUEST_CACHE_SIZE = 16

export default function WaveProgress({
  position,
  duration,
  seed,
  soundCloudTrackId,
  waveformEnabled,
  onSeek,
}: WaveProgressProps) {
  const t = useT()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const previewRef = useRef(0)
  const waveformRequestsRef = useRef(new Map<string, Promise<number[]>>())
  const [scrubbing, setScrubbing] = useState(false)
  const [previewFrac, setPreviewFrac] = useState(0)
  const [barCount, setBarCount] = useState(BAR_COUNT)
  const [loadedWaveform, setLoadedWaveform] = useState<{ trackId: string; samples: number[] } | null>(null)

  useEffect(() => {
    if (!waveformEnabled || !soundCloudTrackId || loadedWaveform?.trackId === soundCloudTrackId) return

    let active = true
    const request = cachedWaveformRequest(
      waveformRequestsRef.current,
      soundCloudTrackId,
      () => api.scWaveform(soundCloudTrackId),
    )
    while (waveformRequestsRef.current.size > WAVEFORM_REQUEST_CACHE_SIZE) {
      const oldest = waveformRequestsRef.current.keys().next().value
      if (oldest === undefined) break
      waveformRequestsRef.current.delete(oldest)
    }
    request.then(samples => {
      if (active && Array.isArray(samples)) setLoadedWaveform({ trackId: soundCloudTrackId, samples })
    }).catch(() => {
      // SoundCloud may hide waveforms or be offline. The stable fallback below
      // keeps seeking available without surfacing a player error.
    })
    return () => { active = false }
  }, [waveformEnabled, soundCloudTrackId, loadedWaveform?.trackId])

  // Each bar has a 2px floor plus a 2px gap, so a fixed 90 bars need ~358px and
  // simply overflow below that - the row is not clipped. Measuring the real
  // width and dropping bars keeps the waveform inside its column at any size.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const apply = (w: number) => {
      const fits = Math.floor(w / BAR_SLOT_PX)
      const next = Math.max(BAR_COUNT_MIN, Math.min(BAR_COUNT, fits))
      setBarCount((prev) => (prev === next ? prev : next))
    }
    apply(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) apply(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const heights = useMemo(() => {
    if (soundCloudTrackId) {
      const samples = loadedWaveform?.trackId === soundCloudTrackId ? loadedWaveform.samples : null
      return soundCloudWaveformHeights(samples, barCount)
    }
    return fallbackWaveformHeights(seed, barCount)
  }, [seed, barCount, soundCloudTrackId, loadedWaveform])

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

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (duration <= 0) return
    const step = 0.01
    let next: number
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = frac - step
        break
      case 'ArrowRight':
      case 'ArrowUp':
        next = frac + step
        break
      case 'PageDown':
        next = frac - step * 10
        break
      case 'PageUp':
        next = frac + step * 10
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = 1
        break
      default:
        return
    }
    e.preventDefault()
    commit(next)
  }

  const bars = useMemo(
    () =>
      heights.map((h, i) => <span key={i} className="wave-bar" style={{ height: `${h.toFixed(2)}%` }} />),
    [heights],
  )

  return (
    <div
      className={`wave${waveformEnabled ? '' : ' wave-is-minimized'}`}
      ref={boxRef}
      onPointerDown={waveformEnabled ? onPointerDown : undefined}
      onKeyDown={waveformEnabled ? onKeyDown : undefined}
      role={waveformEnabled ? 'slider' : undefined}
      tabIndex={waveformEnabled ? 0 : -1}
      aria-hidden={waveformEnabled ? undefined : true}
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

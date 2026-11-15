import { useState, type CSSProperties } from 'react'
import './playbackRange.css'

export default function PlaybackRange({
  value, min, max, step, label, valueText, onChange, onCommit, className = '', vertical = false, disabled = false, id,
}: {
  value: number
  min: number
  max: number
  step: number
  label: string
  valueText?: string
  onChange: (value: number) => void
  onCommit?: () => void
  className?: string
  vertical?: boolean
  disabled?: boolean
  id?: string
}) {
  const [dragValue, setDragValue] = useState<number | null>(null)
  const display = dragValue ?? value
  const percentage = Math.min(100, Math.max(0, 100 * (display - min) / (max - min)))
  const endDrag = () => {
    setDragValue(null)
    onCommit?.()
  }
  return (
    <span
      className={`playback-range ${vertical ? 'is-vertical' : 'is-horizontal'}${dragValue !== null ? ' is-dragging' : ''}${disabled ? ' is-disabled' : ''} ${className}`}
      style={{ '--playback-range-level': `${percentage}%` } as CSSProperties}
    >
      <span className="playback-range-axis" aria-hidden="true">
        <span className="playback-range-fill" />
        <span className="playback-range-thumb" />
      </span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={display}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={dragValue === null ? valueText : undefined}
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        onChange={event => {
          const next = event.currentTarget.valueAsNumber
          if (dragValue !== null) setDragValue(next)
          onChange(next)
        }}
        onPointerDown={() => setDragValue(value)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onBlur={endDrag}
      />
    </span>
  )
}

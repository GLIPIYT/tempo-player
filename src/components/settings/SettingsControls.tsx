import { useEffect, useRef, useState, useId, type ChangeEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useT } from '../../i18n'

export function SettingsSwitch({ checked, label, onClick, disabled }: {
  checked: boolean
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button type="button" className={checked ? 'switch is-on' : 'switch'} role="switch"
      aria-checked={checked} aria-label={label} disabled={disabled} onClick={onClick} />
  )
}

export function Segmented<T extends string>(props: {
  label?: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === props.value ? 'seg-btn is-active' : 'seg-btn'}
          aria-pressed={o.value === props.value}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function fillPct(min: number, max: number, v: number): string {
  return `${((v - min) / (max - min)) * 100}%`
}

type SliderProps = {
  label: string
  min: number
  max: number
  step: number
  value: number
  display: string
  disabled?: boolean
}

function RangeRow(props: SliderProps & {
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onPointerDown?: () => void
  onBlur?: () => void
  valueText?: string
  draftTitle?: string
}) {
  const id = useId()
  return (
    <div className="set-row">
      <label className="set-row-label" htmlFor={id}>{props.label}</label>
      <div className={props.draftTitle ? 'slider-row is-drafting' : 'slider-row'}>
        <input
          id={id}
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          disabled={props.disabled}
          aria-valuetext={props.valueText ?? props.display}
          onChange={props.onChange}
          onKeyDown={props.onKeyDown}
          onPointerDown={props.onPointerDown}
          onBlur={props.onBlur}
          style={{ '--fill': fillPct(props.min, props.max, props.value) } as CSSProperties}
        />
        <output htmlFor={id} className={props.draftTitle ? 'slider-value is-draft' : 'slider-value'}
          title={props.draftTitle}>
          {props.display}{props.draftTitle ? ' ·' : ''}
        </output>
      </div>
    </div>
  )
}

export function SliderRow({ onChange, ...props }: SliderProps & { onChange: (value: number) => void }) {
  return <RangeRow {...props} onChange={(event) => onChange(Number(event.target.value))} />
}

export function CommitSlider(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  format: (v: number) => string
  ariaFormat?: (v: number) => string
  onCommit: (v: number) => void
  disabled?: boolean
}) {
  const t = useT()
  const [draft, setDraft] = useState<number | null>(null)
  const draftRef = useRef<number | null>(null)
  const kbRef = useRef(false)

  const commit = () => {
    const d = draftRef.current
    if (d === null) return
    draftRef.current = null
    setDraft(null)
    props.onCommit(d)
  }

  // The pointer listeners are installed once per drag, so they would otherwise
  // close over the onCommit from that one render. PlayerBar solves the same
  // problem with a ref, and the scrubbing code should read the same way.
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  })

  useEffect(() => {
    if (draft === null) return
    const onUp = () => commitRef.current()
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [draft])

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    if (kbRef.current) {
      kbRef.current = false
      draftRef.current = null
      setDraft(null)
      props.onCommit(v)
      return
    }
    draftRef.current = v
    setDraft(v)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (
      e.key.startsWith('Arrow') ||
      e.key === 'Home' ||
      e.key === 'End' ||
      e.key === 'PageUp' ||
      e.key === 'PageDown'
    ) {
      kbRef.current = true
    }
  }

  const shown = draft ?? props.value
  return (
    <RangeRow label={props.label} min={props.min} max={props.max} step={props.step} value={shown}
      disabled={props.disabled} display={props.format(shown)} valueText={props.ariaFormat?.(shown)}
      onChange={onChange} onKeyDown={onKeyDown} onPointerDown={() => { kbRef.current = false }}
      onBlur={commit} draftTitle={draft === null ? undefined : t('Release to apply')} />
  )
}

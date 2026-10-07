import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'

interface Props {
  value: string
  onCommit: (color: string) => void
}

/** Keep native picker previews local; persist only its final change event. */
export default function LyricsProgressColorPicker({ value, onCommit }: Props) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<{ base: string; color: string } | null>(null)
  const shown = draft?.base === value ? draft.color : value

  useEffect(() => {
    const input = inputRef.current
    if (input) input.value = value
  }, [value])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    let committed = value.toLowerCase()
    const commit = () => {
      const color = input.value
      if (color !== committed) {
        committed = color
        onCommit(color)
      }
      setDraft(null)
    }
    // React onChange also fires for every input sample and can swallow the
    // final native change after tracking the same value. Listen directly so
    // mouse and keyboard selections both commit when the picker is dismissed.
    input.addEventListener('change', commit)
    return () => input.removeEventListener('change', commit)
  }, [value, onCommit])

  return (
    <label className="lyrics-color-picker" title={t('Custom progress color')}>
      <span className="lyrics-color-picker-swatch" style={{ backgroundColor: shown }} aria-hidden="true" />
      <span className="lyrics-color-picker-value" aria-hidden="true">{shown.toUpperCase()}</span>
      <input
        ref={inputRef}
        type="color"
        defaultValue={value}
        aria-label={t('Custom progress color')}
        onInput={event => setDraft({ base: value, color: event.currentTarget.value })}
        onBlur={() => setDraft(null)}
      />
    </label>
  )
}

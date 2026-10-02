import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from '../../api/client'
import { useT } from '../../i18n'
import './BackgroundImageLibrary.css'

interface Props {
  selectedPath: string | null
  onSelect: (path: string) => void
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export default function BackgroundImageLibrary({ selectedPath, onSelect }: Props) {
  const t = useT()
  const [paths, setPaths] = useState<string[]>([])
  const [error, setError] = useState(false)
  const requestId = useRef(0)

  useEffect(() => {
    const current = ++requestId.current
    let active = true
    void api.listSavedBackgrounds()
      .then((saved) => {
        if (!active || current !== requestId.current) return
        setPaths(saved)
        setError(false)
      })
      .catch(() => {
        if (!active || current !== requestId.current) return
        setError(true)
      })
    return () => {
      active = false
      requestId.current += 1
    }
  }, [selectedPath])

  if (paths.length === 0 && !error) return null

  return (
    <div className="saved-backgrounds" role="group" aria-label={t('Saved backgrounds')}>
      <span className="saved-backgrounds-title">{t('Saved backgrounds')}</span>
      {error ? <span className="saved-backgrounds-error" role="status">{t('Could not load saved backgrounds')}</span> : null}
      <div className="saved-backgrounds-grid">
        {paths.map((path) => {
          const selected = path === selectedPath
          return (
            <button
              key={path}
              type="button"
              className={`saved-backgrounds-item${selected ? ' is-selected' : ''}`}
              aria-label={fileName(path)}
              aria-pressed={selected}
              title={fileName(path)}
              onClick={() => onSelect(path)}
            >
              <img src={convertFileSrc(path)} alt="" loading="lazy" decoding="async" />
              {selected ? <span className="saved-backgrounds-check"><Check size={12} aria-hidden="true" /></span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

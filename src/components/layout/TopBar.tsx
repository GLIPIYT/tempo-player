import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import { useNav } from '../../state/nav'
import { useT } from '../../i18n'
import { searchStore } from '../../utils/searchStore'

export default function TopBar() {
  const { view, navigate } = useNav()
  const t = useT()
  const [value, setValue] = useState(searchStore.get())
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const goToSearch = () => {
    if (view.name !== 'search') navigate({ name: 'search' })
  }

  const flushNow = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    searchStore.set(value)
    goToSearch()
  }

  const onChange = (next: string) => {
    setValue(next)
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      searchStore.set(next)
    }, 250)
    if (next.trim().length > 0) goToSearch()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') flushNow()
  }

  const onClear = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    setValue('')
    searchStore.set('')
  }

  return (
    <header className="topbar">
      <div className="topbar-search">
        <Search size={15} className="topbar-search-icon" />
        <input
          value={value}
          placeholder={t('Search tracks, albums, artists')}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {value ? (
          <button className="icon-btn topbar-clear" onClick={onClear} aria-label={t('Clear search')}>
            <X size={14} />
          </button>
        ) : null}
      </div>
    </header>
  )
}

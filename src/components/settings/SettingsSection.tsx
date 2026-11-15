import { createContext, useContext, useState, type ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'

const OpenSections = createContext<Map<string, boolean> | null>(null)

export function SettingsSectionScope({ children }: { children: ReactNode }) {
  const [state] = useState(() => new Map<string, boolean>())
  return <OpenSections.Provider value={state}>{children}</OpenSections.Provider>
}

export function SettingsSection({ id, title, desc, icon: Icon, defaultOpen = false, children }: {
  id?: string
  title: string
  desc?: string
  icon?: LucideIcon
  defaultOpen?: boolean
  children: ReactNode
}) {
  const remembered = useContext(OpenSections)
  const key = id ?? title
  const [open, setOpen] = useState(() => remembered?.get(key) ?? defaultOpen)
  return (
    <details className="set-card set-disclosure" open={open} onToggle={(event) => {
      const next = event.currentTarget.open
      remembered?.set(key, next)
      setOpen(next)
    }}>
      <summary className="set-disclosure-summary">
        {Icon ? <Icon size={16} aria-hidden="true" /> : null}
        <span className="set-card-title">{title}</span>
        <ChevronRight className="set-disclosure-chevron" size={16} aria-hidden="true" />
      </summary>
      {open ? <div className="set-disclosure-body">
        {desc ? <div className="set-card-desc">{desc}</div> : null}
        {children}
      </div> : null}
    </details>
  )
}

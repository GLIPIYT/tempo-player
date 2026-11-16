import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'

const OpenSections = createContext<Map<string, boolean> | null>(null)
const DISCLOSURE_MS = 240
type DisclosurePhase = 'closed' | 'opening' | 'open' | 'closing'

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
  const [phase, setPhase] = useState<DisclosurePhase>(() => (remembered?.get(key) ?? defaultOpen) ? 'open' : 'closed')
  const open = phase === 'opening' || phase === 'open'
  const moving = phase === 'opening' || phase === 'closing'
  const panelId = useId()
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (panelRef.current) panelRef.current.inert = !open
  }, [open])

  useEffect(() => {
    if (!moving) return
    // Finish even if the browser coalesces a pair of rapid clicks or cancels the transition.
    const timer = window.setTimeout(() => setPhase(open ? 'open' : 'closed'), DISCLOSURE_MS + 60)
    return () => window.clearTimeout(timer)
  }, [moving, open])

  const toggle = () => {
    const next = !open
    const instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    remembered?.set(key, next)
    setPhase(next ? (instant ? 'open' : 'opening') : (instant ? 'closed' : 'closing'))
  }

  return (
    <div className="set-card set-disclosure">
      <button type="button" className="set-disclosure-summary" aria-expanded={open} aria-controls={panelId} onClick={toggle}>
        {Icon ? <Icon size={16} aria-hidden="true" /> : null}
        <span className="set-card-title">{title}</span>
        <ChevronRight className="set-disclosure-chevron" size={16} aria-hidden="true" />
      </button>
      <div ref={panelRef} id={panelId} className="set-disclosure-panel"
        data-expanded={open} data-moving={moving} aria-hidden={!open}
        style={{ transitionDuration: `${DISCLOSURE_MS}ms` }}
        onTransitionEnd={event => {
          if (moving && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') {
            setPhase(open ? 'open' : 'closed')
          }
        }}
      >
        <div className="set-disclosure-clip">
          {phase !== 'closed' ? (
            <div className="set-disclosure-body">
              {desc ? <div className="set-card-desc">{desc}</div> : null}
              {children}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

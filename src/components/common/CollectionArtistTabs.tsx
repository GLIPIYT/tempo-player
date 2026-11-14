import { useId, type ReactNode } from 'react'
import { useT } from '../../i18n'

export default function CollectionArtistTabs({ tabs, active, onChange, children }: {
  tabs: ReadonlyArray<{ id: string; label: string }>
  active: string
  onChange: (id: string) => void
  children: ReactNode
}) {
  const t = useT()
  const panelId = useId()
  return (
    <>
      <div className="collection-artist-tabs" role="tablist" aria-label={t('Artist')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const current = tabs.findIndex(tab => tab.id === active)
        const offset = event.key === 'ArrowRight' ? 1 : -1
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : (current + offset + tabs.length) % tabs.length
        event.preventDefault()
        onChange(tabs[index].id)
        event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[index]?.focus()
      }}>
        {tabs.map(({ id, label }) => <button key={id} id={`${panelId}-${id}`} type="button" role="tab"
          aria-selected={active === id} aria-controls={panelId} tabIndex={active === id ? 0 : -1}
          onClick={() => onChange(id)}>{label}</button>)}
      </div>
      <div key={active} className={`collection-tab-panel is-${active}`} id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${active}`}>
        {children}
      </div>
    </>
  )
}

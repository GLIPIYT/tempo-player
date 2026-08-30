import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}

export default function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="empty">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  )
}

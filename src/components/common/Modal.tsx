import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useT } from '../../i18n'

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}

export default function Modal({ open, title, onClose, children }: ModalProps) {
  const t = useT()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close dialog')}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

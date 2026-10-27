import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useT } from '../../i18n'

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  closeDisabled?: boolean
  children: ReactNode
  className?: string
}

export default function Modal({ open, title, onClose, closeDisabled = false, children, className }: ModalProps) {
  const t = useT()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !closeDisabled) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, closeDisabled])

  if (!open) return null

  return (
    <div
      className={className ? `modal-overlay ${className}-overlay` : 'modal-overlay'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !closeDisabled) onClose()
      }}
    >
      <div className={className ? `modal ${className}` : 'modal'} role="dialog" aria-label={title}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close dialog')} disabled={closeDisabled}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

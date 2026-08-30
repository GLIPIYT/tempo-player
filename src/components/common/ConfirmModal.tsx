import { useEffect, useRef } from 'react'
import { useT } from '../../i18n'

interface ConfirmModalProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  const t = useT()
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onConfirm, onClose])

  if (!open) return null

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="confirm-box" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="confirm-title">{title}</div>
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            ref={confirmRef}
            className={'btn' + (danger ? ' btn-danger-solid' : ' btn-primary')}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('Confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

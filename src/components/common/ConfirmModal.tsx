import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Check, Trash2, X } from 'lucide-react'
import { useT } from '../../i18n'
import { useSettings } from '../../state/settings'
import { useExitTransition } from './useExitTransition'
import './deleteRuleDialog.css'

interface ConfirmModalProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}

function ConfirmPrompt({ title, message, confirmLabel, danger, onConfirm, onClose }: ConfirmModalProps) {
  const t = useT()
  const { settings } = useSettings()
  const scale = Math.max(50, Math.min(200, settings.font.uiScalePct)) / 100
  const cancel = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const titleId = useId()
  const messageId = useId()
  const { closing, close } = useExitTransition(onClose, 150)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancel.current?.focus()
    return () => previous?.focus()
  }, [])
  return createPortal(<div className={`rule-delete-layer${closing ? ' is-closing' : ''}`} onPointerDown={event => { if (event.target === event.currentTarget) close() }} onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key !== 'Tab') return
    const items = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const first = items[0], last = items.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}><section ref={dialog} className="rule-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId} style={{ zoom: scale, maxWidth: `calc((100vw - 48px) / ${scale})`, maxHeight: `calc((100dvh - 48px) / ${scale})` }}>
    <button className="rule-delete-close" type="button" aria-label={t('Close dialog')} onClick={() => close()}><X size={18} /></button>
    <div className="rule-delete-panorama" aria-hidden="true"><span className="rule-delete-symbol">{danger ? <Trash2 size={23} /> : <Check size={23} />}</span></div>
    <div className="rule-delete-content"><h2 id={titleId}>{title}</h2><p id={messageId} style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{message}</p>
      <footer style={{ marginTop: 28 }}><button ref={cancel} type="button" className="rule-delete-cancel" onClick={() => close()}><X size={14} />{t('Cancel')}</button><button type="button" className={danger ? 'rule-delete-confirm' : 'playlist-confirm-primary'} onClick={() => close(onConfirm)}>{danger ? <Trash2 size={15} /> : <Check size={15} />}{confirmLabel ?? t('Confirm')}</button></footer>
    </div>
  </section></div>, document.body)
}

export default function ConfirmModal(props: ConfirmModalProps) {
  return props.open ? <ConfirmPrompt {...props} /> : null
}

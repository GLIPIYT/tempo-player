import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ListFilter, ListMusic, LoaderCircle, Trash2, X } from 'lucide-react'
import { useSettings } from '../../state/settings'
import { useT } from '../../i18n'
import { useExitTransition } from './useExitTransition'
import Cover from './Cover'
import './deleteRuleDialog.css'

export default function DeleteRuleDialog({ name, onDelete, onClose, kind = 'rule', coverPath = null }: {
  name: string
  onDelete: () => Promise<void>
  onClose: (deleted?: boolean) => void
  kind?: 'rule' | 'playlist'
  coverPath?: string | null
}) {
  const t = useT()
  const { settings } = useSettings()
  const scale = Math.max(50, Math.min(200, settings.font.uiScalePct)) / 100
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const cancel = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const titleId = useId()
  const messageId = useId()
  const { closing, close } = useExitTransition(() => onClose(), 150)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancel.current?.focus()
    return () => previous?.focus()
  }, [])
  const dismiss = () => { if (!pending.current) close() }
  const remove = async () => {
    if (pending.current || closing) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await onDelete()
      close(() => onClose(true))
    } catch (cause) {
      pending.current = false
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return createPortal(<div className={`rule-delete-layer${closing ? ' is-closing' : ''}`} onPointerDown={event => {
    if (event.target === event.currentTarget) dismiss()
  }} onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); dismiss() }
    if (event.key !== 'Tab') return
    const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const first = buttons[0], last = buttons.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <section ref={dialog} className="rule-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId} aria-busy={busy} style={{ zoom: scale, maxWidth: `calc((100vw - 48px) / ${scale})`, maxHeight: `calc((100dvh - 48px) / ${scale})` }}>
      <button className="rule-delete-close" type="button" aria-label={t('Close dialog')} onClick={dismiss} disabled={busy}><X size={18} /></button>
      <div className="rule-delete-panorama" aria-hidden="true"><div className="rule-delete-art-glow"><Cover path={coverPath} label={name} size={500} /></div>{coverPath && <div className="rule-delete-art-card"><Cover path={coverPath} label={name} size={65} /></div>}<span className="rule-delete-symbol"><Trash2 size={23} strokeWidth={1.6} /></span></div>
      <div className="rule-delete-content">
      <h2 id={titleId}>{t(kind === 'rule' ? 'Delete rule?' : 'Delete playlist?')}</h2>
      <p id={messageId}>{t(kind === 'rule' ? 'The mix will disappear. Your tracks and listening history will stay.' : 'Only the playlist will be deleted. Your tracks will stay in the library.')}</p>
      <div className="rule-delete-item">{coverPath ? <Cover path={coverPath} label={name} size={40} /> : kind === 'rule' ? <ListFilter size={18} /> : <ListMusic size={18} />}<strong>{name}</strong><span>{t(kind === 'rule' ? 'Custom mix' : 'Playlist')}</span></div>
      {error && <p className="rule-delete-error" role="alert"><AlertCircle size={15} />{error}</p>}
      <footer><button ref={cancel} className="rule-delete-cancel" type="button" onClick={dismiss} disabled={busy}><X size={14} />{t('Cancel')}</button><button className="rule-delete-confirm" type="button" onClick={() => void remove()} disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}{t(busy ? 'Deleting…' : kind === 'rule' ? 'Delete rule' : 'Delete playlist')}</button></footer>
      </div>
    </section>
  </div>, document.body)
}

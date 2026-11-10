import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, ListPlus, LoaderCircle, Plus, X } from 'lucide-react'
import { api } from '../../api/client'
import { useSettings } from '../../state/settings'
import { useT } from '../../i18n'
import Cover from './Cover'
import { useExitTransition } from './useExitTransition'
import './createPlaylistDialog.css'

export default function CreatePlaylistDialog({ onCreate, onClose, initialCoverPath = null, forTrack = false }: {
  onCreate: (name: string, coverPath: string | null) => Promise<void>
  onClose: (created?: boolean) => void
  initialCoverPath?: string | null
  forTrack?: boolean
}) {
  const t = useT()
  const { settings } = useSettings()
  const scale = Math.max(50, Math.min(200, settings.font.uiScalePct)) / 100
  const [name, setName] = useState('')
  const [covers, setCovers] = useState<string[]>([])
  const [cover, setCover] = useState(initialCoverPath)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const titleId = useId()
  const inputId = useId()
  const { closing, close } = useExitTransition(() => onClose(), 150)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    input.current?.focus()
    return () => previous?.focus()
  }, [])
  useEffect(() => {
    if (forTrack) return
    let cancelled = false
    void api.getHistory(50, 0).then(entries => {
      if (cancelled) return
      const choices = [...new Set(entries.flatMap(entry => entry.track.coverPath ? [entry.track.coverPath] : []))].slice(0, 4)
      setCovers(choices)
      setCover(current => current ?? choices[0] ?? null)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [forTrack])
  const dismiss = () => { if (!pending.current) close() }
  const submit = async () => {
    if (!name.trim() || pending.current || closing) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await onCreate(name.trim(), forTrack ? initialCoverPath : cover)
      close(() => onClose(true))
    } catch (cause) {
      pending.current = false
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return createPortal(<div className={`playlist-create-layer${closing ? ' is-closing' : ''}`} onPointerDown={event => { if (event.target === event.currentTarget) dismiss() }} onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); dismiss() }
    if (event.key !== 'Tab') return
    const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])]
    const first = nodes[0], last = nodes.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <section ref={dialog} className="playlist-create-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} style={{ zoom: scale, maxWidth: `calc((100vw - 48px) / ${scale})`, maxHeight: `calc((100dvh - 48px) / ${scale})` }}>
      <button className="playlist-create-close" type="button" aria-label={t('Close dialog')} onClick={dismiss} disabled={busy}><X size={18} /></button>
      <div className="playlist-create-panorama" aria-hidden="true"><div className="playlist-create-glow"><Cover path={cover} label={name || t('New playlist')} size={500} /></div><div className="playlist-create-art"><Cover path={cover} label={name || t('New playlist')} size={65} /></div><span><ListPlus size={23} /></span></div>
      <form className="playlist-create-content" onSubmit={event => { event.preventDefault(); void submit() }}>
        <h2 id={titleId}>{t('New playlist')}</h2>
        <p>{t('You can change the name at any time.')}</p>
        <label htmlFor={inputId}>{t('Playlist name')}</label><input ref={input} id={inputId} value={name} onChange={event => setName(event.target.value)} maxLength={150} disabled={busy} placeholder={t('Playlist name')} autoComplete="off" />
        {!forTrack && covers.length > 0 && <div className="playlist-create-covers"><span>{t('Cover')}</span><div role="group" aria-label={t('Cover')}>{covers.map((path, index) => <button key={path} type="button" disabled={busy} aria-label={`${t('Cover')} ${index + 1}`} aria-pressed={path === cover} onClick={() => setCover(path)}><Cover path={path} label={name} size={35} />{path === cover && <Check size={12} />}</button>)}</div></div>}
        {error && <p className="playlist-create-error" role="alert"><AlertCircle size={15} />{error}</p>}
        <footer><button type="button" className="playlist-create-cancel" disabled={busy} onClick={dismiss}><X size={14} />{t('Cancel')}</button><button type="submit" className="playlist-create-submit" disabled={busy || !name.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{t(busy ? 'Creating…' : 'Create playlist')}</button></footer>
      </form>
    </section>
  </div>, document.body)
}

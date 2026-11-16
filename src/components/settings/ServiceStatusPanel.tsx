import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { Activity, AlertCircle, Check, Copy, Globe, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useAsync } from '../../hooks/useAsync'
import { resolveLang, useT } from '../../i18n'
import { useSettings } from '../../state/settings'
import { useExitTransition } from '../common/useExitTransition'
import { SettingsSection } from './SettingsSection'
import './serviceStatus.css'

const STATUS_TEXT = {
  reachable: 'Available',
  restricted: 'Access limited',
  timeout: 'No response in time',
  connectError: 'Connection failed',
  networkError: 'Network error',
  unexpectedResponse: 'Unexpected response',
} as const

interface ServiceProbe {
  id: string
  label: string
  host: string
  primary: boolean
  status: keyof typeof STATUS_TEXT
  latencyMs: number | null
  httpStatus: number | null
}

interface ServiceCheck {
  checkedAt: string
  services: ServiceProbe[]
}

let pendingCheck: Promise<ServiceCheck> | undefined

function checkServices(): Promise<ServiceCheck> {
  pendingCheck ??= invoke<ServiceCheck>('check_services').finally(() => { pendingCheck = undefined })
  return pendingCheck
}

function ServiceStatusDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const { settings } = useSettings()
  const dialog = useRef<HTMLDialogElement>(null)
  const pointerOnBackdrop = useRef(false)
  const [copyState, setCopyState] = useState<'copied' | 'error' | null>(null)
  const title = useId()
  const { close, closing } = useExitTransition(() => {
    dialog.current?.close()
    onClose()
  }, 160)
  const check = useAsync(checkServices, [])
  const rows = check.data?.services ?? []
  const available = rows.filter(row => row.status === 'reachable').length
  const checked = check.data ? new Intl.DateTimeFormat(resolveLang(settings.lang), { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    .format(new Date(check.data.checkedAt)) : null
  const scale = settings.font.uiScalePct / 100

  useEffect(() => {
    const node = dialog.current
    node?.showModal()
    return () => node?.close()
  }, [])

  const copyReport = async () => {
    if (!check.data) return
    const report = rows.map(row => [
      t(row.label), row.host, t(STATUS_TEXT[row.status]),
      row.httpStatus !== null ? `HTTP ${row.httpStatus}` : null,
      row.latencyMs !== null ? `${row.latencyMs} ${t('ms')}` : null,
    ].filter(Boolean).join(' · '))
    try {
      await navigator.clipboard.writeText([`Tempo · ${t('Service status')}`, check.data.checkedAt, ...report].join('\n'))
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  return createPortal(
    <dialog ref={dialog} className={`service-dialog${closing ? ' is-closing' : ''}`} aria-labelledby={title}
      style={{ zoom: scale, maxWidth: `calc((100vw - 32px) / ${scale})`, maxHeight: `calc((100dvh - 32px) / ${scale})` }}
      onCancel={event => { event.preventDefault(); close() }}
      onPointerDown={event => { pointerOnBackdrop.current = event.target === event.currentTarget }}
      onClick={event => { if (pointerOnBackdrop.current && event.target === event.currentTarget) close() }}>
      <div className="service-dialog-sheet">
        <header className="service-dialog-header">
          <div className="service-dialog-mark"><Activity size={22} aria-hidden="true" /></div>
          <div>
            <h2 id={title}>{t('Service status')}</h2>
            <p>{t('Checks public endpoints from this device.')}</p>
          </div>
          <button className="icon-btn service-dialog-close" type="button" aria-label={t('Close dialog')} onClick={() => close()}><X size={19} /></button>
        </header>
        <div className="service-dialog-summary" role="status">
          {check.loading ? <><LoaderCircle size={15} className="spin" />{t('Checking services…')}</>
            : check.error ? <><AlertCircle size={15} />{t('Could not check services')}</>
              : <>{available === rows.length ? <Check size={15} /> : <AlertCircle size={15} />}
                {t('{available} of {total} services available').replace('{available}', String(available)).replace('{total}', String(rows.length))}
                {checked && <time dateTime={check.data?.checkedAt}>{checked}</time>}</>}
        </div>
        {rows.length > 0 && <div className="service-dialog-results" aria-busy={check.loading}>
          {[true, false].map(primary => (
            <section key={String(primary)} className="service-dialog-group">
              <h3>{t(primary ? 'Music APIs' : 'Additional services')}</h3>
              <ul>
                {rows.filter(row => row.primary === primary).map(row => (
                  <li key={row.id} className="service-dialog-row" data-status={row.status}>
                    <span className="service-status-icon">{row.status === 'reachable' ? <Check size={13} /> : <AlertCircle size={13} />}</span>
                    <span className="service-row-identity"><strong>{t(row.label)}</strong><small>{row.host}</small></span>
                    <span className="service-row-outcome">{t(STATUS_TEXT[row.status])}
                      {row.httpStatus !== null && <small>HTTP {row.httpStatus}</small>}
                    </span>
                    <span className="service-row-latency">{row.latencyMs !== null ? `${row.latencyMs} ${t('ms')}` : '—'}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>}
        <footer className="service-dialog-actions">
          {copyState === 'error' && <span role="alert">{t('Could not copy report')}</span>}
          <button className="btn" type="button" disabled={rows.length === 0} onClick={() => void copyReport()}>
            {copyState === 'copied' ? <Check size={15} /> : <Copy size={15} />}
            <span aria-live="polite">{t(copyState === 'copied' ? 'Report copied' : 'Copy report')}</span>
          </button>
          <button className="btn btn-primary" type="button" disabled={check.loading}
            onClick={() => { setCopyState(null); check.reload() }}><RefreshCw size={15} />{t('Check again')}</button>
        </footer>
      </div>
    </dialog>,
    document.body,
  )
}

export default function ServiceStatusPanel() {
  const t = useT()
  const [open, setOpen] = useState(false)
  return <SettingsSection defaultOpen title={t('Connectivity')} icon={Globe}>
    <div className="set-actions">
      <button type="button" className="btn" onClick={() => setOpen(true)}><Activity size={15} />{t('Check connections')}</button>
    </div>
    {open && <ServiceStatusDialog onClose={() => setOpen(false)} />}
  </SettingsSection>
}

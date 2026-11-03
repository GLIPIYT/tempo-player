import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Copy, Maximize, Minimize, Minus, Square, X } from 'lucide-react'
import { useT } from '../../i18n'
import { usePlayer } from '../../player'
import { useSettings } from '../../state/settings'
import { resolveBrandIcon } from '../../theme/brandIcon'

const ESCAPE_HANDLED_SURFACES = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  'dialog[open]',
  '.modal-overlay',
  '.confirm-overlay',
  '.background-search-filter-popover',
  '.home-mix-picker[aria-hidden="false"]',
  '.qpanel.is-open',
].join(',')

function hasEscapeHandledSurface(): boolean {
  return Array.from(document.querySelectorAll(ESCAPE_HANDLED_SURFACES)).some((element) => {
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
  })
}

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenRef = useRef(false)
  const syncWindowStateRef = useRef<() => void>(() => {})
  const t = useT()
  const player = usePlayer()
  const { settings } = useSettings()
  const appIcon = resolveBrandIcon(settings.brandIconStyle, settings.theme)
  const win = getCurrentWindow()
  const now = player.currentTrack
    ? `${player.currentTrack.artists.join(', ')} — ${player.currentTrack.title}`
    : null

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    let syncRequest = 0
    const syncWindowState = () => {
      const request = ++syncRequest
      void Promise.all([win.isMaximized(), win.isFullscreen()]).then(([isMaximized, isFullscreen]) => {
        if (cancelled || request !== syncRequest) return
        setMaximized(isMaximized)
        fullscreenRef.current = isFullscreen
        setFullscreen(isFullscreen)
      }).catch(() => {})
    }
    syncWindowStateRef.current = syncWindowState
    syncWindowState()
    void win.onResized(syncWindowState).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    }).catch(() => {})

    const onEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.repeat ||
        !fullscreenRef.current ||
        hasEscapeHandledSurface()
      ) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      fullscreenRef.current = false
      setFullscreen(false)
      void win.setFullscreen(false).then(
        () => syncWindowStateRef.current(),
        () => syncWindowStateRef.current(),
      )
    }
    document.addEventListener('keydown', onEscape)
    return () => {
      cancelled = true
      syncRequest += 1
      syncWindowStateRef.current = () => {}
      unlisten?.()
      document.removeEventListener('keydown', onEscape)
    }
    // window handle is stable for the lifetime of the app
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleFullscreen = () => {
    const next = !fullscreenRef.current
    fullscreenRef.current = next
    setFullscreen(next)
    void win.setFullscreen(next).then(
      () => syncWindowStateRef.current(),
      () => syncWindowStateRef.current(),
    )
  }
  const fullscreenLabel = fullscreen ? t('Exit fullscreen') : t('Enter fullscreen')

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <img
          className="titlebar-icon"
          src={appIcon.src}
          style={{ width: 26, height: 26, ...(appIcon.filter ? { filter: appIcon.filter } : {}) }}
          alt=""
          draggable={false}
        />
        <span data-tauri-drag-region>Tempo</span>
      </div>
      {now ? (
        <div className="titlebar-now" data-tauri-drag-region title={now}>
          {now}
        </div>
      ) : null}
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          aria-label={fullscreenLabel}
          title={fullscreenLabel}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
        </button>
        <button
          type="button"
          className="titlebar-btn"
          aria-label={t('Minimize')}
          title={t('Minimize')}
          onClick={() => void win.minimize().catch(() => {})}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          aria-label={maximized ? t('Restore') : t('Maximize')}
          title={maximized ? t('Restore') : t('Maximize')}
          onClick={() => void win.toggleMaximize().catch(() => {})}
        >
          {maximized ? <Copy size={12} /> : <Square size={11} />}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-close"
          aria-label={t('Close')}
          title={t('Close')}
          onClick={() => void win.close().catch(() => {})}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  )
}

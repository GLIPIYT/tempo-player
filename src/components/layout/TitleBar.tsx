import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Copy, Minus, Square, X } from 'lucide-react'
import { usePlayer } from '../../player'
import appIcon from '../../assets/app-icon.png'

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const player = usePlayer()
  const win = getCurrentWindow()
  const now = player.currentTrack
    ? `${player.currentTrack.artists.join(', ')} — ${player.currentTrack.title}`
    : null

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void win
      .isMaximized()
      .then((v) => {
        if (!cancelled) setMaximized(v)
      })
      .catch(() => {})
    void win
      .onResized(async () => {
        try {
          setMaximized(await win.isMaximized())
        } catch {}
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
    // window handle is stable for the lifetime of the app
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <img className="titlebar-icon" src={appIcon} alt="" draggable={false} />
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
          className="titlebar-btn"
          aria-label="Minimize"
          onClick={() => void win.minimize().catch(() => {})}
        >
          <Minus size={14} />
        </button>
        <button
          className="titlebar-btn"
          aria-label={maximized ? 'Restore' : 'Maximize'}
          onClick={() => void win.toggleMaximize().catch(() => {})}
        >
          {maximized ? <Copy size={12} /> : <Square size={11} />}
        </button>
        <button
          className="titlebar-btn titlebar-close"
          aria-label="Close"
          onClick={() => void win.close().catch(() => {})}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A small global context menu, opened by right-click anywhere.
 *
 * The track menu (TrackMenu) already owns a dozen actions and a playlist
 * submenu, so tracks use that. This one covers everything that is not a track:
 * section headers, rails, cards - anything that wants a couple of commands at
 * the cursor.
 */

export interface ContextMenuItem {
  id: string
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export interface ContextMenuRequest {
  x: number
  y: number
  title?: string
  items: ContextMenuItem[]
}

let current: ContextMenuRequest | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

export function openContextMenu(req: ContextMenuRequest): void {
  current = req
  notify()
}

export function closeContextMenu(): void {
  if (current === null) return
  current = null
  notify()
}

function useRequest(): ContextMenuRequest | null {
  const [state, setState] = useState<ContextMenuRequest | null>(current)
  useEffect(() => {
    const l = () => setState(current)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return state
}

const EDGE_GAP = 8

function clamp(x: number, y: number, el: HTMLElement): { x: number; y: number } {
  const w = el.offsetWidth
  const h = el.offsetHeight
  return {
    x: Math.min(Math.max(EDGE_GAP, x), Math.max(EDGE_GAP, window.innerWidth - w - EDGE_GAP)),
    y: Math.min(Math.max(EDGE_GAP, y), Math.max(EDGE_GAP, window.innerHeight - h - EDGE_GAP)),
  }
}

export default function ContextMenuHost() {
  const req = useRequest()
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    setPos(req ? { x: req.x, y: req.y } : null)
  }, [req])

  // pull the menu back inside the window before it is painted
  useLayoutEffect(() => {
    if (!pos || !ref.current) return
    const el = ref.current
    const next = clamp(pos.x, pos.y, el)
    if (next.x !== pos.x || next.y !== pos.y) setPos(next)
  }, [pos])

  useEffect(() => {
    if (!req) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return
      closeContextMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu()
    }
    const dismiss = () => closeContextMenu()
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [req])

  if (!req || !pos) return null

  return (
    <div
      ref={ref}
      className="menu-pop menu-pop-at-point"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {req.title ? <div className="menu-title">{req.title}</div> : null}
      {req.items.map((item) => (
        <button
          key={item.id}
          className={'menu-item' + (item.danger ? ' menu-item-danger' : '')}
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            closeContextMenu()
            item.onSelect()
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}

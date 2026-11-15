import { useEffect, useRef, useState, type ReactNode } from 'react'
import TrackPlaybackMenu, { type TrackPlaybackMenuTrack } from './TrackPlaybackMenu'
import { useMenuPosition } from './useMenuPosition'

/**
 * A small global context menu, opened by right-click anywhere.
 *
 * Used by section headers, collection cards, and tracks that only have
 * provider-specific actions. Library tracks have their own TrackMenu.
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
  trigger?: HTMLElement
  track?: TrackPlaybackMenuTrack
}

let current: ContextMenuRequest | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

export function openContextMenu(req: ContextMenuRequest): void {
  if (req.trigger && current?.trigger === req.trigger) {
    closeContextMenu()
    return
  }
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

export default function ContextMenuHost() {
  const req = useRequest()
  const ref = useRef<HTMLDivElement | null>(null)
  useMenuPosition(ref, req)

  useEffect(() => {
    if (!req) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return
      if (req.trigger?.contains(e.target as Node)) return
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

  if (!req) return null

  const actions = <>
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
  </>

  return (
    <div
      ref={ref}
      className={`menu-pop menu-pop-at-point${req.track ? ' has-track-playback-settings' : ''}`}
      role={req.track ? undefined : 'menu'}
      onContextMenu={(e) => e.preventDefault()}
    >
      {req.track ? <TrackPlaybackMenu key={`${req.track.source}:${req.track.sourceId}:${req.x}:${req.y}`} track={req.track}>{actions}</TrackPlaybackMenu> : actions}
    </div>
  )
}

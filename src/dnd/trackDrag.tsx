import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import Cover from '../components/common/Cover'
import type { FavoriteKind } from '../types/models'

/**
 * Pointer-based drag & drop for tracks (into sidebar playlists) and for
 * reordering sidebar favorites - playlists, artists and albums share one order,
 * so one drag kind covers all three. Implemented with pointer events instead of
 * HTML5 drag events because Tauri's native drag-drop hook on Windows swallows
 * the latter. Also powers the floating cover ghost that follows the cursor
 * with a light spring, the drop "suction" animation and the drop highlight.
 */

type DragKind = 'track' | 'favorite'

export interface DragState {
  kind: DragKind
  title: string
  coverPath: string | null
  x: number
  y: number
  rot: number
  scale: number
  opacity: number
  targetId: number | null
  /** favorites reorder only */
  draggedIndex: number | null
  insertAt: number | null
}

interface DragSession {
  kind: DragKind
  title: string
  coverPath: string | null
  pointerId: number
  startX: number
  startY: number
  ox: number
  oy: number
  // animated position
  x: number
  y: number
  tx: number
  ty: number
  rot: number
  scale: number
  opacity: number
  active: boolean
  /** true once the drag passed the movement threshold (ghost is visible) */
  activated: boolean
  targetId: number | null
  // favorites reorder payload
  index?: number
  insertAt?: number | null
  /** when set, only rows of this kind accept the drop (grouped sidebar) */
  restrictKind?: FavoriteKind | null
  trackId?: number
  onFavoriteDrop?: (from: number, to: number) => void
  onTrackDrop?: (playlistId: number, trackId: number) => void
}

let session: DragSession | null = null
let raf = 0
let listeners = new Set<() => void>()
let targetListeners = new Set<() => void>()
let lastDragEnd = 0

export function registerPlaylistDropper(fn: ((playlistId: number, trackId: number) => void) | null): void {
  playlistDropper = fn
}
let playlistDropper: ((playlistId: number, trackId: number) => void) | null = null

function notify(): void {
  for (const l of listeners) l()
}

function notifyTargets(): void {
  for (const l of targetListeners) l()
}

/** True right after a drag ended - suppresses the click that follows pointerup. */
export function consumeDragClick(): boolean {
  const hit = Date.now() - lastDragEnd < 250
  if (hit) lastDragEnd = 0
  return hit
}

interface DragTargets {
  kind: DragKind | null
  targetId: number | null
  insertAt: number | null
  draggedIndex: number | null
}

function readTargets(): DragTargets {
  if (!session || !session.active) {
    return { kind: null, targetId: null, insertAt: null, draggedIndex: null }
  }
  return {
    kind: session.kind,
    targetId: session.targetId,
    insertAt: session.kind === 'favorite' ? (session.insertAt ?? null) : null,
    draggedIndex: session.kind === 'favorite' ? (session.index ?? null) : null,
  }
}

/**
 * Like useDragState but only re-renders when the hovered drop target or
 * insertion point changes - not on every animation frame.
 */
export function useDragTargets(): DragTargets {
  const [state, setState] = useState<DragTargets>(readTargets)
  useEffect(() => {
    const l = () => setState(readTargets())
    targetListeners.add(l)
    return () => {
      targetListeners.delete(l)
    }
  }, [])
  return state
}

export function useDragState(): DragState | null {
  const [state, setState] = useState<DragState | null>(snapshot())
  useEffect(() => {
    const l = () => setState(snapshot())
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return state
}

function snapshot(): DragState | null {
  if (!session) return null
  return {
    kind: session.kind,
    title: session.title,
    coverPath: session.coverPath,
    x: session.x,
    y: session.y,
    rot: session.rot,
    scale: session.scale,
    opacity: session.opacity,
    targetId: session.active ? session.targetId : null,
    draggedIndex: session.kind === 'favorite' ? (session.index ?? null) : null,
    insertAt: session.kind === 'favorite' && session.active ? (session.insertAt ?? null) : null,
  }
}

const GHOST_SIZE = 52
const SPRING = 0.3

function frame(): void {
  const s = session
  if (!s) return
  if (s.active) {
    s.x += (s.tx - s.x) * SPRING
    s.y += (s.ty - s.y) * SPRING
    const vel = s.tx - s.x
    s.rot = Math.max(-14, Math.min(14, vel * 0.09))
    s.scale = 1
    s.opacity = 1
  } else if (s.activated) {
    // settling animation: fly to the target (drop) or back to origin (cancel)
    const done = Math.abs(s.tx - s.x) < 2 && Math.abs(s.ty - s.y) < 2
    s.x += (s.tx - s.x) * 0.22
    s.y += (s.ty - s.y) * 0.22
    s.rot *= 0.8
    s.scale += (0.25 - s.scale) * 0.18
    s.opacity *= 0.82
    if (done || s.opacity < 0.03) {
      session = null
      notify()
      return
    }
  }
  notify()
  raf = requestAnimationFrame(frame)
}

function hitPlaylist(x: number, y: number): { id: number; el: HTMLElement } | null {
  const el = document.elementFromPoint(x, y)
  const target = el?.closest<HTMLElement>('[data-drop-playlist]')
  if (!target) return null
  const id = Number(target.dataset.dropPlaylist)
  if (!Number.isInteger(id) || id <= 0) return null
  return { id, el: target }
}

/**
 * Resolves the favorites row under the cursor. `restrictKind` is what keeps the
 * grouped sidebar honest: indices stay global (they address the one flat order),
 * but a playlist dragged in grouped mode only accepts playlist rows, so it cannot
 * land in the middle of the artists section. Ungrouped mode passes null.
 */
function hitFavIndex(
  x: number,
  y: number,
  restrictKind: FavoriteKind | null,
): { index: number; after: boolean } | null {
  const el = document.elementFromPoint(x, y)
  const target = el?.closest<HTMLElement>('[data-fav-index]')
  if (!target) return null
  if (restrictKind && target.dataset.favKind !== restrictKind) return null
  const index = Number(target.dataset.favIndex)
  if (!Number.isInteger(index) || index < 0) return null
  const r = target.getBoundingClientRect()
  return { index, after: y > r.top + r.height / 2 }
}

function startWatch(s: DragSession): void {
  session = s
  notify()
  notifyTargets()
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(frame)
}

export function beginTrackDrag(opts: {
  e: ReactPointerEvent<HTMLElement>
  title: string
  coverPath: string | null
  trackId: number
  /** allow starting the drag from inside a <button> (home page cards are buttons) */
  allowButtons?: boolean
}): void {
  const { e, title, coverPath, trackId } = opts
  if (!Number.isInteger(trackId) || trackId <= 0) return
  const el = e.currentTarget
  if (!opts.allowButtons && (e.target as HTMLElement).closest('button')) return
  e.preventDefault()
  const rect = el.getBoundingClientRect()
  const s: DragSession = {
    kind: 'track',
    title,
    coverPath,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    ox: rect.left + rect.width / 2,
    oy: rect.top + rect.height / 2,
    x: e.clientX - GHOST_SIZE / 2,
    y: e.clientY - GHOST_SIZE / 2,
    tx: e.clientX - GHOST_SIZE / 2,
    ty: e.clientY - GHOST_SIZE / 2,
    rot: 0,
    scale: 1,
    opacity: 0,
    active: false,
    activated: false,
    targetId: null,
    trackId,
    onTrackDrop: (playlistId, tid) => playlistDropper?.(playlistId, tid),
  }
  const THRESHOLD = 5
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== s.pointerId) return
    const dx = ev.clientX - s.startX
    const dy = ev.clientY - s.startY
    if (!s.active) {
      if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return
      s.active = true
      s.activated = true
    }
    s.tx = ev.clientX - GHOST_SIZE / 2
    s.ty = ev.clientY - GHOST_SIZE / 2
    const hit = hitPlaylist(ev.clientX, ev.clientY)
    const changed = (hit?.id ?? null) !== s.targetId
    s.targetId = hit?.id ?? null
    if (changed) notifyTargets()
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== s.pointerId) return
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    if (!s.active) {
      session = null
      notify()
      notifyTargets()
      return
    }
    lastDragEnd = Date.now()
    const hit = hitPlaylist(ev.clientX, ev.clientY)
    if (hit) {
      // suction: fly into the target row and shrink away
      const r = hit.el.getBoundingClientRect()
      s.tx = r.left + r.width / 2 - GHOST_SIZE / 2
      s.ty = r.top + r.height / 2 - GHOST_SIZE / 2
      s.active = false
      s.onTrackDrop?.(hit.id, s.trackId ?? 0)
    } else {
      s.tx = s.ox - GHOST_SIZE / 2
      s.ty = s.oy - GHOST_SIZE / 2
      s.active = false
    }
    notifyTargets()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  startWatch(s)
}

export function beginFavoriteReorder(opts: {
  e: ReactPointerEvent<HTMLElement>
  index: number
  coverPath: string | null
  /** null in the ungrouped sidebar: everything reorders against everything */
  restrictKind?: FavoriteKind | null
  onDrop: (from: number, to: number) => void
}): void {
  const { e, index, coverPath, onDrop } = opts
  const restrictKind = opts.restrictKind ?? null
  if ((e.target as HTMLElement).closest('button')) return
  e.preventDefault()
  const el = e.currentTarget
  const rect = el.getBoundingClientRect()
  const coverEl = el.querySelector<HTMLElement>('.fav-cover')
  const coverRect = coverEl?.getBoundingClientRect()
  const ghostW = coverRect?.width ?? GHOST_SIZE
  const ghostH = coverRect?.height ?? GHOST_SIZE
  const s: DragSession = {
    kind: 'favorite',
    title: el.title || el.textContent || '',
    coverPath,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    ox: coverRect ? coverRect.left + coverRect.width / 2 : rect.left + 16,
    oy: coverRect ? coverRect.top + coverRect.height / 2 : rect.top + rect.height / 2,
    x: e.clientX - ghostW / 2,
    y: e.clientY - ghostH / 2,
    tx: e.clientX - ghostW / 2,
    ty: e.clientY - ghostH / 2,
    rot: 0,
    scale: 1,
    opacity: 0,
    active: false,
    activated: false,
    targetId: null,
    index,
    insertAt: null,
    restrictKind,
    onFavoriteDrop: onDrop,
  }
  const THRESHOLD = 5
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== s.pointerId) return
    const dx = ev.clientX - s.startX
    const dy = ev.clientY - s.startY
    if (!s.active) {
      if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return
      s.active = true
      s.activated = true
      el.classList.add('is-dragged')
    }
    s.tx = ev.clientX - ghostW / 2
    s.ty = ev.clientY - ghostH / 2
    const hit = hitFavIndex(ev.clientX, ev.clientY, restrictKind)
    const insert = hit ? (hit.after ? hit.index + 1 : hit.index) : null
    if (insert !== s.insertAt) {
      s.insertAt = insert
      notifyTargets()
    }
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== s.pointerId) return
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    el.classList.remove('is-dragged')
    if (!s.active) {
      session = null
      notify()
      notifyTargets()
      return
    }
    lastDragEnd = Date.now()
    const from = s.index ?? 0
    const to = s.insertAt ?? null
    s.tx = s.ox - ghostW / 2
    s.ty = s.oy - ghostH / 2
    s.active = false
    if (to !== null) {
      let t: number = to
      if (from < t) t -= 1
      if (t !== from) s.onFavoriteDrop?.(from, t)
    }
    notifyTargets()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  startWatch(s)
}

/** Floating cover that follows the cursor; render once at the app root. */
export default function TrackDragLayer() {
  const state = useDragState()
  if (!state) return null
  return (
    <div
      className={'dnd-ghost' + (state.kind === 'favorite' ? ' dnd-ghost-sm' : '')}
      style={{
        transform: `translate(${state.x}px, ${state.y}px) rotate(${state.rot}deg) scale(${state.scale})`,
        opacity: state.opacity,
      }}
    >
      <Cover path={state.coverPath} label={state.title} size={GHOST_SIZE} />
    </div>
  )
}

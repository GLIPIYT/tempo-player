import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'

interface Drag {
  key: string
  pointerId: number
  button: HTMLElement
  keys: string[]
  nodes: HTMLElement[]
  slots: number[]
  scale: number
  startX: number
  startY: number
  x: number
  y: number
  scroll: number
  from: number
  to: number
  started: boolean
  frame: number
  time: number
}

/** Keep DOM order stable during capture; only commit the new order on release. */
export function useMixReorder(keys: string[], onReorder: (keys: string[]) => void, reducedMotion: boolean) {
  const railRef = useRef<HTMLDivElement>(null)
  const slotRef = useRef<HTMLSpanElement>(null)
  const session = useRef<Drag | null>(null)
  const suppressClick = useRef<string | null>(null)
  const settle = useRef<Map<string, DOMRect> | null>(null)
  const latest = useRef({ keys, onReorder, reducedMotion })
  latest.current = { keys, onReorder, reducedMotion }
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const keySignature = JSON.stringify(keys)

  const measure = () => new Map(Array.from(railRef.current?.querySelectorAll<HTMLElement>('[data-mix-key]') ?? [])
    .map(node => [node.dataset.mixKey!, node.getBoundingClientRect()]))

  const finish = (commit: boolean) => {
    const drag = session.current
    if (!drag) return
    session.current = null
    cancelAnimationFrame(drag.frame)
    if (drag.started) settle.current = measure()
    for (const node of drag.nodes) node.style.removeProperty('transform')
    if (slotRef.current) slotRef.current.style.removeProperty('opacity')
    setDraggingKey(null)
    if (drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId)
    if (commit && drag.started && drag.from !== drag.to) {
      const next = [...drag.keys]
      next.splice(drag.to, 0, next.splice(drag.from, 1)[0])
      latest.current.onReorder(next)
    }
  }

  // Capture each final position before painting, including when a drag is cancelled.
  useLayoutEffect(() => {
    const before = settle.current
    if (!before) return
    settle.current = null
    const rail = railRef.current
    if (!rail || latest.current.reducedMotion) return
    const scale = rail.getBoundingClientRect().width / rail.offsetWidth || 1
    for (const node of rail.querySelectorAll<HTMLElement>('[data-mix-key]')) {
      const old = before.get(node.dataset.mixKey!)
      if (!old) continue
      const dx = (old.left - node.getBoundingClientRect().left) / scale
      if (Math.abs(dx) > 0.5) node.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], {
        duration: 190, easing: 'cubic-bezier(.2,.8,.2,1)',
      })
    }
  }, [keySignature, draggingKey])

  useEffect(() => () => {
    const drag = session.current
    if (drag) {
      cancelAnimationFrame(drag.frame)
      for (const node of drag.nodes) node.style.removeProperty('transform')
      if (drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId)
    }
  }, [])

  const tick = (time: number) => {
    const drag = session.current
    const rail = railRef.current
    if (!drag?.started || !rail) return
    if (JSON.stringify(drag.keys) !== JSON.stringify(latest.current.keys)) {
      finish(false)
      return
    }
    const rect = rail.getBoundingClientRect()
    const elapsed = Math.min(32, time - drag.time)
    drag.time = time
    if (drag.y >= rect.top && drag.y <= rect.bottom) {
      const edge = Math.min(54 * drag.scale, rect.width / 4)
      const proximity = drag.x < rect.left + edge ? -Math.min(1, (rect.left + edge - drag.x) / edge)
        : drag.x > rect.right - edge ? Math.min(1, (drag.x - rect.right + edge) / edge) : 0
      rail.scrollLeft += proximity * elapsed * .7
    }
    const dx = Math.max(drag.slots[0] - drag.slots[drag.from], Math.min(
      drag.slots.at(-1)! - drag.slots[drag.from],
      (drag.x - drag.startX) / drag.scale + rail.scrollLeft - drag.scroll,
    ))
    const center = drag.slots[drag.from] + dx + drag.button.offsetWidth / 2
    drag.to = drag.slots.reduce((best, slot, i) => Math.abs(slot + drag.nodes[i].offsetWidth / 2 - center)
      < Math.abs(drag.slots[best] + drag.nodes[best].offsetWidth / 2 - center) ? i : best, 0)
    const order = [...drag.keys]
    order.splice(drag.to, 0, order.splice(drag.from, 1)[0])
    drag.nodes.forEach((node, index) => {
      const shift = node === drag.button ? dx : drag.slots[order.indexOf(drag.keys[index])] - drag.slots[index]
      node.style.transform = `translate3d(${shift}px,0,0)`
    })
    if (slotRef.current) {
      slotRef.current.style.left = `${drag.slots[drag.to]}px`
      slotRef.current.style.opacity = '1'
    }
    drag.frame = requestAnimationFrame(tick)
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, key: string) => {
    if (event.button !== 0 || !event.isPrimary || event.altKey || event.ctrlKey || event.metaKey) return
    finish(false)
    suppressClick.current = null
    const rail = railRef.current
    if (!rail) return
    const nodes = Array.from(rail.querySelectorAll<HTMLElement>('[data-mix-key]'))
    const rect = rail.getBoundingClientRect()
    const scale = rect.width / rail.offsetWidth || 1
    const button = event.currentTarget
    const slots = nodes.map(node => (node.getBoundingClientRect().left - rect.left) / scale + rail.scrollLeft)
    const from = keys.indexOf(key)
    button.setPointerCapture(event.pointerId)
    session.current = {
      key, pointerId: event.pointerId, button, keys: [...keys], nodes, slots, scale,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      scroll: rail.scrollLeft, from, to: from, started: false, frame: 0, time: performance.now(),
    }
    if (slotRef.current) {
      Object.assign(slotRef.current.style, {
        top: `${(button.getBoundingClientRect().top - rect.top) / scale}px`,
        width: `${button.offsetWidth}px`, height: `${button.offsetHeight}px`, left: `${slots[from]}px`,
      })
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    const drag = session.current
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.x = event.clientX
    drag.y = event.clientY
    if (!drag.started) {
      if (Math.abs(drag.x - drag.startX) < 6 || Math.abs(drag.x - drag.startX) < Math.abs(drag.y - drag.startY)) return
      drag.started = true
      suppressClick.current = drag.key
      setDraggingKey(drag.key)
      drag.frame = requestAnimationFrame(tick)
    }
    event.preventDefault()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && session.current) {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
      return
    }
    if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-mix-key]')?.dataset.mixKey
    if (!key) return
    event.preventDefault()
    event.stopPropagation()
    const from = keys.indexOf(key)
    const to = Math.min(keys.length - 1, Math.max(0, from + (event.key === 'ArrowLeft' ? -1 : 1)))
    if (from === to) return
    settle.current = measure()
    const next = [...keys]
    next.splice(to, 0, next.splice(from, 1)[0])
    onReorder(next)
  }

  return {
    railRef, slotRef, draggingKey, onPointerDown,
    railHandlers: {
      onPointerMove,
      onPointerUp: () => {
        if (session.current?.started) {
          cancelAnimationFrame(session.current.frame)
          tick(performance.now())
        }
        finish(true)
      },
      onPointerCancel: () => finish(false),
      onLostPointerCapture: () => finish(false),
      onKeyDown,
      onClickCapture: (event: MouseEvent) => {
        if (!suppressClick.current) return
        const key = (event.target as HTMLElement).closest<HTMLElement>('[data-mix-key]')?.dataset.mixKey
        if (key === suppressClick.current) {
          event.preventDefault()
          event.stopPropagation()
        }
        suppressClick.current = null
      },
    },
  }
}

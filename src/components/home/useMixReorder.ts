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
  y: number
  scrollTop: number
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
    if (slotRef.current) {
      for (const property of ['opacity', 'top', 'left', 'width', 'height']) slotRef.current.style.removeProperty(property)
    }
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
    const scale = rail.getBoundingClientRect().height / rail.offsetHeight || 1
    for (const node of rail.querySelectorAll<HTMLElement>('[data-mix-key]')) {
      const old = before.get(node.dataset.mixKey!)
      if (!old) continue
      const dy = (old.top - node.getBoundingClientRect().top) / scale
      if (Math.abs(dy) > 0.5) node.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
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
      const edge = Math.max(1, Math.min(54 * drag.scale, rect.height / 4))
      const proximity = drag.y < rect.top + edge ? -Math.min(1, (rect.top + edge - drag.y) / edge)
        : drag.y > rect.bottom - edge ? Math.min(1, (drag.y - rect.bottom + edge) / edge) : 0
      rail.scrollTop += proximity * elapsed * .7
    }
    const dy = Math.max(drag.slots[0] - drag.slots[drag.from], Math.min(
      drag.slots.at(-1)! - drag.slots[drag.from],
      (drag.y - drag.startY) / drag.scale + rail.scrollTop - drag.scrollTop,
    ))
    const center = drag.slots[drag.from] + dy + drag.button.offsetHeight / 2
    drag.to = drag.slots.reduce((best, slot, i) => Math.abs(slot + drag.nodes[i].offsetHeight / 2 - center)
      < Math.abs(drag.slots[best] + drag.nodes[best].offsetHeight / 2 - center) ? i : best, 0)
    const order = [...drag.keys]
    order.splice(drag.to, 0, order.splice(drag.from, 1)[0])
    drag.nodes.forEach((node, index) => {
      const shift = node === drag.button ? dy : drag.slots[order.indexOf(drag.keys[index])] - drag.slots[index]
      node.style.transform = `translate3d(0,${shift}px,0)`
    })
    if (slotRef.current) {
      slotRef.current.style.top = `${drag.slots[drag.to]}px`
      slotRef.current.style.opacity = '1'
    }
    drag.frame = requestAnimationFrame(tick)
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, key: string) => {
    if (event.pointerType === 'touch') return
    if (event.button !== 0 || !event.isPrimary || event.altKey || event.ctrlKey || event.metaKey) return
    finish(false)
    suppressClick.current = null
    const rail = railRef.current
    if (!rail) return
    const nodes = Array.from(rail.querySelectorAll<HTMLElement>('[data-mix-key]'))
    const rect = rail.getBoundingClientRect()
    const scale = rect.height / rail.offsetHeight || 1
    const button = event.currentTarget
    const from = keys.indexOf(key)
    if (from < 0 || !nodes[from]) return
    const slots = nodes.map(node => (node.getBoundingClientRect().top - rect.top) / scale + rail.scrollTop)
    button.setPointerCapture(event.pointerId)
    session.current = {
      key, pointerId: event.pointerId, button, keys: [...keys], nodes, slots, scale,
      startX: event.clientX, startY: event.clientY, y: event.clientY,
      scrollTop: rail.scrollTop, from, to: from, started: false, frame: 0, time: performance.now(),
    }
    if (slotRef.current) {
      Object.assign(slotRef.current.style, {
        top: `${(button.getBoundingClientRect().top - rect.top) / scale}px`,
        width: `${button.offsetWidth}px`, height: `${button.offsetHeight}px`,
      })
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    const drag = session.current
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.y = event.clientY
    if (!drag.started) {
      const deltaX = Math.abs(event.clientX - drag.startX)
      const deltaY = Math.abs(drag.y - drag.startY)
      if (deltaY < 6 || deltaY <= deltaX) return
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
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-mix-key]')?.dataset.mixKey
    if (!key) return
    event.preventDefault()
    event.stopPropagation()
    const from = keys.indexOf(key)
    if (from < 0) return
    const to = Math.min(keys.length - 1, Math.max(0, from + (event.key === 'ArrowUp' ? -1 : 1)))
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
      onPointerUp: (event: PointerEvent) => {
        if (session.current?.pointerId !== event.pointerId) return
        if (session.current?.started) {
          cancelAnimationFrame(session.current.frame)
          tick(performance.now())
        }
        finish(true)
      },
      onPointerCancel: (event: PointerEvent) => {
        if (session.current?.pointerId === event.pointerId) finish(false)
      },
      onLostPointerCapture: (event: PointerEvent) => {
        if (session.current?.pointerId === event.pointerId) finish(false)
      },
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

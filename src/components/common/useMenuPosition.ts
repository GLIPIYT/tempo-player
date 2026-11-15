import { useLayoutEffect, type RefObject } from 'react'

export type MenuPoint = { x: number; y: number; align?: 'right' }

export function useMenuPosition(ref: RefObject<HTMLElement | null>, point: MenuPoint | null) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !point) return
    const place = () => {
      const gap = 8
      const width = element.offsetWidth
      const height = element.offsetHeight
      const x = point.align === 'right' ? point.x - width : point.x
      const left = Math.max(gap, Math.min(x, window.innerWidth - width - gap))
      const top = Math.max(gap, Math.min(point.y, window.innerHeight - height - gap))
      element.style.left = `${left}px`
      element.style.top = `${top}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [ref, point])
}

import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

const DEFAULT_CARD_SIZE = 120
export const HOME_RAIL_GAP = 12
const OVERSCAN = 2

export function useHomeRailCardSize(page: RefObject<HTMLDivElement>) {
  const [size, setSize] = useState(DEFAULT_CARD_SIZE)
  useLayoutEffect(() => {
    const element = page.current
    if (!element) return
    const measure = () => {
      const width = element.clientWidth
      setSize(width >= 1820 ? 168 : width >= 1300 ? 144 : width < 800 ? 104 : DEFAULT_CARD_SIZE)
    }
    const observer = new ResizeObserver(measure)
    measure()
    observer.observe(element)
    return () => observer.disconnect()
  }, [page])
  return size
}

export function scrollHomeRail(rail: HTMLDivElement | null, direction: number, step: number) {
  if (!rail) return
  const cards = Math.max(1, Math.floor(rail.clientWidth / step) - 1)
  rail.scrollBy({
    left: direction * cards * step,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  })
}

export function onHomeRailKeyDown(event: KeyboardEvent<HTMLDivElement>, step: number) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const rail = event.currentTarget
  switch (event.key) {
    case 'ArrowLeft': case 'ArrowRight':
      scrollHomeRail(rail, event.key === 'ArrowLeft' ? -1 : 1, step)
      break
    case 'Home': case 'End':
      rail.scrollTo({ left: event.key === 'Home' ? 0 : rail.scrollWidth })
      break
    default:
      return
  }
  rail.focus({ preventScroll: true })
  event.preventDefault()
  event.stopPropagation()
}

export function useRecommendationRail(count: number, step: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 0, canScrollLeft: false, canScrollRight: false })
  const [nearViewport, setNearViewport] = useState(false)
  const hasTracks = count > 0

  const measure = useCallback(() => {
    const rail = ref.current
    if (!rail) return
    const { scrollLeft, clientWidth, scrollWidth } = rail
    const start = Math.min(count, Math.max(0, Math.floor(scrollLeft / step) - OVERSCAN))
    const end = Math.min(count, Math.max(start, Math.ceil((scrollLeft + clientWidth) / step) + OVERSCAN))
    const canScrollLeft = scrollLeft > 1
    const canScrollRight = scrollLeft + clientWidth < scrollWidth - 1
    setRange(current => current.start === start && current.end === end
      && current.canScrollLeft === canScrollLeft && current.canScrollRight === canScrollRight
      ? current : { start, end, canScrollLeft, canScrollRight })
  }, [count, step])

  useLayoutEffect(() => {
    const rail = ref.current
    if (!hasTracks || !rail) return
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(rail)
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    rail.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      rail.removeEventListener('scroll', onScroll)
      resize.disconnect()
    }
  }, [hasTracks, measure])

  useLayoutEffect(() => {
    const rail = ref.current
    if (!hasTracks || !rail) return
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => setNearViewport(entry.isIntersecting), {
      rootMargin: '160px 0px',
    })
    observer.observe(rail)
    return () => observer.disconnect()
  }, [hasTracks])

  return {
    ref,
    measure,
    start: nearViewport ? range.start : 0,
    end: nearViewport ? range.end : 0,
    canScrollLeft: range.canScrollLeft,
    canScrollRight: range.canScrollRight,
  }
}

import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'

export const HOME_RAIL_CARD_SIZE = 88
export const HOME_RAIL_GAP = 10
export const HOME_RAIL_STEP = HOME_RAIL_CARD_SIZE + HOME_RAIL_GAP
const OVERSCAN = 2

export const homeRailLayout = {
  '--home-rail-card-size': `${HOME_RAIL_CARD_SIZE}px`,
  '--home-rail-gap': `${HOME_RAIL_GAP}px`,
} as CSSProperties

export function scrollHomeRail(rail: HTMLDivElement | null, direction: number) {
  if (!rail) return
  const cards = Math.max(1, Math.floor(rail.clientWidth / HOME_RAIL_STEP) - 1)
  rail.scrollBy({
    left: direction * cards * HOME_RAIL_STEP,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  })
}

export function onHomeRailKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const rail = event.currentTarget
  switch (event.key) {
    case 'ArrowLeft': case 'ArrowRight':
      scrollHomeRail(rail, event.key === 'ArrowLeft' ? -1 : 1)
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

export function useRecommendationRail(count: number, step = HOME_RAIL_STEP) {
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

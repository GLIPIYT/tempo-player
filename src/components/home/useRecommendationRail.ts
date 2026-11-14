import { useCallback, useLayoutEffect, useRef, useState } from 'react'

export const RECOMMENDATION_CARD_SIZE = 118
export const RECOMMENDATION_CARD_STEP = RECOMMENDATION_CARD_SIZE + 12
const OVERSCAN = 2

export function useRecommendationRail(count: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 0 })
  const [nearViewport, setNearViewport] = useState(false)

  const measure = useCallback(() => {
    const rail = ref.current
    if (!rail) return
    const start = Math.min(count, Math.max(0, Math.floor(rail.scrollLeft / RECOMMENDATION_CARD_STEP) - OVERSCAN))
    const end = Math.min(count, Math.max(start, Math.ceil((rail.scrollLeft + rail.clientWidth) / RECOMMENDATION_CARD_STEP) + OVERSCAN))
    setRange(current => current.start === start && current.end === end ? current : { start, end })
  }, [count])

  useLayoutEffect(() => {
    const rail = ref.current
    if (!rail) return
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
  }, [measure])

  const hasTracks = count > 0
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

  return { ref, measure, start: nearViewport ? range.start : 0, end: nearViewport ? range.end : 0 }
}

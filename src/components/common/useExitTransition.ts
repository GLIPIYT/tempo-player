import { useCallback, useEffect, useRef, useState } from 'react'

/** Keep a modal mounted until its short exit animation has finished. */
export function useExitTransition(onClose: () => void, duration = 140) {
  const [closing, setClosing] = useState(false)
  const pending = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

  const close = useCallback((action?: () => void) => {
    if (pending.current) return
    pending.current = true
    setClosing(true)
    const finish = action ?? (() => closeRef.current())
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion) finish()
    else timer.current = setTimeout(finish, duration)
  }, [duration])

  return { closing, close }
}

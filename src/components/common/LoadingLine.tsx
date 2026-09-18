import { useEffect, useState } from 'react'

/**
 * A status line that changes while it waits.
 *
 * A search takes a few seconds, and a single unchanging sentence for that long
 * reads as though nothing is happening. Cycling says the same thing more
 * honestly - that it is still going - and each line fades in so the change is
 * noticed rather than flickering.
 */
export default function LoadingLine({
  lines,
  intervalMs = 2200,
}: {
  lines: string[]
  intervalMs?: number
}) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (lines.length < 2) return
    const id = window.setInterval(() => setIndex((i) => (i + 1) % lines.length), intervalMs)
    return () => window.clearInterval(id)
  }, [lines.length, intervalMs])

  return (
    <div className="muted sc-status">
      {/* The key is what replays the animation: React remounts the span when
          the line changes, so the fade runs again on every step. */}
      <span key={index} className="loading-line">
        {lines[index]}
      </span>
    </div>
  )
}

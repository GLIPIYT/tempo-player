/** Sample the player clock at display cadence without changing its audio state. */
export function startDisplayPositionLoop(
  read: () => number,
  publish: (position: number) => void,
  request: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
): () => void {
  let frame = 0
  let stopped = false
  const tick = () => {
    if (stopped) return
    publish(read())
    frame = request(tick)
  }
  tick()
  return () => {
    stopped = true
    cancel(frame)
  }
}

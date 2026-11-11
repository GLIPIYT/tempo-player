export interface VisibilitySource {
  hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface FrameScheduler {
  request(callback: FrameRequestCallback): number
  cancel(id: number): void
}

/** Run an animation callback at display cadence only while its document is visible. */
export function startVisibleFrameLoop(update: () => void, target: VisibilitySource = document,
  scheduler: FrameScheduler = { request: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id) }): () => void {
  let frame: number | null = null
  let disposed = false
  const cancelFrame = () => {
    if (frame === null) return
    scheduler.cancel(frame)
    frame = null
  }
  const schedule = () => {
    if (disposed || target.hidden || frame !== null) return
    frame = scheduler.request(() => {
      frame = null
      if (disposed || target.hidden) return
      update()
      schedule()
    })
  }
  const onVisibilityChange = () => {
    if (target.hidden) cancelFrame()
    else schedule()
  }
  target.addEventListener('visibilitychange', onVisibilityChange)
  schedule()
  return () => {
    disposed = true
    cancelFrame()
    target.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

let tail: Promise<unknown> = Promise.resolve()

/** Never race an uncancellable decoder with abort: retain ownership until it settles. */
export function withAnalysisLane<T>(signal: AbortSignal, job: () => Promise<T>): Promise<T> {
  const result = tail.then(async () => {
    signal.throwIfAborted()
    const value = await job()
    signal.throwIfAborted()
    return value
  })
  tail = result.catch(() => {})
  return result
}

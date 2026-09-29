import { expect, it } from 'vitest'
import { withAnalysisLane } from './analysisLane'

it('holds the lane until an uncancellable aborted decode settles and discards its value', async () => {
  const controller = new AbortController()
  let finish!: (value: number) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const first = withAnalysisLane(controller.signal, () => { entered(); return new Promise<number>((r) => { finish = r }) })
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  await started
  controller.abort()
  let secondEntered = false
  const second = withAnalysisLane(new AbortController().signal, async () => { secondEntered = true; return 2 })
  await Promise.resolve()
  const overlapped = secondEntered
  finish(1)
  await rejected
  expect(overlapped).toBe(false)
  expect(await second).toBe(2)
})

it('skips an aborted queued job and recovers after a job rejects', async () => {
  const controller = new AbortController(); controller.abort()
  let entered = false
  await expect(withAnalysisLane(controller.signal, async () => { entered = true })).rejects.toMatchObject({ name: 'AbortError' })
  expect(entered).toBe(false)
  await expect(withAnalysisLane(new AbortController().signal, async () => { throw new Error('decode') })).rejects.toThrow('decode')
  expect(await withAnalysisLane(new AbortController().signal, async () => 7)).toBe(7)
})

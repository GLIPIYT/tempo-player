import { expect, it } from 'vitest'
import { AsrWorkerClient, type WorkerPort } from './workerClient'
import type { AsrRequest, AsrResponse } from './workerProtocol'
function port() {
  const sent: AsrRequest[] = []; let terminated = false
  const worker: WorkerPort = { onmessage: null, onerror: null, postMessage: (message) => sent.push(message), terminate: () => { terminated = true } }
  return { worker, sent, terminated: () => terminated, reply: (data: AsrResponse) => worker.onmessage?.({ data } as MessageEvent<AsrResponse>) }
}
it('ignores old job and wrong fragment responses then resolves the matching result', async () => {
  const fake = port(); const client = new AsrWorkerClient(fake.worker)
  let settled = false
  const pending = client.request({ type: 'transcribe', jobId: 4, fragmentId: 'a', trackStartSec: 0, sampleRate: 16000, pcm: new Float32Array(100), language: 'en' }, new AbortController().signal).then(value => { settled = true; return value })
  fake.reply({ type: 'result', jobId: 3, fragmentId: 'a', words: [], elapsedMs: 1 })
  fake.reply({ type: 'result', jobId: 4, fragmentId: 'old', words: [], elapsedMs: 1 })
  await Promise.resolve(); expect(settled).toBe(false)
  fake.reply({ type: 'result', jobId: 4, fragmentId: 'a', words: [], elapsedMs: 2 })
  expect(await pending).toMatchObject({ elapsedMs: 2 })
})
it('terminates and rejects pending inference on abort; disposal is idempotent', async () => {
  const fake = port(); const client = new AsrWorkerClient(fake.worker); const abort = new AbortController()
  const pending = client.request({ type: 'transcribe', jobId: 1, fragmentId: 'a', trackStartSec: 0, sampleRate: 16000, pcm: new Float32Array(100), language: 'en' }, abort.signal)
  abort.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(fake.terminated()).toBe(true)
  client.dispose()
})

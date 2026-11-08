import { describe, expect, it, vi } from 'vitest'
import { VocalWorkerClient } from './vocalWorkerClient'
import type { VocalRequest, VocalResponse } from './vocalContract'

type WorkerPort = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>

function makePort() {
  return {
    onmessage: null as Worker['onmessage'],
    onerror: null as Worker['onerror'],
    postMessage: vi.fn<(message: unknown, options?: Transferable[] | StructuredSerializeOptions) => void>(),
    terminate: vi.fn<Worker['terminate']>(),
  }
}

function deliver(port: WorkerPort, data: VocalResponse): void {
  port.onmessage?.call(port as Worker, { data } as MessageEvent<VocalResponse>)
}

const chunk = { startSec: 20, endSec: 40, voice: [128], energy: [100], flux: [24] }

describe('VocalWorkerClient', () => {
  it('resolves only a response correlated to both the job and chunk', async () => {
    const port = makePort()
    const client = new VocalWorkerClient(port)
    const pcm = new Float32Array(28 * 16000)
    const request: VocalRequest = { type: 'analyze', jobId: 7, chunkId: '20:40',
      windowStartSec: 16, startSec: 20, endSec: 40, pcm }
    const signal = new AbortController().signal
    let settled = false
    const pending = client.request(request, signal).then(value => { settled = true; return value })

    expect(port.postMessage).toHaveBeenCalledWith(request, [pcm.buffer])
    await expect(client.request({ type: 'init', jobId: 8, modelBaseUrl: '/model/', wasmBaseUrl: '/wasm/' }, signal))
      .rejects.toThrow('unavailable')

    deliver(port, { type: 'result', jobId: 8, chunkId: request.chunkId, chunk, elapsedMs: 3 })
    deliver(port, { type: 'result', jobId: 7, chunkId: '0:20', chunk, elapsedMs: 3 })
    deliver(port, { type: 'ready', jobId: 7 })
    await Promise.resolve()
    expect(settled).toBe(false)

    const result: VocalResponse = { type: 'result', jobId: 7, chunkId: request.chunkId, chunk, elapsedMs: 3 }
    deliver(port, result)
    await expect(pending).resolves.toBe(result)
    expect(port.onmessage).toBeNull()
    expect(port.onerror).toBeNull()
    expect(port.terminate).not.toHaveBeenCalled()
  })

  it('ignores an analyze result during init and resolves the matching ready response', async () => {
    const port = makePort()
    const client = new VocalWorkerClient(port)
    const request: VocalRequest = { type: 'init', jobId: 12, modelBaseUrl: '/model/', wasmBaseUrl: '/wasm/' }
    const pending = client.request(request, new AbortController().signal)

    deliver(port, { type: 'result', jobId: 12, chunkId: 'wrong-phase', chunk, elapsedMs: 1 })
    deliver(port, { type: 'ready', jobId: 11 })
    const ready: VocalResponse = { type: 'ready', jobId: 12 }
    deliver(port, ready)

    await expect(pending).resolves.toBe(ready)
    expect(port.postMessage).toHaveBeenCalledWith(request, [])
  })

  it('terminates and rejects a pending request with the abort reason', async () => {
    const port = makePort()
    const client = new VocalWorkerClient(port)
    const controller = new AbortController()
    const reason = new Error('track changed')
    const request: VocalRequest = { type: 'init', jobId: 1, modelBaseUrl: '/model/', wasmBaseUrl: '/wasm/' }
    const pending = client.request(request, controller.signal)

    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(port.terminate).toHaveBeenCalledTimes(1)
    expect(port.onmessage).toBeNull()
    expect(port.onerror).toBeNull()
    await expect(client.request(request, new AbortController().signal)).rejects.toThrow('unavailable')
  })

  it('rejects an already aborted signal without posting a message', async () => {
    const port = makePort()
    const client = new VocalWorkerClient(port)
    const controller = new AbortController()
    const reason = new Error('cancelled before dispatch')
    controller.abort(reason)

    await expect(client.request({ type: 'init', jobId: 1, modelBaseUrl: '/model/', wasmBaseUrl: '/wasm/' }, controller.signal))
      .rejects.toBe(reason)
    expect(port.postMessage).not.toHaveBeenCalled()
    expect(port.terminate).not.toHaveBeenCalled()
  })
})

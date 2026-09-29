import type { AsrRequest, AsrResponse } from './workerProtocol'
export interface WorkerPort {
  onmessage: ((event: MessageEvent<AsrResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: AsrRequest, transfer?: Transferable[]): void
  terminate(): void
}
export class AsrWorkerClient {
  private rejectPending: ((reason: unknown) => void) | null = null
  private dead = false
  constructor(private port: WorkerPort) {}
  request(message: AsrRequest, signal: AbortSignal): Promise<AsrResponse> {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (this.dead || this.rejectPending) return Promise.reject(new Error('Worker unavailable or busy'))
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { signal.removeEventListener('abort', cancel); clearTimeout(timeout); this.rejectPending = null; this.port.onmessage = null; this.port.onerror = null }
      const fail = (reason: unknown): void => { cleanup(); reject(reason) }
      const cancel = (): void => this.dispose(signal.reason)
      const timeout = setTimeout(() => this.dispose(new Error('Local recognition timed out')), 120000)
      this.rejectPending = fail
      signal.addEventListener('abort', cancel, { once: true })
      this.port.onerror = (event) => this.dispose(new Error(event.message || 'Local recognition worker failed'))
      this.port.onmessage = ({ data }) => {
        if (data.jobId !== message.jobId) return
        if (message.type === 'transcribe' && (data.type === 'ready' || data.fragmentId !== message.fragmentId)) return
        if (message.type === 'init' && data.type === 'result') return
        if (data.type === 'error') { this.dispose(new Error(data.error)); return }
        cleanup(); resolve(data)
      }
      try { this.port.postMessage(message, message.type === 'transcribe' ? [message.pcm.buffer as ArrayBuffer] : []) }
      catch (error) { this.dispose(error) }
    })
  }
  dispose(reason: unknown = new DOMException('Analysis cancelled', 'AbortError')): void {
    if (this.dead) return
    this.dead = true
    this.port.terminate()
    this.rejectPending?.(reason)
  }
}

export function createAsrWorker(): AsrWorkerClient {
  return new AsrWorkerClient(new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' }))
}

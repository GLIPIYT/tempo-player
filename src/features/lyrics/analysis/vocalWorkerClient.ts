import type { VocalRequest, VocalResponse } from './vocalContract'

export class VocalWorkerClient {
  private pending: ((reason: unknown) => void) | null = null
  private dead = false
  constructor(private port: Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>) {}
  request(message: VocalRequest, signal: AbortSignal): Promise<VocalResponse> {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (this.dead || this.pending) return Promise.reject(new Error('Vocal analysis worker is unavailable'))
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); this.pending = null; this.port.onmessage = null; this.port.onerror = null }
      const abort = () => this.dispose(signal.reason)
      const timeout = setTimeout(() => this.dispose(new Error('Vocal analysis timed out')), 60000)
      this.pending = reason => { cleanup(); reject(reason) }
      signal.addEventListener('abort', abort, { once: true })
      this.port.onerror = () => this.dispose(new Error('Vocal analysis worker failed'))
      this.port.onmessage = ({ data }: MessageEvent<VocalResponse>) => {
        if (data.jobId !== message.jobId) return
        if (message.type === 'analyze' && (data.type === 'ready' || data.chunkId !== message.chunkId)) return
        if (message.type === 'init' && data.type === 'result') return
        if (data.type === 'error') { this.dispose(new Error(data.error)); return }
        cleanup(); resolve(data)
      }
      try { this.port.postMessage(message, message.type === 'analyze' ? [message.pcm.buffer as ArrayBuffer] : []) }
      catch (error) { this.dispose(error) }
    })
  }
  dispose(reason: unknown = new DOMException('Vocal analysis cancelled', 'AbortError')) {
    if (this.dead) return
    this.dead = true
    this.port.terminate()
    this.pending?.(reason)
  }
}
export const createVocalWorker = () => new VocalWorkerClient(new Worker(new URL('./vocal.worker.ts', import.meta.url), { type: 'module' }))

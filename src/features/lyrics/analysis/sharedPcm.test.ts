import { describe, expect, it, vi } from 'vitest'
import type { AudioIdentity } from './contract'
import { acquireAnalysisPcm } from './sharedPcm'

const identity: AudioIdentity = { fingerprint: 'same-audio', absolutePath: '/track.wav', fileSize: 8,
  durationSec: 10, sampleRate: 16000, channels: 1 }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('shared lyric PCM leases', () => {
  it('decodes once for concurrent users and releases the shared buffer after the last lease', async () => {
    const pcm = { pcm: new Float32Array([1, 2]), sampleRate: 16000 as const, durationSec: 1 }
    const decodeResult = deferred<typeof pcm | null>()
    const afterReleaseResult = deferred<null>()
    const decode = vi.fn().mockReturnValueOnce(decodeResult.promise).mockReturnValueOnce(afterReleaseResult.promise)
    const first = acquireAnalysisPcm(identity, new AbortController().signal, decode)
    const second = acquireAnalysisPcm(identity, new AbortController().signal, decode)
    await Promise.resolve()
    expect(decode).toHaveBeenCalledTimes(1)

    decodeResult.resolve(pcm)
    const [a, b] = await Promise.all([first, second])
    expect(a?.pcm).toBe(pcm)
    expect(b?.pcm).toBe(pcm)

    a?.release()
    const third = acquireAnalysisPcm(identity, new AbortController().signal, decode)
    await Promise.resolve()
    expect(decode).toHaveBeenCalledTimes(1)
    const c = await third
    b?.release()
    c?.release()

    const afterRelease = acquireAnalysisPcm(identity, new AbortController().signal, decode)
    await Promise.resolve()
    expect(decode).toHaveBeenCalledTimes(2)
    afterReleaseResult.resolve(null)
    expect(await afterRelease).toBeNull()
  })

  it('only cancels the shared decode after its final waiter leaves', async () => {
    const decodeResult = deferred<null>()
    let decodeSignal: AbortSignal | undefined
    const decode = vi.fn((_audio: AudioIdentity, signal: AbortSignal) => {
      decodeSignal = signal
      return decodeResult.promise
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = acquireAnalysisPcm(identity, firstController.signal, decode)
    const second = acquireAnalysisPcm(identity, secondController.signal, decode)
    await Promise.resolve()

    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(decodeSignal?.aborted).toBe(false)

    secondController.abort()
    expect(decodeSignal?.aborted).toBe(true)
    decodeResult.resolve(null)
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
  })
})

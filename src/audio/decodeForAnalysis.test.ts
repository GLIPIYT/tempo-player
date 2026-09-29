import { expect, it, vi } from 'vitest'
import { decodeForAnalysis, type DecodeDependencies } from './decodeForAnalysis'
import type { AudioIdentity } from '../features/lyrics/analysis/contract'

const identity: AudioIdentity = { fingerprint: 'a', absolutePath: 'a.wav', fileSize: 4000, durationSec: 1, sampleRate: 48000, channels: 2 }
function setup() {
  const close = vi.fn(async () => {})
  const decoded = { duration: 1, sampleRate: 48000, length: 48000, numberOfChannels: 2,
    getChannelData: (channel: number) => new Float32Array(48000).fill(channel ? 0.5 : 0.25) } as AudioBuffer
  const decode = vi.fn(async () => decoded)
  const deps: DecodeDependencies = { fetch: vi.fn(async () => new Response(new Uint8Array(4000))), url: (path) => path,
    context: () => ({ decodeAudioData: decode, close }) }
  return { deps, close, decode }
}
it('rejects oversized and unknown metadata before fetch or decode', async () => {
  const { deps, decode } = setup()
  for (const changed of [{ fileSize: 67108865 }, { durationSec: 601 }, { sampleRate: null }, { channels: null },
    { durationSec: 600, sampleRate: 192000, channels: 8 }]) {
    expect(await decodeForAnalysis({ ...identity, ...changed }, new AbortController().signal, deps)).toBeNull()
  }
  expect(deps.fetch).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled()
})
it('downmixes once, resamples to mono 16k and closes the decode context', async () => {
  const { deps, close } = setup()
  const result = await decodeForAnalysis(identity, new AbortController().signal, deps)
  expect(result?.pcm.length).toBe(16000)
  expect(result?.pcm[4000]).toBeCloseTo(0.375)
  expect(result?.sampleRate).toBe(16000)
  expect(close).toHaveBeenCalledOnce()
})
it('bounds actual streamed bytes and rejects data larger than its issued identity', async () => {
  const { deps, decode } = setup()
  deps.fetch = async () => new Response(new Uint8Array(4001))
  expect(await decodeForAnalysis(identity, new AbortController().signal, deps)).toBeNull()
  expect(decode).not.toHaveBeenCalled()
})

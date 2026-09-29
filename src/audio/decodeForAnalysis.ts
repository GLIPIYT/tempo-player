import { convertFileSrc } from '@tauri-apps/api/core'
import { MAX_AUDIO_DURATION_SEC, MAX_AUDIO_FILE_BYTES, MAX_DECODED_AUDIO_BYTES, type AudioIdentity } from '../features/lyrics/analysis/contract'
import { withAnalysisLane } from './analysisLane'
export interface DecodeDependencies {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  url: (path: string) => string
  context: (sampleRate: number) => Pick<AudioContext, 'decodeAudioData' | 'close'>
}
const defaults: DecodeDependencies = {
  fetch: (url, init) => fetch(url, init), url: convertFileSrc,
  // Keep the issued native source rate, avoiding device-dependent allocation and double resampling.
  context: (sampleRate) => new AudioContext({ sampleRate }),
}
export interface AnalysisPcm { pcm: Float32Array; sampleRate: 16000; durationSec: number }
export const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export function audioWithinLimits(identity: AudioIdentity): boolean {
  const { fileSize, durationSec, sampleRate, channels } = identity
  // Unknown source properties are refused: the decoder could allocate before we can inspect it.
  return Number.isSafeInteger(fileSize) && fileSize > 0 && fileSize <= MAX_AUDIO_FILE_BYTES
    && Number.isFinite(durationSec) && durationSec > 0 && durationSec <= MAX_AUDIO_DURATION_SEC
    && sampleRate != null && Number.isInteger(sampleRate) && sampleRate > 0 && sampleRate <= 192000
    && channels != null && Number.isInteger(channels) && channels > 0 && channels <= 32
    && durationSec * Math.max(48000, sampleRate) * channels * 4 <= MAX_DECODED_AUDIO_BYTES
}

async function boundedBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<ArrayBuffer | null> {
  if (!response.ok || !response.body) return null
  const declared = response.headers.get('content-length')
  if (declared != null && (!Number.isFinite(Number(declared)) || Number(declared) > maxBytes)) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) return null
      chunks.push(value)
    }
    if (length !== maxBytes) return null
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return bytes.buffer
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Shared bounded decoder, also used by loudness without changing channel/RMS semantics. */
export async function withDecodedAudio<T>(identity: AudioIdentity, signal: AbortSignal,
  consume: (buffer: AudioBuffer) => Promise<T>, deps = defaults): Promise<T | null> {
  if (!audioWithinLimits(identity)) return null
  return withAnalysisLane(signal, async () => {
    let context: ReturnType<DecodeDependencies['context']> | null = null
    try {
      const response = await deps.fetch(deps.url(identity.absolutePath), { signal, cache: 'no-store' })
      const bytes = await boundedBytes(response, identity.fileSize, signal)
      if (!bytes) return null
      signal.throwIfAborted()
      context = deps.context(identity.sampleRate!)
      const buffer = await context.decodeAudioData(bytes)
      signal.throwIfAborted()
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > MAX_AUDIO_DURATION_SEC
        || buffer.length * buffer.numberOfChannels * 4 > MAX_DECODED_AUDIO_BYTES) return null
      return await consume(buffer)
    } catch (error) {
      if (signal.aborted) throw error
      return null
    } finally { await context?.close().catch(() => {}) }
  })
}

export function decodeForAnalysis(identity: AudioIdentity, signal: AbortSignal, deps = defaults): Promise<AnalysisPcm | null> {
  return withDecodedAudio(identity, signal, async (buffer) => {
    const length = Math.floor(buffer.duration * 16000)
    const pcm = new Float32Array(length)
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch))
    // Integrate source samples into each output bin (low-pass box resampling), keeping only mono output.
    const ratio = buffer.sampleRate / 16000
    for (let base = 0; base < length; base += 8192) {
      signal.throwIfAborted()
      for (let i = base; i < Math.min(base + 8192, length); i++) {
        const begin = i * ratio, end = Math.min((i + 1) * ratio, buffer.length)
        let sum = 0
        for (let j = Math.floor(begin); j < Math.ceil(end); j++) {
          const weight = Math.min(j + 1, end) - Math.max(j, begin)
          for (const channel of channels) sum += (channel[j] ?? 0) * weight
        }
        pcm[i] = sum / ((end - begin) * channels.length)
      }
      await yieldToUi()
    }
    return { pcm, sampleRate: 16000, durationSec: length / 16000 }
  }, deps)
}

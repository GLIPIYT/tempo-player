import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { LYRIC_MODEL_ID, LYRIC_MODEL_REVISION } from './contract'
import { artifactMap, absoluteWords, type AsrRequest, type AsrResponse } from './workerProtocol'

let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let currentJob = -1
let busy = false
const reply = (response: AsrResponse): void => self.postMessage(response)

self.onmessage = async (event: MessageEvent<AsrRequest>) => {
  const request = event.data
  const fragmentId = request.type === 'transcribe' ? request.fragmentId : undefined
  if (busy) { reply({ type: 'error', jobId: request.jobId, fragmentId, error: 'Analysis worker is busy' }); return }
  busy = true
  try {
    if (request.type === 'init') {
      if (transcriber) throw new Error('Worker already initialized')
      const artifacts = artifactMap(request.bundle, request.artifactUrls)
      env.allowLocalModels = true
      env.allowRemoteModels = false
      env.localModelPath = '/tempo-models/'
      env.useFS = false
      env.useFSCache = false
      env.useBrowserCache = false
      env.useCustomCache = true
      env.customCache = {
        match: async (key: string): Promise<Response | undefined> => {
          const url = artifacts.get(key)
          if (!url) return undefined
          const response = await fetch(url, { cache: 'no-store' })
          if (!response.ok) throw new Error('Local model artifact could not be read')
          return response
        },
        put: async () => {},
      }
      const wasm = env.backends.onnx.wasm!
      wasm.numThreads = 1
      wasm.proxy = false
      wasm.wasmPaths = {
        mjs: new URL('ort-wasm-simd-threaded.jsep.mjs', request.wasmBaseUrl).href,
        wasm: new URL('ort-wasm-simd-threaded.jsep.wasm', request.wasmBaseUrl).href,
      }
      transcriber = await pipeline<'automatic-speech-recognition'>('automatic-speech-recognition', LYRIC_MODEL_ID, {
        revision: LYRIC_MODEL_REVISION, device: 'wasm', dtype: 'q8', local_files_only: true,
      })
      currentJob = request.jobId
      reply({ type: 'ready', jobId: request.jobId })
    } else {
      if (!transcriber || currentJob !== request.jobId) throw new Error('Stale or uninitialized analysis worker')
      if (request.sampleRate !== 16000 || !(request.pcm instanceof Float32Array) || request.pcm.length === 0
        || request.pcm.length > 12 * 16000 || !Number.isFinite(request.trackStartSec) || request.trackStartSec < 0
        || !['en', 'ru'].includes(request.language) || request.pcm.some(value => !Number.isFinite(value))) throw new Error('Invalid analysis fragment')
      const started = performance.now()
      const result = await transcriber(request.pcm, { return_timestamps: 'word', task: 'transcribe', language: request.language, chunk_length_s: 0 })
      if (Array.isArray(result)) throw new Error('Unexpected batched transcription')
      reply({ type: 'result', jobId: request.jobId, fragmentId: request.fragmentId,
        words: absoluteWords(result.chunks ?? [], request.trackStartSec, request.pcm.length / 16000), elapsedMs: performance.now() - started })
    }
  } catch (error) {
    reply({ type: 'error', jobId: request.jobId, fragmentId, error: error instanceof Error ? error.message : String(error) })
  } finally { busy = false }
}

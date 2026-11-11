import { InferenceSession, Tensor, env } from 'onnxruntime-web/wasm'
import { extractFireRedFeatures } from './fbank'
import { disposeTensors } from './disposeTensors'
import { VOCAL_MODEL_REVISION, VOCAL_ALGORITHM_VERSION, VOCAL_HOP_SEC, VOCAL_CORE_SEC,
  type VocalRequest, type VocalResponse, type VocalChunk } from './vocalContract'

let session: InferenceSession | null = null
let cmvn: { means: number[]; inverseStd: number[] } | null = null
let job = -1, busy = false
const reply = (response: VocalResponse) => self.postMessage(response)
const byte = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255)
const digest = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
async function artifact(base: string, path: string, sha256: string, maxBytes: number): Promise<ArrayBuffer> {
  const response = await fetch(new URL(path, base), { cache: 'force-cache' })
  if (!response.ok) throw new Error('Could not read the bundled vocal model')
  const body = await response.arrayBuffer()
  if (body.byteLength > maxBytes || await digest(body) !== sha256) throw new Error('Bundled vocal model integrity check failed')
  return body
}

self.onmessage = async ({ data: request }: MessageEvent<VocalRequest>) => {
  const chunkId = request.type === 'analyze' ? request.chunkId : undefined
  if (busy) { reply({ type: 'error', jobId: request.jobId, chunkId, error: 'Vocal worker is busy' }); return }
  busy = true
  try {
    if (request.type === 'init') {
      if (session) throw new Error('Vocal worker already initialized')
      const response = await fetch(new URL('manifest.json', request.modelBaseUrl), { cache: 'force-cache' })
      if (!response.ok) throw new Error('Bundled vocal model manifest is unavailable')
      const manifest = await response.json()
      if (manifest.modelId !== 'FireRedVAD-AED' || manifest.revision !== VOCAL_MODEL_REVISION
        || manifest.algorithmVersion !== VOCAL_ALGORITHM_VERSION || manifest.modelFile !== 'aed.onnx'
        || manifest.modelSha256 !== VOCAL_MODEL_REVISION || manifest.cmvnFile !== 'cmvn.json'
        || typeof manifest.cmvnSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.cmvnSha256)) throw new Error('Unsupported bundled vocal model')
      const [model, normalization] = await Promise.all([
        artifact(request.modelBaseUrl, manifest.modelFile, manifest.modelSha256, 3 * 1024 * 1024),
        artifact(request.modelBaseUrl, manifest.cmvnFile, manifest.cmvnSha256, 16 * 1024),
      ])
      cmvn = JSON.parse(new TextDecoder().decode(normalization))
      if (!cmvn || !Array.isArray(cmvn.means) || !Array.isArray(cmvn.inverseStd) || cmvn.means.length !== 80 || cmvn.inverseStd.length !== 80
        || cmvn.means.some(value => !Number.isFinite(value)) || cmvn.inverseStd.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid bundled vocal normalization')
      env.wasm.numThreads = 1
      env.wasm.proxy = false
      env.wasm.wasmPaths = { mjs: new URL('ort-wasm-simd-threaded.jsep.mjs', request.wasmBaseUrl).href,
        wasm: new URL('ort-wasm-simd-threaded.jsep.wasm', request.wasmBaseUrl).href }
      session = await InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
      job = request.jobId
      reply({ type: 'ready', jobId: job })
    } else {
      if (!session || !cmvn || job !== request.jobId) throw new Error('Vocal worker is not initialized')
      const { pcm, startSec, endSec, windowStartSec } = request
      if (!(pcm instanceof Float32Array) || pcm.length > 32 * 16000 || !pcm.length || pcm.some(value => !Number.isFinite(value))
        || !Number.isFinite(windowStartSec) || windowStartSec < 0 || !Number.isFinite(startSec) || !Number.isFinite(endSec)
        || startSec < windowStartSec || endSec <= startSec || endSec - startSec > VOCAL_CORE_SEC + .001
        || endSec > windowStartSec + pcm.length / 16000 + .1) throw new Error('Invalid vocal analysis window')
      const started = performance.now()
      // Float audio decoders may overshoot full scale. The upstream int16
      // input saturates there; preserve that domain before extracting fbank.
      for (let index = 0; index < pcm.length; index++) pcm[index] = Math.max(-1, Math.min(1, pcm[index]))
      const features = extractFireRedFeatures(pcm, cmvn)
      let probabilities: Float32Array | null = null
      if (features.frames > 0) {
        const input = new Tensor('float32', features.data, [1, features.frames, 80])
        try {
          const output = await session.run({ feat: input })
          try {
            const values = output.probs
            if (!(values?.data instanceof Float32Array) || values.data.length !== features.frames * 3) throw new Error('Invalid vocal model output')
            probabilities = new Float32Array(values.data)
          } finally { disposeTensors(Object.values(output)) }
        } finally { input.dispose() }
      }
      const count = Math.ceil((endSec - startSec) / VOCAL_HOP_SEC)
      const chunk: VocalChunk = { startSec, endSec, voice: [], energy: [], flux: [] }
      for (let index = 0; index < count; index++) {
        let voice = 0, energy = 0, flux = 0, used = 0
        if (probabilities && features.frames) {
          for (let half = 0; half < 2; half++) {
            const frame = Math.min(features.frames - 1, Math.max(0, Math.round((startSec - windowStartSec + index * VOCAL_HOP_SEC) * 100) + half))
            const probability = Math.max(probabilities[frame * 3], probabilities[frame * 3 + 1])
            if (!Number.isFinite(probability)) throw new Error('Non-finite vocal probability')
            voice += probability; energy += features.energy[frame]; flux = Math.max(flux, features.flux[frame]); used++
          }
        }
        chunk.voice.push(byte(used ? voice / used : 0))
        chunk.energy.push(byte(used ? (20 * Math.log10(Math.max(1e-8, energy / used)) + 80) / 80 : 0))
        chunk.flux.push(byte(flux / 2))
      }
      reply({ type: 'result', jobId: job, chunkId: request.chunkId, chunk, elapsedMs: performance.now() - started })
    }
  } catch (error) { reply({ type: 'error', jobId: request.jobId, chunkId, error: error instanceof Error ? error.message : String(error) }) }
  finally { busy = false }
}

import { env, pipeline, Tensor, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { LYRIC_MODEL_ID, LYRIC_MODEL_REVISION } from './contract'
import { artifactMap, absoluteWords, type AsrRequest, type AsrResponse } from './workerProtocol'
import { disposeTensors } from './disposeTensors'
import { attentionTokenBoundaries, knownTextWordsFromBoundaries, mapDecodedTokensToWords,
  MAX_KNOWN_TEXT_TOKENS, MAX_KNOWN_TEXT_WINDOW_SEC, MAX_KNOWN_TEXT_WORDS } from './knownTextAlignment'

let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let currentJob = -1
let busy = false
const reply = (response: AsrResponse): void => self.postMessage(response)

interface RuntimeTensor { dims: number[]; data: Float32Array; dispose?: () => void }
interface WhisperTokenizerRuntime {
  (text: string, options: { add_special_tokens: boolean }): { input_ids: { tolist(): (number | bigint)[][] } }
  decode(ids: number[], options: { skip_special_tokens: boolean; clean_up_tokenization_spaces: boolean }): string
  all_special_ids?: number[]
}
interface WhisperModelRuntime {
  generation_config: {
    decoder_start_token_id: number
    lang_to_id: Record<string, number>
    task_to_id: Record<string, number>
    no_timestamps_token_id: number
    alignment_heads: number[][]
  }
  getAttentions(output: Record<string, RuntimeTensor>): { cross_attentions?: RuntimeTensor[] }
  (inputs: Record<string, unknown>): Promise<Record<string, RuntimeTensor>>
}
interface WhisperPipelineRuntime {
  tokenizer: WhisperTokenizerRuntime
  processor: (pcm: Float32Array) => Promise<Record<string, unknown> & { input_features: RuntimeTensor }>
  model: WhisperModelRuntime
}

function flatIds(encoded: { input_ids: { tolist(): (number | bigint)[][] } }): number[] {
  const ids = encoded.input_ids.tolist()[0]
  return ids.map(id => Number(id))
}

function tokenLikelihoods(logits: RuntimeTensor, decoderPrefixLength: number, targetIds: readonly number[]): number[] | null {
  if (logits.dims.length !== 3 || logits.dims[0] !== 1 || logits.dims[2] < 2) return null
  const [, sequenceLength, vocabularySize] = logits.dims
  if (decoderPrefixLength + targetIds.length > sequenceLength) return null
  const probabilities: number[] = []
  for (let index = 0; index < targetIds.length; index += 1) {
    const row = decoderPrefixLength - 1 + index
    const target = targetIds[index]
    if (!Number.isInteger(target) || target < 0 || target >= vocabularySize) return null
    let maximum = -Infinity
    const rowOffset = row * vocabularySize
    for (let token = 0; token < vocabularySize; token += 1) maximum = Math.max(maximum, logits.data[rowOffset + token])
    let denominator = 0
    for (let token = 0; token < vocabularySize; token += 1) denominator += Math.exp(logits.data[rowOffset + token] - maximum)
    const probability = Math.exp(logits.data[rowOffset + target] - maximum) / denominator
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) return null
    probabilities.push(probability)
  }
  return probabilities
}

async function alignKnownText(request: Extract<AsrRequest, { type: 'align-known-text' }>): Promise<{ words: ReturnType<typeof absoluteWords>; confidence: number }> {
  const windowSec = request.sourceEndSec - request.trackStartSec
  const durationSec = request.pcm.length / request.sampleRate
  const sourceWords = typeof request.text === 'string' ? request.text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [] : []
  if (request.sampleRate !== 16000 || !(request.pcm instanceof Float32Array) || request.pcm.length === 0
    || request.pcm.length > MAX_KNOWN_TEXT_WINDOW_SEC * 16000 || !Number.isFinite(request.trackStartSec) || request.trackStartSec < 0
    || !Number.isFinite(request.sourceEndSec) || windowSec <= 0 || windowSec > MAX_KNOWN_TEXT_WINDOW_SEC
    || Math.abs(windowSec - durationSec) > 1 / request.sampleRate || !['en', 'ru'].includes(request.language)
    || typeof request.text !== 'string' || request.text.length === 0 || request.text.length > 4096 || /[\r\n]/u.test(request.text)
    || sourceWords.length < 2 || sourceWords.length > MAX_KNOWN_TEXT_WORDS
    || request.pcm.some(value => !Number.isFinite(value))) throw new Error('Invalid known-text alignment window')

  const runtime = transcriber as unknown as WhisperPipelineRuntime
  const targetIds = flatIds(runtime.tokenizer(request.text, { add_special_tokens: false }))
  if (targetIds.length === 0 || targetIds.length > MAX_KNOWN_TEXT_TOKENS
    || targetIds.some(id => !Number.isInteger(id) || id < 0 || runtime.tokenizer.all_special_ids?.includes(id))) {
    return { words: [], confidence: 0 }
  }

  const decodedPrefixes: string[] = []
  const prefixIds: number[] = []
  for (const tokenId of targetIds) {
    prefixIds.push(tokenId)
    decodedPrefixes.push(runtime.tokenizer.decode(prefixIds, { skip_special_tokens: true, clean_up_tokenization_spaces: false }))
  }
  const tokenGroups = mapDecodedTokensToWords(request.text, decodedPrefixes)
  if (!tokenGroups) return { words: [], confidence: 0 }

  const generation = runtime.model.generation_config
  const languageToken = generation.lang_to_id[`<|${request.language}|>`]
  const decoderPrefix = [generation.decoder_start_token_id, languageToken, generation.task_to_id.transcribe, generation.no_timestamps_token_id]
  if (decoderPrefix.some(id => !Number.isInteger(id) || id < 0)
    || !Array.isArray(generation.alignment_heads) || generation.alignment_heads.length === 0) {
    throw new Error('Whisper model is missing alignment configuration')
  }

  const decoderTokens = [...decoderPrefix, ...targetIds]
  const features = await runtime.processor(request.pcm)
  let decoderInputIds: Tensor | undefined
  let output: Record<string, RuntimeTensor> | undefined
  try {
    decoderInputIds = new Tensor('int64', BigInt64Array.from(decoderTokens.map(BigInt)), [1, decoderTokens.length])
    output = await runtime.model({ ...features, decoder_input_ids: decoderInputIds })
    const crossAttentions = runtime.model.getAttentions(output).cross_attentions
    if (!crossAttentions || crossAttentions.length === 0) throw new Error('Whisper decoder did not return cross-attention outputs')

    const frameCount = Math.floor(request.pcm.length / 320)
    const tokenRows = targetIds.length + 1 // no-timestamps query plus one query per forced text token
    const rowStart = decoderPrefix.length - 1
    const headRows: Float32Array[] = []
    for (const [layer, head] of generation.alignment_heads) {
      const attention = crossAttentions[layer]
      if (!attention || attention.dims.length !== 4 || attention.dims[0] !== 1
        || head < 0 || head >= attention.dims[1] || rowStart + tokenRows > attention.dims[2]
        || frameCount > attention.dims[3]) throw new Error('Whisper cross-attention shape is incompatible with the alignment configuration')
      const sequenceLength = attention.dims[2]
      const encoderFrames = attention.dims[3]
      const selected = new Float32Array(tokenRows * frameCount)
      for (let row = 0; row < tokenRows; row += 1) {
        const sourceStart = (head * sequenceLength + rowStart + row) * encoderFrames
        selected.set(attention.data.subarray(sourceStart, sourceStart + frameCount), row * frameCount)
      }
      headRows.push(selected)
    }

    const boundaries = attentionTokenBoundaries(headRows, tokenRows, frameCount)
    const probabilities = tokenLikelihoods(output.logits, decoderPrefix.length, targetIds)
    if (!boundaries || !probabilities) return { words: [], confidence: 0 }
    const aligned = knownTextWordsFromBoundaries(request.text, tokenGroups, boundaries, probabilities,
      request.trackStartSec, request.sourceEndSec)
    return aligned ? aligned : { words: [], confidence: 0 }
  } finally {
    // Each aligned lyric line creates logits, cross-attention, and feature tensors.
    // Copy the compact timing result first, then return those large WASM allocations.
    disposeTensors([...Object.values(features), decoderInputIds, ...Object.values(output ?? {})])
  }
}

self.onmessage = async (event: MessageEvent<AsrRequest>) => {
  const request = event.data
  const fragmentId = request.type === 'transcribe' ? request.fragmentId : undefined
  const alignmentId = request.type === 'align-known-text' ? request.alignmentId : undefined
  if (busy) { reply({ type: 'error', jobId: request.jobId, fragmentId, alignmentId, error: 'Analysis worker is busy' }); return }
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
      if (request.type === 'transcribe' && (request.sampleRate !== 16000 || !(request.pcm instanceof Float32Array) || request.pcm.length === 0
        || request.pcm.length > 12 * 16000 || !Number.isFinite(request.trackStartSec) || request.trackStartSec < 0
        || !['en', 'ru'].includes(request.language) || request.pcm.some(value => !Number.isFinite(value)))) throw new Error('Invalid analysis fragment')
      const started = performance.now()
      if (request.type === 'transcribe') {
        const result = await transcriber(request.pcm, { return_timestamps: 'word', task: 'transcribe', language: request.language, chunk_length_s: 0 })
        if (Array.isArray(result)) throw new Error('Unexpected batched transcription')
        reply({ type: 'result', jobId: request.jobId, fragmentId: request.fragmentId,
          words: absoluteWords(result.chunks ?? [], request.trackStartSec, request.pcm.length / 16000), elapsedMs: performance.now() - started })
      } else {
        const aligned = await alignKnownText(request)
        reply({ type: 'alignment', jobId: request.jobId, alignmentId: request.alignmentId,
          words: aligned.words, confidence: aligned.confidence, elapsedMs: performance.now() - started })
      }
    }
  } catch (error) {
    reply({ type: 'error', jobId: request.jobId, fragmentId, alignmentId, error: error instanceof Error ? error.message : String(error) })
  } finally { busy = false }
}

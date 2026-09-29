import { LYRIC_MODEL_ID, LYRIC_MODEL_REVISION, type AnalysisWord, type ModelBundle } from './contract'
export type AsrRequest =
  | { type: 'init'; jobId: number; bundle: ModelBundle; artifactUrls: Record<string, string>; wasmBaseUrl: string }
  | { type: 'transcribe'; jobId: number; fragmentId: string; trackStartSec: number; sampleRate: 16000; pcm: Float32Array; language: 'en' | 'ru' }
export type AsrResponse =
  | { type: 'ready'; jobId: number }
  | { type: 'result'; jobId: number; fragmentId: string; words: AnalysisWord[]; elapsedMs: number }
  | { type: 'error'; jobId: number; fragmentId?: string; error: string }
export const MODEL_ARTIFACTS = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json',
  'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'] as const
export function artifactMap(bundle: ModelBundle, urls: Record<string, string>): Map<string, string> {
  if (bundle.modelId !== LYRIC_MODEL_ID || bundle.revision !== LYRIC_MODEL_REVISION
    || bundle.files.length !== MODEL_ARTIFACTS.length || new Set(bundle.files.map(f => f.relativePath)).size !== MODEL_ARTIFACTS.length
    || MODEL_ARTIFACTS.some(path => !bundle.files.some(f => f.relativePath === path) || !urls[path])) throw new Error('Incomplete or stale local model bundle')
  return new Map(MODEL_ARTIFACTS.map(path => [`/tempo-models/${LYRIC_MODEL_ID}/${path}`, urls[path]]))
}
export function absoluteWords(chunks: readonly { text: string; timestamp: (number | null)[] }[], start: number, duration: number): AnalysisWord[] {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) return []
  const words: AnalysisWord[] = []
  let previous = 0
  for (const chunk of chunks) {
    const [begin, end] = chunk.timestamp
    if (begin == null || end == null || !Number.isFinite(begin) || !Number.isFinite(end)
      || begin < previous || end <= begin || end > duration || !chunk.text.trim()) return []
    words.push({ text: chunk.text.trim(), startSec: start + begin, endSec: start + end })
    previous = end
  }
  return words
}

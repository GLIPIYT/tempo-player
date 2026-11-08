export const VOCAL_ALGORITHM_VERSION = 'vocal-aed-v1'
export const VOCAL_MODEL_REVISION = '823c2802d870aa57f19b1fbd8214c85c72b22930c851342ef7c656f68b8e9ee2'
export const VOCAL_HOP_SEC = .02
export const VOCAL_CORE_SEC = 20
export const VOCAL_CONTEXT_SEC = 4

/** Media seconds, before any user lyric offset. Quantized summaries at 50 Hz. */
export interface VocalChunk {
  startSec: number
  endSec: number
  voice: number[]
  energy: number[]
  flux: number[]
}

export interface VocalAnalysis {
  fingerprint: string
  modelRevision: string
  algorithmVersion: string
  durationSec: number
  hopSec: number
  chunks: VocalChunk[]
}

/** Evidence is projected only when consumed; the cache always stays in media time. */
export interface VocalTimingEvidence {
  analysis: VocalAnalysis
  offsetMs: number
}

export type VocalRequest =
  | { type: 'init'; jobId: number; modelBaseUrl: string; wasmBaseUrl: string }
  | { type: 'analyze'; jobId: number; chunkId: string; windowStartSec: number; startSec: number; endSec: number; pcm: Float32Array }
export type VocalResponse =
  | { type: 'ready'; jobId: number }
  | { type: 'result'; jobId: number; chunkId: string; chunk: VocalChunk; elapsedMs: number }
  | { type: 'error'; jobId: number; chunkId?: string; error: string }

/** Native and worker contracts. All audio times are media seconds at 1× speed. */
export const LYRIC_ANALYSIS_ALGORITHM_VERSION = 'smart-lyrics-v1'
export const LYRIC_MODEL_ID = 'onnx-community/whisper-tiny_timestamped'
export const LYRIC_MODEL_REVISION = '517244293732ee2d58139af5814231b7e6830a0d'
export const MAX_AUDIO_FILE_BYTES = 64 * 1024 * 1024
export const MAX_AUDIO_DURATION_SEC = 600
export const MAX_DECODED_AUDIO_BYTES = 256 * 1024 * 1024
export const LYRIC_MODEL_STATE_EVENT = 'lyrics-analysis://model-state'

export interface ModelState {
  enabled: boolean
  phase: 'absent' | 'downloading' | 'ready' | 'error'
  loadedBytes: number
  totalBytes: number
  error: string | null
}

export interface ModelBundle {
  modelId: typeof LYRIC_MODEL_ID
  revision: string
  files: { relativePath: string; absolutePath: string }[]
}

/** Issued only for a registered track's existing local/cache file. */
export interface AudioIdentity {
  fingerprint: string
  absolutePath: string
  fileSize: number
  durationSec: number
  sampleRate: number | null
  channels: number | null
}

export interface AnalysisWord {
  text: string
  startSec: number
  endSec: number
}

export interface CompletedFragment {
  startSec: number
  endSec: number
  status: 'completed'
  words: AnalysisWord[]
}

export interface MatchedSourceEnd {
  lineIndex: number
  /** Canonical source endpoint; apply the CURRENT user offset once on replay. */
  sourceEndSec: number
  matchedMediaEndSec: number
  /** Offset when accepted: sourceEndSec = matchedMediaEndSec - offsetAtMatchMs/1000. */
  offsetAtMatchMs: number
  confidence: number
}

export interface CachedLyricMatches {
  /** Text, canonical starts and provider identity; excludes the user offset. */
  sourceLyricKey: string
  ends: MatchedSourceEnd[]
}

export interface BpmEstimate {
  bpm: number
  confidence: number
}

export interface AudioAnalysis {
  fingerprint: string
  algorithmVersion: string
  modelRevision: string
  durationSec: number
  bpm: number | null
  bpmConfidence: number
  fragments: CompletedFragment[]
  lyricMatches: CachedLyricMatches[]
}

export interface AnalysisMerge {
  fingerprint: string
  algorithmVersion: string
  modelRevision: string
  bpm?: BpmEstimate
  completedFragment?: CompletedFragment
  acceptedMatches?: CachedLyricMatches
}

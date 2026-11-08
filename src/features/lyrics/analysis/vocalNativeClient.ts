import { invoke } from '@tauri-apps/api/core'
import { analysisNativeClient, type AnalysisTrack } from './nativeClient'
import type { AudioIdentity } from './contract'
import type { VocalAnalysis } from './vocalContract'

export interface VocalNativeClient {
  identity(track: AnalysisTrack): Promise<AudioIdentity | null>
  get(fingerprint: string): Promise<VocalAnalysis | null>
  merge(analysis: VocalAnalysis): Promise<VocalAnalysis>
}
export const vocalNativeClient: VocalNativeClient = {
  identity: track => analysisNativeClient.identity(track),
  get: fingerprint => invoke('lyrics_vocal_get', { fingerprint }),
  merge: analysis => invoke('lyrics_vocal_merge', { analysis }),
}

import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import type { UnifiedTrack } from '../../../types/models'
import type { AnalysisMerge, AudioAnalysis, AudioIdentity, ModelBundle, ModelState } from './contract'

export type AnalysisTrack = Pick<UnifiedTrack, 'dbId' | 'source' | 'sourceId'>
export interface AnalysisNativeClient {
  identity(track: AnalysisTrack): Promise<AudioIdentity | null>
  get(fingerprint: string): Promise<AudioAnalysis | null>
  merge(update: AnalysisMerge): Promise<AudioAnalysis>
  ensureModel(): Promise<ModelBundle>
  assetUrl(path: string): string
}
export const analysisNativeClient: AnalysisNativeClient = {
  identity: (track) => invoke('lyrics_analysis_audio_identity', { trackId: track.dbId, source: track.source,
    sourceId: track.source === 'local' ? null : track.sourceId }),
  get: (fingerprint) => invoke('lyrics_analysis_get', { fingerprint }),
  merge: (update) => invoke('lyrics_analysis_merge', { ...update }),
  ensureModel: () => invoke('lyrics_analysis_ensure_model'),
  assetUrl: convertFileSrc,
}
export const getAnalysisModelState = (): Promise<ModelState> => invoke('lyrics_analysis_status')
export const setAnalysisModelEnabled = (enabled: boolean): Promise<ModelState> => invoke('lyrics_analysis_set_enabled', { enabled })

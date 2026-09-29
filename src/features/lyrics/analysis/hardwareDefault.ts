import { invoke } from '@tauri-apps/api/core'

export interface HardwareProfile {
  installedRamBytes: number | null
  physicalCores: number | null
  maxDedicatedVramBytes: number | null
  recommendedEnabled: boolean
}

let recommendation: Promise<boolean> | undefined

export function initializeDeepAnalysis(current: boolean | null, recommended: boolean): boolean {
  return current ?? recommended
}

/** Cache failures as disabled too; remounts never start another native probe. */
export async function initializeDeepAnalysisDefault(
  apply: (resolve: (current: boolean | null) => boolean) => void,
): Promise<void> {
  recommendation ??= invoke<HardwareProfile>('get_lyrics_analysis_hardware')
    .then(profile => profile.recommendedEnabled === true)
    .catch(() => false)
  const recommended = await recommendation
  apply(current => initializeDeepAnalysis(current, recommended))
}

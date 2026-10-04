import { api } from '../../api/client'
import { withAnalysisLane } from '../../audio/analysisLane'
import { RECORDING_VERSION_MARKER_SOURCE } from './identity'
import type { AudioRecordingFeature, RecommendationTrack } from './types'

const versionMarkers = (value: string) => Array.from(
  value.matchAll(new RegExp(`\\b(?:${RECORDING_VERSION_MARKER_SOURCE})\\b`, 'giu')),
  match => match[0].replace(/[ -]+/gu, ' ').trim().replace(/\b(speed|sped)up\b/gu, '$1 up'),
)

export function audioVersionKey(track: RecommendationTrack): string {
  const title = track.title.normalize('NFKC').toLocaleLowerCase('en-US')
  const markers = new Set(versionMarkers(title))
  const declared = track.traits?.version?.normalize('NFKC').toLocaleLowerCase('en-US').trim()
  if (declared && declared !== 'original' && declared !== 'base' && declared !== 'unknown') {
    const declaredMarkers = versionMarkers(declared)
    if (!declaredMarkers.length) return 'unknown'
    for (const marker of declaredMarkers) markers.add(marker)
  } else if (declared === 'unknown') {
    return 'unknown'
  }
  return markers.size ? [...markers].sort().join('|').replace(/ /gu, '-') : 'base'
}

export async function analyzeCachedRecommendationTrack(
  track: RecommendationTrack,
  signal: AbortSignal,
): Promise<AudioRecordingFeature | null> {
  const jobId = `rec-audio-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const cancel = () => { void api.cancelRecommendationAudioFeature(jobId).catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return await withAnalysisLane(signal, () => api.getRecommendationAudioFeature({
      jobId,
      trackId: track.dbId,
      source: track.source,
      sourceId: track.sourceId,
      durationSec: track.durationSec,
      versionKey: audioVersionKey(track),
    }))
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

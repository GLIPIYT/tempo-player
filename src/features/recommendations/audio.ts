import { api } from '../../api/client'
import { withAnalysisLane } from '../../audio/analysisLane'
import type { AudioRecordingFeature, RecommendationTrack } from './types'

const VERSION_MARKER = /\b(?:remix|live|slowed|sped[ -]?up|nightcore|cover|instrumental|acoustic|edit|demo|rework|bootleg)\b/giu
const VERSION_KEYS = new Set(['remix', 'live', 'slowed', 'sped up', 'nightcore', 'cover', 'instrumental', 'acoustic', 'edit', 'demo', 'rework', 'bootleg'])

export function audioVersionKey(track: RecommendationTrack): string {
  const title = track.title.normalize('NFKC').toLocaleLowerCase('en-US')
  const markers = new Set(Array.from(title.matchAll(VERSION_MARKER), match => match[0].replace(/[ -]+/gu, ' ').trim()))
  const declared = track.traits?.version?.normalize('NFKC').toLocaleLowerCase('en-US').trim()
  if (declared && declared !== 'original' && declared !== 'base' && declared !== 'unknown') {
    const declaredMarkers = Array.from(declared.matchAll(VERSION_MARKER), match => match[0].replace(/[ -]+/gu, ' ').trim())
    if (!declaredMarkers.length) return 'unknown'
    for (const marker of declaredMarkers) markers.add(marker)
  } else if (declared === 'unknown') {
    return 'unknown'
  }
  const ordered = [...markers].filter(marker => VERSION_KEYS.has(marker)).sort()
  return ordered.length ? ordered.join('|').replace(/ /gu, '-') : 'base'
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

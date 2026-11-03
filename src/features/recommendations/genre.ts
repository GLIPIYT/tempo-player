import type { ScTrack } from '../../types/models'
import { canPlaySoundCloudTrack } from '../../soundcloud/playability'
import { normalizeRecordingText, recordingIdentity } from './identity'
import { candidateScore, type TasteProfile } from './profile'
import type { FeedCandidate } from './storage'

function normalizeGenreTag(value: string): string {
  const withoutPrefix = value.replace(/^\s*#+/u, '').replace(/^\s*(?:genre|tag)\s*:\s*/iu, '').replace(/^\s*#+/u, '')
  return normalizeRecordingText(withoutPrefix)
}

/** Require explicit metadata; a title or uploader name alone is not genre evidence. */
export function matchesFavoriteGenre(track: ScTrack, genreKey: string): boolean {
  const expected = normalizeGenreTag(genreKey)
  if (!expected) return false
  if (track.genre && normalizeGenreTag(track.genre) === expected) return true
  return (track.tags ?? []).some(tag => normalizeGenreTag(tag) === expected)
}

/** Reuse the main feed score: Sonara is used when both vectors are cached; metadata fills gaps. */
export function genreTrackScore(track: ScTrack, profile: TasteProfile | null): number {
  if (!profile) return 0
  const identity = recordingIdentity(track, Object.keys(profile.artists))
  const candidate: FeedCandidate = {
    track, identity, groupKey: identity.groupKey, seedTrackKey: '', cursor: null, alternates: [], addedAt: 0,
  }
  return candidateScore(candidate, profile)
}

/** Keep fallback candidates relevant, playable, unique, and in taste order. */
export function rankGenreTracks(
  candidates: readonly ScTrack[],
  genreKey: string,
  profile: TasteProfile | null = null,
  limit = 40,
): ScTrack[] {
  const seen = new Set<string>()
  const relevant = candidates.filter(track => {
    if (!canPlaySoundCloudTrack(track) || !matchesFavoriteGenre(track, genreKey) || seen.has(track.id)) return false
    seen.add(track.id)
    return true
  })
  return relevant.map((track, index) => ({ track, index, score: genreTrackScore(track, profile) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(item => item.track)
}

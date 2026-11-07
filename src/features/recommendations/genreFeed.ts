import type { ScTrack } from '../../types/models'
import { rankGenreTracks } from './genre'
import type { TasteProfile } from './profile'

export interface GenreRecommendationPage {
  tracks: ScTrack[]
  nextCursor: string | null
  error?: string | null
}

export interface GenreFeedRefillOptions {
  genreKey: string
  profile: TasteProfile | null
  tracks: readonly ScTrack[]
  loadedTrackIds: Set<string>
  seenCursors: Set<string>
  startCursor: string | null
  fillTarget: number
  pageBudget: number
  minimumPages?: number
  fetchPage: (cursor: string | null) => Promise<GenreRecommendationPage>
  isCurrent?: () => boolean
  random?: () => number
  onAppend?: (tracks: ScTrack[], appended: ScTrack[]) => void | Promise<void>
  onCursor?: (cursor: string | null) => void
}

/** Fetch and filter several provider pages until the genre shelf has enough tracks. */
export async function refillGenreRecommendations({
  genreKey,
  profile,
  tracks: initialTracks,
  loadedTrackIds,
  seenCursors,
  startCursor,
  fillTarget,
  pageBudget,
  minimumPages = 1,
  fetchPage,
  isCurrent = () => true,
  random = Math.random,
  onAppend,
  onCursor,
}: GenreFeedRefillOptions): Promise<{ tracks: ScTrack[]; cursor: string | null; pages: number }> {
  let tracks = [...initialTracks]
  let cursor = startCursor
  let firstPage = startCursor === null
  let pages = 0
  let batch: ScTrack[] = []
  const targetCount = tracks.length + Math.max(0, fillTarget)
  const batchIds = new Set<string>()

  const commitBatch = async () => {
    if (!batch.length) return
    const candidates = batch
    batch = []
    const ranked = rankGenreTracks(candidates, genreKey, profile, Number.POSITIVE_INFINITY, random)
    const currentIds = new Set(tracks.map(track => track.id))
    const appended = ranked.filter(track => !currentIds.has(track.id))
    if (!appended.length) return
    tracks = [...tracks, ...appended]
    await onAppend?.(tracks, appended)
  }

  try {
    while (pages < pageBudget && (firstPage || cursor !== null)) {
      if (!isCurrent()) break
      if (pages >= minimumPages && tracks.length + batch.length >= targetCount) break
      if (cursor && seenCursors.has(cursor)) {
        cursor = null
        onCursor?.(cursor)
        break
      }

      const requestedCursor = firstPage ? null : cursor
      const page = await fetchPage(requestedCursor)
      if (!isCurrent()) break
      if (page.error) throw new Error(page.error)

      if (requestedCursor) seenCursors.add(requestedCursor)
      const knownIds = new Set([...tracks.map(track => track.id), ...batchIds])
      const fresh = page.tracks.filter(track => {
        const previouslyLoaded = loadedTrackIds.has(track.id)
        loadedTrackIds.add(track.id)
        if (previouslyLoaded || knownIds.has(track.id)) return false
        batchIds.add(track.id)
        return true
      })
      batch.push(...rankGenreTracks(fresh, genreKey))

      cursor = page.nextCursor?.trim() ? page.nextCursor : null
      if (cursor && seenCursors.has(cursor)) cursor = null
      onCursor?.(cursor)
      firstPage = false
      pages += 1

      if (!cursor || (pages >= minimumPages && tracks.length + batch.length >= targetCount)) break
    }
  } catch (cause) {
    if (isCurrent()) await commitBatch()
    throw cause
  }

  if (isCurrent()) await commitBatch()
  return { tracks, cursor, pages }
}

/** Show main-feed matches only when the independent SoundCloud request failed. */
export function genreShelfTracks(
  providerTracks: readonly ScTrack[],
  fallbackCandidates: readonly ScTrack[],
  genreKey: string,
  profile: TasteProfile | null,
  error: string | null,
): ScTrack[] {
  if (providerTracks.length) return [...providerTracks]
  return error ? rankGenreTracks(fallbackCandidates, genreKey, profile) : []
}

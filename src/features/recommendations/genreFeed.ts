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
  fetchPage: (cursor: string | null) => Promise<GenreRecommendationPage>
  isCurrent?: () => boolean
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
  fetchPage,
  isCurrent = () => true,
  onAppend,
  onCursor,
}: GenreFeedRefillOptions): Promise<{ tracks: ScTrack[]; cursor: string | null; pages: number }> {
  let tracks = [...initialTracks]
  let cursor = startCursor
  let firstPage = startCursor === null
  let pages = 0
  const targetCount = tracks.length + Math.max(0, fillTarget)

  while (pages < pageBudget && (firstPage || cursor !== null)) {
    if (!isCurrent()) break
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
    const fresh = page.tracks.filter(track => {
      if (loadedTrackIds.has(track.id)) return false
      loadedTrackIds.add(track.id)
      return true
    })
    const accepted = rankGenreTracks(fresh, genreKey, profile)
    const currentIds = new Set(tracks.map(track => track.id))
    const appended = accepted.filter(track => !currentIds.has(track.id))
    if (appended.length) {
      tracks = [...tracks, ...appended]
      await onAppend?.(tracks, appended)
      if (!isCurrent()) break
    }

    cursor = page.nextCursor?.trim() ? page.nextCursor : null
    if (cursor && seenCursors.has(cursor)) cursor = null
    onCursor?.(cursor)
    firstPage = false
    pages += 1

    if (tracks.length >= targetCount || !cursor) break
  }

  return { tracks, cursor, pages }
}

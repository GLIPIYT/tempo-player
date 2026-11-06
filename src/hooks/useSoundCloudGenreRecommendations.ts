import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { libraryVersion } from '../utils/libraryVersion'
import type { ScTrack } from '../types/models'
import { buildTasteProfile, type TasteProfile } from '../features/recommendations/profile'
import { rankGenreTracks } from '../features/recommendations/genre'
import { recommendationLanguagePreference, recommendationService } from '../features/recommendations/service'

interface FavoriteGenre {
  key: string
  label: string
}

const PAGE_SIZE = 50
const FILL_TARGET = 24
const PAGE_BUDGET = 6

export function useSoundCloudGenreRecommendations(genre: FavoriteGenre | null, fallbackCandidates: readonly ScTrack[] = []) {
  const genreKey = genre?.key ?? null
  const genreLabel = genre?.label ?? null
  const [providerTracks, setProviderTracks] = useState<ScTrack[]>([])
  const [profile, setProfile] = useState<TasteProfile | null>(null)
  const [cachedTrackIds, setCachedTrackIds] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  const providerTracksRef = useRef<ScTrack[]>([])
  const profileRef = useRef<TasteProfile | null>(null)
  const nextCursorRef = useRef<string | null>(null)
  const seenCursorsRef = useRef(new Set<string>())
  const loadedIdsRef = useRef(new Set<string>())
  const loadingRef = useRef(false)
  const generationRef = useRef(0)

  const loadPages = useCallback(async (startCursor: string | null, generation: number) => {
    if (!genreKey || !genreLabel || loadingRef.current || generation !== generationRef.current) return
    loadingRef.current = true
    setLoading(true)
    setError(null)

    try {
      let cursor = startCursor
      let firstPage = startCursor === null
      let pages = 0
      const initialCount = rankGenreTracks(providerTracksRef.current, genreKey, profileRef.current).length
      const targetCount = initialCount + FILL_TARGET

      while (pages < PAGE_BUDGET && (firstPage || cursor !== null)) {
        if (generation !== generationRef.current) return
        if (cursor && seenCursorsRef.current.has(cursor)) {
          cursor = null
          break
        }
        const requestedCursor = firstPage ? null : cursor
        const page = await api.scRecommendationGenreSearch(genreLabel, requestedCursor, PAGE_SIZE)
        if (generation !== generationRef.current) return
        if (page.error) throw new Error(page.error)

        // Commit each successful page before requesting its continuation. A later
        // page failure must not discard this page or mark its data as unseen.
        if (requestedCursor) seenCursorsRef.current.add(requestedCursor)
        const fresh = page.tracks.filter(track => {
          if (loadedIdsRef.current.has(track.id)) return false
          loadedIdsRef.current.add(track.id)
          return true
        })
        const accepted = rankGenreTracks(fresh, genreKey, profileRef.current)
        const currentIds = new Set(providerTracksRef.current.map(track => track.id))
        const appended = accepted.filter(track => !currentIds.has(track.id))
        if (appended.length) {
          const merged = [...providerTracksRef.current, ...appended]
          providerTracksRef.current = merged
          setProviderTracks(merged)
          recommendationService.queueGenreAudioAnalysis(appended)
          const cached = await api.scGetCachedTrackIds(appended.map(track => track.id)).catch(() => [])
          if (generation !== generationRef.current) return
          setCachedTrackIds(previous => {
            const next = new Set(previous)
            cached.forEach(id => next.add(id))
            return next
          })
        }

        cursor = page.nextCursor?.trim() ? page.nextCursor : null
        if (cursor && seenCursorsRef.current.has(cursor)) cursor = null
        nextCursorRef.current = cursor
        setHasMore(cursor !== null)
        firstPage = false
        pages += 1

        if (providerTracksRef.current.length >= targetCount || !cursor) break
      }
    } catch (cause: unknown) {
      if (generation === generationRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === generationRef.current) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }, [genreKey, genreLabel])

  useEffect(() => {
    if (!providerTracksRef.current.length) return
    const balanced = rankGenreTracks(providerTracksRef.current, genreKey ?? '', profile)
    providerTracksRef.current = balanced
    setProviderTracks(balanced)
  }, [profile, genreKey])

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    providerTracksRef.current = []
    profileRef.current = null
    nextCursorRef.current = null
    seenCursorsRef.current.clear()
    loadedIdsRef.current.clear()
    loadingRef.current = false
    setProviderTracks([])
    setProfile(null)
    setCachedTrackIds(new Set())
    setHasMore(false)
    setLoading(Boolean(genreKey && genreLabel))
    setError(null)

    if (!genreKey || !genreLabel) return
    let cancelled = false

    void api.getRecommendationContext().catch(() => null).then(context => {
      if (cancelled || generation !== generationRef.current) return
      const nextProfile = context ? buildTasteProfile({ ...context, languagePreference: recommendationLanguagePreference() }, Date.now()) : null
      profileRef.current = nextProfile
      setProfile(nextProfile)
      return loadPages(null, generation)
    }).catch((cause: unknown) => {
      if (!cancelled && generation === generationRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    })

    return () => {
      cancelled = true
      if (generation === generationRef.current) generationRef.current += 1
    }
  }, [genreKey, genreLabel, retryVersion, loadPages])

  useEffect(() => {
    if (!genreKey) return
    let active = true
    const refreshProfile = () => {
      void api.getRecommendationContext().then(context => {
        if (!active) return
        const nextProfile = buildTasteProfile({ ...context, languagePreference: recommendationLanguagePreference() }, Date.now())
        profileRef.current = nextProfile
        setProfile(nextProfile)
      }).catch(() => undefined)
    }
    window.addEventListener('tempo:recommendation-audio-updated', refreshProfile)
    return () => {
      active = false
      window.removeEventListener('tempo:recommendation-audio-updated', refreshProfile)
    }
  }, [genreKey])

  const tracks = useMemo(() => {
    return providerTracks.length > 0
      ? providerTracks
      : rankGenreTracks(fallbackCandidates, genreKey ?? '', profile)
  }, [providerTracks, fallbackCandidates, genreKey, profile])

  useEffect(() => {
    if (tracks.length === 0) return
    let active = true
    const refresh = async () => {
      const ids = [...new Set(tracks.slice(-100).map(track => track.id))]
      const cached = new Set<string>()
      for (let start = 0; start < ids.length; start += 50) {
        const batch = await api.scGetCachedTrackIds(ids.slice(start, start + 50)).catch(() => [])
        batch.forEach(id => cached.add(id))
      }
      if (active) setCachedTrackIds(previous => {
        const next = new Set(previous)
        for (const id of ids) next.delete(id)
        cached.forEach(id => next.add(id))
        return next
      })
    }
    const unsubscribe = libraryVersion.subscribe(() => { void refresh() })
    return () => { active = false; unsubscribe() }
  }, [tracks])

  const loadMore = useCallback(() => {
    const cursor = nextCursorRef.current
    if (!cursor || !hasMore || loadingRef.current) return
    void loadPages(cursor, generationRef.current)
  }, [hasMore, loadPages])
  const retry = useCallback(() => setRetryVersion(version => version + 1), [])
  return { tracks, cachedTrackIds, loading, error, hasMore, loadMore, retry }
}

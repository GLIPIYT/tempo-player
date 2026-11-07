import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { libraryVersion } from '../utils/libraryVersion'
import type { ScTrack } from '../types/models'
import { buildTasteProfile, type TasteProfile } from '../features/recommendations/profile'
import { genreShelfTracks, refillGenreRecommendations } from '../features/recommendations/genreFeed'
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
  const [loadedGenreKey, setLoadedGenreKey] = useState<string | null>(null)
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
      await refillGenreRecommendations({
        genreKey,
        profile: profileRef.current,
        tracks: providerTracksRef.current,
        loadedTrackIds: loadedIdsRef.current,
        seenCursors: seenCursorsRef.current,
        startCursor,
        fillTarget: FILL_TARGET,
        pageBudget: PAGE_BUDGET,
        minimumPages: startCursor === null ? 3 : 1,
        fetchPage: (cursor) => api.scRecommendationGenreSearch(genreLabel, cursor, PAGE_SIZE),
        isCurrent: () => generation === generationRef.current,
        onAppend: async (merged, appended) => {
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
        },
        onCursor: cursor => {
          nextCursorRef.current = cursor
          setHasMore(cursor !== null)
        },
      })
    } catch (cause: unknown) {
      if (generation === generationRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === generationRef.current) {
        loadingRef.current = false
        setLoading(false)
        setLoadedGenreKey(genreKey)
      }
    }
  }, [genreKey, genreLabel])

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
    setLoadedGenreKey(null)
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
    if (loadedGenreKey !== genreKey) return []
    return genreShelfTracks(providerTracks, fallbackCandidates, genreKey ?? '', profile, error)
  }, [loadedGenreKey, providerTracks, fallbackCandidates, genreKey, profile, error])

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
  const waitingForFirstResult = genreKey !== null && loadedGenreKey !== genreKey
  return { tracks, cachedTrackIds, loading: loading || waitingForFirstResult, error, hasMore, loadMore, retry }
}

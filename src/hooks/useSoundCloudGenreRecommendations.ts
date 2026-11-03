import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { libraryVersion } from '../utils/libraryVersion'
import type { ScTrack } from '../types/models'
import { buildTasteProfile, type TasteProfile } from '../features/recommendations/profile'
import { rankGenreTracks } from '../features/recommendations/genre'
import { recommendationService } from '../features/recommendations/service'

interface FavoriteGenre {
  key: string
  label: string
}

export function useSoundCloudGenreRecommendations(genre: FavoriteGenre | null, fallbackCandidates: readonly ScTrack[] = []) {
  const genreKey = genre?.key ?? null
  const genreLabel = genre?.label ?? null
  const [providerTracks, setProviderTracks] = useState<ScTrack[]>([])
  const [profile, setProfile] = useState<TasteProfile | null>(null)
  const [cachedTrackIds, setCachedTrackIds] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryVersion, setRetryVersion] = useState(0)

  useEffect(() => {
    if (!genreKey || !genreLabel) {
      setProviderTracks([])
      setProfile(null)
      setCachedTrackIds(new Set())
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setProviderTracks([])
    setProfile(null)
    setCachedTrackIds(new Set())
    setLoading(true)
    setError(null)

    void Promise.all([
      api.scRecommendationGenreSearch(genreLabel, 40).then(result => ({ result })).catch(cause => ({ cause })),
      api.getRecommendationContext().catch(() => null),
    ]).then(async ([request, context]) => {
      if (cancelled) return
      const nextProfile = context ? buildTasteProfile(context, Date.now()) : null
      setProfile(nextProfile)
      if ('cause' in request) throw request.cause
      const { result } = request
      if (result.error) throw new Error(result.error)
      const next = rankGenreTracks(result.tracks, genreKey, nextProfile)
      setProviderTracks(next)
      recommendationService.queueGenreAudioAnalysis(next)
      if (next.length) {
        const cached = await api.scGetCachedTrackIds(next.map((track) => track.id)).catch(() => [])
        if (!cancelled) setCachedTrackIds(previous => previous.size === cached.length && cached.every(id => previous.has(id))
          ? previous : new Set(cached))
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [genreKey, genreLabel, retryVersion])

  useEffect(() => {
    if (!genreKey) return
    let active = true
    const refreshProfile = () => {
      void api.getRecommendationContext().then(context => {
        if (active) setProfile(buildTasteProfile(context, Date.now()))
      }).catch(() => undefined)
    }
    window.addEventListener('tempo:recommendation-audio-updated', refreshProfile)
    return () => {
      active = false
      window.removeEventListener('tempo:recommendation-audio-updated', refreshProfile)
    }
  }, [genreKey])

  const tracks = useMemo(() => {
    const relevantProviderTracks = rankGenreTracks(providerTracks, genreKey ?? '', profile)
    return relevantProviderTracks.length > 0
      ? relevantProviderTracks
      : rankGenreTracks(fallbackCandidates, genreKey ?? '', profile)
  },
  [providerTracks, fallbackCandidates, genreKey, profile])

  useEffect(() => {
    if (tracks.length === 0) return
    let active = true
    const refresh = () => {
      void api.scGetCachedTrackIds(tracks.map(track => track.id))
        .then(ids => { if (active) setCachedTrackIds(previous => previous.size === ids.length && ids.every(id => previous.has(id))
          ? previous : new Set(ids)) })
        .catch(() => undefined)
    }
    const unsubscribe = libraryVersion.subscribe(refresh)
    return () => { active = false; unsubscribe() }
  }, [tracks])

  const retry = useCallback(() => setRetryVersion((version) => version + 1), [])
  return { tracks, cachedTrackIds, loading, error, retry }
}

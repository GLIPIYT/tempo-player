import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { libraryVersion } from '../utils/libraryVersion'
import type { ScTrack } from '../types/models'

interface FavoriteGenre {
  key: string
  label: string
}

export function useSoundCloudGenreRecommendations(genre: FavoriteGenre | null) {
  const genreKey = genre?.key ?? null
  const genreLabel = genre?.label ?? null
  const [tracks, setTracks] = useState<ScTrack[]>([])
  const [cachedTrackIds, setCachedTrackIds] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryVersion, setRetryVersion] = useState(0)

  useEffect(() => {
    if (!genreKey || !genreLabel) {
      setTracks([])
      setCachedTrackIds(new Set())
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setTracks([])
    setCachedTrackIds(new Set())
    setLoading(true)
    setError(null)

    void api.scRecommendationGenreSearch(genreLabel, 40).then(async (result) => {
      if (cancelled) return
      if (result.error) throw new Error(result.error)
      const seen = new Set<string>()
      const next = result.tracks.filter((track) => {
        if (!track.streamable || (!track.hasProgressive && !track.hasHls)) return false
        if (seen.has(track.id)) return false
        seen.add(track.id)
        return true
      })
      setTracks(next)
      if (next.length) {
        const cached = await api.scGetCachedTrackIds(next.map((track) => track.id)).catch(() => [])
        if (!cancelled) setCachedTrackIds(new Set(cached))
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [genreKey, genreLabel, retryVersion])

  useEffect(() => {
    if (tracks.length === 0) return
    let active = true
    const refresh = () => {
      void api.scGetCachedTrackIds(tracks.map(track => track.id))
        .then(ids => { if (active) setCachedTrackIds(new Set(ids)) })
        .catch(() => undefined)
    }
    const unsubscribe = libraryVersion.subscribe(refresh)
    return () => { active = false; unsubscribe() }
  }, [tracks])

  const retry = useCallback(() => setRetryVersion((version) => version + 1), [])
  return { tracks, cachedTrackIds, loading, error, retry }
}

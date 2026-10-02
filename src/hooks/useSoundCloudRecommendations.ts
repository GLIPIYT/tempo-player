import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { ScTrack, TopTrackItem } from '../types/models'

const CACHE_TTL_MS = 30 * 60 * 1000
const MAX_SEEDS_PER_BATCH = 3
const MAX_TRACKS = 48

interface RecommendationCache {
  expiresAt: number
  tracks: ScTrack[]
  usedTopTrackIds: string[]
}

let sessionCache: RecommendationCache | null = null

function readSessionCache(): RecommendationCache | null {
  if (!sessionCache || sessionCache.expiresAt <= Date.now()) return null
  return sessionCache
}

function shuffled<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

async function resolveSeed(item: TopTrackItem): Promise<string | null> {
  const track = item.track
  if (track.source === 'soundcloud' && track.externalId && /^\d+$/.test(track.externalId)) {
    return track.externalId
  }

  const query = [track.artistName, track.title].filter((part) => part?.trim()).join(' ')
  if (!query) return null
  try {
    const hits = await api.scSearchTracks(query, 8, 0)
    if (hits.length === 0) return null
    const title = normalize(track.title)
    const artist = normalize(track.artistName ?? '')
    const match = hits.find((hit) => {
      if (normalize(hit.title) !== title) return false
      if (!artist) return true
      const candidateArtist = normalize(hit.artist)
      return candidateArtist === artist || candidateArtist.includes(artist) || artist.includes(candidateArtist)
    })
    return (match ?? hits[0]).id
  } catch {
    return null
  }
}

function mergeUnique(existing: ScTrack[], incoming: ScTrack[]): ScTrack[] {
  const merged = existing.slice(0, MAX_TRACKS)
  const known = new Set(merged.map((track) => track.id))
  for (const track of incoming) {
    if (merged.length >= MAX_TRACKS) break
    if (!track.streamable || (!track.hasProgressive && !track.hasHls) || known.has(track.id)) continue
    known.add(track.id)
    merged.push(track)
  }
  return merged
}

/**
 * Recommendations use the user's most played tracks as SoundCloud seeds.
 * Nothing is fetched until the home shelf comes near the viewport; results and
 * sampled seeds stay in memory for half an hour.
 */
export function useSoundCloudRecommendations(topTracks: TopTrackItem[] | null) {
  const [initial] = useState(readSessionCache)
  const [active, setActive] = useState(false)
  const [tracks, setTracks] = useState<ScTrack[]>(() => initial?.tracks ?? [])
  const [usedTopTrackIds, setUsedTopTrackIds] = useState<Set<string>>(
    () => new Set(initial?.usedTopTrackIds ?? []),
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasLoaded, setHasLoaded] = useState(initial !== null)
  const autoStarted = useRef(false)
  const inFlight = useRef(false)

  const activate = useCallback(() => setActive(true), [])

  const loadBatch = useCallback(async () => {
    if (inFlight.current || topTracks === null) return
    if (topTracks.length === 0) {
      setHasLoaded(true)
      setError(null)
      return
    }

    const candidates = shuffled(topTracks.filter(({ track }) => !usedTopTrackIds.has(String(track.id))))
      .slice(0, MAX_SEEDS_PER_BATCH)
    if (candidates.length === 0) {
      setHasLoaded(true)
      return
    }

    inFlight.current = true
    const previousSeeds = usedTopTrackIds
    const nextUsed = new Set(previousSeeds)
    for (const candidate of candidates) nextUsed.add(String(candidate.track.id))
    setUsedTopTrackIds(nextUsed)
    setLoading(true)
    setError(null)

    try {
      const seeds = await Promise.all(candidates.map(resolveSeed))
      const seedIds = [...new Set(seeds.filter((id): id is string => id !== null))]
      if (seedIds.length === 0) throw new Error('No matching SoundCloud tracks were found.')
      const related = await api.scRelatedTracks(seedIds, 24)
      const merged = mergeUnique(tracks, related)
      setTracks(merged)
      setHasLoaded(true)
      sessionCache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        tracks: merged,
        usedTopTrackIds: [...nextUsed],
      }
    } catch (cause) {
      setUsedTopTrackIds(previousSeeds)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
      inFlight.current = false
    }
  }, [topTracks, usedTopTrackIds, tracks])

  useEffect(() => {
    if (!active || topTracks === null || autoStarted.current) return
    autoStarted.current = true
    if (readSessionCache()) {
      setHasLoaded(true)
      return
    }
    void loadBatch()
  }, [active, topTracks, loadBatch])

  const retry = useCallback(() => {
    setError(null)
    void loadBatch()
  }, [loadBatch])

  const loadMore = useCallback(() => {
    setError(null)
    void loadBatch()
  }, [loadBatch])

  return {
    tracks,
    loading,
    error,
    hasLoaded,
    hasMore: tracks.length < MAX_TRACKS && topTracks !== null && usedTopTrackIds.size < topTracks.length,
    activate,
    retry,
    loadMore,
  }
}

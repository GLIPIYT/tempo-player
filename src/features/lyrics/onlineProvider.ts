import { api } from '../../api/client'
import type { OnlineLyricsCandidateData, UnifiedTrack } from '../../types/models'
import { parseLrc } from './lrc'
import type { LyricsProvider, LyricsResult } from './types'

const CACHE_CAP = 128
const cache = new Map<string, LyricsResult | null>()
const CANDIDATE_CACHE_CAP = 128
const candidateCache = new Map<string, LyricsCandidate[]>()

export interface LyricsCandidate {
  provider: OnlineLyricsCandidateData['provider']
  result: LyricsResult
  plain: OnlineLyricsCandidateData['plain']
  syncedLrc: OnlineLyricsCandidateData['syncedLrc']
  id?: OnlineLyricsCandidateData['id']
  trackName?: OnlineLyricsCandidateData['trackName']
  artistName?: OnlineLyricsCandidateData['artistName']
  albumName?: OnlineLyricsCandidateData['albumName']
  duration?: OnlineLyricsCandidateData['duration']
  instrumental?: OnlineLyricsCandidateData['instrumental']
  copyright?: OnlineLyricsCandidateData['copyright']
}

function cacheKey(track: UnifiedTrack): string {
  return `${track.artists[0] ?? ''}|${track.title}`
}

function candidateKey(artist: string, title: string): string {
  return `${artist.trim().toLowerCase()}|${title.trim().toLowerCase()}`
}

function store(key: string, value: LyricsResult | null): void {
  if (cache.size >= CACHE_CAP && !cache.has(key)) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, value)
}

function storeCandidates(key: string, value: LyricsCandidate[]): void {
  if (candidateCache.size >= CANDIDATE_CACHE_CAP && !candidateCache.has(key)) {
    const oldest = candidateCache.keys().next()
    if (!oldest.done) candidateCache.delete(oldest.value)
  }
  candidateCache.set(key, value)
}

function toResult(data: { plain: string | null; syncedLrc: string | null }): LyricsResult | null {
  if (data.syncedLrc) {
    const lines = parseLrc(data.syncedLrc)
    if (lines && lines.length > 0) return { kind: 'synced', lines }
  }
  const plain = data.plain?.trim()
  if (plain) return { kind: 'plain', text: plain }
  return null
}

export function toLyricsCandidates(raw: OnlineLyricsCandidateData[]): LyricsCandidate[] {
  const out: LyricsCandidate[] = []
  for (const entry of raw) {
    const result = toResult(entry)
    if (!result) continue
    out.push({ ...entry, result })
  }
  return out
}

export async function fetchOnlineLyricsCandidates(
  artist: string,
  title: string,
  _track?: UnifiedTrack,
): Promise<LyricsCandidate[]> {
  const key = candidateKey(artist, title)
  if (candidateCache.has(key)) return candidateCache.get(key) ?? []
  let raw: OnlineLyricsCandidateData[]
  try {
    raw = await api.fetchOnlineLyricsAll(artist, title)
  } catch {
    return []
  }
  const out = toLyricsCandidates(raw)
  storeCandidates(key, out)
  return out
}

export function clearOnlineLyricsCandidateCache(): void {
  cache.clear()
  candidateCache.clear()
}

export const OnlineLyricsProvider: LyricsProvider = {
  id: 'online',
  name: 'Online (LRCLib/Musixmatch/...)',
  async getLyrics(track: UnifiedTrack): Promise<LyricsResult | null> {
    if (!track.dbId && track.source === 'local') return null
    const key = cacheKey(track)
    if (cache.has(key)) return cache.get(key) ?? null
    let data: { plain: string | null; syncedLrc: string | null } | null
    try {
      data = await api.fetchOnlineLyrics(track.artists[0] ?? '', track.title)
    } catch {
      return null
    }
    const res = data ? toResult(data) : null
    store(key, res)
    return res
  },
}

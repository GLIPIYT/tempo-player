import type { Track } from '../types/models'

export interface HourMix {
  key: string
  title: string
  tracks: Track[]
}

function stableMixRank(id: number): number {
  let hash = 2166136261
  for (const char of String(id)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function buildHourMixes(picks: Track[], unknownArtist: string, hourMixTitle: string): HourMix[] {
  if (picks.length === 0) return []

  const mixes: HourMix[] = []
  const byArtist = new Map<string, Track[]>()
  for (const track of picks) {
    const artist = track.artistName?.trim()
    if (
      !artist ||
      artist.toLowerCase() === unknownArtist.toLowerCase() ||
      artist.toLowerCase() === 'unknown artist' ||
      artist.toLowerCase() === 'неизвестный исполнитель'
    ) continue
    const list = byArtist.get(artist)
    if (list) list.push(track)
    else byArtist.set(artist, [track])
  }

  if (picks.length >= 4) {
    const ordered = picks.slice().sort((a, b) => stableMixRank(a.id) - stableMixRank(b.id) || a.id - b.id)
    mixes.push({ key: 'mix', title: hourMixTitle, tracks: ordered.slice(0, 24) })
  }
  for (const [artist, tracks] of [...byArtist.entries()]
    .filter(([, tracks]) => tracks.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)) {
    mixes.push({ key: `artist:${artist}`, title: artist, tracks })
  }
  return mixes
}

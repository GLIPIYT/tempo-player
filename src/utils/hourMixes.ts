import type { Track } from '../types/models'

export type HomeMixKind = 'hour' | 'artist' | 'smart'

export interface HourMix {
  key: string
  kind: HomeMixKind
  title: string
  description: string
  tracks: Track[]
}

export interface SmartMixTitles {
  onRepeat: string
  newToYou: string
  forgottenFavorites: string
  noSkips: string
}

export interface HomeMixSources {
  /** A recent library window, combined with locally known history and favorites. */
  tracks: Track[]
  likedTrackIds: ReadonlySet<number>
  titles: SmartMixTitles
  now?: number
}

const MIX_LIMIT = 24
const MIN_SONG_SECONDS = 20
const DAY_SECONDS = 86_400

function stableMixRank(id: number): number {
  let hash = 2166136261
  for (const char of String(id)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function uniqueTracks(tracks: Track[]): Track[] {
  const seen = new Set<number>()
  return tracks.filter((track) => {
    if (seen.has(track.id)) return false
    seen.add(track.id)
    return true
  })
}

function isSong(track: Track): boolean {
  // Duration can be unknown for older library entries; otherwise omit short
  // notification sounds from music recommendations.
  return track.durationSec == null || track.durationSec >= MIN_SONG_SECONDS
}

function artistKey(track: Track): string {
  if (track.artistId != null) return `id:${track.artistId}`
  const name = track.artistName?.trim().toLocaleLowerCase()
  return name ? `name:${name}` : `track:${track.id}`
}

function diverseRanked(tracks: Track[], score: (track: Track) => number): Track[] {
  const ranked = uniqueTracks(tracks)
    .map((track) => ({ track, score: score(track) }))
    .sort((a, b) => b.score - a.score
      || (b.track.lastPlayedAt ?? 0) - (a.track.lastPlayedAt ?? 0)
      || stableMixRank(a.track.id) - stableMixRank(b.track.id)
      || a.track.id - b.track.id)

  const selected: Track[] = []
  const deferred: Track[] = []
  const artistCounts = new Map<string, number>()
  for (const { track } of ranked) {
    const key = artistKey(track)
    const count = artistCounts.get(key) ?? 0
    if (count >= 3) {
      deferred.push(track)
      continue
    }
    selected.push(track)
    artistCounts.set(key, count + 1)
    if (selected.length === MIX_LIMIT) break
  }

  // Keep small libraries useful; relax the per-artist cap only when it would
  // otherwise leave a short mix.
  if (selected.length < MIX_LIMIT) {
    const selectedIds = new Set(selected.map((track) => track.id))
    for (const track of deferred) {
      if (selectedIds.has(track.id)) continue
      selected.push(track)
      if (selected.length === MIX_LIMIT) break
    }
  }
  return selected
}

function smartMix(
  key: string,
  title: string,
  description: string,
  tracks: Track[],
  score: (track: Track) => number,
): HourMix | null {
  const ranked = diverseRanked(tracks.filter(isSong), score)
  return ranked.length >= 3 ? { key, kind: 'smart', title, description, tracks: ranked } : null
}

export function buildHourMixes(
  picks: Track[],
  unknownArtist: string,
  hourMixTitle: string,
  sources?: HomeMixSources,
): HourMix[] {
  if (picks.length === 0 && !sources) return []

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
    mixes.push({
      key: 'mix',
      kind: 'hour',
      title: hourMixTitle,
      description: 'Picked from what you usually play around this time of day',
      tracks: ordered.slice(0, MIX_LIMIT),
    })
  }
  for (const [artist, tracks] of [...byArtist.entries()]
    .filter(([, artistTracks]) => artistTracks.length >= 3)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, 3)) {
    mixes.push({
      key: `artist:${artist}`,
      kind: 'artist',
      title: artist,
      description: 'Tracks by this artist in your hourly picks',
      tracks,
    })
  }

  if (!sources) return mixes

  const now = sources.now ?? Math.floor(Date.now() / 1000)
  const allTracks = uniqueTracks(sources.tracks).filter(isSong)
  const liked = sources.likedTrackIds
  const twoWeeksAgo = now - 14 * DAY_SECONDS
  const monthAgo = now - 30 * DAY_SECONDS
  const activeArtists = new Set(allTracks
    .filter((track) => liked.has(track.id) || track.playCount >= 3)
    .map(artistKey))
  const activeGenres = new Set(allTracks
    .filter((track) => liked.has(track.id) || track.playCount >= 3)
    .map((track) => track.genre?.trim().toLocaleLowerCase())
    .filter((genre): genre is string => Boolean(genre)))

  const onRepeat = smartMix(
    'smart:on-repeat',
    sources.titles.onRepeat,
    'Tracks you return to most often',
    allTracks.filter((track) =>
      track.lastPlayedAt != null &&
      track.lastPlayedAt >= twoWeeksAgo &&
      (track.playCount >= 2 || liked.has(track.id))),
    (track) => {
      const ageDays = Math.max(0, (now - (track.lastPlayedAt ?? now)) / DAY_SECONDS)
      const skipRate = track.playCount > 0 ? track.skipCount / track.playCount : 0
      return Math.log1p(track.playCount) * Math.exp(-ageDays / 10)
        + (liked.has(track.id) ? 0.35 : 0)
        - Math.min(1, skipRate) * 0.7
    },
  )
  if (onRepeat) mixes.push(onRepeat)

  const newToYou = smartMix(
    'smart:new-to-you',
    sources.titles.newToYou,
    'Recently added tracks you have barely played',
    allTracks.filter((track) => track.addedAt >= monthAgo && track.playCount <= 1),
    (track) => {
      const ageDays = Math.max(0, (now - track.addedAt) / DAY_SECONDS)
      const genre = track.genre?.trim().toLocaleLowerCase()
      const familiarity = (activeArtists.has(artistKey(track)) ? 2 : 0)
        + (genre && activeGenres.has(genre) ? 1 : 0)
      return familiarity + Math.exp(-ageDays / 30) - track.playCount * 0.25
    },
  )
  if (newToYou) mixes.push(newToYou)

  const forgotten = smartMix(
    'smart:forgotten-favorites',
    sources.titles.forgottenFavorites,
    "Favorites you haven't played in a month",
    allTracks.filter((track) =>
      (liked.has(track.id) || track.playCount >= 3) &&
      (track.lastPlayedAt == null || track.lastPlayedAt < monthAgo)),
    (track) => Math.log1p(track.playCount)
      + (liked.has(track.id) ? 1.5 : 0)
      + Math.min(0.5, Math.max(0, (now - (track.lastPlayedAt ?? monthAgo)) / (365 * DAY_SECONDS))),
  )
  if (forgotten) mixes.push(forgotten)

  const noSkips = smartMix(
    'smart:no-skips',
    sources.titles.noSkips,
    'Tracks you usually listen to without skipping',
    allTracks.filter((track) =>
      track.playCount >= 5 &&
      track.skipCount <= Math.floor(track.playCount * 0.15)),
    (track) => track.playCount - track.skipCount * 2,
  )
  if (noSkips) mixes.push(noSkips)

  return mixes
}

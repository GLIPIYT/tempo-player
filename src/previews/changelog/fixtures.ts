import showcase from '../../../docs/design/changelog-1.5.0/user-showcase.json'
import type { Album, AnalyticsData, DailyMinutes, HistoryEntry, ListeningPeriodStats, Playlist, Track } from '../../types/models'
import { normalizeCustomMixRule, type CustomMixRule } from '../../features/mixes/types'

// Only metadata and artwork explicitly approved for the changelog are bundled.
// This isolated fixture never opens the live database or an authenticated session.
const publicAsset = (path: string | null) => path ? new URL(path, window.location.origin).href : null
const adaptTrack = (track: typeof showcase.tracks[number]): Track => ({
  ...track,
  source: track.source as Track['source'],
  coverPath: publicAsset(track.coverPath),
})

export const fixtureIdentity = {
  nickname: showcase.identity.nickname,
  avatarPath: publicAsset(`/docs/design/changelog-1.5.0/${showcase.identity.avatarPath}`)!,
}
export const fixtureTracks = showcase.tracks.map(adaptTrack)
const pair = (value: number[]): [number, number] => {
  if (value.length !== 2) throw new Error('Expected a saved two-ended rule range')
  return [value[0], value[1]]
}
export const fixtureCustomRule = normalizeCustomMixRule({
  ...showcase.customRule,
  artistMode: showcase.customRule.artistMode as CustomMixRule['artistMode'],
  genreMode: showcase.customRule.genreMode as CustomMixRule['genreMode'],
  sources: showcase.customRule.sources as CustomMixRule['sources'],
  artistPercent: [0, 100],
  timeWindow: pair(showcase.customRule.timeWindow),
  completionPercent: pair(showcase.customRule.completionPercent),
  genrePercent: pair(showcase.customRule.genrePercent),
  forgottenPercent: pair(showcase.customRule.forgottenPercent),
  forgottenDays: pair(showcase.customRule.forgottenDays),
})
export const fixtureCustomTracks = showcase.customTrackIds.flatMap(id => fixtureTracks.filter(track => track.id === id))
export const fixtureArtists = showcase.artists.map(artist => ({ ...artist, imagePath: publicAsset(artist.imagePath) }))
export const fixtureAlbums: Album[] = showcase.albums.map(album => ({ ...album, coverPath: publicAsset(album.coverPath) }))
export const fixturePlaylists: Playlist[] = showcase.playlists.map(playlist => ({ ...playlist, coverPath: publicAsset(playlist.coverPath) }))
export const fixtureHistory: HistoryEntry[] = showcase.history.map(entry => ({ ...entry, track: adaptTrack(entry.track) }))
export const fixtureDailyMinutes: DailyMinutes[] = showcase.daily
export const fixtureAnalytics: AnalyticsData = {
  summary: showcase.summary,
  topTracks: showcase.topTrackIds.flatMap(id => {
    const track = fixtureTracks.find(item => item.id === id)
    return track ? [{ track, playCount: (showcase.trackCounts as Record<string, number>)[id] ?? 0 }] : []
  }),
  topArtists: fixtureArtists.map(artist => ({ artist, playCount: artist.plays })),
  recent: fixtureHistory,
}
export const fixturePeriods: ListeningPeriodStats[] = showcase.periods.map(period => ({
  ...period,
  topTracks: period.topTracks.map(item => ({ ...item, track: adaptTrack(item.track) })),
  topTrack: period.topTrack ? { ...period.topTrack, track: adaptTrack(period.topTrack.track) } : null,
  topArtist: period.topArtist ? { ...period.topArtist, artist: {
    ...period.topArtist.artist, imagePath: publicAsset(period.topArtist.artist.imagePath),
  } } : null,
}))

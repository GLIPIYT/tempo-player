import type { BaseView, View } from '../state/nav'
import type { Track } from '../types/models'
import { getKnownSoundCloudTrack } from '../soundcloud/cacheMetadata'

function comparableArtistName(name: string | null | undefined): string {
  return name?.trim().normalize('NFKC').toLowerCase() ?? ''
}

function sameArtistPage(view: BaseView, track: Track): boolean {
  if (view.name === 'artist') return track.artistId === view.id
  if (view.name === 'local-artist') {
    return comparableArtistName(track.artistName) !== ''
      && comparableArtistName(track.artistName) === comparableArtistName(view.artistName)
  }
  if (view.name === 'sc-artist') {
    const known = track.source === 'soundcloud' && track.externalId
      ? getKnownSoundCloudTrack(track.externalId)
      : null
    return known?.uploaderId === view.id
      || comparableArtistName(track.artistName) !== ''
        && comparableArtistName(track.artistName) === comparableArtistName(view.artistName ?? view.fallback?.artistName)
  }
  if (view.name === 'yt-collection' && view.kind === 'artist') {
    return comparableArtistName(track.artistName) !== ''
      && comparableArtistName(track.artistName) === comparableArtistName(view.artistName)
  }
  return false
}

/** Menu actions that would navigate back to the page already showing this track. */
export function trackMenuNavigationVisibility(view: View, track: Track): { artist: boolean; album: boolean } {
  if (view.name === 'track-details') return { artist: track.artistId != null, album: track.albumId != null }
  const page = view
  return {
    artist: track.artistId != null && !sameArtistPage(page, track),
    album: track.albumId != null && !(page.name === 'album' && page.id === track.albumId),
  }
}

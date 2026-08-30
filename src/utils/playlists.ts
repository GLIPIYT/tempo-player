import type { Playlist } from '../types/models'

/** The auto-created Likes playlist ships with the name 'Likes'; localized until renamed. */
export function playlistDisplayName(playlist: Playlist | undefined | null, fallback: string, t: (key: string) => string): string {
  if (!playlist) return fallback
  if (playlist.isLikes && playlist.name === 'Likes') return t('Likes')
  return playlist.name
}

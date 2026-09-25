import type { Lang } from './index'

type Unit = 'artist' | 'album' | 'playlist' | 'track'

const forms: Record<Unit, [string, string, string]> = {
  artist: ['artist', 'artists few', 'artists'],
  album: ['album', 'albums few', 'albums'],
  playlist: ['playlist', 'playlists few', 'playlists'],
  track: ['track', 'tracks few', 'tracks'],
}

export function formatCount(count: number, unit: Unit, t: (key: string) => string, lang: Lang): string {
  const category = new Intl.PluralRules(lang).select(count)
  const [one, few, other] = forms[unit]
  return `${count} ${t(category === 'one' ? one : category === 'few' ? few : other)}`
}

import { resolveLang, useT, type Lang } from './index'
import { useSettings } from '../state/settings'

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

export function useFormatCount(): (count: number, unit: Unit) => string {
  const t = useT()
  const { settings } = useSettings()
  const lang = resolveLang(settings.lang)
  return (count, unit) => formatCount(count, unit, t, lang)
}

import showcase from '../../../docs/design/changelog-1.5.0/user-showcase.json'
import library from '../../../docs/design/library-redesign/sample-data.json'

const libraryArt = '/docs/design/library-redesign/assets/'
const covers = '/docs/design/changelog-1.5.0/figures/covers/'

export type Track = { id: number; title: string; artist: string; art: string | null; seconds: number }
export type Artist = { name: string; art: string | null; count: number; plays?: number }
export type Mix = { name: string; hint: string; kind: string; tracks: Track[]; art: string }

export const tracks: Track[] = showcase.tracks.map(track => ({
  id: track.id,
  title: track.title.replace(/^CUPSIZE\s*-\s*/i, ''),
  artist: track.artistName ?? 'Неизвестный исполнитель',
  art: track.coverPath,
  seconds: track.durationSec ?? 180,
}))

const withArt = tracks.filter(item => item.art)
export const recent = [...tracks.slice(0, 3), ...withArt.slice(14, 20)]
export const recommendations = [...withArt.slice(20), ...withArt.slice(14, 20), ...withArt.slice(0, 8)]
export const genreTracks = [...withArt.slice(14, 20), ...withArt.slice(3, 8), ...withArt.slice(-4)]
export const mostPlayed = showcase.topTrackIds.flatMap(id => {
  const song = tracks.find(item => item.id === id)
  return song ? [song] : []
})
export const recentlyAdded = [...withArt.slice(-8), ...withArt.slice(5, 11)]
export const initialLikes = mostPlayed.slice(2).map(song => song.id)
export const playlists: Mix[] = showcase.playlists.map((playlist, index) => ({
  name: playlist.name, hint: '', kind: 'Плейлист',
  tracks: recommendations.slice(index * 3, index * 3 + 8), art: playlist.coverPath,
}))

export const mixes: Mix[] = [
  { name: 'Музыка этого часа', hint: 'Песни, которые вы обычно слушаете в это время', kind: 'Подборка Tempo', tracks: recent, art: libraryArt + 'cover-2.png' },
  { name: 'CUPSIZE', hint: 'Любимые песни и редкие записи исполнителя', kind: 'Микс исполнителя', tracks: tracks.filter(item => item.artist === 'CUPSIZE'), art: libraryArt + 'cover-1.jpg' },
  { name: 'На повторе', hint: 'Треки, к которым вы чаще всего возвращаетесь', kind: 'Из медиатеки', tracks: withArt.slice(-9), art: covers + '5a2d7533fa7ab571.jpg' },
  { name: 'Новое для вас', hint: 'Недавно добавленные песни, которые вы ещё мало слушали', kind: 'Из медиатеки', tracks: recommendations.slice(0, 8), art: covers + 'f781543b4de0bb62.jpg' },
]

export const favoriteArtists: Artist[] = [
  { name: 'CUPSIZE', art: libraryArt + 'artist-2.jpg', count: 90, plays: 1240 },
  { name: 'ssshhhiiittt!', art: libraryArt + 'artist-3.jpg', count: 27, plays: 318 },
  { name: 'Clarion', art: libraryArt + 'artist-1.jpg', count: 14, plays: 167 },
]

const startingArtists: Artist[] = showcase.artists
  .filter(artist => !favoriteArtists.some(favorite => favorite.name === artist.name))
  .map(artist => ({ name: artist.name, art: artist.imagePath, count: artist.trackCount ?? 1 }))

const catalogNames = [
  'Автоспорт', 'конец солнечных дней', 'Егор Воронеж', 'DJ ZUP RAlii', 'тёмный принц', 'Hhnglee', 'Пошлая Молли',
  'Дайте танк (!)', 'nyan.mp3', 'madk1d', 'VILLIAN', 'never goodbye', 'Uralic Archive', 'deceit', 'Depre??sed',
  'Молчат Дома', 'Буерак', 'Пасош', 'Хмыров', 'Дурной Вкус', 'Бонд с кнопкой', 'Увула', 'Перемотка', 'Где Фантом?',
  'Деревянные киты', 'Электрофорез', 'Плохо', 'Утро', 'Луна', 'Сова', 'Кино', 'АукцЫон', 'Земфира', 'Сплин', 'Motorama',
  'Дельфин', 'Космонавтов Нет', 'Кис-кис', 'shiawase', 'dierreite', 'Madkid', 'boogshi', 'tw1zen!', 'farmac0l0r',
]
export const artists = [...favoriteArtists, ...startingArtists, ...catalogNames.map((name, i): Artist => {
  const albumCover = library.albums.find(album => album.artist === name)?.cover
  return {
    name,
    art: tracks.find(item => item.artist === name)?.art ?? showcase.albums.find(album => album.artistName === name)?.coverPath
      ?? (albumCover ? libraryArt + albumCover : null),
    count: 1 + i % 19,
  }
})]

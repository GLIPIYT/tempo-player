import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  api: {
    isFavoriteArtist: vi.fn(),
    getArtistTracks: vi.fn(),
    toggleFavoriteArtist: vi.fn(),
    isFavoriteAlbum: vi.fn(),
    getAlbum: vi.fn(),
    toggleFavoriteAlbum: vi.fn(),
    getPlaylist: vi.fn(),
    recordPlaylistStart: vi.fn(),
    setPlaylistPinned: vi.fn(),
  },
  openContextMenu: vi.fn(),
  playTracks: vi.fn(),
  bumpLibraryVersion: vi.fn(),
  toastShow: vi.fn(),
}))

vi.mock('../../api/client', () => ({ api: mocks.api }))
vi.mock('../../components/common/ContextMenu', () => ({ openContextMenu: mocks.openContextMenu }))
vi.mock('../../components/common/Toast', () => ({ toast: { show: mocks.toastShow } }))
vi.mock('../../player/controller', () => ({ playerController: { playTracks: mocks.playTracks } }))
vi.mock('../../utils/libraryVersion', () => ({ bumpLibraryVersion: mocks.bumpLibraryVersion }))
vi.mock('../../utils/unified', () => ({
  trackToUnified: (track: { id: number }) => `track:${track.id}`,
  tracksToUnified: (tracks: { id: number }[]) => tracks.map(track => `track:${track.id}`),
}))

import type { MouseEvent as ReactMouseEvent } from 'react'
import { createProfileEntityMenus } from './entityMenus'
import type { Artist, Playlist } from '../../types/models'

const t = (key: string) => key
const artist: Artist = { id: 11, name: 'Artist', trackCount: 3 }
const album = { id: 21, title: 'Album' }
const playlist: Playlist = { id: 31, name: 'Playlist', trackCount: 2, pinned: true, isLikes: false,
  createdAt: 0, updatedAt: 0 }
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }

function event(x: number, y: number, connected = true): ReactMouseEvent<HTMLElement> {
  return { preventDefault: vi.fn(), clientX: x, clientY: y, currentTarget: { isConnected: connected } } as unknown as ReactMouseEvent<HTMLElement>
}
function itemsAt(index = 0) {
  const request = mocks.openContextMenu.mock.calls[index][0] as { title: string; x: number; y: number; trigger: HTMLElement; items: { id: string; label: string; onSelect: () => void }[] }
  return { request, items: new Map(request.items.map(item => [item.id, item])) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => vi.resetAllMocks())

it('builds artist actions from the current favorite state and uses shared player/navigation actions', async () => {
  const navigate = vi.fn()
  const menus = createProfileEntityMenus({ t, navigate })
  mocks.api.isFavoriteArtist.mockResolvedValue(true)
  mocks.api.getArtistTracks.mockResolvedValue([{ id: 7 }])
  mocks.api.toggleFavoriteArtist.mockResolvedValue(false)

  const triggerEvent = event(120, 240)
  const trigger = triggerEvent.currentTarget
  menus.artist(triggerEvent, artist)
  await flush()

  const { request, items } = itemsAt()
  expect(triggerEvent.preventDefault).toHaveBeenCalled()
  expect(request).toMatchObject({ title: 'Artist', x: 120, y: 240, trigger })
  expect(items.get('favorite')?.label).toBe('Remove from favorites')
  items.get('open')?.onSelect()
  expect(navigate).toHaveBeenCalledWith({ name: 'artist', id: artist.id })
  items.get('play')?.onSelect()
  await flush()
  expect(mocks.api.getArtistTracks).toHaveBeenCalledWith(artist.id)
  expect(mocks.playTracks).toHaveBeenCalledWith(['track:7'], 0)
  items.get('favorite')?.onSelect()
  await flush()
  expect(mocks.api.toggleFavoriteArtist).toHaveBeenCalledWith(artist.id)
  expect(mocks.bumpLibraryVersion).toHaveBeenCalledOnce()
})

it('loads album tracks for Play all and fetches the favorite label before opening', async () => {
  const navigate = vi.fn()
  const menus = createProfileEntityMenus({ t, navigate })
  mocks.api.isFavoriteAlbum.mockResolvedValue(false)
  mocks.api.getAlbum.mockResolvedValue({ album, tracks: [{ id: 8 }] })
  mocks.api.toggleFavoriteAlbum.mockResolvedValue(true)

  menus.album(event(30, 40), album)
  await flush()
  const { request, items } = itemsAt()
  expect(request.title).toBe(album.title)
  expect(items.get('favorite')?.label).toBe('Add to favorites')
  items.get('open')?.onSelect()
  expect(navigate).toHaveBeenCalledWith({ name: 'album', id: album.id })
  items.get('play')?.onSelect()
  await flush()
  expect(mocks.api.getAlbum).toHaveBeenCalledWith(album.id)
  expect(mocks.playTracks).toHaveBeenCalledWith(['track:8'], 0)
  items.get('favorite')?.onSelect()
  await flush()
  expect(mocks.api.toggleFavoriteAlbum).toHaveBeenCalledWith(album.id)
  expect(mocks.bumpLibraryVersion).toHaveBeenCalledOnce()
})

it('plays and pins playlists, then delegates deletable playlists to the confirmation callback', async () => {
  const navigate = vi.fn()
  const onDeletePlaylist = vi.fn()
  const menus = createProfileEntityMenus({ t, navigate, onDeletePlaylist })
  mocks.api.getPlaylist.mockResolvedValue([{ track: { id: 9 } }])
  mocks.api.recordPlaylistStart.mockResolvedValue(undefined)
  mocks.api.setPlaylistPinned.mockResolvedValue(undefined)

  menus.playlist(event(50, 60), playlist)
  const { request, items } = itemsAt()
  expect(request.title).toBe('Playlist')
  expect(items.get('favorite')?.label).toBe('Remove from favorites')
  items.get('open')?.onSelect()
  expect(navigate).toHaveBeenCalledWith({ name: 'playlist', id: playlist.id })
  items.get('play')?.onSelect()
  await flush()
  expect(mocks.api.getPlaylist).toHaveBeenCalledWith(playlist.id)
  expect(mocks.playTracks).toHaveBeenCalledWith(['track:9'], 0)
  expect(mocks.api.recordPlaylistStart).toHaveBeenCalledWith(playlist.id)
  expect(mocks.api.setPlaylistPinned).not.toHaveBeenCalled()
  items.get('favorite')?.onSelect()
  await flush()
  expect(mocks.api.setPlaylistPinned).toHaveBeenCalledWith(playlist.id, false)
  items.get('delete')?.onSelect()
  expect(onDeletePlaylist).toHaveBeenCalledWith(playlist)

  menus.playlist(event(70, 80), { ...playlist, id: 1, name: 'Likes', isLikes: true })
  expect(itemsAt(1).items.has('delete')).toBe(false)
})

it('does not open a slower old favorite lookup after a newer entity menu request', async () => {
  const menus = createProfileEntityMenus({ t, navigate: vi.fn() })
  const favoriteGate = deferred<boolean>()
  mocks.api.isFavoriteArtist.mockReturnValue(favoriteGate.promise)

  menus.artist(event(10, 20), artist)
  menus.playlist(event(30, 40), playlist)
  expect(mocks.openContextMenu).toHaveBeenCalledOnce()
  favoriteGate.resolve(true)
  await flush()

  expect(mocks.openContextMenu).toHaveBeenCalledOnce()
  expect(itemsAt().request.title).toBe('Playlist')
})

it('does not open a menu when the source card has been removed', async () => {
  const menus = createProfileEntityMenus({ t, navigate: vi.fn() })
  mocks.api.isFavoriteAlbum.mockResolvedValue(false)
  menus.album(event(1, 2, false), album)
  await flush()
  expect(mocks.openContextMenu).not.toHaveBeenCalled()
})

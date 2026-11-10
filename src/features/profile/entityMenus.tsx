import type { MouseEvent as ReactMouseEvent } from 'react'
import { ArrowUpRight, Heart, Play, Trash2 } from 'lucide-react'
import { api } from '../../api/client'
import { openContextMenu, type ContextMenuItem } from '../../components/common/ContextMenu'
import { toast } from '../../components/common/Toast'
import type { BaseView } from '../../state/nav'
import type { Artist, Playlist } from '../../types/models'
import { trackToUnified, tracksToUnified } from '../../utils/unified'
import { bumpLibraryVersion } from '../../utils/libraryVersion'
import { playlistDisplayName } from '../../utils/playlists'
import { playerController } from '../../player/controller'

export interface ProfileAlbumMenuTarget {
  id: number
  title: string
}

export interface ProfileEntityMenuOptions {
  t: (key: string) => string
  navigate: (view: BaseView) => void
  onDeletePlaylist?: (playlist: Playlist) => void
}

export interface ProfileEntityMenus {
  artist(event: ReactMouseEvent<HTMLElement>, artist: Artist): void
  album(event: ReactMouseEvent<HTMLElement>, album: ProfileAlbumMenuTarget): void
  playlist(event: ReactMouseEvent<HTMLElement>, playlist: Playlist): void
}

interface MenuRequest {
  id: number
  x: number
  y: number
  trigger: HTMLElement
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createProfileEntityMenus({ t, navigate, onDeletePlaylist }: ProfileEntityMenuOptions): ProfileEntityMenus {
  let latestRequest = 0

  const beginRequest = (event: ReactMouseEvent<HTMLElement>): MenuRequest => {
    event.preventDefault()
    return { id: ++latestRequest, x: event.clientX, y: event.clientY, trigger: event.currentTarget }
  }
  const isCurrent = (request: MenuRequest): boolean => request.id === latestRequest && request.trigger.isConnected
  const show = (request: MenuRequest, title: string, items: ContextMenuItem[]): void => {
    if (!isCurrent(request)) return
    openContextMenu({ x: request.x, y: request.y, title, items, trigger: request.trigger })
  }
  const reportError = (error: unknown): void => toast.show(errorText(error), 'error')

  const playArtist = async (artist: Artist): Promise<void> => {
    try {
      const tracks = await api.getArtistTracks(artist.id)
      if (tracks.length > 0) playerController.playTracks(tracksToUnified(tracks), 0)
    } catch (error) {
      reportError(error)
    }
  }
  const playAlbum = async (album: ProfileAlbumMenuTarget): Promise<void> => {
    try {
      const detail = await api.getAlbum(album.id)
      if (detail.tracks.length > 0) playerController.playTracks(tracksToUnified(detail.tracks), 0)
    } catch (error) {
      reportError(error)
    }
  }
  const playPlaylist = async (playlist: Playlist): Promise<void> => {
    try {
      const rows = await api.getPlaylist(playlist.id)
      if (rows.length === 0) return
      playerController.playTracks(rows.map(row => trackToUnified(row.track)), 0)
      await api.recordPlaylistStart(playlist.id)
      bumpLibraryVersion()
    } catch (error) {
      reportError(error)
    }
  }

  return {
    artist(event, artist) {
      const request = beginRequest(event)
      void api.isFavoriteArtist(artist.id).then(isFavorite => {
        show(request, artist.name, [
          { id: 'open', label: t('Open'), icon: <ArrowUpRight size={13} />, onSelect: () => navigate({ name: 'artist', id: artist.id }) },
          { id: 'play', label: t('Play all'), icon: <Play size={13} />, disabled: artist.trackCount === 0, onSelect: () => { void playArtist(artist) } },
          { id: 'favorite', label: isFavorite ? t('Remove from favorites') : t('Add to favorites'),
            icon: <Heart size={13} fill={isFavorite ? 'currentColor' : 'none'} />, onSelect: () => {
              void api.toggleFavoriteArtist(artist.id).then(() => bumpLibraryVersion()).catch(reportError)
            } },
        ])
      }).catch(error => { if (isCurrent(request)) reportError(error) })
    },
    album(event, album) {
      const request = beginRequest(event)
      void api.isFavoriteAlbum(album.id).then(isFavorite => {
        show(request, album.title, [
          { id: 'open', label: t('Open'), icon: <ArrowUpRight size={13} />, onSelect: () => navigate({ name: 'album', id: album.id }) },
          { id: 'play', label: t('Play all'), icon: <Play size={13} />, onSelect: () => { void playAlbum(album) } },
          { id: 'favorite', label: isFavorite ? t('Remove from favorites') : t('Add to favorites'),
            icon: <Heart size={13} fill={isFavorite ? 'currentColor' : 'none'} />, onSelect: () => {
              void api.toggleFavoriteAlbum(album.id).then(() => bumpLibraryVersion()).catch(reportError)
            } },
        ])
      }).catch(error => { if (isCurrent(request)) reportError(error) })
    },
    playlist(event, playlist) {
      const request = beginRequest(event)
      const name = playlistDisplayName(playlist, playlist.name, t)
      const pinned = playlist.pinned === true
      const items: ContextMenuItem[] = [
        { id: 'open', label: t('Open'), icon: <ArrowUpRight size={13} />, onSelect: () => navigate({ name: 'playlist', id: playlist.id }) },
        { id: 'play', label: t('Play all'), icon: <Play size={13} />, disabled: (playlist.trackCount ?? 0) === 0,
          onSelect: () => { void playPlaylist(playlist) } },
        { id: 'favorite', label: pinned ? t('Remove from favorites') : t('Add to favorites'),
          icon: <Heart size={13} fill={pinned ? 'currentColor' : 'none'} />, onSelect: () => {
            void api.setPlaylistPinned(playlist.id, !pinned).then(() => bumpLibraryVersion()).catch(reportError)
          } },
      ]
      if (!playlist.isLikes && onDeletePlaylist) {
        items.push({ id: 'delete', label: t('Delete playlist'), icon: <Trash2 size={13} />, danger: true,
          onSelect: () => onDeletePlaylist(playlist) })
      }
      show(request, name, items)
    },
  }
}

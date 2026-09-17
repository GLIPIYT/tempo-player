import type { MouseEvent } from 'react'
import { Check, Download, ExternalLink, Star } from 'lucide-react'
import type { ScArtist, ScPlaylist } from '../../types/models'
import { useNav } from '../../state/nav'
import { useT } from '../../i18n'
import ScArtwork from './ScArtwork'
import { toast } from './Toast'
import { openContextMenu, type ContextMenuItem } from './ContextMenu'
import CacheBadge from '../../soundcloud/CacheBadge'
import { favoritePlaylist, requestArtistCache, requestPlaylistCache } from '../../soundcloud/cacheJobs'

/**
 * The two SoundCloud result shapes, shared by the search page and the artist
 * page. Both open the in-app view, which reads live from SoundCloud - nothing
 * reaches the library until it is cached or favorited.
 */

/** Shared: a failed request should say so rather than do nothing visible. */
function report(promise: Promise<unknown>): void {
  promise.catch((e: unknown) => {
    toast.show(e instanceof Error ? e.message : String(e), 'error')
  })
}

export function ScPlaylistCard({ playlist }: { playlist: ScPlaylist }) {
  const t = useT()
  const { navigate } = useNav()

  const cache = (): void => {
    report(
      requestPlaylistCache(playlist).then((outcome) => {
        if (outcome === 'started') toast.show(t('Caching started'))
        else if (outcome === 'empty') toast.show(t('Nothing in this playlist can be cached'), 'info')
        // 'asked' leaves the name question on screen; it reports its own result
      }),
    )
  }

  const favorite = (): void => {
    report(
      favoritePlaylist(playlist).then((outcome) => {
        if (outcome === 'started') toast.show(t('Added to favorites'))
        else if (outcome === 'empty') toast.show(t('Nothing in this playlist can be cached'), 'info')
      }),
    )
  }

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    const items: ContextMenuItem[] = [
      { id: 'cache', label: t('Cache playlist'), icon: <Download size={13} />, onSelect: cache },
      { id: 'fav', label: t('Add to favorites'), icon: <Star size={13} />, onSelect: favorite },
    ]
    if (playlist.permalinkUrl) {
      items.push({
        id: 'open',
        label: t('Open on SoundCloud'),
        icon: <ExternalLink size={13} />,
        onSelect: () => window.open(playlist.permalinkUrl ?? '', '_blank'),
      })
    }
    openContextMenu({ x: e.clientX, y: e.clientY, title: playlist.title, items })
  }

  return (
    <button
      type="button"
      className="card sc-card"
      title={playlist.title}
      onClick={() => navigate({ name: 'sc-playlist', id: playlist.id })}
      onContextMenu={onContextMenu}
    >
      <span className="sc-card-art">
        <CacheBadge kind="playlist" scId={playlist.id}>
          <ScArtwork url={playlist.artworkUrl} title={playlist.title} />
        </CacheBadge>
      </span>
      <span className="card-title">{playlist.title}</span>
      <span className="card-sub">{playlist.user}</span>
      <span className="card-sub">
        {playlist.trackCount} {t('tracks')}
        {playlist.isAlbum ? ` · ${t('Album')}` : ''}
      </span>
    </button>
  )
}

export function ScArtistRow({ artist }: { artist: ScArtist }) {
  const t = useT()
  const { navigate } = useNav()

  const keep = (favorite: boolean): void => {
    report(
      requestArtistCache(artist, favorite).then((outcome) => {
        if (outcome === 'started') {
          toast.show(favorite ? t('Added to favorites') : t('Caching started'))
        } else if (outcome === 'empty') {
          toast.show(t('Nothing to cache for this artist'), 'info')
        }
        // 'asked' leaves the track picker on screen; it reports its own result
      }),
    )
  }

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    const items: ContextMenuItem[] = [
      {
        id: 'cache',
        label: t('Cache artist'),
        icon: <Download size={13} />,
        onSelect: () => keep(false),
      },
      {
        id: 'fav',
        label: t('Add to favorites'),
        icon: <Star size={13} />,
        onSelect: () => keep(true),
      },
    ]
    if (artist.permalinkUrl) {
      items.push({
        id: 'open',
        label: t('Open on SoundCloud'),
        icon: <ExternalLink size={13} />,
        onSelect: () => window.open(artist.permalinkUrl ?? '', '_blank'),
      })
    }
    openContextMenu({ x: e.clientX, y: e.clientY, title: artist.username, items })
  }

  return (
    <button
      type="button"
      className="arow"
      onClick={() => navigate({ name: 'sc-artist', id: artist.id })}
      onContextMenu={onContextMenu}
    >
      <span className="arow-art">
        <CacheBadge kind="artist" scId={artist.id}>
          <ScArtwork url={artist.avatarUrl} title={artist.username} />
        </CacheBadge>
      </span>
      <span className="arow-name">
        {artist.username}
        {artist.verified ? <Check size={13} className="sc-verified" /> : null}
      </span>
      <span className="arow-meta">
        {artist.trackCount} {t('tracks')}
      </span>
    </button>
  )
}

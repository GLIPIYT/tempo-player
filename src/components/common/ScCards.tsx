import type { MouseEvent } from 'react'
import { Check, Download, ExternalLink } from 'lucide-react'
import type { ScArtist, ScPlaylist } from '../../types/models'
import { useNav } from '../../state/nav'
import { useT } from '../../i18n'
import ScArtwork from './ScArtwork'
import { toast } from './Toast'
import { openContextMenu, type ContextMenuItem } from './ContextMenu'
import { requestPlaylistCache } from '../../soundcloud/cacheJobs'

/**
 * The two SoundCloud result shapes, shared by the search page and the artist
 * page. Both open the in-app view, which reads live from SoundCloud - nothing
 * reaches the library until it is cached.
 */

export function ScPlaylistCard({ playlist }: { playlist: ScPlaylist }) {
  const t = useT()
  const { navigate } = useNav()

  const cache = (): void => {
    void requestPlaylistCache(playlist)
      .then((outcome) => {
        if (outcome === 'started') toast.show(t('Caching started'))
        else if (outcome === 'empty') toast.show(t('Nothing in this playlist can be cached'), 'info')
        // 'asked' leaves the name question on screen; it reports its own result
      })
      .catch((e: unknown) => toast.show(e instanceof Error ? e.message : String(e), 'error'))
  }

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    const items: ContextMenuItem[] = [
      { id: 'cache', label: t('Cache playlist'), icon: <Download size={13} />, onSelect: cache },
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
        <ScArtwork url={playlist.artworkUrl} title={playlist.title} />
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
  return (
    <button
      type="button"
      className="arow"
      onClick={() => navigate({ name: 'sc-artist', id: artist.id })}
    >
      <span className="arow-art">
        <ScArtwork url={artist.avatarUrl} title={artist.username} />
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

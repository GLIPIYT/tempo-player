import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Clock3, Ellipsis, Heart, ListMusic, Play, Plus, Search, Trash2, Upload } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import type { Playlist } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { resolveLang, useT } from '../i18n'
import { formatCount } from '../i18n/count'
import { useSettings } from '../state/settings'
import { playlistDisplayName } from '../utils/playlists'
import { usePlayer } from '../player'
import { trackToUnified } from '../utils/unified'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { openContextMenu, type ContextMenuItem } from '../components/common/ContextMenu'
import CollectionArtwork from '../components/common/CollectionArtwork'
import CollectionFavoriteButton from '../components/common/CollectionFavoriteButton'
import { CollectionCatalogHeading, CollectionCatalogToolbar } from '../components/common/CollectionCatalog'
import EmptyState from '../components/common/EmptyState'
import Modal from '../components/common/Modal'
import { toast } from '../components/common/Toast'
import CacheBadge from '../soundcloud/CacheBadge'

type PlaylistSort = 'name' | 'updated' | 'tracks'

export default function PlaylistsPage() {
  const { navigate } = useNav()
  const t = useT()
  const { settings } = useSettings()
  const lang = resolveLang(settings.lang)
  const player = usePlayer()
  const version = useLibraryVersion()
  const { data, loading, error, reload } = useAsync(() => api.listPlaylists(), [version])
  const previews = useAsync(() => api.listPlaylistCoverPreviews(), [version])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<PlaylistSort>('updated')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const search = query.trim().toLocaleLowerCase()
  const visiblePlaylists = (data ?? [])
    .filter((playlist) => (!favoritesOnly || playlist.pinned) && playlistDisplayName(playlist, playlist.name, t).toLocaleLowerCase().includes(search))
    .sort((a, b) => {
      if (sort === 'updated') return b.updatedAt - a.updatedAt || a.id - b.id
      if (sort === 'tracks') return (b.trackCount ?? 0) - (a.trackCount ?? 0) || a.name.localeCompare(b.name)
      return playlistDisplayName(a, a.name, t).localeCompare(playlistDisplayName(b, b.name, t))
    })

  const playPlaylist = async (playlist: Playlist) => {
    try {
      const tracks = (await api.getPlaylist(playlist.id)).map((row) => row.track)
      if (tracks.length === 0) return
      player.playTracks(tracks.map(trackToUnified), 0)
      await api.recordPlaylistStart(playlist.id)
      bumpLibraryVersion()
    } catch (cause: unknown) {
      toast.show(cause instanceof Error ? cause.message : String(cause), 'error')
    }
  }

  const deletePlaylist = async (playlist: Playlist, displayName: string) => {
    if (playlist.isLikes) return
    const confirmed = window.confirm(`${t('Delete playlist')} "${displayName}"? ${t('This cannot be undone.')}`)
    if (!confirmed) return
    try {
      await api.deletePlaylist(playlist.id)
      bumpLibraryVersion()
    } catch (cause: unknown) {
      toast.show(cause instanceof Error ? cause.message : String(cause), 'error')
    }
  }

  const playlistMenu = (
    event: ReactMouseEvent,
    playlist: Playlist,
    displayName: string,
  ) => {
    event.preventDefault()
    const items: ContextMenuItem[] = [
      {
        id: 'play',
        label: t('Play all'),
        icon: <Play size={13} />,
        disabled: (playlist.trackCount ?? 0) === 0,
        onSelect: () => void playPlaylist(playlist),
      },
      {
        id: 'favorite',
        label: playlist.pinned ? t('Remove from favorites') : t('Add to favorites'),
        icon: <Heart size={13} fill={playlist.pinned ? 'currentColor' : 'none'} />,
        onSelect: () => {
          void api
            .setPlaylistPinned(playlist.id, !playlist.pinned)
            .then(() => bumpLibraryVersion())
            .catch((cause: unknown) => toast.show(cause instanceof Error ? cause.message : String(cause), 'error'))
        },
      },
    ]
    if (!playlist.isLikes) {
      items.push({
        id: 'delete',
        label: t('Delete playlist'),
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => void deletePlaylist(playlist, displayName),
      })
    }
    openContextMenu({ x: event.clientX, y: event.clientY, title: displayName, items })
  }

  const importM3u8 = async () => {
    try {
      const sel = await open({
        multiple: false,
        filters: [{ name: 'M3U playlist', extensions: ['m3u8', 'm3u'] }],
      })
      if (typeof sel !== 'string') return
      const parts = sel.split(/[\/]/)
      const file = parts[parts.length - 1] ?? 'Playlist'
      const stem = file.replace(/\.(m3u8|m3u)$/i, '') || 'Playlist'
      const pl = await api.importPlaylistM3u8(sel, stem)
      reload()
      navigate({ name: 'playlist', id: pl.id })
      toast.show(t('Playlist imported'))
    } catch (e: unknown) {
      toast.show(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const create = async () => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    setBusy(true)
    try {
      const pl: Playlist = await api.createPlaylist(trimmed)
      setCreating(false)
      setName('')
      reload()
      navigate({ name: 'playlist', id: pl.id })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page playlist-list-page collection-catalog collection-playlists-air">
      <CollectionCatalogHeading title={t('Playlists')} count={data?.length} actions={<>
        <button className="btn btn-primary" onClick={() => { setName(''); setCreating(true) }}><Plus size={15} />{t('New playlist')}</button>
        <button className="collection-icon-action" onClick={() => void importM3u8()} title={t('Import playlist (m3u8)')} aria-label={t('Import playlist (m3u8)')}><Upload size={18} /></button>
      </>} />
      <CollectionCatalogToolbar query={query} onQuery={setQuery} placeholder={t('Search playlists')} favoritesOnly={favoritesOnly} onFavoritesOnly={setFavoritesOnly} allLabel={t('All playlists')}>
        <select value={sort} aria-label={t('Sort by')} onChange={event => setSort(event.target.value as PlaylistSort)}>
          <option value="name">{t('Sort by title')}</option>
          <option value="updated">{t('Recently updated')}</option>
          <option value="tracks">{t('Most tracks')}</option>
        </select>
      </CollectionCatalogToolbar>

      {error ? <div className="error-line">{error}</div> : null}
      {loading && data === null ? (
        <div className="muted">{t('Loading…')}</div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<ListMusic size={34} />}
          title={t('No playlists yet')}
          hint={t('Create a playlist and add tracks to it.')}
        />
      ) : visiblePlaylists.length === 0 ? (
        <EmptyState icon={<Search size={30} />} title={t('No playlists match')} hint={t('Try another search.')} />
      ) : (
        <div className="collection-playlist-grid">
          {visiblePlaylists.map(playlist => {
            const displayName = playlistDisplayName(playlist, playlist.name, t)
            const paths = playlist.coverPath ? [playlist.coverPath] : previews.data?.[playlist.id] ?? []
            const updated = new Date(playlist.updatedAt * 1000).toLocaleDateString(lang, { day: 'numeric', month: 'short' })
            return <article key={playlist.id} className="collection-playlist-card" onContextMenu={event => playlistMenu(event, playlist, displayName)}>
              <button type="button" className="collection-playlist-open" title={displayName} onClick={() => navigate({ name: 'playlist', id: playlist.id })}>
                <span className="collection-playlist-art"><CacheBadge kind="playlist" scId={null} localId={playlist.id}><CollectionArtwork paths={paths} label={displayName} likes={playlist.isLikes} /></CacheBadge><span className="collection-art-count"><ListMusic size={12} />{formatCount(playlist.trackCount ?? 0, 'track', t, lang)}</span></span>
                <strong>{displayName}</strong>
                <span className="collection-playlist-meta"><span>{formatCount(playlist.trackCount ?? 0, 'track', t, lang)}</span><span title={t('Recently updated')}><Clock3 size={10} />{updated}</span></span>
              </button>
              <div className="collection-playlist-card-actions">
                <CollectionFavoriteButton active={playlist.pinned ?? false} label={displayName} onClick={() => { void api.setPlaylistPinned(playlist.id, !playlist.pinned).then(bumpLibraryVersion).catch(cause => toast.show(String(cause), 'error')) }} />
                <button type="button" className="collection-icon-action" aria-label={`${t('More')}: ${displayName}`} onClick={event => playlistMenu(event, playlist, displayName)}><Ellipsis size={18} /></button>
              </div>
              <button type="button" className="collection-card-play" disabled={(playlist.trackCount ?? 0) === 0} aria-label={`${t('Play all')}: ${displayName}`} onClick={() => void playPlaylist(playlist)}><Play size={17} fill="currentColor" /></button>
            </article>
          })}
          <button type="button" className="collection-create-card" onClick={() => { setName(''); setCreating(true) }}><span><Plus size={29} /></span><strong>{t('New playlist')}</strong></button>
        </div>
      )}

      <Modal open={creating} title={t('New playlist')} onClose={() => setCreating(false)}>
        <input
          className="text-input"
          autoFocus
          value={name}
          placeholder={t('Playlist name')}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={() => setCreating(false)}>
            {t('Cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || name.trim().length === 0}
            onClick={() => void create()}
          >
            {t('Create')}
          </button>
        </div>
      </Modal>
    </div>
  )
}

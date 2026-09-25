import { useState } from 'react'
import { ListMusic, Play, Plus, Search, Star, Upload } from 'lucide-react'
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
import Cover from '../components/common/Cover'
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
  const [sort, setSort] = useState<PlaylistSort>('name')
  const search = query.trim().toLocaleLowerCase()
  const visiblePlaylists = (data ?? [])
    .filter((playlist) => playlistDisplayName(playlist, playlist.name, t).toLocaleLowerCase().includes(search))
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
    <div className="page playlist-list-page">
      <div className="page-head collection-library-heading">
        <div>
          <h1 className="page-title">{t('Playlists')}</h1>
          <div className="page-sub">{data ? formatCount(data.length, 'playlist', t, lang) : t('Loading…')}</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => { setName(''); setCreating(true) }}><Plus size={15} />{t('New playlist')}</button>
          <button className="btn" onClick={() => void importM3u8()} title={t('Import playlist (m3u8)')}><Upload size={15} />{t('Import')}</button>
        </div>
      </div>

      <div className="collection-library-toolbar">
        <label className="collection-library-search">
          <Search size={15} />
          <input type="search" value={query} aria-label={t('Search playlists')} placeholder={t('Search playlists')} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <select className="select" value={sort} aria-label={t('Sort by')} onChange={(event) => setSort(event.target.value as PlaylistSort)}>
          <option value="name">{t('Sort by title')}</option>
          <option value="updated">{t('Recently updated')}</option>
          <option value="tracks">{t('Most tracks')}</option>
        </select>
      </div>

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
        <>
          <div className="playlist-list-header" aria-hidden="true"><span>{t('Playlist')}</span><span></span><span>{t('Tracks')}</span><span></span></div>
          <div className="playlist-list-rows">
            {visiblePlaylists.map((playlist) => {
              const displayName = playlistDisplayName(playlist, playlist.name, t)
              const covers = previews.data?.[playlist.id] ?? (playlist.coverPath ? [playlist.coverPath] : [])
              return (
                <div key={playlist.id} className="playlist-list-row">
                  <button type="button" className="playlist-list-open" onClick={() => navigate({ name: 'playlist', id: playlist.id })} title={displayName}>
                    <span className="playlist-list-cover"><CacheBadge kind="playlist" scId={null} localId={playlist.id}>
                      {playlist.coverPath ? <Cover path={playlist.coverPath} label={displayName} size={56} /> : <span className="playlist-list-fallback"><ListMusic size={24} /></span>}
                    </CacheBadge></span>
                    <span className="playlist-list-title"><strong>{displayName}</strong>{playlist.pinned ? <small><Star size={12} fill="currentColor" /> {t('Pinned')}</small> : null}</span>
                  </button>
                  <div className="playlist-list-covers" aria-hidden="true">{covers.map((path) => <Cover key={path} path={path} label={displayName} size={30} />)}</div>
                  <span className="playlist-list-count">{formatCount(playlist.trackCount ?? 0, 'track', t, lang)}</span>
                  <button type="button" className="playlist-list-play" disabled={(playlist.trackCount ?? 0) === 0} aria-label={`${t('Play all')}: ${displayName}`} onClick={() => void playPlaylist(playlist)}><Play size={16} fill="currentColor" /></button>
                </div>
              )
            })}
          </div>
        </>
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

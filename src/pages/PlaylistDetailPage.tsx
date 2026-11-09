import { useFormatCount } from '../i18n/count'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { Check, Download, Ellipsis, FileDown, Folder, ListMusic, Pencil, Play, Shuffle, Star, Trash2, X } from 'lucide-react'
import { useNav } from '../state/nav'
import { useT } from '../i18n'
import { api } from '../api/client'
import type { PlaylistTrack, Track } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { usePlayer } from '../player'
import { fmtTime } from '../utils/format'
import { trackToUnified } from '../utils/unified'
import { playlistDisplayName } from '../utils/playlists'
import Cover from '../components/common/Cover'
import { CollectionTrackHeading } from '../components/common/CollectionCatalog'
import CollectionArtwork from '../components/common/CollectionArtwork'
import { openContextMenu, type ContextMenuItem } from '../components/common/ContextMenu'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import CacheBadge from '../soundcloud/CacheBadge'
import { toast } from '../components/common/Toast'
import EmptyState from '../components/common/EmptyState'
import TrackSourceIcon from '../components/common/TrackSourceIcon'
import TrackMenu, { type TrackMenuHandle } from '../components/common/TrackMenu'
import { beginTrackDrag } from '../dnd/trackDrag'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function PlaylistDetailPage({ playlistId }: { playlistId: number }) {
  const { navigate } = useNav()
  const t = useT()
  const count = useFormatCount()
  const player = usePlayer()
  const version = useLibraryVersion()
  const detail = useAsync(() => api.getPlaylist(playlistId), [playlistId, version])
  const lists = useAsync(() => api.listPlaylists(), [version])
  const [query, setQuery] = useState('')
  useEffect(() => setQuery(''), [playlistId])
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [savedRename, setSavedRename] = useState<{ playlistId: number; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragFromPos, setDragFromPos] = useState<number | null>(null)
  const [dropEdge, setDropEdge] = useState<{ pos: number; after: boolean } | null>(null)
  const [orderOverride, setOrderOverride] = useState<PlaylistTrack[] | null>(null)
  const lastDetailData = useRef(detail.data)
  const [exportBusy, setExportBusy] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  // One handle per row, so right-clicking a row opens that row's own menu.
  // Must stay above the loading early-return below: a hook called after it
  // would run on some renders and not others, which unmounts the whole tree.
  const menus = useRef(new Map<number, TrackMenuHandle | null>())

  const exportM3u8 = async () => {
    setExportBusy(true)
    try {
      const fileName = `${playlist?.name ?? 'playlist'}.m3u8`
      const path = await save({ defaultPath: fileName, filters: [{ name: 'M3U playlist', extensions: ['m3u8'] }] })
      if (typeof path === 'string') {
        const count = await api.exportPlaylistM3u8(playlistId, path)
        toast.show(`${t('Exported')}: ${count}`)
      }
    } catch (e: unknown) {
      toast.show(errText(e), 'error')
    } finally {
      setExportBusy(false)
    }
  }

  const downloadToCache = async () => {
    setDownloadBusy(true)
    try {
      let started = 0
      for (const item of baseItems) {
        const tr = item.track
        if (tr.source === 'soundcloud' && tr.externalId) {
          await api.scGetPlayback(tr.externalId).catch(() => {})
          started += 1
        }
      }
      toast.show(started > 0 ? t('Downloads started') : t('Nothing to download'))
    } finally {
      setDownloadBusy(false)
    }
  }

  useEffect(() => {
    const refreshed = detail.data !== lastDetailData.current
    lastDetailData.current = detail.data
    if (refreshed && !detail.loading) setOrderOverride(null)
  }, [detail.data, detail.loading])

  if (detail.loading && detail.data === null && orderOverride === null) {
    return (
      <div className="page">
        <div className="muted">{t('Loading…')}</div>
      </div>
    )
  }

  const playlistError = detail.error ?? lists.error ?? error
  const baseItems = detail.data ?? []
  const items = orderOverride ?? baseItems
  const tracks: Track[] = items.map((p) => p.track)
  const search = query.trim().toLocaleLowerCase()
  const shownItems = items.filter(item => `${item.track.title} ${item.track.artistName ?? ''}`.toLocaleLowerCase().includes(search))
  const playlist = (lists.data ?? []).find((pl) => pl.id === playlistId)

  const reloadAll = () => {
    detail.reload()
    lists.reload()
  }

  const applyMove = async (fromPos: number, toPos: number) => {
    if (!Number.isInteger(fromPos) || !Number.isInteger(toPos) || fromPos === toPos) return
    const current = orderOverride ?? baseItems
    if (fromPos < 0 || toPos < 0 || fromPos >= current.length || toPos >= current.length) return
    const next = current.slice()
    const moved = next.splice(fromPos, 1)[0]
    next.splice(toPos, 0, moved)
    setOrderOverride(next.map((it, idx) => ({ ...it, position: idx })))
    setDragFromPos(null)
    setDropEdge(null)
    try {
      await api.playlistMoveTrack(playlistId, fromPos, toPos)
      setError(null)
    } catch (e: unknown) {
      setError(errText(e))
      setOrderOverride(null)
    } finally {
      detail.reload()
    }
  }

  const dropAtInsertion = (fromPos: number, insIndex: number) => {
    const target = insIndex > fromPos ? insIndex - 1 : insIndex
    void applyMove(fromPos, target)
  }

  const removeTrack = async (trackId: number) => {
    try {
      await api.playlistRemoveTrack(playlistId, trackId)
      reloadAll()
      setError(null)
    } catch (e: unknown) {
      setError(errText(e))
    }
  }

  const rename = async () => {
    const trimmed = name.trim()
    if (trimmed.length === 0 || !playlist) return
    const currentName = savedRename?.playlistId === playlistId ? savedRename.name : playlist.name
    if (trimmed === currentName) {
      setRenaming(false)
      return
    }
    setBusy(true)
    try {
      await api.renamePlaylist(playlistId, trimmed)
      setName(trimmed)
      setSavedRename({ playlistId, name: trimmed })
      setRenaming(false)
      bumpLibraryVersion()
      lists.reload()
      setError(null)
    } catch (e: unknown) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const togglePin = async () => {
    if (!playlist) return
    try {
      await api.setPlaylistPinned(playlistId, !playlist.pinned)
      bumpLibraryVersion()
      setError(null)
    } catch (e: unknown) {
      setError(errText(e))
    }
  }

  const destroy = async () => {
    if (!playlist) return
    const ok = window.confirm(`${t('Delete playlist')} "${playlist.name}"? ${t('This cannot be undone.')}`)
    if (!ok) return
    setBusy(true)
    try {
      await api.deletePlaylist(playlistId)
      // The sidebar's favorites are built from the playlist list, so it has to
      // be told the list changed - otherwise the deleted playlist sits there
      // until something unrelated refreshes it.
      bumpLibraryVersion()
      navigate({ name: 'playlists' })
    } catch (e: unknown) {
      setError(errText(e))
      setBusy(false)
    }
  }

  const playAria = t('Play')
  const removeAria = t('Remove')
  const fromPlaylist = t('from playlist')
  const unknownArtist = t('Unknown artist')
  const currentName = playlist
    ? (savedRename?.playlistId === playlistId ? savedRename.name : playlist.name)
    : t('Playlist')
  const displayPlaylist = playlist && savedRename?.playlistId === playlistId
    ? { ...playlist, name: savedRename.name }
    : playlist
  const displayName = playlistDisplayName(displayPlaylist, t('Playlist'), t)
  const isLikes = playlist?.isLikes === true
  const beginRename = () => {
    if (!playlist || isLikes || busy) return
    setName(currentName)
    setRenaming(true)
  }
  const cancelRename = () => {
    setName(currentName)
    setRenaming(false)
  }

  const artworkPaths = playlist?.coverPath ? [playlist.coverPath] : tracks.map(track => track.coverPath)
  const artwork = <CollectionArtwork paths={artworkPaths} label={displayName} likes={isLikes} eager />
  const playAll = (shuffle = false) => {
    if (!tracks.length) return
    if (shuffle && !player.shuffle) player.toggleShuffle()
    player.playTracks(tracks.map(trackToUnified), 0)
    void api.recordPlaylistStart(playlistId).then(bumpLibraryVersion).catch(cause => toast.show(String(cause), 'error'))
  }
  const collectionMenu = (event: MouseEvent) => {
    const items: ContextMenuItem[] = []
    if (!isLikes) items.push({ id: 'rename', label: t('Rename'), icon: <Pencil size={14} />, disabled: busy, onSelect: beginRename })
    items.push({ id: 'export', label: t('Export playlist (m3u8)'), icon: <FileDown size={14} />, disabled: exportBusy || !tracks.length, onSelect: () => void exportM3u8() })
    if (isLikes) items.push({ id: 'cache', label: t('Download to cache'), icon: <Download size={14} />, disabled: downloadBusy || !tracks.some(track => track.source === 'soundcloud'), onSelect: () => void downloadToCache() })
    else items.push({ id: 'delete', label: t('Delete'), icon: <Trash2 size={14} />, danger: true, disabled: busy, onSelect: () => void destroy() })
    openContextMenu({ x: event.clientX, y: event.clientY, title: displayName, items })
  }
  return (
    <EditorialDetailLayout
      className="local-playlist-page"
      variant="panorama"
      artworkPath={artworkPaths.find(Boolean)}
      artworkLabel={displayName}
      artworkPreview={artwork}
      kindIcon={<ListMusic size={13} />}
      onBack={() => navigate({ name: 'playlists' })}
      backLabel={t('Playlists')}
      art={<CacheBadge kind="playlist" scId={null} localId={playlistId}>{artwork}</CacheBadge>}
      kind={t('Playlist')}
      title={playlist && !isLikes ? (
        renaming ? (
          <span className="playlist-title-editor">
            <input
              className="playlist-title-input"
              autoFocus
              aria-label={t('Playlist name')}
              value={name}
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void rename()
                if (event.key === 'Escape') cancelRename()
              }}
            />
            <button className="playlist-title-action is-save" type="button" aria-label={t('Save')} title={t('Save')}
              disabled={busy || name.trim().length === 0} onClick={() => void rename()}>
              <Check size={16} />
            </button>
            <button className="playlist-title-action" type="button" aria-label={t('Cancel')} title={t('Cancel')}
              disabled={busy} onClick={cancelRename}>
              <X size={15} />
            </button>
          </span>
        ) : (
          <button className="playlist-title-trigger" type="button" title={t('Rename playlist')} onClick={beginRename}>
            <span>{displayName}</span>
            <Pencil className="playlist-title-pencil" size={17} aria-hidden="true" />
          </button>
        )
      ) : displayName}
      meta={
        <span>
          {count(items.length, 'track')} · {fmtTime(tracks.reduce((sum, track) => sum + (track.durationSec ?? 0), 0))}
        </span>
      }
      actions={<>
        {tracks.length > 0 && <button className="btn btn-primary" onClick={() => playAll()}><Play size={15} fill="currentColor" />{t('Play all')}</button>}
        {playlist && <>
          <button type="button" className={`collection-icon-action${playlist.pinned ? ' is-active' : ''}`} title={playlist.pinned ? t('Remove from favorites') : t('Add to favorites')} aria-label={playlist.pinned ? t('Remove from favorites') : t('Add to favorites')} aria-pressed={playlist.pinned ?? false} onClick={() => void togglePin()}><Star size={21} fill={playlist.pinned ? 'currentColor' : 'none'} /></button>
          <button type="button" className={`collection-icon-action${player.shuffle ? ' is-active' : ''}`} title={t('Shuffle')} aria-label={t('Shuffle')} disabled={!tracks.length} onClick={() => playAll(true)}><Shuffle size={19} /></button>
          <button type="button" className="collection-icon-action" aria-label={t('More')} title={t('More')} onClick={collectionMenu}><Ellipsis size={22} /></button>
        </>}
      </>}
    >

      {playlistError ? <div className="error-line">{playlistError}</div> : null}

      <CollectionTrackHeading count={shownItems.length} query={query} onQuery={setQuery} />
      {items.length === 0 ? (
        <EmptyState
          icon={<ListMusic size={34} />}
          title={t('This playlist is empty')}
          hint={t('Add tracks from your library to fill it.')}
        />
      ) : !shownItems.length ? <EmptyState title={t('No tracks found')} hint={t('Try another search.')} /> : (
        <div className="tl tl-withactions tl-has-header">
          <div className="tl-head playlist-track-head" aria-hidden="true">
            <span className="tl-head-index">#</span>
            <span>{t('Title')}</span>
            <span className="tl-head-album">{t('Album')}</span>
            <span>{t('Duration')}</span>
            <span className="tl-head-remove" />
            <span className="tl-head-menu" />
          </div>
          {shownItems.map((p) => {
            const i = items.indexOf(p)
            const t = p.track
            const playing = player.currentTrack?.source === t.source && player.currentTrack.sourceId === (t.source === 'local' ? String(t.id) : t.externalId)
            const dragging = dragFromPos === p.position
            const before = dropEdge !== null && dropEdge.pos === p.position && !dropEdge.after && !dragging
            const after = dropEdge !== null && dropEdge.pos === p.position && dropEdge.after && !dragging
            return (
              <div
                key={`${t.id}-${p.position}`}
                className={
                  'tl-row pl-row' +
                  (playing ? ' is-playing' : '') +
                  (dragging ? ' dragging' : '') +
                  (before ? ' drop-before' : '') +
                  (after ? ' drop-after' : '')
                }
                data-dnd-sort-group={search ? undefined : `playlist-${playlistId}`}
                data-dnd-sort-position={p.position}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  beginTrackDrag({
                    e,
                    title: t.title,
                    coverPath: t.coverPath,
                    trackId: t.id,
                    sourceTrack: t,
                    sort: search ? undefined : {
                      group: `playlist-${playlistId}`,
                      position: p.position,
                      onDrop: (fromPosition, insertionIndex) => dropAtInsertion(fromPosition, insertionIndex),
                      onTargetChange: (target) =>
                        setDropEdge(target ? { pos: target.position, after: target.after } : null),
                      onActivate: () => setDragFromPos(p.position),
                      onFinish: () => {
                        setDragFromPos(null)
                        setDropEdge(null)
                      },
                    },
                  })
                }}
                onDoubleClick={() => player.playTracks(tracks.map((x) => trackToUnified(x)), i)}
                onContextMenu={(e) => {
                  const handle = menus.current.get(t.id)
                  if (!handle) return
                  e.preventDefault()
                  handle.openAt(e.clientX, e.clientY)
                }}
              >
                <div className="tl-index">
                  <span className="tl-num">{i + 1}</span>
                  <button
                    className="tl-play"
                    aria-label={`${playAria} ${t.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      player.playTracks([trackToUnified(t)], 0)
                    }}
                  >
                    <Play size={13} />
                  </button>
                </div>
                <div className="tl-main">
                  <Cover path={t.coverPath} label={t.title} size={30} />
                  <div className="tl-meta">
                    <span className="tl-title">{t.title}</span>
                    <span className="tl-artist"><span className="tl-artist-name">{t.artistName ?? unknownArtist}</span><TrackSourceIcon source={t.source} /></span>
                  </div>
                </div>
                <div className="tl-album">{t.albumTitle ?? '—'}</div>
                <div className="tl-duration">{fmtTime(t.durationSec)}</div>
                <button
                  className="icon-btn tl-remove"
                  aria-label={`${removeAria} ${t.title} ${fromPlaylist}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeTrack(t.id)
                  }}
                >
                  <X size={14} />
                </button>
                <TrackMenu
                  ref={(h) => {
                    if (h) menus.current.set(t.id, h)
                    else menus.current.delete(t.id)
                  }}
                  track={t}
                  tracks={tracks}
                  index={i}
                  playlistMode
                  playlistId={playlistId}
                  onChanged={reloadAll}
                  onMove={(delta) => {
                    void applyMove(p.position, p.position + delta)
                  }}
                />
              </div>
            )
          })}
        </div>
      )}

      <footer className="collection-detail-footnote"><Folder size={13} />{t('In library')}</footer>
    </EditorialDetailLayout>
  )
}

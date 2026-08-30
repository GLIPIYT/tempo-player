import { useEffect, useState } from 'react'
import { ChevronLeft, ListMusic, Pencil, Play, Star, StarOff, Trash2, X } from 'lucide-react'
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
import Cover from '../components/common/Cover'
import EmptyState from '../components/common/EmptyState'
import Modal from '../components/common/Modal'
import TrackMenu from '../components/common/TrackMenu'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function PlaylistDetailPage({ playlistId }: { playlistId: number }) {
  const { navigate } = useNav()
  const t = useT()
  const player = usePlayer()
  const version = useLibraryVersion()
  const detail = useAsync(() => api.getPlaylist(playlistId), [playlistId, version])
  const lists = useAsync(() => api.listPlaylists(), [version])
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragFromPos, setDragFromPos] = useState<number | null>(null)
  const [dropEdge, setDropEdge] = useState<{ pos: number; after: boolean } | null>(null)
  const [orderOverride, setOrderOverride] = useState<PlaylistTrack[] | null>(null)

  useEffect(() => {
    if (orderOverride !== null && !detail.loading) setOrderOverride(null)
  }, [detail.loading, orderOverride])

  if (detail.loading && orderOverride === null) {
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
    setBusy(true)
    try {
      await api.renamePlaylist(playlistId, trimmed)
      setRenaming(false)
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

  return (
    <div className="page">
      <button className="back-link" onClick={() => navigate({ name: 'playlists' })}>
        <ChevronLeft size={15} />
        {t('Playlists')}
      </button>

      <div className="detail-hero">
        <div className="playlist-tile playlist-tile-lg">
          <ListMusic size={34} />
        </div>
        <div className="detail-hero-info">
          <div className="section-label">{t('Playlist')}</div>
          <h1 className="detail-title">{playlist?.name ?? t('Playlist')}</h1>
          <div className="detail-meta">
            <span>
              {items.length === 1 ? `${items.length} ${t('track')}` : `${items.length} ${t('tracks')}`}
            </span>
          </div>
          <div className="detail-actions">
            {tracks.length > 0 ? (
              <button
                className="btn btn-primary"
                onClick={() => player.playTracks(tracks.map((t) => trackToUnified(t)), 0)}
              >
                {t('Play all')}
              </button>
            ) : null}
            {playlist ? (
              <>
                <button
                  className="btn"
                  title={playlist.pinned ? t('Remove from favorites') : t('Add to favorites')}
                  onClick={() => void togglePin()}
                >
                  {playlist.pinned ? <StarOff size={14} /> : <Star size={14} />}
                  {playlist.pinned ? t('Remove from favorites') : t('Add to favorites')}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setName(playlist.name)
                    setRenaming(true)
                  }}
                >
                  <Pencil size={14} />
                  {t('Rename')}
                </button>
                <button className="btn btn-danger" disabled={busy} onClick={() => void destroy()}>
                  <Trash2 size={14} />
                  {t('Delete')}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {playlistError ? <div className="error-line">{playlistError}</div> : null}

      {items.length === 0 ? (
        <EmptyState
          icon={<ListMusic size={34} />}
          title={t('This playlist is empty')}
          hint={t('Add tracks from your library to fill it.')}
        />
      ) : (
        <div
          className="tl tl-withactions"
          onDragOver={(e) => {
            if (dragFromPos === null || items.length === 0) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            const last = items[items.length - 1]
            setDropEdge({ pos: last.position, after: true })
          }}
          onDrop={(e) => {
            if (dragFromPos === null) return
            e.preventDefault()
            dropAtInsertion(dragFromPos, items.length)
          }}
        >
          {items.map((p, i) => {
            const t = p.track
            const playing = player.currentTrack?.sourceId === String(t.id)
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
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', String(p.position))
                  setDragFromPos(p.position)
                }}
                onDragOver={(e) => {
                  if (dragFromPos === null || dragFromPos === p.position) return
                  e.preventDefault()
                  e.stopPropagation()
                  e.dataTransfer.dropEffect = 'move'
                  const rect = e.currentTarget.getBoundingClientRect()
                  setDropEdge({ pos: p.position, after: e.clientY > rect.top + rect.height / 2 })
                }}
                onDragLeave={() => {
                  setDropEdge((cur) => (cur !== null && cur.pos === p.position ? null : cur))
                }}
                onDrop={(e) => {
                  if (dragFromPos === null) return
                  e.preventDefault()
                  e.stopPropagation()
                  const insIndex = dropEdge !== null && dropEdge.after ? i + 1 : i
                  dropAtInsertion(dragFromPos, insIndex)
                }}
                onDragEnd={() => {
                  setDragFromPos(null)
                  setDropEdge(null)
                }}
                onDoubleClick={() => player.playTracks(tracks.map((x) => trackToUnified(x)), i)}
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
                    <span className="tl-artist">{t.artistName ?? unknownArtist}</span>
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

      <Modal open={renaming} title={t('Rename playlist')} onClose={() => setRenaming(false)}>
        <input
          className="text-input"
          autoFocus
          value={name}
          placeholder={t('Playlist name')}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void rename()
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={() => setRenaming(false)}>
            {t('Cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || name.trim().length === 0}
            onClick={() => void rename()}
          >
            {t('Save')}
          </button>
        </div>
      </Modal>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Heart, MoreHorizontal, Plus } from 'lucide-react'
import { api } from '../../api/client'
import type { Playlist, Track } from '../../types/models'
import { usePlayer } from '../../player'
import { useLikes } from '../../hooks/useLikes'
import { useT } from '../../i18n'
import { trackToUnified } from '../../utils/unified'

interface TrackMenuProps {
  track: Track
  tracks: Track[]
  index: number
  playlistMode?: boolean
  playlistId?: number
  onChanged?: () => void
  onMove?: (delta: 1 | -1) => void
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function TrackMenu({
  track,
  tracks,
  index,
  playlistMode = false,
  playlistId,
  onChanged,
  onMove,
}: TrackMenuProps) {
  const player = usePlayer()
  const likes = useLikes()
  const t = useT()
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<number | null>(null)

  const flash = useCallback((text: string, bad: boolean) => {
    setNote({ text, bad })
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setNote(null), 1500)
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open || !sub || playlists !== null) return
    let cancelled = false
    api
      .listPlaylists()
      .then((list) => {
        if (!cancelled) setPlaylists(list)
      })
      .catch(() => {
        if (!cancelled) setPlaylists([])
      })
    return () => {
      cancelled = true
    }
  }, [open, sub, playlists])

  const close = useCallback(() => {
    setOpen(false)
    setSub(false)
    setCreating(false)
    setNewName('')
    setPlaylists(null)
  }, [])

  const toggleOpen = () => {
    if (open) {
      close()
      return
    }
    setNote(null)
    setSub(false)
    setCreating(false)
    setNewName('')
    setPlaylists(null)
    setOpen(true)
  }

  const unified = trackToUnified(track)

  const playNow = () => {
    player.playTracks(tracks.map((t) => trackToUnified(t)), index)
    close()
  }

  const playNext = () => {
    const qLen = player.queue.length
    const qi = player.queueIndex
    if (qLen === 0 || qi < 0) {
      player.playTracks([unified], 0)
    } else {
      player.addToQueue(unified)
      const target = qi + 1
      if (qLen !== target) player.moveInQueue(qLen, target)
    }
    close()
  }

  const addQueue = () => {
    player.addToQueue(unified)
    flash(t('Added to queue'), false)
  }

  const addTo = async (pl: Playlist) => {
    try {
      await api.playlistAddTrack(pl.id, track.id)
      setSub(false)
      flash(`${t('Added to')} ${pl.name}`, false)
    } catch (e: unknown) {
      flash(errText(e), true)
    }
  }

  const createAndAdd = async () => {
    const name = newName.trim()
    if (name.length === 0) return
    try {
      const pl = await api.createPlaylist(name)
      await api.playlistAddTrack(pl.id, track.id)
      setCreating(false)
      setNewName('')
      setSub(false)
      flash(`${t('Added to')} ${pl.name}`, false)
    } catch (e: unknown) {
      flash(errText(e), true)
    }
  }

  const removeFromPlaylist = async () => {
    if (playlistId == null) return
    try {
      await api.playlistRemoveTrack(playlistId, track.id)
      close()
      onChanged?.()
    } catch (e: unknown) {
      flash(errText(e), true)
    }
  }

  const toggleLike = () => {
    likes.toggle(track.id)
    close()
  }

  return (
    <div
      ref={rootRef}
      className={'tm-cell' + (open ? ' is-open' : '')}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        className="icon-btn tm-btn"
        aria-label={`${t('More actions for')} ${track.title}`}
        onClick={toggleOpen}
      >
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div className="menu-pop" role="menu">
          {note ? <div className={'menu-note' + (note.bad ? ' is-bad' : '')}>{note.text}</div> : null}
          <button className="menu-item" role="menuitem" onClick={toggleLike}>
            <Heart size={13} fill={likes.isLiked(track.id) ? 'currentColor' : 'none'} />
            {likes.isLiked(track.id) ? t('Remove from Likes') : t('Add to Likes')}
          </button>
          <div className="menu-sep" />
          {playlistMode ? (
            <>
              <button
                className="menu-item"
                role="menuitem"
                disabled={onMove === undefined || index <= 0}
                onClick={() => {
                  onMove?.(-1)
                  close()
                }}
              >
                <ArrowUp size={13} />
                {t('Move up')}
              </button>
              <button
                className="menu-item"
                role="menuitem"
                disabled={onMove === undefined || index >= tracks.length - 1}
                onClick={() => {
                  onMove?.(1)
                  close()
                }}
              >
                <ArrowDown size={13} />
                {t('Move down')}
              </button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => void removeFromPlaylist()}>
                {t('Remove from playlist')}
              </button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={playNow}>
                {t('Play now')}
              </button>
              <button className="menu-item" role="menuitem" onClick={playNext}>
                {t('Play next')}
              </button>
              <button className="menu-item" role="menuitem" onClick={addQueue}>
                {t('Add to queue')}
              </button>
            </>
          ) : sub ? (
            <>
              <div className="menu-title">{t('Add to playlist')}</div>
              {playlists === null ? (
                <div className="menu-item is-static">{t('Loading…')}</div>
              ) : playlists.length === 0 ? (
                <div className="menu-item is-static">{t('No playlists yet')}</div>
              ) : (
                playlists.map((pl) => (
                  <button
                    key={pl.id}
                    className="menu-item"
                    role="menuitem"
                    onClick={() => void addTo(pl)}
                  >
                    {pl.name}
                  </button>
                ))
              )}
              <div className="menu-sep" />
              {creating ? (
                <div className="tm-create">
                  <input
                    className="menu-input"
                    autoFocus
                    value={newName}
                    placeholder={t('Playlist name')}
                    spellCheck={false}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createAndAdd()
                      if (e.key === 'Escape') setCreating(false)
                    }}
                  />
                  <button
                    className="icon-btn tm-create-btn"
                    aria-label={t('Create playlist and add track')}
                    disabled={newName.trim().length === 0}
                    onClick={() => void createAndAdd()}
                  >
                    <Check size={14} />
                  </button>
                </div>
              ) : (
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setNewName('')
                    setCreating(true)
                  }}
                >
                  <Plus size={13} />
                  {t('New playlist…')}
                </button>
              )}
            </>
          ) : (
            <>
              <button className="menu-item" role="menuitem" onClick={playNow}>
                {t('Play now')}
              </button>
              <button className="menu-item" role="menuitem" onClick={playNext}>
                {t('Play next')}
              </button>
              <button className="menu-item" role="menuitem" onClick={addQueue}>
                {t('Add to queue')}
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setPlaylists(null)
                  setSub(true)
                }}
              >
                {t('Add to playlist')}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

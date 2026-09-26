import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { ArrowDown, ArrowUp, Check, Disc3, FolderOpen, Heart, MoreHorizontal, PencilLine, Plus, Trash2, User } from 'lucide-react'
import { api } from '../../api/client'
import type { Playlist, Track } from '../../types/models'
import { usePlayer } from '../../player'
import { useLikes } from '../../hooks/useLikes'
import { useNav } from '../../state/nav'
import { useT } from '../../i18n'
import { trackToUnified } from '../../utils/unified'
import { playlistDisplayName } from '../../utils/playlists'
import { bumpLibraryVersion } from '../../utils/libraryVersion'
import { toast } from './Toast'
import TrackMetadataEditor from './TrackMetadataEditor'

interface TrackMenuProps {
  track: Track
  tracks: Track[]
  index: number
  playlistMode?: boolean
  playlistId?: number
  /** Render without the trigger button - for surfaces that only open on right-click. */
  hideTrigger?: boolean
  onChanged?: () => void
  onMove?: (delta: 1 | -1) => void
}

/** Lets a row open its own menu on right-click without owning the open state. */
export interface TrackMenuHandle {
  open: () => void
  /** Opens at a point in viewport coordinates, for right-click. */
  openAt: (x: number, y: number) => void
}

/** Keeps the menu inside the viewport when it is opened at the cursor. */
const EDGE_GAP = 8

function clampToViewport(x: number, y: number, el: HTMLElement | null): { x: number; y: number } {
  if (!el) return { x, y }
  const w = el.offsetWidth
  const h = el.offsetHeight
  return {
    x: Math.min(Math.max(EDGE_GAP, x), Math.max(EDGE_GAP, window.innerWidth - w - EDGE_GAP)),
    y: Math.min(Math.max(EDGE_GAP, y), Math.max(EDGE_GAP, window.innerHeight - h - EDGE_GAP)),
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const TrackMenu = forwardRef<TrackMenuHandle, TrackMenuProps>(function TrackMenu(
  { track, tracks, index, playlistMode = false, playlistId, hideTrigger = false, onChanged, onMove },
  ref,
) {
  const player = usePlayer()
  const likes = useLikes()
  const { navigate } = useNav()
  const t = useT()
  const [open, setOpen] = useState(false)
  const [editingMetadata, setEditingMetadata] = useState(false)
  /** Null means anchored to the trigger button; a point means opened at the cursor. */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [sub, setSub] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  // the menu is measured once it exists, then pulled back inside the window if
  // it would hang off the right or bottom edge
  useLayoutEffect(() => {
    if (!open || !pos) return
    const el = popRef.current
    if (!el) return
    const clamped = clampToViewport(pos.x, pos.y, el)
    if (clamped.x !== pos.x || clamped.y !== pos.y) setPos(clamped)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pos !== null])

  const flash = useCallback((text: string, bad: boolean) => {
    toast.show(text, bad ? 'error' : 'success')
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
    setPos(null)
    setSub(false)
    setCreating(false)
    setNewName('')
    setPlaylists(null)
  }, [])

  const openFresh = useCallback(() => {
    setSub(false)
    setCreating(false)
    setNewName('')
    setPlaylists(null)
    setPos(null)
    setOpen(true)
  }, [])

  const openAtPoint = useCallback((x: number, y: number) => {
    setSub(false)
    setCreating(false)
    setNewName('')
    setPlaylists(null)
    setPos({ x, y })
    setOpen(true)
  }, [])

  useImperativeHandle(ref, () => ({ open: openFresh, openAt: openAtPoint }), [openFresh, openAtPoint])

  const toggleOpen = () => {
    if (open) {
      close()
      return
    }
    openFresh()
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
      flash(`${t('Added to')} ${playlistDisplayName(pl, pl.name, t)}`, false)
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
      flash(`${t('Added to')} ${playlistDisplayName(pl, pl.name, t)}`, false)
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

  // "Gone from the library" is a deleted row plus a blacklisted path - the file on
  // disk is never touched. Undo re-reads that one file rather than rescanning.
  const hideTrack = async () => {
    close()
    if (player.currentTrack?.dbId === track.id) player.next()
    try {
      const path = await api.hideTrack(track.id)
      bumpLibraryVersion()
      onChanged?.()
      toast.show(`${t('Hidden from library')}: ${track.title}`, 'info', 2600, {
        label: t('Undo'),
        run: () => {
          api
            .unhideTrack(path)
            .then((restored) => {
              bumpLibraryVersion()
              onChanged?.()
              if (!restored) flash(t('File is gone - it will return on the next scan'), false)
            })
            .catch((e: unknown) => flash(errText(e), true))
        },
      })
    } catch (e: unknown) {
      flash(errText(e), true)
    }
  }

  const goToArtist = () => {
    if (track.artistId == null) return
    close()
    navigate({ name: 'artist', id: track.artistId })
  }

  const goToAlbum = () => {
    if (track.albumId == null) return
    close()
    navigate({ name: 'album', id: track.albumId })
  }

  const editMetadata = () => {
    close()
    setEditingMetadata(true)
  }

  const revealInExplorer = async () => {
    close()
    try {
      const shown = await api.revealInFileManager(track.path)
      if (!shown) flash(t('File not found on disk'), true)
    } catch (e: unknown) {
      flash(errText(e), true)
    }
  }

  // Same three rows in two of the three menu bodies; built once so they cannot
  // drift apart. Each is gated on the datum it needs: a track with no album row
  // has nowhere to go, and only a local file has a path worth revealing.
  const navRows =
    track.artistId != null || track.albumId != null || track.source === 'local' ? (
      <>
        <div className="menu-sep" />
        {track.artistId != null ? (
          <button className="menu-item" role="menuitem" onClick={goToArtist}>
            <User size={13} />
            {t('Go to artist')}
          </button>
        ) : null}
        {track.source === 'local' ? (
          <button className="menu-item" role="menuitem" onClick={editMetadata}>
            <PencilLine size={13} />
            {t('Edit track')}
          </button>
        ) : null}
        {track.albumId != null ? (
          <button className="menu-item" role="menuitem" onClick={goToAlbum}>
            <Disc3 size={13} />
            {t('Go to album')}
          </button>
        ) : null}
        {track.source === 'local' ? (
          <button className="menu-item" role="menuitem" onClick={() => void revealInExplorer()}>
            <FolderOpen size={13} />
            {t('Show in Explorer')}
          </button>
        ) : null}
      </>
    ) : null

  const hideRow =
    track.source === 'local' ? (
      <>
        <div className="menu-sep" />
        <button
          className="menu-item menu-item-danger"
          role="menuitem"
          onClick={() => void hideTrack()}
          title={t('The file stays on disk')}
        >
          <Trash2 size={13} />
          {t('Remove from library')}
        </button>
      </>
    ) : null

  return (
    <div
      ref={rootRef}
      className={'tm-cell' + (open ? ' is-open' : '')}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {hideTrigger ? null : (
        <button
          className="icon-btn tm-btn"
          aria-label={`${t('More actions for')} ${track.title}`}
          onClick={toggleOpen}
        >
          <MoreHorizontal size={15} />
        </button>
      )}
      {open ? (
        <div
          ref={popRef}
          className={'menu-pop' + (pos ? ' menu-pop-at-point' : '')}
          role="menu"
          style={pos ? { left: pos.x, top: pos.y } : undefined}
        >
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
              {navRows}
              {hideRow}
            </>
          ) : sub ? (
            <>
              <div className="menu-title">{t('Add to playlist')}</div>
              {playlists === null ? (
                <div className="menu-item is-static">{t('Loading…')}</div>
              ) : playlists.length === 0 ? (
                <div className="menu-item is-static">{t('No playlists yet')}</div>
              ) : (
                playlists.map((pl) => {
                  const displayName = playlistDisplayName(pl, pl.name, t)
                  return (
                    <button
                      key={pl.id}
                      className="menu-item"
                      role="menuitem"
                      onClick={() => void addTo(pl)}
                    >
                      {displayName}
                    </button>
                  )
                })
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
              {navRows}
              {hideRow}
            </>
          )}
        </div>
      ) : null}
      {editingMetadata && track.source === 'local' ? (
        <TrackMetadataEditor
          key={track.id}
          track={track}
          onClose={() => setEditingMetadata(false)}
          onSaved={(savedTrack) => {
            player.updateTrackMetadata(savedTrack)
            setEditingMetadata(false)
            onChanged?.()
          }}
        />
      ) : null}
    </div>
  )
})

export default TrackMenu

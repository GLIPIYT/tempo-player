import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  Disc3,
  House,
  LibraryBig,
  ListMusic,
  MicVocal,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Settings,
  StarOff,
  Trash2,
  User,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useNav, type View } from '../../state/nav'
import { useSettings } from '../../state/settings'
import { useT } from '../../i18n'
import { toast } from '../common/Toast'
import { api } from '../../api/client'
import type { Playlist } from '../../types/models'
import { playlistDisplayName } from '../../utils/playlists'
import { useLibraryVersion } from '../../hooks/useLibraryVersion'
import { useAsync } from '../../hooks/useAsync'
import { bumpLibraryVersion } from '../../utils/libraryVersion'
import { tracksToUnified, trackToUnified } from '../../utils/unified'
import { usePlayer } from '../../player'
import {
  beginPlaylistReorder,
  consumeDragClick,
  registerPlaylistDropper,
  useDragTargets,
} from '../../dnd/trackDrag'
import Cover from '../common/Cover'
import Modal from '../common/Modal'
import ConfirmModal from '../common/ConfirmModal'

const WIDTH_KEY = 'tempo.sidebar.width'
const COLLAPSED_KEY = 'tempo.sidebar.collapsed'
const MIN_W = 200
const MAX_W = 340
const DEFAULT_W = 216
const COLLAPSED_W = 64

interface NavItem {
  key: 'home' | 'library' | 'albums' | 'artists' | 'playlists'
  label: string
  icon: LucideIcon
}

const items: NavItem[] = [
  { key: 'home', label: 'Home', icon: House },
  { key: 'library', label: 'Library', icon: LibraryBig },
  { key: 'albums', label: 'Albums', icon: Disc3 },
  { key: 'artists', label: 'Artists', icon: MicVocal },
  { key: 'playlists', label: 'Playlists', icon: ListMusic },
]

function activeFor(view: View): string | null {
  switch (view.name) {
    case 'album':
      return 'albums'
    case 'artist':
      return 'artists'
    case 'playlist':
      return 'playlists'
    case 'search':
    case 'settings':
      return null
    default:
      return view.name
  }
}

interface FavMenu {
  kind: 'playlist' | 'artist' | 'album'
  id: number
  name: string
  isLikes: boolean
  x: number
  y: number
}

interface DeleteTarget {
  id: number
  name: string
}

function clampW(v: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, v))
}

function readWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY)
  if (raw === null) return DEFAULT_W
  const n = Number(raw)
  return Number.isFinite(n) ? clampW(n) : DEFAULT_W
}

function readCollapsed(): boolean {
  return localStorage.getItem(COLLAPSED_KEY) === '1'
}

export default function Sidebar() {
  const { view, navigate } = useNav()
  const { settings } = useSettings()
  const t = useT()
  const player = usePlayer()
  const version = useLibraryVersion()
  const favArtists = useAsync(() => api.listFavoriteArtists(), [version])
  const favAlbums = useAsync(() => api.listFavoriteAlbums(), [version])
  const dragState = useDragTargets()
  const active = activeFor(view)
  const grouped = settings.sidebar.grouped

  const [width, setWidth] = useState(readWidth)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [resizing, setResizing] = useState(false)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [override, setOverride] = useState<number[] | null>(null)
  const [menu, setMenu] = useState<FavMenu | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const widthRef = useRef(width)
  widthRef.current = width
  const resizeStart = useRef<{ x: number; w: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listPlaylists()
      .then((ps) => {
        if (cancelled) return
        setPlaylists(ps)
        setOverride(null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [version])

  useEffect(() => {
    if (!menu) return
    const onPointer = (e: PointerEvent) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    const onScroll = () => setMenu(null)
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [menu])

  useLayoutEffect(() => {
    if (!menu) return
    const el = menuRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8))}px`
  }, [menu])

  const pinned = useMemo(
    () =>
      playlists
        .filter((p) => p.pinned)
        .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0) || a.id - b.id),
    [playlists],
  )

  const favorites = useMemo(() => {
    if (!override) return pinned
    const map = new Map(pinned.map((p) => [p.id, p]))
    const kept = override
      .map((id) => map.get(id))
      .filter((p): p is Playlist => p !== undefined)
    const seen = new Set(override)
    for (const p of pinned) if (!seen.has(p.id)) kept.push(p)
    return kept
  }, [pinned, override])

  const favoritesRef = useRef(favorites)
  favoritesRef.current = favorites

  const playFavorite = useCallback(
    async (id: number) => {
      try {
        const rows = await api.getPlaylist(id)
        player.playTracks(tracksToUnified(rows.map((r) => r.track)), 0)
      } catch {}
    },
    [player],
  )

  const playArtist = useCallback(
    async (id: number) => {
      try {
        const rows = await api.getArtistTracks(id)
        if (rows.length > 0) player.playTracks(rows.map(trackToUnified), 0)
      } catch {}
    },
    [player],
  )

  const playAlbum = useCallback(
    async (id: number) => {
      try {
        const detail = await api.getAlbum(id)
        if (detail.tracks.length > 0) player.playTracks(tracksToUnified(detail.tracks), 0)
      } catch {}
    },
    [player],
  )

  // track drop target: add the dropped track to the playlist + toast
  useEffect(() => {
    registerPlaylistDropper((playlistId, trackId) => {
      const pl = favoritesRef.current.find((f) => f.id === playlistId)
      void api
        .playlistAddTrack(playlistId, trackId)
        .then(() => {
          const name = pl ? playlistDisplayName(pl, pl.name, t) : ''
          toast.show(`${t('Added to')} ${name}`)
          bumpLibraryVersion()
        })
        .catch(() => undefined)
    })
    return () => registerPlaylistDropper(null)
  }, [t])

  const reorderFavorites = useCallback((from: number, to: number) => {
    const ids = favoritesRef.current.map((f) => f.id)
    if (from < 0 || from >= ids.length) return
    const moved = ids[from]
    ids.splice(from, 1)
    ids.splice(Math.max(0, Math.min(to, ids.length)), 0, moved)
    setOverride(ids)
    api
      .movePinnedPlaylist(moved, to)
      .then(() => bumpLibraryVersion())
      .catch(() => undefined)
  }, [])

  const toggleCollapse = () => {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1')
      return !c
    })
  }

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (collapsed || e.button !== 0) return
    e.preventDefault()
    resizeStart.current = { x: e.clientX, w: widthRef.current }
    e.currentTarget.setPointerCapture(e.pointerId)
    setResizing(true)
  }

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = resizeStart.current
    if (!s) return
    setWidth(clampW(s.w + e.clientX - s.x))
  }

  const onResizeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeStart.current) return
    resizeStart.current = null
    setResizing(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    localStorage.setItem(WIDTH_KEY, String(widthRef.current))
  }

  const onResizeReset = () => {
    if (collapsed) return
    setWidth(DEFAULT_W)
    localStorage.setItem(WIDTH_KEY, String(DEFAULT_W))
  }

  const createNew = async () => {
    const trimmed = newName.trim()
    if (trimmed.length === 0 || creating) return
    setCreating(true)
    try {
      // new playlists are pinned (favorites) by the backend by default
      const pl = await api.createPlaylist(trimmed)
      setNewOpen(false)
      setNewName('')
      bumpLibraryVersion()
      navigate({ name: 'playlist', id: pl.id })
    } catch {} finally {
      setCreating(false)
    }
  }

  const confirmDelete = async () => {
    const target = deleteTarget
    if (!target) return
    try {
      await api.deletePlaylist(target.id)
      setDeleteTarget(null)
      bumpLibraryVersion()
      if (view.name === 'playlist' && view.id === target.id) navigate({ name: 'playlists' })
    } catch {
      setDeleteTarget(null)
    }
  }

  const trackDragActive = dragState?.kind === 'track'
  const reorderDrag = dragState?.kind === 'playlist' ? dragState : null

  const playlistRow = (f: Playlist, i: number) => {
    const isActive = view.name === 'playlist' && view.id === f.id
    const displayName = playlistDisplayName(f, f.name, t)
    const isDropTarget = trackDragActive && dragState?.targetId === f.id
    const dropBefore = reorderDrag !== null && reorderDrag.insertAt === i
    const dropAfter =
      reorderDrag !== null &&
      reorderDrag.insertAt === favorites.length &&
      i === favorites.length - 1
    const isDragged = reorderDrag !== null && reorderDrag.draggedIndex === i
    return (
      <div
        key={`p${f.id}`}
        data-fav-index={i}
        data-drop-playlist={f.id}
        title={displayName}
        className={
          'fav-item' +
          (isActive ? ' is-active' : '') +
          (isDropTarget ? ' is-drop-target' : '') +
          (isDragged ? ' is-dragged' : '') +
          (dropBefore ? ' drop-before' : '') +
          (dropAfter ? ' drop-after' : '')
        }
        onClick={() => {
          // a drag that ends on this row is followed by a click - ignore it
          if (consumeDragClick()) return
          navigate({ name: 'playlist', id: f.id })
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({
            kind: 'playlist',
            id: f.id,
            name: displayName,
            isLikes: f.isLikes === true,
            x: e.clientX,
            y: e.clientY,
          })
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          beginPlaylistReorder({
            e,
            index: i,
            coverPath: f.coverPath ?? null,
            onDrop: reorderFavorites,
          })
        }}
      >
        <span className="fav-cover">
          <Cover path={f.coverPath ?? null} label={displayName} size={22} />
        </span>
        <span className="fav-name">{displayName}</span>
      </div>
    )
  }

  const artistRow = (a: { id: number; name: string; imagePath?: string | null }) => (
    <div
      key={`a${a.id}`}
      className="fav-item"
      title={a.name}
      onClick={() => navigate({ name: 'artist', id: a.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ kind: 'artist', id: a.id, name: a.name, isLikes: false, x: e.clientX, y: e.clientY })
      }}
    >
      <span className="fav-cover">
        <Cover path={a.imagePath ?? null} label={a.name} size={22} rounded />
      </span>
      <span className="fav-name">{a.name}</span>
    </div>
  )

  const albumRow = (al: { id: number; title: string; coverPath: string | null }) => (
    <div
      key={`al${al.id}`}
      className="fav-item"
      title={al.title}
      onClick={() => navigate({ name: 'album', id: al.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ kind: 'album', id: al.id, name: al.title, isLikes: false, x: e.clientX, y: e.clientY })
      }}
    >
      <span className="fav-cover">
        <Cover path={al.coverPath} label={al.title} size={22} />
      </span>
      <span className="fav-name">{al.title}</span>
    </div>
  )

  const artists = favArtists.data ?? []
  const albums = favAlbums.data ?? []

  return (
    <>
      <aside
        className={
          'sidebar' +
          (collapsed ? ' is-collapsed' : '') +
          (resizing ? ' is-resizing' : '')
        }
        style={{ width: collapsed ? COLLAPSED_W : width }}
      >
        <div className="sidebar-brand">
          <Disc3 size={18} className="sidebar-brand-icon" />
          <span>Tempo</span>
        </div>
        <nav className="sidebar-nav">
          {items.map((it) => {
            const Icon = it.icon
            return (
              <button
                key={it.key}
                className={'side-item' + (active === it.key ? ' is-active' : '')}
                title={t(it.label)}
                onClick={() => navigate({ name: it.key })}
              >
                <Icon size={17} />
                <span>{t(it.label)}</span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-favs">
          {!collapsed ? (
            <div className="fav-head">
              <span>{t('Favorites')}</span>
              <span className="fav-count">
                {grouped ? favorites.length : favorites.length + artists.length + albums.length}
              </span>
            </div>
          ) : null}
          {!collapsed &&
          (grouped
            ? favorites.length === 0
            : favorites.length + artists.length + albums.length === 0) ? (
            <div className="fav-empty">{t('Pin playlists to see them here')}</div>
          ) : null}
          <div className="fav-list">{favorites.map((f, i) => playlistRow(f, i))}</div>
          {grouped && !collapsed ? (
            artists.length > 0 ? (
              <>
                <div className="fav-head" style={{ marginTop: 10 }}>
                  <span>{t('Favorite artists')}</span>
                  <span className="fav-count">{artists.length}</span>
                </div>
                <div className="fav-list" style={{ marginTop: 2 }}>
                  {artists.map(artistRow)}
                </div>
              </>
            ) : null
          ) : artists.length > 0 ? (
            <div className="fav-list">{artists.map(artistRow)}</div>
          ) : null}
          {grouped && !collapsed ? (
            albums.length > 0 ? (
              <>
                <div className="fav-head" style={{ marginTop: 10 }}>
                  <span>{t('Favorite albums')}</span>
                  <span className="fav-count">{albums.length}</span>
                </div>
                <div className="fav-list" style={{ marginTop: 2 }}>
                  {albums.map(albumRow)}
                </div>
              </>
            ) : null
          ) : albums.length > 0 ? (
            <div className="fav-list">{albums.map(albumRow)}</div>
          ) : null}
          <button className="fav-new" title={t('New playlist')} onClick={() => setNewOpen(true)}>
            <Plus size={15} />
            {!collapsed ? <span>{t('New playlist')}</span> : null}
          </button>
        </div>
        <div className="sidebar-bottom">
          <button
            className={'side-item' + (view.name === 'profile' ? ' is-active' : '')}
            title={t('Profile')}
            onClick={() => navigate({ name: 'profile' })}
          >
            {settings.profile.avatarPath ? (
              <img
                className="side-avatar"
                src={convertFileSrc(settings.profile.avatarPath)}
                alt=""
                draggable={false}
              />
            ) : (
              <User size={17} />
            )}
            <span>{settings.profile.nickname ?? t('Profile')}</span>
          </button>
          <button
            className={'side-item' + (view.name === 'settings' ? ' is-active' : '')}
            title={t('Settings')}
            onClick={() => navigate({ name: 'settings' })}
          >
            <Settings size={17} />
            <span>{t('Settings')}</span>
          </button>
          <button
            className="side-item"
            title={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
            onClick={toggleCollapse}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            <span>{collapsed ? t('Expand sidebar') : t('Collapse sidebar')}</span>
          </button>
        </div>
        <div
          className="sidebar-resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onDoubleClick={onResizeReset}
        />
      </aside>
      {menu ? (
        <div ref={menuRef} className="fav-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            className="menu-item"
            onClick={() => {
              const m = menu
              setMenu(null)
              if (m.kind === 'playlist') void playFavorite(m.id)
              else if (m.kind === 'artist') void playArtist(m.id)
              else void playAlbum(m.id)
            }}
          >
            <Play size={13} />
            {t('Play now')}
          </button>
          <button
            className="menu-item"
            onClick={() => {
              const m = menu
              setMenu(null)
              if (m.kind === 'playlist') {
                api.setPlaylistPinned(m.id, false).then(() => bumpLibraryVersion()).catch(() => undefined)
              } else if (m.kind === 'artist') {
                void api.toggleFavoriteArtist(m.id).then(() => bumpLibraryVersion()).catch(() => undefined)
              } else {
                void api.toggleFavoriteAlbum(m.id).then(() => bumpLibraryVersion()).catch(() => undefined)
              }
            }}
          >
            <StarOff size={13} />
            {t('Remove from favorites')}
          </button>
          {menu.kind === 'playlist' && !menu.isLikes ? (
            <>
              <div className="menu-sep" />
              <button
                className="menu-item menu-item-danger"
                onClick={() => {
                  const m = menu
                  setMenu(null)
                  setDeleteTarget({ id: m.id, name: m.name })
                }}
              >
                <Trash2 size={13} />
                {t('Delete playlist')}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <ConfirmModal
        open={deleteTarget !== null}
        danger
        title={t('Delete playlist')}
        message={`"${deleteTarget?.name ?? ''}" ${t('will be deleted. This cannot be undone.')}`}
        confirmLabel={t('Delete')}
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleteTarget(null)}
      />
      <Modal
        open={newOpen}
        title={t('New playlist')}
        onClose={() => {
          setNewOpen(false)
          setNewName('')
        }}
      >
        <input
          className="text-input"
          autoFocus
          value={newName}
          placeholder={t('Playlist name')}
          spellCheck={false}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createNew()
          }}
        />
        <div className="modal-actions">
          <button
            className="btn"
            onClick={() => {
              setNewOpen(false)
              setNewName('')
            }}
          >
            {t('Cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={creating || newName.trim().length === 0}
            onClick={() => void createNew()}
          >
            {t('Create')}
          </button>
        </div>
      </Modal>
    </>
  )
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
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
import { tracksToUnified } from '../../utils/unified'
import { usePlayer } from '../../player'
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
  const active = activeFor(view)

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
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [trackDropFav, setTrackDropFav] = useState<number | null>(null)

  const widthRef = useRef(width)
  widthRef.current = width
  const resizeStart = useRef<{ x: number; w: number } | null>(null)
  const dragIndexRef = useRef<number | null>(null)
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

  const playFavorite = useCallback(
    async (id: number) => {
      try {
        const rows = await api.getPlaylist(id)
        player.playTracks(tracksToUnified(rows.map((r) => r.track)), 0)
      } catch {}
    },
    [player],
  )

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

  const finishDrag = () => {
    dragIndexRef.current = null
    setDragIndex(null)
    setDropAt(null)
  }

  const insertionAt = (e: ReactDragEvent<HTMLDivElement>, index: number): number => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY > r.top + r.height / 2 ? index + 1 : index
  }

  const onFavDragStart = (e: ReactDragEvent<HTMLDivElement>, index: number) => {
    dragIndexRef.current = index
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(favorites[index].id))
  }

  const isTrackDrag = (e: ReactDragEvent) => e.dataTransfer.types.includes('application/x-tempo-track')

  const onFavDragOver = (e: ReactDragEvent<HTMLDivElement>, index: number) => {
    if (isTrackDrag(e)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setTrackDropFav(index)
      return
    }
    if (dragIndexRef.current === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropAt(insertionAt(e, index))
  }

  const onFavDrop = (e: ReactDragEvent<HTMLDivElement>, index: number) => {
    if (isTrackDrag(e)) {
      e.preventDefault()
      const raw = e.dataTransfer.getData('application/x-tempo-track')
      const trackId = Number(raw)
      setTrackDropFav(null)
      dragIndexRef.current = null
      setDragIndex(null)
      setDropAt(null)
      if (!Number.isInteger(trackId) || trackId <= 0) return
      void api
        .playlistAddTrack(favorites[index].id, trackId)
        .then(() => {
          toast.show(`${t('Added to')} ${favorites[index].name}`)
          bumpLibraryVersion()
        })
        .catch(() => undefined)
      return
    }
    e.preventDefault()
    const from = dragIndexRef.current
    const rawTo = from === null ? null : insertionAt(e, index)
    finishDrag()
    if (from === null || rawTo === null) return
    let to = rawTo
    if (from < to) to -= 1
    if (to === from) return
    const ids = favorites.map((f) => f.id)
    const moved = ids[from]
    ids.splice(from, 1)
    ids.splice(to, 0, moved)
    setOverride(ids)
    api
      .movePinnedPlaylist(moved, to)
      .then(() => bumpLibraryVersion())
      .catch(() => undefined)
  }

  const createNew = async () => {
    const trimmed = newName.trim()
    if (trimmed.length === 0 || creating) return
    setCreating(true)
    try {
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
              <span className="fav-count">{favorites.length}</span>
            </div>
          ) : null}
          {favorites.length === 0 && !collapsed ? (
            <div className="fav-empty">{t('Pin playlists to see them here')}</div>
          ) : (
            <div className="fav-list">
              {favorites.map((f, i) => {
                const isActive = view.name === 'playlist' && view.id === f.id
                const displayName = playlistDisplayName(f, f.name, t)
                return (
                  <div
                    key={f.id}
                    draggable
                    title={displayName}
                    className={
                      'fav-item' +
                      (isActive ? ' is-active' : '') +
                      (trackDropFav === i ? ' is-drop-target' : '') +
                      (dragIndex !== null && dropAt === i ? ' drop-before' : '') +
                      (dragIndex !== null &&
                      dropAt === favorites.length &&
                      i === favorites.length - 1
                        ? ' drop-after'
                        : '')
                    }
                    onClick={() => navigate({ name: 'playlist', id: f.id })}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ id: f.id, name: displayName, isLikes: f.isLikes === true, x: e.clientX, y: e.clientY })
                    }}
                    onDragStart={(e) => onFavDragStart(e, i)}
                    onDragOver={(e) => onFavDragOver(e, i)}
                    onDragLeave={() => setTrackDropFav((cur) => (cur === i ? null : cur))}
                    onDrop={(e) => onFavDrop(e, i)}
                    onDragEnd={finishDrag}
                  >
                    <span className="fav-cover">
                      <Cover path={f.coverPath ?? null} label={displayName} size={22} />
                    </span>
                    <span className="fav-name">{displayName}</span>
                  </div>
                )
              })}
            </div>
          )}
          {!collapsed && (favArtists.data?.length ?? 0) > 0 ? (
            <>
              <div className="fav-head" style={{ marginTop: 10 }}>
                <span>{t('Favorite artists')}</span>
                <span className="fav-count">{favArtists.data!.length}</span>
              </div>
              <div className="fav-list">
                {favArtists.data!.map((a) => (
                  <div
                    key={a.id}
                    className="fav-item"
                    title={a.name}
                    onClick={() => navigate({ name: 'artist', id: a.id })}
                  >
                    <span className="fav-cover">
                      <Cover path={null} label={a.name} size={22} rounded />
                    </span>
                    <span className="fav-name">{a.name}</span>
                  </div>
                ))}
              </div>
            </>
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
              const id = menu.id
              setMenu(null)
              void playFavorite(id)
            }}
          >
            <Play size={13} />
            {t('Play now')}
          </button>
          <button
            className="menu-item"
            onClick={() => {
              const id = menu.id
              setMenu(null)
              api
                .setPlaylistPinned(id, false)
                .then(() => bumpLibraryVersion())
                .catch(() => undefined)
            }}
          >
            <StarOff size={13} />
            {t('Remove from favorites')}
          </button>
          {menu.isLikes ? null : (
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
          )}
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

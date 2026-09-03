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
import type { Album, Artist, FavoriteKind, FavoriteOrderEntry, Playlist } from '../../types/models'
import { playlistDisplayName } from '../../utils/playlists'
import { useLibraryVersion } from '../../hooks/useLibraryVersion'
import { useAsync } from '../../hooks/useAsync'
import { bumpLibraryVersion } from '../../utils/libraryVersion'
import { tracksToUnified, trackToUnified } from '../../utils/unified'
import { usePlayer } from '../../player'
import {
  beginFavoriteReorder,
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

/**
 * One row of the sidebar favorites. Playlists, artists and albums share a single
 * order (`favorite_order`), so they share one array; the grouped view is that
 * array filtered per kind, which is what keeps the relative order intact when the
 * user turns grouping on and off.
 */
type FavEntry =
  | { kind: 'playlist'; id: number; item: Playlist }
  | { kind: 'artist'; id: number; item: Artist }
  | { kind: 'album'; id: number; item: Album }

/** A row plus its index into the flat array - the index the drag layer reports. */
interface FavRow {
  entry: FavEntry
  index: number
}

/** Stable empties, so the favorites memo does not re-run on every render. */
const EMPTY_ARTISTS: Artist[] = []
const EMPTY_ALBUMS: Album[] = []

function favKey(kind: FavoriteKind, id: number): string {
  return `${kind}:${id}`
}

/**
 * Where the insertion line goes inside one rendered list. Flat indices are not
 * contiguous inside a group, so the slot is resolved by comparison rather than by
 * equality: the line sits before the first row the insert index reaches.
 */
function insertSlot(rows: FavRow[], insertAt: number | null): number | null {
  if (insertAt === null) return null
  for (let p = 0; p < rows.length; p += 1) {
    if (insertAt <= rows[p].index) return p
  }
  return rows.length
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
  const favOrder = useAsync(() => api.listFavoritesOrder(), [version])
  const dragState = useDragTargets()
  const active = activeFor(view)
  const grouped = settings.sidebar.grouped
  // grouping off is the whole point of the shared order: one list where the three
  // kinds can be mixed. Grouping on keeps the three sections, still ordered by the
  // same array.
  const interleaved = !grouped

  const [width, setWidth] = useState(readWidth)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [resizing, setResizing] = useState(false)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [override, setOverride] = useState<string[] | null>(null)
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
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [version])

  // The optimistic order a drag drew is dropped only once the backend hands back a
  // fresh one, otherwise clearing it early shows the pre-drag order for a frame.
  useEffect(() => {
    if (favOrder.data !== null) setOverride(null)
  }, [favOrder.data])

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

  const artists = favArtists.data ?? EMPTY_ARTISTS
  const albums = favAlbums.data ?? EMPTY_ALBUMS

  /**
   * The three lists merged into the stored order. Anything the order table does
   * not mention is appended in its own list's order, so a newly pinned playlist
   * or freshly favorited artist shows up at the end instead of vanishing.
   * `override` is the optimistic sequence a drag just produced; it wins until the
   * next reload confirms it.
   */
  const favorites = useMemo<FavEntry[]>(() => {
    const byKey = new Map<string, FavEntry>()
    for (const p of pinned) byKey.set(favKey('playlist', p.id), { kind: 'playlist', id: p.id, item: p })
    for (const a of artists) byKey.set(favKey('artist', a.id), { kind: 'artist', id: a.id, item: a })
    for (const al of albums) byKey.set(favKey('album', al.id), { kind: 'album', id: al.id, item: al })

    const sequence = override ?? (favOrder.data ?? []).map((e) => favKey(e.kind, e.refId))
    const out: FavEntry[] = []
    const used = new Set<string>()
    for (const key of sequence) {
      const entry = byKey.get(key)
      if (entry === undefined || used.has(key)) continue
      used.add(key)
      out.push(entry)
    }
    for (const [key, entry] of byKey) {
      if (!used.has(key)) out.push(entry)
    }
    return out
  }, [pinned, artists, albums, favOrder.data, override])

  const favoritesRef = useRef(favorites)
  favoritesRef.current = favorites

  const rowsOf = useCallback(
    (kind: FavoriteKind): FavRow[] =>
      favorites
        .map((entry, index) => ({ entry, index }))
        .filter((row) => row.entry.kind === kind),
    [favorites],
  )

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
      const found = favoritesRef.current.find(
        (f) => f.kind === 'playlist' && f.id === playlistId,
      )
      const pl = found?.kind === 'playlist' ? found.item : undefined
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

  /**
   * The drag layer reports flat indices, so a move is just a splice on the flat
   * sequence - the same arithmetic for all three kinds. The whole resulting
   * sequence is what goes to the backend; it never has to reconstruct a move.
   */
  const reorderFavorites = useCallback((from: number, to: number) => {
    const keys = favoritesRef.current.map((f) => favKey(f.kind, f.id))
    if (from < 0 || from >= keys.length) return
    const moved = keys[from]
    keys.splice(from, 1)
    keys.splice(Math.max(0, Math.min(to, keys.length)), 0, moved)
    setOverride(keys)
    const items: FavoriteOrderEntry[] = keys.map((key) => {
      const [kind, id] = key.split(':')
      return { kind: kind as FavoriteKind, refId: Number(id) }
    })
    api
      .setFavoritesOrder(items)
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
  const reorderDrag = dragState?.kind === 'favorite' ? dragState : null
  const draggedKind: FavoriteKind | null =
    reorderDrag?.draggedIndex != null ? (favorites[reorderDrag.draggedIndex]?.kind ?? null) : null

  /**
   * Drag decorations for one row. `rows`/`pos` are the row's place inside the list
   * it is rendered in, so the insertion line lands correctly in grouped mode where
   * flat indices skip; `index` is the flat index the drag layer speaks in. In
   * grouped mode only the dragged kind's own section is decorated - the insert
   * index belongs to that section and would read as a bogus slot in the others.
   */
  const dragClasses = (index: number, rows: FavRow[], pos: number): string => {
    if (reorderDrag === null) return ''
    const isDragged = reorderDrag.draggedIndex === index ? ' is-dragged' : ''
    const rowKind = rows[pos].entry.kind
    if (!interleaved && draggedKind !== null && rowKind !== draggedKind) return isDragged
    const slot = insertSlot(rows, reorderDrag.insertAt)
    return (
      isDragged +
      (slot === pos ? ' drop-before' : '') +
      (slot === rows.length && pos === rows.length - 1 ? ' drop-after' : '')
    )
  }

  const dragProps = (
    index: number,
    coverPath: string | null,
    restrictKind: FavoriteKind | null,
  ) => ({
    'data-fav-index': index,
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      beginFavoriteReorder({ e, index, coverPath, restrictKind, onDrop: reorderFavorites })
    },
  })

  const playlistRow = (f: Playlist, index: number, rows: FavRow[], pos: number) => {
    const isActive = view.name === 'playlist' && view.id === f.id
    const displayName = playlistDisplayName(f, f.name, t)
    const isDropTarget = trackDragActive && dragState?.targetId === f.id
    return (
      <div
        key={`p${f.id}`}
        {...dragProps(index, f.coverPath ?? null, grouped ? 'playlist' : null)}
        data-fav-kind="playlist"
        data-drop-playlist={f.id}
        title={displayName}
        className={
          'fav-item' +
          (isActive ? ' is-active' : '') +
          (isDropTarget ? ' is-drop-target' : '') +
          dragClasses(index, rows, pos)
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
      >
        <span className="fav-cover">
          <Cover path={f.coverPath ?? null} label={displayName} size={22} />
        </span>
        <span className="fav-name">{displayName}</span>
      </div>
    )
  }

  const artistRow = (a: Artist, index: number, rows: FavRow[], pos: number) => (
    <div
      key={`a${a.id}`}
      {...dragProps(index, a.imagePath ?? null, grouped ? 'artist' : null)}
      data-fav-kind="artist"
      className={'fav-item' + dragClasses(index, rows, pos)}
      title={a.name}
      onClick={() => {
        if (consumeDragClick()) return
        navigate({ name: 'artist', id: a.id })
      }}
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

  const albumRow = (al: Album, index: number, rows: FavRow[], pos: number) => (
    <div
      key={`al${al.id}`}
      {...dragProps(index, al.coverPath, grouped ? 'album' : null)}
      data-fav-kind="album"
      className={'fav-item' + dragClasses(index, rows, pos)}
      title={al.title}
      onClick={() => {
        if (consumeDragClick()) return
        navigate({ name: 'album', id: al.id })
      }}
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

  /** One row dispatched by kind, so both views render from the same array. */
  const favRow = (rows: FavRow[], pos: number) => {
    const { entry, index } = rows[pos]
    if (entry.kind === 'playlist') return playlistRow(entry.item, index, rows, pos)
    if (entry.kind === 'artist') return artistRow(entry.item, index, rows, pos)
    return albumRow(entry.item, index, rows, pos)
  }

  const renderRows = (rows: FavRow[]) => rows.map((_, pos) => favRow(rows, pos))

  const flatRows = useMemo<FavRow[]>(
    () => favorites.map((entry, index) => ({ entry, index })),
    [favorites],
  )
  const playlistRows = rowsOf('playlist')
  const artistRows = rowsOf('artist')
  const albumRows = rowsOf('album')
  const headerCount = interleaved ? favorites.length : playlistRows.length

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
              <span className="fav-count">{headerCount}</span>
            </div>
          ) : null}
          {!collapsed && headerCount === 0 ? (
            <div className="fav-empty">{t('Pin playlists to see them here')}</div>
          ) : null}
          {interleaved ? (
            // one continuous list: a playlist, an artist and an album can sit in any
            // order relative to each other
            <div className="fav-list">{renderRows(flatRows)}</div>
          ) : (
            <>
              <div className="fav-list">{renderRows(playlistRows)}</div>
              {artistRows.length > 0 ? (
                <>
                  {!collapsed ? (
                    <div className="fav-head" style={{ marginTop: 10 }}>
                      <span>{t('Favorite artists')}</span>
                      <span className="fav-count">{artistRows.length}</span>
                    </div>
                  ) : null}
                  <div className="fav-list" style={{ marginTop: 2 }}>
                    {renderRows(artistRows)}
                  </div>
                </>
              ) : null}
              {albumRows.length > 0 ? (
                <>
                  {!collapsed ? (
                    <div className="fav-head" style={{ marginTop: 10 }}>
                      <span>{t('Favorite albums')}</span>
                      <span className="fav-count">{albumRows.length}</span>
                    </div>
                  ) : null}
                  <div className="fav-list" style={{ marginTop: 2 }}>
                    {renderRows(albumRows)}
                  </div>
                </>
              ) : null}
            </>
          )}
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

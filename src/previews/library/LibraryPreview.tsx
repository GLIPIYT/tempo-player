import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpDown, Check, ChevronDown, Clock3, Disc3, Ellipsis, Folder, Heart, House, ListMusic, ListPlus, Maximize2, MicVocal, Minus, Music2, Pause, Pencil, Play, Plus, Repeat2, Search, Settings2, Shuffle, SkipBack, SkipForward, Star, Upload, Users, Volume2, X } from 'lucide-react'
import BrandIcon from '../../components/common/BrandIcon'
import { normalizeSearchText } from '../../utils/searchText'
import sample from '../../../docs/design/library-redesign/sample-data.json'
import '../../styles/global.css'
import './libraryPreview.css'

type Page = 'playlists' | 'albums' | 'playlist' | 'album' | 'artist'
type Variant = 'air' | 'focus' | 'panorama'
type Theme = 'graphite' | 'cherry' | 'wallpaper'
type Track = typeof sample.tracks[number] & { id: number; album: string; source: 'soundcloud' | 'youtube' | 'local' }
type Collection = { id: string; title: string; description: string; cover: string; count: number }
const ASSETS = '/docs/design/library-redesign/assets/'
const PAGES: [Page, string][] = [['playlists', 'Плейлисты'], ['albums', 'Альбомы'], ['playlist', 'Плейлист'], ['album', 'Альбом'], ['artist', 'Исполнитель']]
const VARIANTS: [Variant, string, string][] = [['air', 'Воздух', 'Обложки и пространство'], ['focus', 'Фокус', 'Музыка всегда рядом'], ['panorama', 'Панорама', 'Широкие шапки и крупные обложки']]
const TRACKS: Track[] = sample.tracks.map((track, id) => ({ ...track, id, album: sample.albums[1].title, source: (['soundcloud', 'local', 'youtube'] as const)[id % 3] }))
const INITIAL_LISTS: Collection[] = [
  { id: 'likes', title: 'Любимые песни', description: 'То, что хочется включить снова', cover: 'cover-2.png', count: 36 },
  { id: 'night', title: 'После полуночи', description: 'Тихий город, громкие мысли', cover: 'cover-4.jpg', count: 24 },
  { id: 'guitars', title: 'Гитары и ничего лишнего', description: 'CUPSIZE, Clarion и знакомый шум', cover: 'cover-1.jpg', count: 18 },
  { id: 'walk', title: 'Пешком домой', description: 'Для долгой дороги без спешки', cover: 'cover-7.jpg', count: 32 },
  { id: 'summer', title: 'Прошлым летом', description: 'Песни, которые остались', cover: 'cover-8.png', count: 15 },
  { id: 'new', title: 'Новая волна', description: 'Недавние находки из SoundCloud', cover: 'cover-6.jpg', count: 21 },
]
const time = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
const pluralRules = new Intl.PluralRules('ru')
const songCount = (value: number) => `${value} ${pluralRules.select(value) === 'one' ? 'песня' : pluralRules.select(value) === 'few' ? 'песни' : 'песен'}`
const asset = (file: string) => ASSETS + file
const waveform = Array.from({ length: 122 }, (_, i) => 12 + (Math.sin(i * .72) ** 2 * .55 + Math.sin(i * .17 + 1.5) ** 2 * .45) * 76)

function readRoute() {
  const hash = new URLSearchParams(location.hash.slice(1))
  const variant = hash.get('variant') as Variant
  const page = hash.get('page') as Page
  return { variant: VARIANTS.some(v => v[0] === variant) ? variant : 'air' as Variant, page: PAGES.some(p => p[0] === page) ? page : 'playlists' as Page, id: hash.get('id') ?? 'likes' }
}

function PreviewDialog({ children, label, onClose, cover = false }: { children: ReactNode; label: string; onClose: () => void; cover?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const close = () => { if (!timer.current) { setClosing(true); timer.current = setTimeout(onClose, 150) } }
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ;(ref.current?.querySelector<HTMLInputElement>('input') ?? ref.current)?.focus()
    return () => { if (timer.current) clearTimeout(timer.current); before?.focus() }
  }, [])
  return <div className={`lp-overlay${closing ? ' is-closing' : ''}${cover ? ' is-cover' : ''}`} onPointerDown={e => { if (e.target === e.currentTarget) close() }}>
    <div ref={ref} className="lp-dialog" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
      if (e.key !== 'Tab') return
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button,input') ?? []).filter(n => !n.hasAttribute('disabled'))
      const first = items[0], last = items.at(-1)
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first?.focus() }
    }}>
      <button className="lp-icon lp-dialog-close" aria-label="Закрыть окно" onClick={close}><X size={20} /></button>
      {children}
    </div>
  </div>
}

function Source({ source }: { source: Track['source'] }) {
  return source === 'local' ? <Folder size={13} /> : <BrandIcon mark={source === 'youtube' ? 'youtubemusic' : 'soundcloud'} brand size={15} />
}

function LibraryPreview() {
  const [route, setRoute] = useState(readRoute)
  const [theme, setTheme] = useState<Theme>('cherry')
  const [lists, setLists] = useState(INITIAL_LISTS)
  const [favorites, setFavorites] = useState(new Set(['likes', 'night', 'album:2']))
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('recent')
  const [artistTab, setArtistTab] = useState('popular')
  const [artistName, setArtistName] = useState(() => route.page === 'artist' && route.id !== 'likes' && !/^\d+$/.test(route.id) ? route.id : 'CUPSIZE')
  const [trackQuery, setTrackQuery] = useState('')
  const [current, setCurrent] = useState(TRACKS[0])
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(48)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState(false)
  const [volume, setVolume] = useState(42)
  const [modal, setModal] = useState<'cover' | 'create' | 'import' | null>(null)
  const [cover, setCover] = useState('cover-2.png')
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [rename, setRename] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; key: string; page?: Page; id?: string } | null>(null)
  const [notice, setNotice] = useState('')
  const main = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { page, variant, id } = route
  const selectedList = lists.find(list => list.id === id) ?? lists[0]
  const selectedAlbum = sample.albums.find(album => album.id === id) ?? sample.albums[1]
  const artistImage = sample.artists.find(item => item.name === artistName)?.image ?? sample.albums.find(item => item.artist === artistName)?.cover ?? sample.artists[1].image
  const isArtist = page === 'artist'
  const isPlaylist = page === 'playlist'
  const isDetail = isArtist || isPlaylist || page === 'album'
  const title = isArtist ? artistName : isPlaylist ? selectedList.title : selectedAlbum.title
  const heroCover = isArtist ? artistImage : isPlaylist ? selectedList.cover : selectedAlbum.cover
  const activeKey = isArtist ? `artist:${artistName}` : isPlaylist ? selectedList.id : `album:${selectedAlbum.id}`

  useEffect(() => {
    const changed = () => {
      const next = readRoute()
      setRoute(next)
      if (next.page === 'artist' && next.id !== 'likes' && !/^\d+$/.test(next.id)) setArtistName(next.id)
      setQuery(''); setTrackQuery(''); setMenu(null); setRenaming(false); setFilter('all'); main.current?.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => setProgress(value => value + .25 >= current.duration ? 0 : value + .25), 250)
    return () => clearInterval(timer)
  }, [playing, current.duration])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 2300)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [menu])

  const go = (next: Page, nextId = id, nextVariant = variant) => {
    location.hash = new URLSearchParams({ variant: nextVariant, page: next, id: nextId }).toString()
  }
  const favorite = (key: string) => setFavorites(value => { const next = new Set(value); if (!next.delete(key)) next.add(key); return next })
  const play = (track = TRACKS[0]) => { setCurrent(track); setProgress(0); setPlaying(true) }
  const skip = (direction: number) => play(TRACKS[(TRACKS.findIndex(track => track.id === current.id) + direction + TRACKS.length) % TRACKS.length])
  const showCover = (image: string) => { setCover(image); setModal('cover') }
  const showMenu = (event: { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number }, item: { title: string; key: string; page?: Page; id?: string }) => {
    event.preventDefault(); event.stopPropagation()
    setMenu({ ...item, x: Math.max(12, Math.min(innerWidth - 236, event.clientX)), y: Math.max(12, Math.min(innerHeight - 175, event.clientY)) })
  }
  const artistLink = (name: string, tab = 'popular') => { setArtistName(name); setArtistTab(tab); go('artist', name) }
  const normalizedTrackQuery = normalizeSearchText(trackQuery)
  const filteredTracks = TRACKS.filter(track => normalizeSearchText(`${track.title} ${track.artist}`).includes(normalizedTrackQuery))
  const emptyPlaylist = isPlaylist && selectedList.count === 0

  const trackList = (tracks: Track[], showAlbum = true) => <div className={`lp-tracks${showAlbum ? '' : ' no-album'}`}>
    <div className="lp-track-columns" aria-hidden="true"><span>#</span><span>Название</span>{showAlbum && <span>Альбом</span>}<Clock3 size={13} /><span /></div>
    {tracks.map((track, index) => <div className={`lp-track-row${current.id === track.id ? ' is-current' : ''}`} key={track.id} onContextMenu={e => showMenu(e, { title: track.title, key: `track:${track.id}` })}>
      <button className="lp-track-index" aria-label={`Включить: ${track.title}`} onClick={() => play(track)}>{current.id === track.id && playing ? <span className="lp-equalizer"><i /><i /><i /></span> : <><span>{index + 1}</span><Play size={13} fill="currentColor" /></>}</button>
      <div className="lp-track-name"><button className="lp-track-title" onClick={() => play(track)}><img src={asset(track.cover)} alt="" /><span><strong>{track.title}</strong><small>{track.artist}<Source source={track.source} /></small></span></button></div>
      {showAlbum && <button className="lp-track-album" onClick={() => go('album', '2')}>{track.album}</button>}
      <time>{time(track.duration)}</time>
      <div className="lp-row-actions"><button className={`lp-icon${favorites.has(`track:${track.id}`) ? ' is-accent' : ''}`} aria-label={`Лайк: ${track.title}`} onClick={() => favorite(`track:${track.id}`)}><Heart size={14} fill={favorites.has(`track:${track.id}`) ? 'currentColor' : 'none'} /></button><button className="lp-icon" aria-label={`Меню: ${track.title}`} onClick={e => showMenu(e, { title: track.title, key: `track:${track.id}` })}><Ellipsis size={17} /></button></div>
    </div>)}
    {!tracks.length && <div className="lp-empty"><Search size={26} /><h3>Песни не найдены</h3><button className="lp-text-button" onClick={() => setTrackQuery('')}>Очистить поиск</button></div>}
  </div>

  const albumCards = (albums = sample.albums) => <div className="lp-album-grid">{albums.map((album, index) => <article className="lp-album-card" key={album.id} onContextMenu={e => showMenu(e, { title: album.title, key: `album:${album.id}`, page: 'album', id: album.id })}>
    <button className="lp-album-open" onClick={() => go('album', album.id)}><span className="lp-album-art"><img src={asset(album.cover)} alt={album.title} loading="lazy" /><span className="lp-art-count"><Disc3 size={12} />{index === 1 ? 6 : 8 + index}</span></span><span className="lp-album-copy"><strong>{album.title}</strong><small>{album.artist}</small><span>{album.year} <span>•</span> Альбом</span></span></button>
    <button className="lp-card-play" aria-label={`Слушать альбом: ${album.title}`} onClick={() => play()}><Play size={17} fill="currentColor" /></button>
    <button className={`lp-card-star${favorites.has(`album:${album.id}`) ? ' is-accent' : ''}`} aria-label={`В избранное: ${album.title}`} onClick={() => favorite(`album:${album.id}`)}><Star size={15} fill={favorites.has(`album:${album.id}`) ? 'currentColor' : 'none'} /></button>
  </article>)}</div>

  const collectionList = () => {
    const albums = page === 'albums'
    const needle = normalizeSearchText(query)
    const visibleLists = lists.filter(list => normalizeSearchText(list.title).includes(needle) && (filter !== 'favorites' || favorites.has(list.id))).sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title) : sort === 'count' ? b.count - a.count : 0)
    const visibleAlbums = sample.albums.filter(album => normalizeSearchText(`${album.title} ${album.artist}`).includes(needle) && (filter !== 'favorites' || favorites.has(`album:${album.id}`))).sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title) : sort === 'count' ? a.artist.localeCompare(b.artist) : 0)
    return <>
      <header className="lp-page-heading"><div><span className="lp-overline">Ваша медиатека</span><h1>{albums ? 'Альбомы' : 'Плейлисты'}<span>{albums ? sample.albums.length : lists.length}</span></h1></div>{!albums && <div className="lp-heading-actions"><button className="lp-button lp-primary" onClick={() => { setNewName(''); setModal('create') }}><Plus size={16} />Новый плейлист</button><button className="lp-icon" aria-label="Импортировать плейлист" onClick={() => setModal('import')}><Upload size={18} /></button></div>}</header>
      <div className="lp-catalog-tools"><div className="lp-filter"><button aria-pressed={filter === 'all'} className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>Все {albums ? 'альбомы' : 'плейлисты'}</button><button aria-pressed={filter === 'favorites'} className={filter === 'favorites' ? 'is-active' : ''} onClick={() => setFilter('favorites')}><Star size={13} />Избранное</button></div><label className="lp-search"><Search size={15} /><input aria-label={albums ? 'Поиск альбомов' : 'Поиск плейлистов'} placeholder="Найти в коллекции" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="Очистить поиск" onClick={() => setQuery('')}><X size={13} /></button>}</label><label className="lp-sort"><ArrowUpDown size={14} /><select aria-label="Сортировка" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">Недавние</option><option value="name">По названию</option><option value="count">{albums ? 'По исполнителю' : 'По числу песен'}</option></select><ChevronDown size={12} /></label></div>
      {albums ? albumCards(visibleAlbums) : <div className="lp-playlist-grid">{visibleLists.map((list, index) => <article className={`lp-playlist-card${list.id === 'likes' ? ' is-likes' : ''}`} key={list.id} onContextMenu={e => showMenu(e, { title: list.title, key: list.id, page: 'playlist', id: list.id })}>
        <button className="lp-playlist-open" onClick={() => go('playlist', list.id)}><span className="lp-playlist-art">{list.id === 'likes' ? <span className="lp-likes-art"><Heart size={55} strokeWidth={1.1} fill="currentColor" /></span> : <img src={asset(list.cover)} alt="" loading="lazy" />}<span className="lp-playlist-numbers"><ListMusic size={13} />{songCount(list.count)}</span></span><span className="lp-playlist-copy"><strong>{list.title}</strong><span>{list.description}</span><small>{songCount(list.count)} <span>•</span> {index === 0 ? 'Обновлён сегодня' : `Обновлён ${index + 1} дн. назад`}</small></span></button>
        <div className="lp-playlist-actions"><button className={`lp-icon${favorites.has(list.id) ? ' is-accent' : ''}`} aria-label={`Закрепить: ${list.title}`} onClick={() => favorite(list.id)}><Star size={15} fill={favorites.has(list.id) ? 'currentColor' : 'none'} /></button><button className="lp-card-play" aria-label={`Слушать: ${list.title}`} onClick={() => play()}><Play size={17} fill="currentColor" /></button><button className="lp-icon" aria-label={`Меню: ${list.title}`} onClick={e => showMenu(e, { title: list.title, key: list.id, page: 'playlist', id: list.id })}><Ellipsis size={19} /></button></div>
      </article>)}<button className="lp-create-card" onClick={() => { setNewName(''); setModal('create') }}><span><Plus size={29} /></span><strong>Новый плейлист</strong></button></div>}
      {(albums ? visibleAlbums.length : visibleLists.length) === 0 && <div className="lp-empty"><Search size={28} /><h3>Ничего не найдено</h3><p>Попробуйте другое название или снимите фильтр.</p><button className="lp-button" onClick={() => { setQuery(''); setFilter('all') }}>Показать всё</button></div>}
    </>
  }

  const detail = () => <div className={`lp-detail${isArtist ? ' is-artist' : ''}`}>
    <header className="lp-detail-hero" style={{ '--hero-art': `url("${asset(heroCover)}")` } as React.CSSProperties}>
      <button className="lp-detail-cover" onClick={() => showCover(heroCover)} aria-label="Рассмотреть обложку"><img src={asset(heroCover)} alt={title} /><span><Maximize2 size={18} /></span></button>
      <div className="lp-detail-copy"><span className="lp-overline">{isArtist ? <MicVocal size={13} /> : isPlaylist ? <ListMusic size={13} /> : <Disc3 size={13} />}{isArtist ? 'Исполнитель' : isPlaylist ? 'Плейлист' : 'Альбом'}<span className="lp-local"><Folder size={11} />В медиатеке</span></span>
        {renaming ? <input className="lp-rename" autoFocus aria-label="Название плейлиста" value={rename} onChange={e => setRename(e.target.value)} onBlur={() => { if (rename.trim()) setLists(lists.map(list => list.id === selectedList.id ? { ...list, title: rename.trim() } : list)); setRenaming(false) }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setRename(selectedList.title); setRenaming(false) } }} /> : <h1>{title}{isPlaylist && <button className="lp-icon lp-rename-button" aria-label="Переименовать плейлист" onClick={() => { setRename(selectedList.title); setRenaming(true) }}><Pencil size={16} /></button>}</h1>}
        {isArtist ? <p className="lp-detail-description">Все сохранённые песни и альбомы исполнителя.</p> : isPlaylist ? <p className="lp-detail-description">{selectedList.description}</p> : <button className="lp-artist-link" onClick={() => artistLink(selectedAlbum.artist)}><img src={asset(sample.artists.find(a => a.name === selectedAlbum.artist)?.image ?? selectedAlbum.cover)} alt="" />{selectedAlbum.artist}<ArrowRight size={13} /></button>}
        <div className="lp-detail-meta">{isArtist ? <><span>2 альбома</span><span>{songCount(TRACKS.length)}</span></> : <><span>{songCount(isPlaylist ? selectedList.count : TRACKS.length)}</span><span>{isPlaylist ? emptyPlaylist ? '0 мин' : '1 ч 24 мин' : '17 мин'}</span><span>{isPlaylist ? 'Обновлён сегодня' : selectedAlbum.year}</span></>}</div>
        <div className="lp-detail-actions"><button className="lp-button lp-primary" disabled={emptyPlaylist} onClick={() => play()}><Play size={16} fill="currentColor" />Воспроизвести все</button><button className={`lp-icon lp-favorite-action${favorites.has(activeKey) ? ' is-accent' : ''}`} aria-label="Добавить в избранное" aria-pressed={favorites.has(activeKey)} onClick={() => favorite(activeKey)}><Heart size={21} fill={favorites.has(activeKey) ? 'currentColor' : 'none'} /></button><button className={`lp-icon${shuffle ? ' is-accent' : ''}`} aria-label="Перемешать подборку" aria-pressed={shuffle} onClick={() => { setShuffle(!shuffle); play(TRACKS[3]) }}><Shuffle size={19} /></button><button className="lp-icon" aria-label="Действия с коллекцией" onClick={e => showMenu(e, { title, key: activeKey })}><Ellipsis size={22} /></button></div>
      </div>
    </header>
    <div className="lp-detail-body">
      {isArtist && <div className="lp-artist-tabs">{[['popular', 'Популярное'], ['albums', 'Альбомы'], ['tracks', 'Все песни']].map(([key, label]) => <button className={artistTab === key ? 'is-active' : ''} key={key} onClick={() => setArtistTab(key)}>{label}</button>)}</div>}
      {(!isArtist || artistTab !== 'albums') && <><div className="lp-section-heading"><h2>{isArtist && artistTab === 'popular' ? 'Популярные песни' : 'Песни'}<span>{emptyPlaylist ? 0 : filteredTracks.length}</span></h2><label className="lp-search lp-track-search"><Search size={14} /><input aria-label="Найти песню" placeholder="Найти песню" value={trackQuery} onChange={e => setTrackQuery(e.target.value)} /></label></div>{emptyPlaylist ? <div className="lp-empty"><ListMusic size={28} /><h3>Пока без песен</h3><p>Добавьте музыку из вашей медиатеки.</p><button className="lp-button" onClick={() => go('albums')}>Открыть медиатеку<ArrowRight size={14} /></button></div> : trackList(filteredTracks, isArtist)}</>}
      {isArtist && artistTab !== 'tracks' && <section className="lp-discography"><div className="lp-section-heading"><h2>Альбомы<span>2</span></h2><button className="lp-text-button" onClick={() => go('albums')}>Все альбомы<ArrowRight size={14} /></button></div>{albumCards(sample.albums.slice(0, 2))}</section>}
      {!isArtist && <footer className="lp-detail-footnote"><Folder size={13} />Сохранено в вашей медиатеке <span>•</span> Доступно без интернета</footer>}
    </div>
  </div>

  return <div className={`lp variant-${variant} theme-${theme}`}>
    <div className="lp-preview-toolbar"><div className="lp-preview-title"><span>Tempo</span><small>Медиатека · дизайн-превью</small></div><div className="lp-variants" aria-label="Вариант дизайна">{VARIANTS.map(([key, name], index) => <button key={key} title={VARIANTS[index][2]} className={variant === key ? 'is-active' : ''} aria-pressed={variant === key} onClick={() => go(page, id, key)}><span>{String.fromCharCode(65 + index)}</span>{name}</button>)}</div><div className="lp-theme-picker" aria-label="Фон превью">{(['graphite', 'cherry', 'wallpaper'] as const).map(key => <button className={theme === key ? 'is-active' : ''} key={key} aria-pressed={theme === key} onClick={() => setTheme(key)}>{key === 'graphite' ? 'Графит' : key === 'cherry' ? 'Вишня' : 'Обои'}</button>)}</div></div>
    <nav className="lp-page-picker" aria-label="Экраны превью">{PAGES.map(([key, name]) => <button key={key} aria-current={page === key ? 'page' : undefined} className={page === key ? 'is-active' : ''} onClick={() => go(key, key === 'album' ? '2' : key === 'playlist' ? 'night' : key === 'artist' ? artistName : id)}>{key === 'playlists' || key === 'playlist' ? <ListMusic size={13} /> : key === 'artist' ? <Users size={13} /> : <Disc3 size={13} />}{name}</button>)}<span>Можно открывать карточки и включать песни · без звука</span></nav>
    <div className="lp-window">
      <div className="lp-titlebar"><span><img src="/docs/brand/icon-concepts/vector/pulse-sunset.svg" alt="" />TEMPO</span><div className="lp-window-buttons" aria-hidden="true"><Minus size={13} /><Maximize2 size={12} /><X size={14} /></div></div>
      <aside className="lp-sidebar"><div className="lp-side-main"><button onClick={() => go('playlists')}><House size={17} />Главная</button><button onClick={() => go('albums')}><Music2 size={17} />Медиатека</button><button className={page === 'albums' || page === 'album' ? 'is-active' : ''} onClick={() => go('albums')}><Disc3 size={17} />Альбомы</button><button className={page === 'artist' ? 'is-active' : ''} onClick={() => artistLink('CUPSIZE')}><Users size={17} />Исполнители</button><button className={page === 'playlists' || page === 'playlist' ? 'is-active' : ''} onClick={() => go('playlists')}><ListMusic size={17} />Плейлисты</button></div><div className="lp-side-favorites"><h2>Избранное<span>{lists.filter(l => favorites.has(l.id)).length}</span></h2>{lists.filter(list => favorites.has(list.id)).map(list => <button key={list.id} onClick={() => go('playlist', list.id)}><img src={asset(list.cover)} alt="" /><span>{list.title}</span></button>)}<h2>Любимые исполнители</h2>{sample.artists.slice(1).map(a => <button key={a.name} onClick={() => artistLink(a.name)}><img className="is-round" src={asset(a.image)} alt="" /><span>{a.name}</span></button>)}<button className="lp-side-create" onClick={() => { setNewName(''); setModal('create') }}><Plus size={17} />Новый плейлист</button></div><button className="lp-side-settings" onClick={() => setTheme(value => value === 'wallpaper' ? 'cherry' : 'wallpaper')}><Settings2 size={16} />Оформление<ArrowRight size={13} /></button></aside>
      <main className="lp-main" ref={main}><div className="lp-breadcrumb"><button className="lp-icon" aria-label="Назад" onClick={() => window.history.length > 1 ? history.back() : go('playlists')}><ArrowLeft size={16} /></button><button onClick={() => go(page === 'album' ? 'albums' : 'playlists')}>{isArtist ? 'Исполнители' : isPlaylist || page === 'playlists' ? 'Плейлисты' : 'Альбомы'}</button>{isDetail && <><span>/</span><span>{title}</span></>}<span className="lp-library-status"><span />Локальная медиатека</span></div><div key={`${variant}:${page}:${id}`} className="lp-page">{isDetail ? detail() : collectionList()}</div></main>
      <footer className="lp-player"><div className="lp-now"><button onClick={() => showCover(current.cover)} aria-label="Обложка текущей песни"><img src={asset(current.cover)} alt="" /></button><div><strong>{current.title}</strong><button onClick={() => artistLink(current.artist)}>{current.artist}</button></div><button className={`lp-icon${favorites.has(`track:${current.id}`) ? ' is-accent' : ''}`} aria-label="Лайк текущей песни" onClick={() => favorite(`track:${current.id}`)}><Heart size={16} fill={favorites.has(`track:${current.id}`) ? 'currentColor' : 'none'} /></button></div><div className="lp-player-center"><div className="lp-player-controls"><button className={`lp-icon${shuffle ? ' is-accent' : ''}`} aria-label="Перемешивание" aria-pressed={shuffle} onClick={() => setShuffle(!shuffle)}><Shuffle size={14} /></button><button className="lp-icon" aria-label="Предыдущая песня" onClick={() => skip(-1)}><SkipBack size={17} fill="currentColor" /></button><button className="lp-player-play" aria-label={playing ? 'Приостановить' : 'Воспроизвести'} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><button className="lp-icon" aria-label="Следующая песня" onClick={() => skip(1)}><SkipForward size={17} fill="currentColor" /></button><button className={`lp-icon${repeat ? ' is-accent' : ''}`} aria-label="Повтор" aria-pressed={repeat} onClick={() => setRepeat(!repeat)}><Repeat2 size={14} /></button></div><div className="lp-player-progress"><time>{time(progress)}</time><div className="lp-waveform"><div className="lp-wave-bars" aria-hidden="true">{waveform.map((height, i) => <i key={i} style={{ height: `${height}%`, background: i / waveform.length < progress / current.duration ? 'var(--accent)' : undefined }} />)}</div><input type="range" min={0} max={current.duration} step={.1} value={progress} aria-label="Позиция воспроизведения" onChange={e => setProgress(Number(e.target.value))} /></div><time>{time(current.duration)}</time></div></div><div className="lp-volume"><Volume2 size={16} /><input type="range" min={0} max={100} value={volume} aria-label="Громкость" onChange={e => setVolume(Number(e.target.value))} /><button className="lp-icon" aria-label="Очередь воспроизведения" onClick={() => artistLink(current.artist, 'tracks')}><ListMusic size={19} /></button></div></footer>
    </div>
    {modal && <PreviewDialog label={modal === 'cover' ? 'Просмотр обложки' : modal === 'create' ? 'Новый плейлист' : 'Импорт плейлиста'} cover={modal === 'cover'} onClose={() => setModal(null)}>{modal === 'cover' ? <img className="lp-zoom-cover" src={asset(cover)} alt="Увеличенная обложка" /> : modal === 'create' ? <form onSubmit={e => { e.preventDefault(); if (!newName.trim()) return; const newList = { id: `custom-${lists.length}`, title: newName.trim(), description: 'Ваш новый плейлист', cover: 'cover-8.png', count: 0 }; setLists([...lists, newList]); setModal(null); go('playlist', newList.id); setNotice('Плейлист создан в превью') }}><span className="lp-dialog-symbol"><ListPlus size={25} /></span><h2>Новый плейлист</h2><p>Дайте имя вашей следующей подборке.</p><label>Название<input autoFocus required maxLength={100} value={newName} placeholder="Например, после полуночи" onChange={e => setNewName(e.target.value)} /></label><button className="lp-button lp-primary" disabled={!newName.trim()}><Plus size={16} />Создать плейлист</button></form> : <div className="lp-import-preview"><span className="lp-dialog-symbol"><Upload size={25} /></span><h2>Импорт плейлиста</h2><p>Оформление выбора файла M3U / M3U8.</p><button className="lp-button lp-primary" onClick={() => { setModal(null); setNotice('В плеере здесь откроется выбор файла') }}><Folder size={16} />Выбрать файл</button></div>}</PreviewDialog>}
    {menu && <div className="lp-menu-shield" onPointerDown={() => setMenu(null)} onKeyDown={e => { if (e.key === 'Escape') setMenu(null) }}><div ref={menuRef} className="lp-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}><strong>{menu.title}</strong><button role="menuitem" onClick={() => { play(menu.key.startsWith('track:') ? TRACKS[Number(menu.key.slice(6))] : TRACKS[0]); setMenu(null) }}><Play size={14} />Воспроизвести</button><button role="menuitem" onClick={() => { favorite(menu.key); setMenu(null) }}><Star size={14} />{favorites.has(menu.key) ? 'Убрать из избранного' : 'Добавить в избранное'}</button>{menu.page && <button role="menuitem" onClick={() => { go(menu.page!, menu.id); setMenu(null) }}><ArrowRight size={14} />Открыть страницу</button>}<button role="menuitem" onClick={() => { setMenu(null); setNotice('Все песни уже доступны в демонстрации') }}><ArrowDownToLine size={14} />Сохранить в кэш<Check size={12} /></button></div></div>}
    {notice && <div className="lp-notice" role="status"><Check size={15} />{notice}</div>}
  </div>
}

const previewHost = document.getElementById('root')! as HTMLElement & { tempoPreviewRoot?: Root }
previewHost.tempoPreviewRoot ??= createRoot(previewHost)
previewHost.tempoPreviewRoot.render(<LibraryPreview />)

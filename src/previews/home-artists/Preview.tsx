import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, ArrowDownToLine, ArrowDownUp, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight,
  Clock3, Disc3, Headphones, Heart, House, ListMusic, MicVocal, Music2, Pause, Play, Plus,
  Repeat2, Search, Shuffle, SkipBack, SkipForward, Volume2, X,
} from 'lucide-react'
import { normalizeSearchText } from '../../utils/searchText'
import { useRecommendationRail } from '../../components/home/useRecommendationRail'
import {
  artists, favoriteArtists, genreTracks, initialLikes, mixes, mostPlayed, playlists,
  recent, recentlyAdded, recommendations, tracks, type Artist, type Mix, type Track,
} from './fixtures'
import '../../styles/global.css'
import './preview.css'

type Page = 'home' | 'artists'
type Variant = 'a' | 'b' | 'c'
type Modal = { kind: 'mix'; mix: Mix } | { kind: 'artist'; artist: Artist } | { kind: 'all-mixes' } | { kind: 'new-rule' }
type PlayTracks = (tracks: Track[], index?: number) => void
const LOGO = '/docs/brand/icon-concepts/vector/pulse-violet.svg'
const BG = '/docs/design/1.0-remaster/home-assets/night-transit.png'
const pageLabels = { home: 'Главная', artists: 'Исполнители' }
const variantLabels = {
  home: { a: 'Панорама', b: 'Две колонки', c: 'Стопка' },
  artists: { a: 'Витрина', b: 'Портрет', c: 'Галерея' },
}
const compact = new Intl.NumberFormat('ru-RU')
const time = (duration: number) => `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`
const artStyle = (art?: string | null): CSSProperties | undefined => art ? { '--art': `url("${art}")` } as CSSProperties : undefined

function routeFromHash() {
  const params = new URLSearchParams(location.hash.slice(1))
  const page = params.get('page') === 'artists' ? 'artists' : 'home'
  const value = params.get('variant')
  const variant = value === 'b' || value === 'c' ? value : 'a'
  return { page, variant } as const
}

function Artwork({ art, name, eager = false, round = false }: { art: string | null; name: string; eager?: boolean; round?: boolean }) {
  return <span className={`pv-art${round ? ' is-round' : ''}`}>
    {art ? <img src={art} alt="" loading={eager ? 'eager' : 'lazy'} fetchPriority={eager ? 'high' : 'auto'} decoding="async" draggable={false} />
      : <span aria-hidden="true">{name.replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 1).toUpperCase() || <Music2 size={18} />}</span>}
  </span>
}

function PlayAll({ onClick, children = 'Воспроизвести все' }: { onClick: () => void; children?: ReactNode }) {
  return <button type="button" className="pv-primary" onClick={onClick}><Play size={14} fill="currentColor" />{children}</button>
}

function Glow({ art }: { art: string }) {
  return <div className="pv-glow" style={artStyle(art)} aria-hidden="true" />
}

function TrackRow({ song, onPlay, active = false }: { song: Track; onPlay: () => void; active?: boolean }) {
  return <button className="pv-track-row" onClick={onPlay} aria-pressed={active}>
    <Artwork art={song.art} name={song.title} />
    <span className="pv-row-copy"><strong>{song.title}</strong><small>{song.artist}</small></span>
    <span className="pv-track-time">{time(song.seconds)}</span><Play size={15} className="pv-row-play" />
  </button>
}

function TrackShelf({ title, songs, variant, onPlay, current, cached, onCache }: {
  title: string; songs: Track[]; variant: Variant; onPlay: PlayTracks; current: Track | undefined;
  cached: Set<number>; onCache?: (id: number) => void
}) {
  const [offset, setOffset] = useState(0)
  const smooth = variant === 'b'
  const cardSize = 88
  const step = cardSize + 10
  const rail = useRecommendationRail(smooth ? songs.length : 0, step)
  const [edges, setEdges] = useState({ start: true, end: false })
  const drag = useRef<{ pointerId: number; x: number; left: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const count = variant === 'a' ? 5 : 3
  const max = Math.max(0, songs.length - count)
  const start = smooth ? rail.start : offset
  const visible = songs.slice(start, smooth ? rail.end : offset + count)
  const { ref } = rail
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => {
      const start = node.scrollLeft <= 1
      const end = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1
      setEdges(prior => prior.start === start && prior.end === end ? prior : { start, end })
    }
    const observer = new ResizeObserver(update)
    observer.observe(node)
    node.addEventListener('scroll', update, { passive: true })
    update()
    return () => { observer.disconnect(); node.removeEventListener('scroll', update) }
  }, [ref, songs.length])
  const slide = (direction: number) => {
    if (!smooth) { setOffset(value => Math.min(max, Math.max(0, value + count * direction))); return }
    const node = ref.current
    if (node) node.scrollBy({
      left: direction * Math.max(1, Math.floor(node.clientWidth / step) - 1) * step,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    })
  }
  if (!songs.length) return null
  const cards = visible.map((song, i) => <article className="pv-shelf-track" key={song.id}>
    {variant === 'c' ? <TrackRow song={song} active={current?.id === song.id} onPlay={() => onPlay(songs, start + i)} /> :
      <button className="pv-track-card" aria-pressed={current?.id === song.id} onClick={() => onPlay(songs, start + i)}>
        <span className="pv-card-image"><Artwork art={song.art} name={song.title} /><span className="pv-art-play"><Play size={18} fill="currentColor" /></span></span>
        <strong title={song.title}>{song.title}</strong><small title={song.artist}>{song.artist}</small>
      </button>}
    {onCache && <button className="pv-icon pv-cache" aria-label={cached.has(song.id) ? `Скачано — ${song.title}` : `Кэшировать — ${song.title}`}
      aria-pressed={cached.has(song.id)} onClick={() => onCache(song.id)}
      title={cached.has(song.id) ? 'Скачано' : 'Кэшировать'}>{cached.has(song.id) ? <Check size={14} /> : <ArrowDownToLine size={14} />}</button>}
  </article>)
  return <section className={`pv-track-shelf pv-shelf-${variant}`} aria-label={title}>
    <header className="pv-section-head">
      <h2>{title}</h2>
      <div className="pv-shelf-nav">
        <button className="pv-icon" onClick={() => onPlay(songs)} title="Воспроизвести все" aria-label={`Воспроизвести все — ${title}`}><Play size={14} /></button>
        <button className="pv-icon" onClick={() => slide(-1)} disabled={smooth ? edges.start : offset === 0} aria-label={`Назад — ${title}`}><ChevronLeft size={15} /></button>
        <button className="pv-icon" onClick={() => slide(1)} disabled={smooth ? edges.end : offset >= max} aria-label={`Дальше — ${title}`}><ChevronRight size={15} /></button>
      </div>
    </header>
    {smooth ? <div className="pv-shelf-scroll" ref={ref} tabIndex={0} aria-label={`Прокрутить — ${title}`}
      onPointerDown={event => {
        suppressClick.current = false
        if (event.pointerType !== 'mouse' || event.button !== 0 || (event.target as Element).closest('.pv-cache')) return
        drag.current = { pointerId: event.pointerId, x: event.clientX, left: event.currentTarget.scrollLeft, moved: false }
      }}
      onPointerMove={event => {
        const active = drag.current
        if (!active || active.pointerId !== event.pointerId || !(event.buttons & 1)) return
        const dx = event.clientX - active.x
        if (!active.moved && Math.abs(dx) < 6) return
        if (!active.moved) {
          active.moved = true
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        suppressClick.current = true
        event.currentTarget.scrollLeft = active.left - dx
      }}
      onLostPointerCapture={() => { drag.current = null }}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
      onClickCapture={event => {
        if (!suppressClick.current || event.detail === 0) return
        suppressClick.current = false
        event.stopPropagation()
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault()
        slide(event.key === 'ArrowLeft' ? -1 : 1)
      }}>
      <div className="pv-shelf-window" style={{ width: songs.length * step - 10, paddingInlineStart: start * step, '--shelf-card': `${cardSize}px` } as CSSProperties}>{cards}</div>
    </div> : <div className="pv-shelf-items" key={offset}>{cards}</div>}
  </section>
}

function Home({ variant, onPlay, open, current, cached, onCache, mixList, liked }: {
  variant: Variant; onPlay: PlayTracks; open: (modal: Modal) => void; current: Track | undefined;
  cached: Set<number>; onCache: (id: number) => void; mixList: Mix[]; liked: ReadonlySet<number>
}) {
  const [selected, setSelected] = useState<Mix | null>(null)
  const [railOpen, setRailOpen] = useState(false)
  const collapsed = variant === 'b'
  const mix = selected ?? mixList[0]
  const artworks = [...new Set(mix.tracks.flatMap(song => song.art && song.art !== mix.art ? [song.art] : []))]
  const shelf = { variant, onPlay, current, cached }
  return <div className={`pv-page pv-home pv-home-${variant}`}>
    <header className="pv-page-head">
      <div><h1>Главная</h1></div>
      <button className="pv-secondary pv-all" onClick={() => open({ kind: 'all-mixes' })}><ListMusic size={16} />Все подборки<ChevronDown size={14} /></button>
    </header>
    <section className="pv-mix-stage" aria-label="Подборки">
      <article className="pv-glass pv-mix-hero" key={mix.name}>
        <Glow art={mix.art} />
        <div className="pv-hero-copy">
          <span className="pv-kind"><Clock3 size={14} />{mix.kind}</span>
          <h2>{mix.name}</h2>
          <p>{mix.hint}</p>
          <div className="pv-hero-actions"><PlayAll onClick={() => onPlay(mix.tracks)}>Слушать подборку</PlayAll>
            <button className="pv-secondary" onClick={() => open({ kind: 'mix', mix })}>Посмотреть треки<ArrowRight size={15} /></button></div>
        </div>
        <button className={`pv-mix-art${collapsed ? ' has-three-cards' : ''}`} onClick={() => open({ kind: 'mix', mix })} aria-label={`Открыть подборку ${mix.name}`}>
          {collapsed && <>
            <span className="pv-stack-card is-left" aria-hidden="true"><Artwork art={artworks[0] ?? mix.art} name={mix.name} /></span>
            <span className="pv-stack-card is-right" aria-hidden="true"><Artwork art={artworks[1] ?? mix.art} name={mix.name} /></span>
          </>}
          {variant === 'c' && <span className="pv-art-stack" aria-hidden="true"><Artwork art={mix.tracks[2]?.art ?? mix.art} name={mix.name} /></span>}
          <Artwork art={mix.art} name={mix.name} eager />
        </button>
      </article>
      <div className={`pv-mix-dock${collapsed && railOpen ? ' is-expanded' : ''}`}>
        <div className="pv-mix-selector" id="pv-mix-selector" role="group" aria-label="Выбор подборки"
          onKeyDown={event => {
            if (event.key === 'Escape' && collapsed) {
              setRailOpen(false)
              event.currentTarget.querySelector<HTMLButtonElement>('.pv-mix-expand')?.focus()
            }
          }}>
          {collapsed && <button className="pv-mix-expand" aria-label={railOpen ? 'Свернуть колонку подборок' : 'Раскрыть колонку подборок'}
            aria-expanded={railOpen} onClick={() => setRailOpen(value => !value)}><ChevronLeft size={16} /></button>}
          <div className="pv-mix-options">
            {mixList.map((item) => <button key={item.name} aria-pressed={item === mix} aria-label={item.name} title={item.name}
              className={item === mix ? 'is-selected' : undefined} onClick={() => setSelected(item)}>
              {variant !== 'c' && <Artwork art={item.art} name={item.name} />}
              <span className="pv-mix-option-copy"><strong>{item.name}</strong>{collapsed && <small>{item.kind} · {item.tracks.length} тр.</small>}</span>
              {collapsed && <ChevronRight size={15} className="pv-mix-option-arrow" />}
            </button>)}
          </div>
          {collapsed && <button className="pv-mix-create" onClick={() => open({ kind: 'new-rule' })}><Plus size={16} />Добавить своё правило</button>}
        </div>
      </div>
    </section>
    <div className="pv-home-bottom">
      <div className="pv-recommendations">
        <TrackShelf title="Рекомендации для вас" songs={recommendations} {...shelf} onCache={onCache} />
        <TrackShelf title="Alternative Rock" songs={genreTracks} {...shelf} onCache={onCache} />
        {collapsed && <>
          <TrackShelf title="Слушали недавно" songs={recent} {...shelf} />
          <TrackShelf title="Часто слушаете" songs={mostPlayed} {...shelf} />
          <TrackShelf title="Лайки" songs={tracks.filter(song => liked.has(song.id))} {...shelf} />
        </>}
      </div>
      {collapsed ? <div className="pv-home-side">
        <section className="pv-recent" aria-label="Недавно добавленные">
          <header className="pv-section-head"><h2>Недавно добавленные</h2><Clock3 size={15} /></header>
          {recentlyAdded.slice(0, 6).map((song, index) => <TrackRow key={song.id} song={song}
            active={current?.id === song.id} onPlay={() => onPlay(recentlyAdded, index)} />)}
        </section>
        <section className="pv-recent pv-playlist-section" aria-label="Часто включаете">
          <header className="pv-section-head"><h2>Часто включаете</h2><ListMusic size={15} /></header>
          {playlists.map(list => <div key={list.name} className="pv-recent-playlist">
            <button onClick={() => open({ kind: 'mix', mix: list })}><Artwork art={list.art} name={list.name} />
              <strong title={list.name}>{list.name}</strong></button>
            <button className="pv-icon" aria-label={`Воспроизвести — ${list.name}`} onClick={() => onPlay(list.tracks)}><Play size={15} /></button>
          </div>)}
        </section>
      </div> : <section className="pv-recent" aria-label="Слушали недавно">
        <header className="pv-section-head"><h2>Слушали недавно</h2><Clock3 size={15} /></header>
        {recent.slice(0, variant === 'a' ? 4 : 6).map((song, index) =>
          <TrackRow key={song.id} song={song} active={current?.id === song.id} onPlay={() => onPlay(recent, index)} />)}
      </section>}
    </div>
  </div>
}

const ROW_HEIGHT = 156
const WIDE_COLUMNS = 6
const BATCH_ROWS = 3

function ArtistCatalog({ items, variant, open }: { items: Artist[]; variant: Variant; open: (artist: Artist) => void }) {
  const container = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(WIDE_COLUMNS)
  const [rows, setRows] = useState({ start: 0, end: 5 })
  const [{ batches, addedFrom }, setBatch] = useState<{ batches: number; addedFrom: number | null }>({ batches: 1, addedFrom: null })
  const loaded = Math.min(items.length, batches * BATCH_ROWS * columns)
  const remaining = loaded < items.length
  const rowCount = Math.ceil(loaded / columns)
  const loadMore = () => {
    setBatch(batch => ({ batches: batch.batches + 1, addedFrom: loaded }))
  }

  useLayoutEffect(() => {
    const grid = container.current
    const root = grid?.closest('.pv-main')
    if (!grid || !root) return
    let frame = 0
    const measure = () => {
      const width = grid.clientWidth
      setColumns(width >= 850 ? 6 : width >= 620 ? 5 : width >= 450 ? 4 : width >= 300 ? 3 : 2)
      const relativeTop = root.getBoundingClientRect().top - grid.getBoundingClientRect().top
      const start = Math.max(0, Math.floor(relativeTop / ROW_HEIGHT) - 1)
      const end = Math.max(0, Math.ceil((relativeTop + root.clientHeight) / ROW_HEIGHT) + 1)
      setRows(previous => previous.start === start && previous.end === end ? previous : { start, end })
    }
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; measure() })
    }
    measure()
    const resize = new ResizeObserver(schedule)
    resize.observe(grid)
    root.addEventListener('scroll', schedule, { passive: true })
    return () => {
      resize.disconnect()
      cancelAnimationFrame(frame)
      root.removeEventListener('scroll', schedule)
    }
  }, [])

  useEffect(() => {
    const root = container.current?.closest('.pv-main')
    if (!remaining || !root) return
    const onScroll = () => {
      if (root.scrollTop > 0 && root.scrollHeight - root.scrollTop - root.clientHeight < 90) {
        root.removeEventListener('scroll', onScroll)
        setBatch(batch => ({ batches: batch.batches + 1, addedFrom: loaded }))
      }
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [loaded, remaining])

  const first = Math.min(loaded, rows.start * columns)
  const end = Math.min(loaded, rows.end * columns)
  return <div className={`pv-catalog pv-catalog-${variant}`} ref={container} style={{
    minHeight: rowCount * ROW_HEIGHT + (remaining ? 31 : 0), '--catalog-cols': columns, '--row-height': `${ROW_HEIGHT}px`,
  } as CSSProperties}>
    <div className="pv-catalog-cells" style={{ top: rows.start * ROW_HEIGHT }}>
      {items.slice(first, end).map((artist, offset) => {
        const index = first + offset
        const column = index % columns
        const entering = addedFrom !== null && index >= addedFrom
        return <button key={artist.name} className={`pv-artist-card${entering ? ' is-entering' : ''}`} style={{
          gridColumn: column + 1, gridRow: Math.floor(index / columns) - rows.start + 1,
        }} onClick={() => open(artist)}>
          <Artwork art={artist.art} name={artist.name} round />
          <strong>{artist.name}</strong><small>{artist.count} тр.</small>
        </button>
      })}
    </div>
    {remaining && <button className="pv-catalog-more pv-icon" aria-label="Показать ещё исполнителей" onClick={loadMore}><ChevronDown size={16} /></button>}
  </div>
}

function Artists({ variant, onPlay, open, query, setQuery }: {
  variant: Variant; onPlay: PlayTracks; open: (modal: Modal) => void; query: string; setQuery: (value: string) => void
}) {
  const [sorted, setSorted] = useState(false)
  const needle = normalizeSearchText(query.trim())
  const filtered = useMemo(() => {
    const matches = artists.filter(artist => normalizeSearchText(artist.name).includes(needle))
    return sorted ? matches.sort((a, b) => a.name.localeCompare(b.name, 'ru')) : matches
  }, [needle, sorted])
  const openArtist = (artist: Artist) => open({ kind: 'artist', artist })
  return <div className={`pv-page pv-artists pv-artists-${variant}`}>
    <header className="pv-page-head"><div><h1>Исполнители</h1><span>{artists.length} в медиатеке</span></div></header>
    {!needle && <section className="pv-favorites" aria-label="Часто слушаете">
      <header className="pv-section-head"><h2>Часто слушаете</h2><Headphones size={17} /></header>
      <div className="pv-featured-artists">
        {favoriteArtists.map((artist, index) => <article key={artist.name} className="pv-featured-artist pv-glass">
          {artist.art && (variant === 'b'
            ? <span className="pv-artist-wall" style={artStyle(artist.art)} aria-hidden="true" />
            : <Glow art={artist.art} />)}
          <button className="pv-featured-open" onClick={() => openArtist(artist)}>
            <Artwork art={artist.art} name={artist.name} eager round />
            <span className="pv-featured-copy">
              <span className="pv-kind">{index === 0 ? <><Activity size={13} />Чаще всех</> : <><Headphones size={13} />В топе</>}</span>
              <strong>{artist.name}</strong><small>{compact.format(artist.plays ?? 0)} прослушиваний</small>
            </span>
          </button>
          {index === 0 && <button className="pv-featured-play pv-icon" aria-label={`Слушать ${artist.name}`}
            onClick={() => onPlay(tracks.filter(song => song.artist === artist.name))}><Play size={16} fill="currentColor" /></button>}
        </article>)}
      </div>
    </section>}
    <section className="pv-artists-library" aria-label="Все исполнители">
      <header className="pv-section-head">
        <h2>Все исполнители <small>{filtered.length}</small></h2>
        <div className="pv-catalog-tools">
          <label className="pv-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти исполнителя" />
            {query && <button className="pv-icon" onClick={() => setQuery('')} aria-label="Очистить поиск"><X size={14} /></button>}</label>
          <button className="pv-icon" aria-label="Сортировать по имени" aria-pressed={sorted} onClick={() => setSorted(value => !value)} title="Сортировать по имени"><ArrowDownUp size={16} /></button>
        </div>
      </header>
      {filtered.length ? <ArtistCatalog key={`${needle}:${sorted}`} items={filtered} variant={variant} open={openArtist} /> : <p className="pv-empty">Исполнители не найдены</p>}
    </section>
  </div>
}

function PreviewDialog({ modal, close, open, onPlay, mixList, onCreateMix }: {
  modal: Modal; close: () => void; open: (modal: Modal) => void; onPlay: PlayTracks;
  mixList: Mix[]; onCreateMix: (mix: Mix) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [artistName, setArtistName] = useState('')
  const [limit, setLimit] = useState(10)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  const title = modal.kind === 'mix' ? modal.mix.name : modal.kind === 'artist' ? modal.artist.name
    : modal.kind === 'new-rule' ? 'Своё правило' : 'Все подборки'
  const art = modal.kind === 'mix' ? modal.mix.art : modal.kind === 'artist' ? modal.artist.art : null
  const songs = modal.kind === 'mix' ? modal.mix.tracks : modal.kind === 'artist' ? tracks.filter(song => song.artist === modal.artist.name) : []
  return <dialog className="pv-dialog" ref={dialog} aria-label={title} onCancel={event => { event.preventDefault(); close() }}
    onClick={event => { if (event.target === event.currentTarget) close() }}>
    <div className="pv-dialog-inner pv-glass">
      <button className="pv-icon pv-dialog-close" aria-label="Закрыть" onClick={close}><X size={20} /></button>
      {art && <Glow art={art} />}
      <header className="pv-dialog-head">
        {art && <Artwork art={art} name={title} round={modal.kind === 'artist'} eager />}
        <div><span className="pv-kind">{modal.kind === 'artist' ? <><MicVocal size={14} />Исполнитель</> : modal.kind === 'mix' ? modal.mix.kind : null}</span>
          <h2>{title}</h2>
          {songs.length > 0 && <PlayAll onClick={() => { onPlay(songs); close() }} />}
        </div>
      </header>
      {modal.kind === 'all-mixes' ? <div className="pv-dialog-mixes">
        {mixList.map(mix => <button className="pv-secondary" key={mix.name} onClick={() => open({ kind: 'mix', mix })}>
          <Artwork art={mix.art} name={mix.name} /><strong>{mix.name}</strong><ArrowRight size={16} />
        </button>)}
        <button className="pv-secondary" onClick={() => open({ kind: 'new-rule' })}><Plus size={16} /><strong>Добавить своё правило</strong></button>
      </div> : modal.kind === 'new-rule' ? <form className="pv-rule-form" onSubmit={event => {
        event.preventDefault()
        const title = name.trim()
        if (!title || mixList.some(mix => normalizeSearchText(mix.name) === normalizeSearchText(title))) return
        const selected = (artistName ? tracks.filter(song => song.artist === artistName) : mostPlayed).slice(0, limit)
        onCreateMix({ name: title, hint: artistName || '', kind: 'Своя подборка', tracks: selected, art: selected.find(song => song.art)?.art ?? mixList[0].art })
      }}>
        <label>Название подборки<input placeholder="Название подборки" value={name} onChange={event => setName(event.target.value)} maxLength={64} required /></label>
        <label>Исполнитель<select value={artistName} onChange={event => setArtistName(event.target.value)}>
          <option value="">Все исполнители</option>
          {[...new Set(tracks.map(song => song.artist))].sort((a, b) => a.localeCompare(b, 'ru')).map(artist => <option key={artist}>{artist}</option>)}
        </select></label>
        <label>Количество песен <output>{limit}</output><input type="range" min={1} max={20} value={limit} onChange={event => setLimit(+event.target.value)} /></label>
        <button className="pv-primary" disabled={!name.trim() || mixList.some(mix => normalizeSearchText(mix.name) === normalizeSearchText(name.trim()))}>Сохранить правило</button>
      </form> : songs.length ? <div className="pv-dialog-tracks">
        {songs.map((song, index) => <TrackRow key={song.id} song={song} onPlay={() => { onPlay(songs, index); close() }} />)}
      </div> : <p className="pv-empty">В медиатеке нет записей для этого исполнителя</p>}
    </div>
  </dialog>
}

function Preview() {
  const [{ page, variant }, setRoute] = useState(routeFromHash)
  const [wallpaper, setWallpaper] = useState(true)
  const [query, setQuery] = useState('')
  const [modal, setModal] = useState<Modal | null>(null)
  const [mixList, setMixList] = useState(mixes)
  const [cached, setCached] = useState(new Set<number>())
  const [queue, setQueue] = useState({ tracks: recent, index: 0 })
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(32)
  const [volume, setVolume] = useState(54)
  const [repeat, setRepeat] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [liked, setLiked] = useState(() => new Set(initialLikes))
  const scroll = useRef<HTMLElement>(null)
  const song = queue.tracks[queue.index]

  useEffect(() => {
    const read = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])
  useLayoutEffect(() => { scroll.current?.scrollTo({ top: 0 }) }, [page, variant])
  useEffect(() => {
    if (!playing) return
    const interval = window.setInterval(() => setProgress(value => Math.min(song.seconds, value + 1)), 1000)
    return () => window.clearInterval(interval)
  }, [playing, song.seconds])
  useEffect(() => {
    if (progress < song.seconds) return
    if (repeat) setProgress(0)
    else setPlaying(false)
  }, [progress, repeat, song.seconds])

  const navigate = (next: Page, style: Variant = variant) => {
    setRoute({ page: next, variant: style })
    location.hash = new URLSearchParams({ page: next, variant: style }).toString()
  }
  const play: PlayTracks = (next, index = 0) => {
    if (!next.length) return
    setQueue({ tracks: next, index }); setProgress(0); setPlaying(true)
  }
  const skip = (direction: number) => {
    const delta = shuffle && queue.tracks.length > 1 ? 1 + Math.floor(Math.random() * (queue.tracks.length - 1)) : direction
    play(queue.tracks, (queue.index + delta + queue.tracks.length) % queue.tracks.length)
  }
  const toggle = (id: number, setter: typeof setCached) => setter(items => {
    const next = new Set(items)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return <div className={`pv-shell${wallpaper ? ' has-wallpaper' : ''}`} style={{ '--wallpaper': `url("${BG}")` } as CSSProperties}>
    <header className="pv-toolbar">
      <div className="pv-brand"><img src={LOGO} alt="" /><strong>Tempo</strong><span>Превью</span></div>
      <div className="pv-segment" aria-label="Страница">
        {(['home', 'artists'] as const).map(name => <button key={name} aria-pressed={page === name} onClick={() => navigate(name)}>{pageLabels[name]}</button>)}
      </div>
      <div className="pv-segment pv-variants" aria-label="Вариант оформления">
        {(['a', 'b', 'c'] as const).map(style => <button key={style} aria-pressed={style === variant} onClick={() => navigate(page, style)}>
          <span>{style.toUpperCase()}</span>{variantLabels[page][style]}
        </button>)}
      </div>
      <button className="pv-icon pv-wallpaper" aria-pressed={wallpaper} onClick={() => setWallpaper(value => !value)}
        aria-label="Показать обои" title="Показать обои"><Disc3 size={17} /></button>
    </header>
    <div className="pv-window">
      <aside className="pv-sidebar" aria-label="Навигация">
        <div className="pv-side-links">
          <button aria-current={page === 'home' ? 'page' : undefined} onClick={() => navigate('home')}><House size={17} />Главная</button>
          <button aria-current={page === 'artists' ? 'page' : undefined} onClick={() => navigate('artists')}><MicVocal size={17} />Исполнители</button>
        </div>
        <div className="pv-side-pins">
          <h2>Избранное</h2>
          <button onClick={() => setModal({ kind: 'mix', mix: { ...mixList[0], name: 'Лайки', tracks: tracks.filter(item => liked.has(item.id)) } })}><Heart size={15} />Лайки</button>
          <button onClick={() => setModal({ kind: 'all-mixes' })}><ListMusic size={15} />Подборки</button>
          {favoriteArtists.map(artist => <button key={artist.name} onClick={() => setModal({ kind: 'artist', artist })}>
            <Artwork art={artist.art} name={artist.name} round />{artist.name}
          </button>)}
        </div>
      </aside>
      <main className="pv-main" ref={scroll}>
        {page === 'home' ? <Home key={variant} variant={variant} onPlay={play} open={setModal} current={playing ? song : undefined} cached={cached} onCache={id => toggle(id, setCached)} {...{ mixList, liked }} />
          : <Artists key={variant} {...{ variant, query, setQuery }} onPlay={play} open={setModal} />}
      </main>
      <footer className="pv-player">
        <div className="pv-player-track"><Artwork art={song.art} name={song.title} /><span><strong>{song.title}</strong><small>{song.artist}</small></span></div>
        <div className="pv-playback">
          <div className="pv-transport">
            <button className="pv-icon" aria-label="Перемешать" aria-pressed={shuffle} onClick={() => setShuffle(value => !value)}><Shuffle size={16} /></button>
            <button className="pv-icon" aria-label="Предыдущий трек" onClick={() => skip(-1)}><SkipBack size={17} /></button>
            <button className="pv-play-toggle" aria-label={playing ? 'Пауза' : 'Воспроизвести'} onClick={() => {
              if (progress >= song.seconds) setProgress(0)
              setPlaying(value => !value)
            }}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>
            <button className="pv-icon" aria-label="Следующий трек" onClick={() => skip(1)}><SkipForward size={17} /></button>
            <button className="pv-icon" aria-label="Повтор" aria-pressed={repeat} onClick={() => setRepeat(value => !value)}><Repeat2 size={16} /></button>
          </div>
          <div className="pv-progress"><span>{time(progress)}</span><input type="range" aria-label="Позиция трека"
            min={0} max={song.seconds} value={progress} onChange={event => setProgress(+event.target.value)} /><span>{time(song.seconds)}</span></div>
        </div>
        <div className="pv-player-end">
          <button className="pv-icon" aria-label="В избранное" aria-pressed={liked.has(song.id)} onClick={() => toggle(song.id, setLiked)}><Heart size={17} fill={liked.has(song.id) ? 'currentColor' : 'none'} /></button>
          <Volume2 size={16} /><input type="range" min={0} max={100} value={volume} aria-label="Громкость" onChange={event => setVolume(+event.target.value)} />
        </div>
      </footer>
    </div>
    {modal && <PreviewDialog key={modal.kind} {...{ modal, mixList }} close={() => setModal(null)} open={setModal} onPlay={play}
      onCreateMix={mix => { setMixList(previous => [...previous, mix]); setModal({ kind: 'mix', mix }) }} />}
  </div>
}

createRoot(document.getElementById('root')!).render(<Preview />)

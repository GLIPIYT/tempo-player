import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, ArrowDownToLine, ArrowDownUp, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight,
  Clock3, Disc3, Headphones, Heart, House, ListMusic, MicVocal, Music2, Pause, Play,
  Repeat2, Search, Shuffle, SkipBack, SkipForward, Volume2, X,
} from 'lucide-react'
import { normalizeSearchText } from '../../utils/searchText'
import { artists, favoriteArtists, genreTracks, mixes, recent, recommendations, tracks, type Artist, type Mix, type Track } from './fixtures'
import '../../styles/global.css'
import './preview.css'

type Page = 'home' | 'artists'
type Variant = 'a' | 'b' | 'c'
type Modal = { kind: 'mix'; mix: Mix } | { kind: 'artist'; artist: Artist } | { kind: 'all-mixes' }
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
  cached: Set<number>; onCache: (id: number) => void
}) {
  const [offset, setOffset] = useState(0)
  const count = variant === 'a' ? 5 : variant === 'b' ? 4 : 3
  const max = Math.max(0, songs.length - count)
  const visible = songs.slice(offset, offset + count)
  return <section className={`pv-track-shelf pv-shelf-${variant}`} aria-label={title}>
    <header className="pv-section-head">
      <h2>{title}</h2>
      <div className="pv-shelf-nav">
        <button className="pv-icon" onClick={() => onPlay(songs)} title="Воспроизвести все" aria-label={`Воспроизвести все — ${title}`}><Play size={14} /></button>
        <button className="pv-icon" onClick={() => setOffset(Math.max(0, offset - count))} disabled={offset === 0} aria-label={`Назад — ${title}`}><ChevronLeft size={15} /></button>
        <button className="pv-icon" onClick={() => setOffset(Math.min(offset + count, max))} disabled={offset >= max} aria-label={`Дальше — ${title}`}><ChevronRight size={15} /></button>
      </div>
    </header>
    <div className="pv-shelf-items" key={offset}>
      {visible.map((song, i) => <article className="pv-shelf-track" key={song.id}>
        {variant === 'c' ? <TrackRow song={song} active={current?.id === song.id} onPlay={() => onPlay(songs, offset + i)} /> :
          <button className="pv-track-card" aria-pressed={current?.id === song.id} onClick={() => onPlay(songs, offset + i)}>
            <span className="pv-card-image"><Artwork art={song.art} name={song.title} /><span className="pv-art-play"><Play size={18} fill="currentColor" /></span></span>
            <strong>{song.title}</strong><small>{song.artist}</small>
          </button>}
        <button className="pv-icon pv-cache" aria-label={cached.has(song.id) ? `Скачано — ${song.title}` : `Кэшировать — ${song.title}`}
          aria-pressed={cached.has(song.id)} onClick={() => onCache(song.id)}
          title={cached.has(song.id) ? 'Скачано' : 'Кэшировать'}>{cached.has(song.id) ? <Check size={14} /> : <ArrowDownToLine size={14} />}</button>
      </article>)}
    </div>
  </section>
}

function Home({ variant, onPlay, open, current, cached, onCache }: {
  variant: Variant; onPlay: PlayTracks; open: (modal: Modal) => void; current: Track | undefined;
  cached: Set<number>; onCache: (id: number) => void
}) {
  const [selected, setSelected] = useState(0)
  const mix = mixes[selected]
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
        <button className="pv-mix-art" onClick={() => open({ kind: 'mix', mix })} aria-label={`Открыть подборку ${mix.name}`}>
          {variant === 'c' && <span className="pv-art-stack" aria-hidden="true"><Artwork art={mix.tracks[2]?.art ?? mix.art} name={mix.name} /></span>}
          <Artwork art={mix.art} name={mix.name} eager />
        </button>
      </article>
      <div className="pv-mix-selector" aria-label="Выбор подборки">
        {mixes.map((item, index) => <button key={item.name} aria-pressed={index === selected}
          className={index === selected ? 'is-selected' : undefined} onClick={() => setSelected(index)}>
          {variant !== 'c' && <Artwork art={item.art} name={item.name} />}
          <span><strong>{item.name}</strong>{variant === 'b' && <small>{item.kind}</small>}</span>
          {variant === 'b' && <ChevronRight size={16} />}
        </button>)}
      </div>
    </section>
    <div className="pv-home-bottom">
      <div className="pv-recommendations">
        <TrackShelf title="Рекомендации для вас" songs={recommendations} {...{ variant, onPlay, current, cached, onCache }} />
        <TrackShelf title="Alternative Rock" songs={genreTracks} {...{ variant, onPlay, current, cached, onCache }} />
      </div>
      <section className="pv-recent" aria-label="Слушали недавно">
        <header className="pv-section-head"><h2>Слушали недавно</h2><Clock3 size={15} /></header>
        {recent.slice(0, variant === 'a' ? 4 : 6).map((song, index) =>
          <TrackRow key={song.id} song={song} active={current?.id === song.id} onPlay={() => onPlay(recent, index)} />)}
      </section>
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
  const tornSlots = columns >= 5 ? [0, 2, columns - 1] : [0, columns - 1]
  const completeRows = batches * BATCH_ROWS - 1
  const loaded = Math.min(items.length, completeRows * columns + tornSlots.length)
  const remaining = loaded < items.length
  const rowCount = remaining ? completeRows + 1 : Math.ceil(loaded / columns)
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
        const last = remaining && index >= completeRows * columns
        const column = last ? tornSlots[index - completeRows * columns] : index % columns
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
          {artist.art && <Glow art={artist.art} />}
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

function PreviewDialog({ modal, close, open, onPlay }: {
  modal: Modal; close: () => void; open: (modal: Modal) => void; onPlay: PlayTracks
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  const title = modal.kind === 'mix' ? modal.mix.name : modal.kind === 'artist' ? modal.artist.name : 'Все подборки'
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
        {mixes.map(mix => <button className="pv-secondary" key={mix.name} onClick={() => open({ kind: 'mix', mix })}>
          <Artwork art={mix.art} name={mix.name} /><strong>{mix.name}</strong><ArrowRight size={16} />
        </button>)}
      </div> : songs.length ? <div className="pv-dialog-tracks">
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
  const [cached, setCached] = useState(new Set<number>())
  const [queue, setQueue] = useState({ tracks: recent, index: 0 })
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(32)
  const [volume, setVolume] = useState(54)
  const [repeat, setRepeat] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [liked, setLiked] = useState(new Set<number>())
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
          <button onClick={() => setModal({ kind: 'mix', mix: { ...mixes[0], name: 'Лайки', tracks: tracks.filter(item => liked.has(item.id)) } })}><Heart size={15} />Лайки</button>
          <button onClick={() => setModal({ kind: 'all-mixes' })}><ListMusic size={15} />Подборки</button>
          {favoriteArtists.map(artist => <button key={artist.name} onClick={() => setModal({ kind: 'artist', artist })}>
            <Artwork art={artist.art} name={artist.name} round />{artist.name}
          </button>)}
        </div>
      </aside>
      <main className="pv-main" ref={scroll}>
        {page === 'home' ? <Home key={variant} variant={variant} onPlay={play} open={setModal} current={playing ? song : undefined} cached={cached} onCache={id => toggle(id, setCached)} />
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
    {modal && <PreviewDialog {...{ modal }} close={() => setModal(null)} open={setModal} onPlay={play} />}
  </div>
}

createRoot(document.getElementById('root')!).render(<Preview />)

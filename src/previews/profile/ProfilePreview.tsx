import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ArrowLeft, BarChart3, Check, ChevronRight, Clock3, Disc3, Heart, House, ListMusic, ListPlus, Maximize2, Minus, Music2, Pause, Pencil, Play, Plus, Settings2, SkipBack, SkipForward, Trash2, Users, Volume2, X } from 'lucide-react'
import sample from '../../../docs/design/library-redesign/sample-data.json'
import '../../styles/global.css'
import '../library/libraryPreview.css'
import './profilePreview.css'

type Variant = 'air' | 'focus' | 'panorama'
type Playlist = { id: number; name: string; cover: string; count: number }
const ASSETS = '/docs/design/library-redesign/assets/'
const VARIANTS: [Variant, string][] = [['air', 'Воздух'], ['focus', 'Фокус'], ['panorama', 'Панорама']]
const MONTHS = ['дек', 'янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя']
const ACTIVITY = [32, 46, 29, 54, 62, 37, 44, 80, 71, 58, 92, 63]
const TRACKS = sample.tracks.slice(0, 8)
const INITIAL_PLAYLISTS: Playlist[] = [{ id: 1, name: 'После полуночи', cover: 'cover-4.jpg', count: 24 }, { id: 2, name: 'Гитары и ничего лишнего', cover: 'cover-1.jpg', count: 18 }, { id: 3, name: 'Пешком домой', cover: 'cover-7.jpg', count: 32 }]
const asset = (file: string) => ASSETS + file
const duration = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`

function readVariant(): Variant {
  const value = new URLSearchParams(location.hash.slice(1)).get('variant')
  return VARIANTS.find(([key]) => key === value)?.[0] ?? 'air'
}

function Dialog({ variant, kind, children, onClose }: { variant: Variant; kind: 'create' | 'delete'; children: (close: () => void) => ReactNode; onClose: () => void }) {
  const [closing, setClosing] = useState(false)
  const ref = useRef<HTMLElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const close = () => {
    if (timer.current) return
    setClosing(true)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) onClose()
    else timer.current = setTimeout(onClose, 160)
  }
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ;(ref.current?.querySelector<HTMLElement>('input, .pp-dialog-cancel') ?? ref.current)?.focus()
    return () => { clearTimeout(timer.current); previous?.focus() }
  }, [])
  return <div className={`pp-overlay${closing ? ' is-closing' : ''}`} onPointerDown={e => { if (e.target === e.currentTarget) close() }}>
    <section ref={ref} tabIndex={-1} className={`pp-dialog is-${kind} dialog-${variant}`} role={kind === 'delete' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={kind === 'create' ? 'Новый плейлист' : 'Удалить плейлист?'} onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
      if (e.key !== 'Tab') return
      const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])]
      const first = nodes[0], last = nodes.at(-1)
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }}>
      <button className="pp-dialog-close" type="button" aria-label="Закрыть окно" onClick={close}><X size={18} /></button>
      {children(close)}
    </section>
  </div>
}

function ProfilePreview() {
  const [variant, setVariant] = useState<Variant>(readVariant)
  const [theme, setTheme] = useState<'graphite' | 'cherry' | 'wallpaper'>('cherry')
  const [nickname, setNickname] = useState('Лили')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(nickname)
  const [period, setPeriod] = useState<'year' | 'month'>('year')
  const [hover, setHover] = useState<number | null>(null)
  const [chosenMonth, setChosenMonth] = useState<number | null>(null)
  const [trackTab, setTrackTab] = useState<'top' | 'recent'>('top')
  const [artistFilter, setArtistFilter] = useState<string | null>(null)
  const [trackIndex, setTrackIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [likes, setLikes] = useState(new Set([0, 2]))
  const [playlists, setPlaylists] = useState(INITIAL_PLAYLISTS)
  const [modal, setModal] = useState<'create' | 'delete' | null>(null)
  const [deleting, setDeleting] = useState<Playlist>(INITIAL_PLAYLISTS[0])
  const [newName, setNewName] = useState('')
  const [cover, setCover] = useState('cover-4.jpg')
  const [notice, setNotice] = useState('')
  const active = TRACKS[trackIndex]
  const values = period === 'year' && chosenMonth === null ? ACTIVITY : Array.from({ length: 30 }, (_, i) => 10 + ((i * 17 + (chosenMonth ?? 10) * 9) % 83))
  const labels = period === 'year' && chosenMonth === null ? MONTHS : values.map((_, i) => String(i + 1))
  const filtered = (trackTab === 'recent' ? [...TRACKS].reverse() : TRACKS).filter(track => !artistFilter || track.artist === artistFilter)
  useEffect(() => { history.replaceState(null, '', `#variant=${variant}`) }, [variant])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 2500)
    return () => clearTimeout(timer)
  }, [notice])
  const openCreate = () => { setNewName(''); setModal('create') }
  const toggleLike = (id: number) => setLikes(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const play = (index: number) => { setTrackIndex(index); setPlaying(true) }
  const stats = <div className="pp-stats">
    <div><Clock3 size={17} /><strong>684<span>ч</span></strong><small>Прослушано</small></div>
    <div><Music2 size={17} /><strong>12 408</strong><small>Прослушиваний</small></div>
    <div><Disc3 size={17} /><strong>386</strong><small>Разных песен</small></div>
    <div><Check size={17} /><strong>91<span>%</span></strong><small>Дослушиваний</small></div>
  </div>
  return <div className={`lp pp variant-${variant} theme-${theme}`}>
    <header className="lp-preview-toolbar"><div className="lp-preview-title"><span>Tempo</span><small>Профиль и диалоги</small></div><nav className="lp-variants" aria-label="Варианты оформления">{VARIANTS.map(([id, label], i) => <button key={id} className={variant === id ? 'is-active' : ''} aria-pressed={variant === id} onClick={() => setVariant(id)}><span>{String.fromCharCode(65 + i)}</span>{label}</button>)}</nav><div className="lp-theme-picker">{(['graphite', 'cherry', 'wallpaper'] as const).map(id => <button key={id} className={theme === id ? 'is-active' : ''} onClick={() => setTheme(id)}>{id === 'graphite' ? 'Графит' : id === 'cherry' ? 'Вишня' : 'Обои'}</button>)}</div></header>
    <nav className="lp-page-picker pp-preview-controls" aria-label="Окна превью"><button className="is-active" onClick={() => { setChosenMonth(null); setArtistFilter(null) }}><Users size={14} />Профиль</button><button onClick={openCreate}><ListPlus size={14} />Создание плейлиста</button><button disabled={!playlists.length} onClick={() => { setDeleting(playlists[0]); setModal('delete') }}><Trash2 size={14} />Подтверждение удаления</button><span>Кликабельное превью · без звука и изменений медиатеки</span></nav>
    <div className="lp-window pp-window">
      <div className="lp-titlebar"><span><img src="/docs/brand/icon-concepts/vector/pulse-sunset.svg" alt="" />TEMPO</span><div className="lp-window-buttons" aria-hidden="true"><Minus size={13} /><Maximize2 size={12} /><X size={14} /></div></div>
      <aside className="lp-sidebar"><div className="lp-side-main">{[[House, 'Главная'], [Music2, 'Медиатека'], [Disc3, 'Альбомы'], [Users, 'Исполнители'], [ListMusic, 'Плейлисты']].map(([Icon, label]) => { const Glyph = Icon as typeof House; return <button key={String(label)} onClick={() => setNotice(`${label} · в этом превью открыт профиль`)}><Glyph size={17} />{String(label)}</button> })}</div><div className="lp-side-favorites"><h2>Избранное<span>{playlists.length}</span></h2>{playlists.map(list => <button key={list.id} onClick={() => { setDeleting(list); setModal('delete') }}><img src={asset(list.cover)} alt="" /><span>{list.name}</span></button>)}<button className="lp-side-create" onClick={openCreate}><Plus size={17} />Новый плейлист</button></div><button className="pp-side-profile" onClick={() => setEditing(true)}><img src={asset('artist-3.jpg')} alt="" />{nickname}<ChevronRight size={14} /></button><button className="lp-side-settings" onClick={() => setTheme(theme === 'wallpaper' ? 'cherry' : 'wallpaper')}><Settings2 size={16} />Оформление</button></aside>
      <main className="pp-main"><div className="lp-breadcrumb"><ArrowLeft size={16} /><span>Ваш профиль</span><button className="pp-edit-button" onClick={() => { setDraft(nickname); setEditing(true) }}><Pencil size={13} />Редактировать</button></div>
        <div key={variant} className="pp-content">
          <header className="pp-head"><div className="pp-identity-glow" style={{ backgroundImage: `url(${asset('cover-4.jpg')})` }} /><button className="pp-avatar" onClick={() => { setDraft(nickname); setEditing(true) }} aria-label="Редактировать профиль"><img src={asset('artist-3.jpg')} alt="Аватар профиля" /><span><Pencil size={18} /></span></button><div className="pp-identity"><span className="pp-kicker">Профиль</span>{editing ? <form className="pp-name-form" onSubmit={e => { e.preventDefault(); if (draft.trim()) setNickname(draft.trim()); setEditing(false) }}><input aria-label="Имя профиля" autoFocus value={draft} maxLength={32} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setEditing(false) }} /><button type="submit" aria-label="Сохранить имя"><Check size={20} /></button></form> : <h1><button onClick={() => { setDraft(nickname); setEditing(true) }}>{nickname}</button></h1>}<p>Ваша музыка в цифрах</p><span className="pp-profile-since"><Music2 size={13} />В Tempo с сентября 2025</span></div>{stats}</header>
          <section className="pp-activity"><div className="pp-section-head"><h2><BarChart3 size={17} />История прослушиваний</h2><div className="pp-seg">{(['year', 'month'] as const).map(value => <button key={value} aria-pressed={period === value} onClick={() => { setPeriod(value); setChosenMonth(null); setHover(null) }}>{value === 'year' ? 'За год' : 'За месяц'}</button>)}</div></div><div className="pp-chart-summary"><div><strong>{hover === null ? chosenMonth === null ? period === 'year' ? 'Ноябрь 2025 — ноябрь 2026' : 'Ноябрь 2026' : `${MONTHS[chosenMonth]} 2026` : period === 'year' && chosenMonth === null ? `${MONTHS[hover]} 2026` : `${hover + 1} ноября, пт.`}</strong><span>{hover === null ? '684 часа за выбранный период' : `${values[hover]} ч прослушано`}</span></div>{chosenMonth !== null && <button onClick={() => { setChosenMonth(null); setHover(null) }}><ArrowLeft size={13} />К году</button>}<span className="pp-chart-total">{hover === null ? '684' : values[hover]}<small>часов</small></span></div><div className="pp-chart" onPointerLeave={() => setHover(null)}>{values.map((value, index) => <button key={index} className={`${hover === index ? 'is-hovered' : ''}${hover !== null && hover !== index ? ' is-muted' : ''}`} style={{ '--bar': `${value}%`, '--i': index } as CSSProperties} aria-label={`${labels[index]}: ${value} часов`} onPointerEnter={() => setHover(index)} onFocus={() => setHover(index)} onBlur={() => setHover(null)} onClick={() => { if (period === 'year' && chosenMonth === null) { setChosenMonth(index); setHover(null) } else setNotice(`${index + 1} ноября · ${value} ч`) }}><span className="pp-chart-bar"><i /></span><small>{labels[index]}</small></button>)}</div><div className="pp-chart-foot"><span><i />Прослушано в Tempo</span><span>226 дней с музыкой</span></div></section>
          <section className="pp-track-section"><div className="pp-section-head"><div className="pp-track-tabs"><button aria-pressed={trackTab === 'top'} onClick={() => setTrackTab('top')}>Часто включаете</button><button aria-pressed={trackTab === 'recent'} onClick={() => setTrackTab('recent')}>Недавно</button></div>{artistFilter && <button className="pp-filter" onClick={() => setArtistFilter(null)}>{artistFilter}<X size={12} /></button>}</div><div className="pp-track-list">{filtered.slice(0, 5).map((track, index) => { const id = TRACKS.indexOf(track); return <article key={id} className={trackIndex === id ? 'is-playing' : ''}><span className="pp-track-index">{index + 1}</span><button className="pp-track-art" onClick={() => play(id)} aria-label={`Воспроизвести ${track.title}`}><img src={asset(track.cover)} alt="" /><span><Play size={15} fill="currentColor" /></span></button><button className="pp-track-copy" onClick={() => play(id)}><strong>{track.title}</strong><span>{track.artist}</span></button><small>{trackTab === 'top' ? `${42 - index * 6} раз` : 'Сегодня'}</small><button className={`pp-like${likes.has(id) ? ' is-active' : ''}`} aria-label="Нравится" aria-pressed={likes.has(id)} onClick={() => toggleLike(id)}><Heart size={15} fill={likes.has(id) ? 'currentColor' : 'none'} /></button></article> })}{!filtered.length && <p className="pp-empty">Нет песен этого исполнителя в примере</p>}</div></section>
          <section className="pp-artists"><div className="pp-section-head"><h2>Топ исполнителей</h2><span>За всё время</span></div><div className="pp-artists-list">{sample.artists.map((artist, index) => <button key={artist.name} onClick={() => setArtistFilter(artist.name)}><span className="pp-artist-rank">{index + 1}</span><img src={asset(artist.image)} alt="" /><span><strong>{artist.name}</strong><small>{[182, 164, 98][index]} ч</small></span><ChevronRight size={14} /></button>)}</div></section>
          <section className="pp-playlists"><div className="pp-section-head"><h2>Ваши плейлисты<span>{playlists.length}</span></h2><button className="pp-edit-button" onClick={openCreate}><Plus size={14} />Новый плейлист</button></div><div className="pp-playlist-grid">{playlists.map(list => <article key={list.id}><img src={asset(list.cover)} alt="" /><div><strong>{list.name}</strong><span>{list.count} трека</span></div><button aria-label={`Удалить ${list.name}`} onClick={() => { setDeleting(list); setModal('delete') }}><Trash2 size={15} /></button></article>)}</div></section>
        </div>
      </main>
      <footer className="pp-player"><div className="pp-player-track"><img src={asset(active.cover)} alt="" /><span><strong>{active.title}</strong><small>{active.artist}</small></span><Heart size={15} /></div><div className="pp-player-center"><div><button aria-label="Предыдущий трек" onClick={() => setTrackIndex((trackIndex + TRACKS.length - 1) % TRACKS.length)}><SkipBack size={17} /></button><button className="pp-player-play" aria-label={playing ? 'Пауза' : 'Воспроизвести'} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><button aria-label="Следующий трек" onClick={() => setTrackIndex((trackIndex + 1) % TRACKS.length)}><SkipForward size={17} /></button></div><span><time>0:48</time><i /><time>{duration(active.duration)}</time></span></div><div className="pp-player-volume"><Volume2 size={16} /><input aria-label="Громкость превью" type="range" min="0" max="100" defaultValue="40" /></div></footer>
    </div>
    {modal && <Dialog variant={variant} kind={modal} onClose={() => setModal(null)}>{close => <>
      <div className="pp-dialog-art" style={{ '--dialog-art': `url(${asset(modal === 'delete' ? deleting.cover : cover)})` } as CSSProperties}><img src={asset(modal === 'delete' ? deleting.cover : cover)} alt="" /><span>{modal === 'delete' ? <Trash2 size={22} /> : <ListPlus size={22} />}</span></div>
      <div className="pp-dialog-content"><h2>{modal === 'create' ? 'Новый плейлист' : 'Удалить плейлист?'}</h2>{modal === 'create' ? <form onSubmit={e => { e.preventDefault(); if (!newName.trim()) return; setPlaylists([...playlists, { id: Date.now(), name: newName.trim(), cover, count: 0 }]); setNotice('Плейлист создан в превью'); close() }}><p>Имя можно изменить в любое время.</p><label>Название плейлиста<input required maxLength={100} autoFocus placeholder="Например, после полуночи" value={newName} onChange={e => setNewName(e.target.value)} /></label><div className="pp-cover-picker"><span>Обложка</span>{['cover-4.jpg', 'cover-1.jpg', 'cover-8.png', 'cover-7.jpg'].map(file => <button key={file} type="button" aria-label={`Обложка ${file}`} aria-pressed={cover === file} onClick={() => setCover(file)}><img src={asset(file)} alt="" />{cover === file && <Check size={13} />}</button>)}</div><footer><button className="pp-dialog-cancel" type="button" onClick={close}>Отмена</button><button className="pp-dialog-primary" type="submit" disabled={!newName.trim()}><Plus size={15} />Создать плейлист</button></footer></form> : <><p>Песни останутся в вашей медиатеке. Удалится только этот плейлист.</p><div className="pp-delete-selection"><img src={asset(deleting.cover)} alt="" /><span><strong>{deleting.name}</strong><small>{deleting.count} трека</small></span><ListMusic size={18} /></div><footer><button className="pp-dialog-cancel" type="button" onClick={close}>Отмена</button><button className="pp-dialog-danger" type="button" onClick={() => { setPlaylists(playlists.filter(list => list.id !== deleting.id)); setNotice('Плейлист удалён только в превью'); close() }}><Trash2 size={15} />Удалить плейлист</button></footer></>}</div>
    </>}</Dialog>}
    {notice && <div className="lp-notice" role="status"><Check size={15} />{notice}</div>}
  </div>
}

const host = document.getElementById('root')! as HTMLElement & { tempoProfilePreviewRoot?: Root }
host.tempoProfilePreviewRoot ??= createRoot(host)
host.tempoProfilePreviewRoot.render(<ProfilePreview />)

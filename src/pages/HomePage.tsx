import {
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Clock3, Eye, EyeOff, Flame, FolderPlus, Play, RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import type { TopTrackItem, Track } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useFolders } from '../hooks/useFolders'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useScanProgress } from '../hooks/useScanProgress'
import { useSettings } from '../state/settings'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { trackToUnified } from '../utils/unified'
import Cover from '../components/common/Cover'
import CardPlayButton from '../components/common/CardPlayButton'
import EmptyState from '../components/common/EmptyState'
import ScanLine from '../components/common/ScanLine'
import { beginTrackDrag, consumeDragClick } from '../dnd/trackDrag'
import { openContextMenu, type ContextMenuItem } from '../components/common/ContextMenu'
import TrackContextMenu, { type TrackContextRequest } from '../components/common/TrackContextMenu'
import {
  anySectionHidden,
  hideSectionUntilTomorrow,
  isSectionHidden,
  unhideAllSections,
  useHiddenSections,
} from '../utils/hiddenSections'

function greetingForHour(h: number): string {
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 18) return 'Good afternoon'
  if (h >= 18 && h < 23) return 'Good evening'
  return 'Good night'
}

function dedupeRecent(entries: { track: Track }[], limit: number): Track[] {
  const seen = new Set<number>()
  const out: Track[] = []
  for (const e of entries) {
    if (seen.has(e.track.id)) continue
    seen.add(e.track.id)
    out.push(e.track)
    if (out.length >= limit) break
  }
  return out
}

function stableMixRank(id: number): number {
  let hash = 2166136261
  for (const char of String(id)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export default function HomePage() {
  const t = useT()
  const { settings } = useSettings()
  const player = usePlayer()
  const foldersApi = useFolders()
  const scan = useScanProgress()
  const version = useLibraryVersion()
  const total = useAsync(() => api.countTracks(), [version])
  const recent = useAsync(() => api.listTracks('', 12, 0), [version])
  const hourPicks = useAsync(() => api.getHourPicks(30), [version])
  const top = useAsync(() => api.getTopTracks(12), [version])
  const played = useAsync(async () => dedupeRecent((await api.getAnalytics('30d')).recent, 10), [version])
  const unknownArtist = t('Unknown artist')
  // Keep the fallback identity stable while the first result is loading.
  const hourPicksList = useMemo(() => hourPicks.data ?? [], [hourPicks.data])
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), [])
  const nickname = settings.profile.nickname
  const hourMixes = useMemo(() => {
    if (hourPicksList.length === 0) return []
    const mixes: { key: string; title: string; tracks: Track[] }[] = []
    const byArtist = new Map<string, Track[]>()
    for (const tr of hourPicksList) {
      const artist = tr.artistName?.trim()
      if (
        !artist ||
        artist.toLowerCase() === unknownArtist.toLowerCase() ||
        artist.toLowerCase() === 'unknown artist' ||
        artist.toLowerCase() === 'неизвестный исполнитель'
      ) continue
      const list = byArtist.get(artist)
      if (list) list.push(tr)
      else byArtist.set(artist, [tr])
    }
    if (hourPicksList.length >= 4) {
      const ordered = hourPicksList
        .slice()
        .sort((a, b) => stableMixRank(a.id) - stableMixRank(b.id) || a.id - b.id)
      mixes.push({ key: 'mix', title: t('Hour mix'), tracks: ordered.slice(0, 24) })
    }
    const artistMixes = [...byArtist.entries()]
      .filter(([, list]) => list.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3)
    for (const [artist, list] of artistMixes) {
      mixes.push({ key: `artist:${artist}`, title: artist, tracks: list })
    }
    return mixes
  }, [hourPicksList, unknownArtist, t])

  // right-click on a home card re-targets this one menu, so the grids and rails
  // do not need an extra element per card
  const [ctx, setCtx] = useState<TrackContextRequest | null>(null)
  useHiddenSections()

  if (recent.loading && recent.data === null) {
    return (
      <div className="page">
        <div className="muted">{t('Loading…')}</div>
      </div>
    )
  }

  const error = recent.error ?? foldersApi.error
  if (error && recent.data === null) {
    return (
      <div className="page">
        <div className="error-line">{error}</div>
      </div>
    )
  }

  const totalTracks = total.data ?? 0
  const topTracks: TopTrackItem[] = top.data ?? []
  const recentPlays = played.data ?? []
  const topTrackList = topTracks.map((x) => x.track)
  const recentAdded = recent.data ?? []

  const playSection = (tracks: Track[], index: number) => {
    player.playTracks(tracks.map((tr) => trackToUnified(tr)), index)
  }

  // drag a single-track home card into a sidebar playlist
  const trackCardDrag = (tr: Track) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) =>
      beginTrackDrag({
        e,
        title: tr.title,
        coverPath: tr.coverPath,
        trackId: tr.id,
        allowButtons: true,
      }),
    onClick: () => {
      if (consumeDragClick()) return
      player.playTracks([trackToUnified(tr)], 0)
    },
  })

  /**
   * Right-click menu for a section header or a generated mix: play the lot, or
   * hide it for the rest of the day.
   */
  const sectionMenu = (e: ReactMouseEvent, opts: { title: string; id: string; tracks: Track[] }) => {
    e.preventDefault()
    e.stopPropagation()
    const items: ContextMenuItem[] = [
      {
        id: 'play',
        label: t('Play all'),
        icon: <Play size={13} />,
        disabled: opts.tracks.length === 0,
        onSelect: () => playSection(opts.tracks, 0),
      },
      {
        id: 'hide',
        label: t('Hide until tomorrow'),
        icon: <EyeOff size={13} />,
        onSelect: () => hideSectionUntilTomorrow(opts.id),
      },
    ]
    if (anySectionHidden()) {
      items.push({
        id: 'unhide',
        label: t('Show hidden sections'),
        icon: <Eye size={13} />,
        onSelect: () => unhideAllSections(),
      })
    }
    openContextMenu({ x: e.clientX, y: e.clientY, title: opts.title, items })
  }

  const trackContext = (e: ReactMouseEvent, track: Track, tracks: Track[], index: number) => {
    e.preventDefault()
    setCtx({ x: e.clientX, y: e.clientY, track, tracks, index })
  }

  const hidden = (id: string) => isSectionHidden(id)

  return (
    <div className="page">
      {error ? <div className="error-line">{error}</div> : null}
      <div className="hero">
        <div className="hero-main">
          <h1 className="hero-title">
            {t(greeting)}
            {nickname ? `, ${nickname}` : ''}
          </h1>
          <div className="hero-sub">{t('Tempo · local library')}</div>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-ghost"
            onClick={() => void foldersApi.addFolder()}
            disabled={foldersApi.busy}
          >
            <FolderPlus size={15} />
            {t('Add folder')}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void api.rescanLibrary()}
            disabled={foldersApi.busy || scan.active}
          >
            <RefreshCw size={15} className={scan.active ? 'spin' : undefined} />
            {t('Rescan')}
          </button>
        </div>
      </div>

      <ScanLine />

      {totalTracks === 0 ? (
        <EmptyState
          icon={<FolderPlus size={34} />}
          title={t('Your library is empty')}
          hint={t('Add a folder containing music files. Tempo scans it locally and builds your collection.')}
          action={
            <button
              className="btn btn-primary"
              onClick={() => void foldersApi.addFolder()}
              disabled={foldersApi.busy}
            >
              <FolderPlus size={15} />
              {t('Add folder')}
            </button>
          }
        />
      ) : (
        <>
          {hourMixes.length > 0 && !hidden('home.hour') ? (
            <section className="home-section">
              <div
                className="home-section-head"
                onContextMenu={(e) =>
                  sectionMenu(e, { title: t('For this hour'), id: 'home.hour', tracks: hourPicksList })
                }
              >
                <span className="home-section-title">
                  <Clock3 size={15} />
                  {t('For this hour')}
                </span>
                <span className="home-section-hint">
                  {t('Auto-generated playlists from what you usually play around this time of day')}
                </span>
              </div>
              <div className="cards-grid cards-grid-tight">
                {hourMixes.filter((mix) => !hidden(`home.mix:${mix.key}`)).map((mix) => {
                  const cover = mix.tracks.find((tr) => tr.coverPath)?.coverPath ?? null
                  return (
                    <button
                      key={mix.key}
                      className="card"
                      title={mix.title}
                      onClick={() => playSection(mix.tracks, 0)}
                      onContextMenu={(e) =>
                        sectionMenu(e, { title: mix.title, id: `home.mix:${mix.key}`, tracks: mix.tracks })
                      }
                    >
                      <div className="hour-mix-tile">
                        <Cover path={cover} label={mix.title} size={150} />
                        <CardPlayButton onPlay={() => playSection(mix.tracks, 0)} />
                        <span className="rail-badge rail-badge-hour">
                          <Clock3 size={11} />
                        </span>
                      </div>
                      <span className="card-title">{mix.title}</span>
                      <span className="card-sub">
                        {mix.tracks.length === 1 ? `1 ${t('track')}` : `${mix.tracks.length} ${t('tracks')}`}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          ) : null}

          {topTracks.length > 0 && !hidden('home.top') ? (
            <section className="home-section">
              <div
                className="home-section-head"
                onContextMenu={(e) =>
                  sectionMenu(e, { title: t('Most played'), id: 'home.top', tracks: topTrackList })
                }
              >
                <span className="home-section-title">
                  <Flame size={15} />
                  {t('Most played')}
                </span>
                <span className="home-section-hint">{t('Your all-time favorites by play count')}</span>
              </div>
              <div className="rail">
                {topTracks.map((item, i) => (
                  <button
                    key={`top-${item.track.id}`}
                    className="rail-card"
                    title={item.track.title}
                    onClick={() => {
                      if (consumeDragClick()) return
                      playSection(topTrackList, i)
                    }}
                    onContextMenu={(e) => trackContext(e, item.track, topTrackList, i)}
                    onPointerDown={(e) =>
                      beginTrackDrag({
                        e,
                        title: item.track.title,
                        coverPath: item.track.coverPath,
                        trackId: item.track.id,
                        allowButtons: true,
                      })
                    }
                  >
                    <div className="rail-cover">
                      <Cover path={item.track.coverPath} label={item.track.title} size={152} />
                      <CardPlayButton onPlay={() => playSection(topTracks.map((x) => x.track), i)} />
                      <span className="rail-rank">{i + 1}</span>
                    </div>
                    <span className="card-title">{item.track.title}</span>
                    <span className="card-sub">
                      {item.track.artistName ?? unknownArtist}
                      <span className="rail-plays"> · {item.playCount} {t('plays')}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {!hidden('home.recent') ? (
            <section className="home-section">
              <div
                className="home-section-head"
                onContextMenu={(e) =>
                  sectionMenu(e, { title: t('Recently added'), id: 'home.recent', tracks: recentAdded })
                }
              >
                <span className="home-section-title">{t('Recently added')}</span>
              </div>
              <div className="cards-grid cards-grid-tight">
                {recentAdded.map((tr, i) => (
                  <button
                    key={tr.id}
                    className="card track-card"
                    title={tr.title}
                    {...trackCardDrag(tr)}
                    onContextMenu={(e) => trackContext(e, tr, recentAdded, i)}
                  >
                    <Cover path={tr.coverPath} label={tr.title} size={120} />
                    <span className="card-title">{tr.title}</span>
                    <span className="card-sub">{tr.artistName ?? unknownArtist}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {recentPlays.length > 0 && !hidden('home.played') ? (
            <section className="home-section">
              <div
                className="home-section-head"
                onContextMenu={(e) =>
                  sectionMenu(e, { title: t('Recently played'), id: 'home.played', tracks: recentPlays })
                }
              >
                <span className="home-section-title">{t('Recently played')}</span>
              </div>
              <div className="cards-grid cards-grid-tight">
                {recentPlays.map((tr, i) => (
                  <button
                    key={`played-${tr.id}`}
                    className="card track-card"
                    title={tr.title}
                    {...trackCardDrag(tr)}
                    onContextMenu={(e) => trackContext(e, tr, recentPlays, i)}
                  >
                    <Cover path={tr.coverPath} label={tr.title} size={120} />
                    <span className="card-title">{tr.title}</span>
                    <span className="card-sub">{tr.artistName ?? unknownArtist}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {/* without this, hiding every section would leave nothing to
              right-click and no way back */}
          {anySectionHidden() ? (
            <div className="home-restore">
              <button className="btn btn-ghost" onClick={() => unhideAllSections()}>
                <Eye size={15} />
                {t('Show hidden sections')}
              </button>
            </div>
          ) : null}
        </>
      )}
      <TrackContextMenu req={ctx} onClose={() => setCtx(null)} />
    </div>
  )
}

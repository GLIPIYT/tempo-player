import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronDown, Headphones, MicVocal, Play, Search, Star, StarOff, X } from 'lucide-react'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import type { Artist } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { resolveLang, useT } from '../i18n'
import { formatCount } from '../i18n/count'
import { useSettings } from '../state/settings'
import { usePlayerActions } from '../player'
import { tracksToUnified } from '../utils/unified'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { openContextMenu, type ContextMenuItem } from '../components/common/ContextMenu'
import Cover from '../components/common/Cover'
import EmptyState from '../components/common/EmptyState'
import CacheBadge from '../soundcloud/CacheBadge'
import { normalizeSearchText } from '../utils/searchText'

type FeaturedArtist = {
  artist: Artist
  playCount: number | null
}

const INITIAL_CATALOG_ROWS = 6
const CATALOG_BATCH_ROWS = 6
const CATALOG_ROW_HEIGHT = 156
const CATALOG_OVERSCAN_ROWS = 2

function formatNumber(value: number, lang: 'ru' | 'en'): string {
  return new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-US').format(value)
}

function ArtistCatalog({
  items,
  lang,
  onOpen,
  onContextMenu,
  onPlay,
  t,
}: {
  items: Artist[]
  lang: 'ru' | 'en'
  onOpen: (artist: Artist) => void
  onContextMenu: (event: ReactMouseEvent, artist: Artist) => void
  onPlay: (artistId: number) => void
  t: (key: string) => string
}) {
  const grid = useRef<HTMLDivElement>(null)
  const loadMore = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(6)
  const [loadedCount, setLoadedCount] = useState(0)
  const [windowRows, setWindowRows] = useState({ start: 0, end: INITIAL_CATALOG_ROWS + CATALOG_OVERSCAN_ROWS })
  const [pendingFocus, setPendingFocus] = useState<{ index: number; action: 'open' | 'play' } | null>(null)
  const totalRows = Math.ceil(items.length / columns)

  useLayoutEffect(() => {
    const container = grid.current
    if (!container) return
    const root = container.closest('.app-content') as HTMLElement | null
    const gridNode = container.querySelector<HTMLDivElement>('.artists-catalog-grid')
    let frame = 0

    const measure = () => {
      if (!gridNode) return
      const template = window.getComputedStyle(gridNode).gridTemplateColumns
      const nextColumns = template.trim().split(/\s+/).filter(Boolean).length
      if (nextColumns > 0) setColumns((current) => current === nextColumns ? current : nextColumns)

      const containerRect = container.getBoundingClientRect()
      const scale = container.offsetWidth > 0 ? containerRect.width / container.offsetWidth : 1
      const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
      const rootRect = root?.getBoundingClientRect()
      const relativeTop = rootRect ? (rootRect.top - containerRect.top) / safeScale : -containerRect.top / safeScale
      const viewportHeight = rootRect ? rootRect.height / safeScale : window.innerHeight
      const start = Math.max(0, Math.floor(relativeTop / CATALOG_ROW_HEIGHT) - CATALOG_OVERSCAN_ROWS)
      const end = Math.min(
        totalRows,
        Math.max(start + 1, Math.ceil((relativeTop + viewportHeight) / CATALOG_ROW_HEIGHT) + CATALOG_OVERSCAN_ROWS),
      )
      setWindowRows((current) => current.start === start && current.end === end ? current : { start, end })
    }

    measure()
    const schedule = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    if (observer) {
      observer.observe(container)
      if (root) observer.observe(root)
    }
    root?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    if (!root) window.addEventListener('scroll', schedule, { passive: true })
    return () => {
      observer?.disconnect()
      root?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (!root) window.removeEventListener('scroll', schedule)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [totalRows])

  const initialCount = Math.min(items.length, columns * INITIAL_CATALOG_ROWS)
  const visibleCount = Math.min(items.length, Math.max(loadedCount, initialCount))
  const remainingCount = items.length - visibleCount
  const firstIndex = Math.min(visibleCount, windowRows.start * columns)
  const endIndex = Math.min(visibleCount, windowRows.end * columns)
  const addRows = useCallback(() => {
    setLoadedCount((current) => Math.min(
      items.length,
      Math.max(current, visibleCount) + columns * CATALOG_BATCH_ROWS,
    ))
  }, [columns, items.length, visibleCount])

  useEffect(() => {
    const sentinel = loadMore.current
    if (!sentinel || remainingCount <= 0 || typeof IntersectionObserver === 'undefined') return
    const scrollRoot = sentinel.closest('.app-content')
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) addRows()
    }, { root: scrollRoot, rootMargin: '360px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [addRows, remainingCount])

  useLayoutEffect(() => {
    if (pendingFocus === null) return
    const article = grid.current?.querySelector<HTMLElement>('[data-artist-index="' + pendingFocus.index + '"]')
    const target = article?.querySelector<HTMLButtonElement>('.artists-catalog-' + pendingFocus.action)
    target?.focus()
    setPendingFocus(null)
  }, [pendingFocus, windowRows, visibleCount])

  const handleCatalogKey = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
    action: 'open' | 'play',
  ) => {
    if (event.key !== 'Tab') return

    const lastIndex = endIndex - 1
    const lastAction = (items[lastIndex]?.trackCount ?? 0) > 0 ? 'play' : 'open'
    if (!event.shiftKey && index === lastIndex && action === lastAction && index + 1 < items.length) {
      event.preventDefault()
      const nextIndex = index + 1
      const nextRow = Math.floor(nextIndex / columns)
      setLoadedCount((current) => Math.min(
        items.length,
        Math.max(current, visibleCount) + (nextIndex >= visibleCount ? columns * CATALOG_BATCH_ROWS : 0),
      ))
      setWindowRows({ start: Math.max(0, nextRow - CATALOG_OVERSCAN_ROWS), end: nextRow + INITIAL_CATALOG_ROWS + CATALOG_OVERSCAN_ROWS })
      setPendingFocus({ index: nextIndex, action: 'open' })
      return
    }

    const firstIndexInWindow = Math.min(visibleCount, windowRows.start * columns)
    if (event.shiftKey && index === firstIndexInWindow && action === 'open' && index > 0) {
      event.preventDefault()
      const previousIndex = index - 1
      const previousAction = (items[previousIndex]?.trackCount ?? 0) > 0 ? 'play' : 'open'
      const previousRow = Math.floor(previousIndex / columns)
      setWindowRows({ start: Math.max(0, previousRow - CATALOG_OVERSCAN_ROWS), end: previousRow + INITIAL_CATALOG_ROWS + CATALOG_OVERSCAN_ROWS })
      setPendingFocus({ index: previousIndex, action: previousAction })
    }
  }

  return (
    <>
      <div
        className="artists-catalog-window"
        ref={grid}
        style={{ height: Math.ceil(visibleCount / columns) * CATALOG_ROW_HEIGHT, '--artists-catalog-row-height': CATALOG_ROW_HEIGHT + 'px' } as CSSProperties}
      >
        <div className="artists-catalog-grid" style={{ top: windowRows.start * CATALOG_ROW_HEIGHT }}>
        {items.slice(firstIndex, endIndex).map((artist, offset) => {
          const index = firstIndex + offset
          return (
          <article
            key={artist.id}
            className="artists-catalog-item"
            data-artist-index={index}
            onContextMenu={(event) => onContextMenu(event, artist)}
          >
            <button
              type="button"
              className="artists-catalog-open"
              onClick={() => onOpen(artist)}
              aria-label={artist.name + ', ' + formatCount(artist.trackCount ?? 0, 'track', t, lang)}
              onKeyDown={(event) => handleCatalogKey(event, index, 'open')}
            >
              <span className="artists-catalog-art">
                <CacheBadge kind="artist" scId={null} localId={artist.id}>
                  <Cover path={artist.imagePath} label={artist.name} size={104} rounded />
                </CacheBadge>
              </span>
              <strong title={artist.name}>{artist.name}</strong>
              <small>{formatCount(artist.trackCount ?? 0, 'track', t, lang)}</small>
            </button>
            <button
              type="button"
              className="artists-catalog-play"
              disabled={(artist.trackCount ?? 0) === 0}
              aria-label={t('Play all') + ': ' + artist.name}
              onClick={() => onPlay(artist.id)}
              onKeyDown={(event) => handleCatalogKey(event, index, 'play')}
            >
              <Play size={15} fill="currentColor" />
            </button>
          </article>
          )
        })}
        </div>
      </div>
      {remainingCount > 0 ? (
        <div className="artists-catalog-more" ref={loadMore}>
          <button
            type="button"
            aria-label={t('Load more') + ' ' + formatCount(remainingCount, 'artist', t, lang)}
            title={t('Load more')}
            onClick={addRows}
          >
            <ChevronDown size={16} />
          </button>
        </div>
      ) : null}
    </>
  )
}

export default function ArtistsPage() {
  const { navigate } = useNav()
  const t = useT()
  const { settings } = useSettings()
  const lang = resolveLang(settings.lang)
  const player = usePlayerActions()
  const version = useLibraryVersion()
  const { data, loading, error } = useAsync(() => api.listArtists(''), [version])
  const analytics = useAsync(() => api.getAnalytics('all'), [version])
  const [query, setQuery] = useState('')
  const search = normalizeSearchText(query.trim())
  const visibleArtists = useMemo(
    () => (data ?? []).filter((artist) => normalizeSearchText(artist.name).includes(search)),
    [data, search],
  )
  const byId = useMemo(() => new Map((data ?? []).map((artist) => [artist.id, artist])), [data])

  const ranked = useMemo(
    () => (analytics.data?.topArtists ?? [])
      .map((item) => {
        const artist = byId.get(item.artist.id)
        return artist ? { artist, playCount: item.playCount } : null
      })
      .filter((item): item is { artist: Artist; playCount: number } => item !== null),
    [analytics.data, byId],
  )
  const featured: FeaturedArtist[] = useMemo(() => {
    const top = ranked.slice(0, 3)
    const usedIds = new Set(top.map((item) => item.artist.id))
    const fallback = (data ?? []).filter((artist) => !usedIds.has(artist.id))
    return [
      ...top,
      ...fallback.slice(0, Math.max(0, 3 - top.length)).map((artist) => ({ artist, playCount: null })),
    ]
  }, [ranked, data])

  const playArtist = async (artistId: number) => {
    try {
      const tracks = await api.getArtistTracks(artistId)
      if (tracks.length > 0) player.playTracks(tracksToUnified(tracks), 0)
    } catch {}
  }

  // Fetch the favorite state before showing the menu so its action stays accurate.
  const artistMenu = (event: ReactMouseEvent, artist: Artist) => {
    event.preventDefault()
    const x = event.clientX
    const y = event.clientY
    void api
      .isFavoriteArtist(artist.id)
      .then((isFavorite) => {
        const items: ContextMenuItem[] = [
          {
            id: 'play',
            label: t('Play all'),
            icon: <Play size={13} />,
            disabled: (artist.trackCount ?? 0) === 0,
            onSelect: () => void playArtist(artist.id),
          },
          {
            id: 'fav',
            label: isFavorite ? t('Remove from favorites') : t('Add to favorites'),
            icon: isFavorite ? <StarOff size={13} /> : <Star size={13} />,
            onSelect: () => {
              void api
                .toggleFavoriteArtist(artist.id)
                .then(() => bumpLibraryVersion())
                .catch(() => undefined)
            },
          },
        ]
        openContextMenu({ x, y, title: artist.name, items })
      })
      .catch(() => undefined)
  }

  const openArtist = (artist: Artist) => navigate({ name: 'artist', id: artist.id })

  return (
    <div className="page artists-page">
      <div className="page-head artists-page-heading">
        <div>
          <h1 className="page-title">{t('Artists')}</h1>
          <div className="page-sub">{data ? formatCount(data.length, 'artist', t, lang) : t('Loading…')}</div>
        </div>
      </div>

      {error ? <div className="error-line">{error}</div> : null}
      {loading && data === null ? (
        <div className="muted">{t('Loading…')}</div>
      ) : data === null ? null : data.length === 0 ? (
        <EmptyState
          icon={<MicVocal size={34} />}
          title={t('No artists found')}
          hint={t('Artists appear after your library has been scanned.')}
        />
      ) : (
        <>
          {!search && featured.length > 0 ? (
            <section className="artists-most-played" aria-labelledby="artists-most-played-title">
              <h2 id="artists-most-played-title">{t(featured.some((item) => item.playCount !== null) ? 'Most played' : 'Your collection')}</h2>
              <div className={'artists-featured-grid' + (featured.length === 1 ? ' is-single' : featured.length === 2 ? ' is-two' : '')}>
                {featured.map((item, index) => {
                  const artist = item.artist
                  const isLead = index === 0
                  const label = item.playCount === null
                    ? t('Your collection')
                    : isLead ? t('Most played') : t('Top artists')
                  return (
                    <article
                      key={artist.id}
                      className={'artists-featured-card' + (isLead ? ' is-lead' : '')}
                      onContextMenu={(event) => artistMenu(event, artist)}
                    >
                      <button type="button" className="artists-featured-open" onClick={() => openArtist(artist)}>
                        <span className="artists-featured-art" aria-hidden="true">
                          <CacheBadge kind="artist" scId={null} localId={artist.id}>
                            <span className="artists-featured-wall">
                              <Cover path={artist.imagePath} label={artist.name} size={512} loading={isLead ? 'eager' : 'lazy'} fetchPriority={isLead ? 'high' : 'auto'} thumbnailOnly />
                            </span>
                            <span className="artists-featured-avatar">
                              <Cover path={artist.imagePath} label={artist.name} size={180} rounded loading={isLead ? 'eager' : 'lazy'} fetchPriority={isLead ? 'high' : 'auto'} />
                            </span>
                          </CacheBadge>
                        </span>
                        <span className="artists-featured-copy">
                          <small className="artists-featured-label"><Headphones size={13} />{label}</small>
                          <strong title={artist.name}>{artist.name}</strong>
                          {item.playCount === null ? (
                            <small>{formatCount(artist.trackCount ?? 0, 'track', t, lang)} · {formatCount(artist.albumCount ?? 0, 'album', t, lang)}</small>
                          ) : (
                            <small>{formatNumber(item.playCount, lang)} {t('plays')}</small>
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="artists-featured-play"
                        disabled={(artist.trackCount ?? 0) === 0}
                        aria-label={t('Play all') + ': ' + artist.name}
                        onClick={() => void playArtist(artist.id)}
                      >
                        <Play size={16} fill="currentColor" />
                      </button>
                    </article>
                  )
                })}
              </div>
            </section>
          ) : null}

          <section className="artists-library" aria-labelledby="artists-library-title">
            <div className="artists-library-head">
              <div className="artists-library-title">
                <h2 id="artists-library-title">{t('Your collection')}</h2>
                <span>{formatCount(visibleArtists.length, 'artist', t, lang)}</span>
              </div>
              <div className="collection-library-search">
                <Search size={15} />
                <input
                  type="search"
                  value={query}
                  aria-label={t('Search artists')}
                  placeholder={t('Search artists')}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button type="button" aria-label={t('Clear search')} onClick={() => setQuery('')}>
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            </div>
            {visibleArtists.length === 0 ? (
              <EmptyState
                icon={<Search size={30} />}
                title={t('No artists match')}
                hint={t('Try another artist name.')}
              />
            ) : (
              <ArtistCatalog
                key={search + ':' + version}
                items={visibleArtists}
                lang={lang}
                onOpen={openArtist}
                onContextMenu={artistMenu}
                onPlay={(artistId) => void playArtist(artistId)}
                t={t}
              />
            )}
          </section>
        </>
      )}
    </div>
  )
}

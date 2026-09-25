import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Check, Ellipsis, ExternalLink, Lock, Plus, Search } from 'lucide-react'
import { api } from '../api/client'
import type {
  Playlist,
  YtCollectionHit,
  YtCollectionInfo,
  ScArtist,
  ScPlaylist,
  ScTrack,
  SearchResults,
  YtEnrichment,
  YtSearchHit,
} from '../types/models'
import { useSearchQuery } from '../hooks/useSearchQuery'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import TrackList from '../components/common/TrackList'
import Cover from '../components/common/Cover'
import EmptyState from '../components/common/EmptyState'
import ScArtwork, { Spinner } from '../components/common/ScArtwork'
import BrandIcon, { type BrandMark } from '../components/common/BrandIcon'
import { toast } from '../components/common/Toast'
import { ScArtistRow, ScPlaylistCard } from '../components/common/ScCards'
import YtCard from '../components/common/YtCard'
import { useNav } from '../state/nav'
import { usePlayer } from '../player'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'
import { scTrackToUnified, scTracksToUnified } from '../utils/unified'
import { ytHitToUnified, ytdlpPath } from '../providers/youtubeProvider'

/** Emitted once per track as its metadata resolves. */
const YT_ENRICH_EVENT = 'ytdlp://enriched'
/** Emitted when a run stops, so nothing can wait on an event that never comes. */
const YT_ENRICH_DONE_EVENT = 'ytdlp://enriched-done'
/** Emitted once per album, artist or playlist as its name resolves. */
const YT_BROWSE_EVENT = 'ytdlp://browsed'
const YT_BROWSE_DONE_EVENT = 'ytdlp://browsed-done'

type ScStatus = 'idle' | 'loading' | 'error' | 'done'

/**
 * What the search is looking for. Tabs rather than a dropdown, so the scope is
 * visible at a glance and switching costs one click.
 *
 * Albums are their own tab even though the request only named tracks,
 * playlists and artists: local albums are already a search category, and
 * without a tab of their own they would be reachable only from "All".
 */
type SearchTab = 'all' | 'tracks' | 'albums' | 'playlists' | 'artists'

/**
 * Which catalogue to search. Picking one narrows the whole page to it - the
 * local library included - because the question being answered is "where do I
 * want to look", and a half-filtered page answers it badly.
 */
type SearchSource = 'all' | 'soundcloud' | 'youtube'

const SEARCH_SOURCES: { id: SearchSource; label: string; mark: BrandMark | null }[] = [
  { id: 'all', label: 'Everything', mark: null },
  { id: 'soundcloud', label: 'SoundCloud', mark: 'soundcloud' },
  { id: 'youtube', label: 'YouTube Music', mark: 'youtubemusic' },
]

const SEARCH_TABS: { id: SearchTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tracks', label: 'Tracks' },
  { id: 'albums', label: 'Albums' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'artists', label: 'Artists' },
]

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function ScRowMenu({ track }: { track: ScTrack }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<number | null>(null)

  const flash = useCallback((text: string, bad: boolean) => {
    setNote({ text, bad })
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setNote(null), 1500)
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
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
    setSub(false)
    setCreating(false)
    setNewName('')
    setPlaylists(null)
  }, [])

  const toggleOpen = () => {
    if (open) {
      close()
      return
    }
    setNote(null)
    setSub(false)
    setCreating(false)
    setNewName('')
    setPlaylists(null)
    setOpen(true)
  }

  const addTo = async (pl: Playlist) => {
    try {
      await api.addScTrackToPlaylist(pl.id, track)
      setSub(false)
      flash(`${t('Added to')} ${pl.name}`, false)
    } catch (e: unknown) {
      flash(errText(e), true)
    }
  }

  const createAndAdd = async () => {
    const name = newName.trim()
    if (name.length === 0) return
    try {
      const pl = await api.createPlaylist(name)
      await api.addScTrackToPlaylist(pl.id, track)
      setCreating(false)
      setNewName('')
      setSub(false)
      flash(`${t('Added to')} ${pl.name}`, false)
    } catch (e: unknown) {
      flash(errText(e), true)
    }
  }

  const openOnSoundCloud = () => {
    if (!track.permalinkUrl) return
    window.open(track.permalinkUrl, '_blank')
    setOpen(false)
  }

  return (
    <div
      ref={rootRef}
      className={'sc-cell' + (open ? ' is-open' : '')}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        className="icon-btn sc-menu-btn"
        aria-label={`${t('More actions for')} ${track.title}`}
        onClick={toggleOpen}
      >
        <Ellipsis size={15} />
      </button>
      {open ? (
        <div className="menu-pop" role="menu">
          {note ? <div className={'menu-note' + (note.bad ? ' is-bad' : '')}>{note.text}</div> : null}
          {sub ? (
            <>
              <div className="menu-title">{t('Add to playlist')}</div>
              {playlists === null ? (
                <div className="menu-item is-static">{t('Loading…')}</div>
              ) : playlists.length === 0 ? (
                <div className="menu-item is-static">{t('No playlists yet')}</div>
              ) : (
                playlists.map((pl) => (
                  <button
                    key={pl.id}
                    className="menu-item"
                    role="menuitem"
                    onClick={() => void addTo(pl)}
                  >
                    {pl.name}
                  </button>
                ))
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
              <button
                className={'menu-item' + (track.permalinkUrl ? '' : ' is-static')}
                role="menuitem"
                disabled={!track.permalinkUrl}
                onClick={openOnSoundCloud}
              >
                <ExternalLink size={13} />
                {t('Open on SoundCloud')}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default function SearchPage() {
  const t = useT()
  const query = useSearchQuery()
  const { navigate } = useNav()
  const version = useLibraryVersion()
  const player = usePlayer()
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scStatus, setScStatus] = useState<ScStatus>('idle')
  const [scTracks, setScTracks] = useState<ScTrack[]>([])
  const [ytHits, setYtHits] = useState<YtSearchHit[]>([])
  const [ytStatus, setYtStatus] = useState<ScStatus>('idle')
  /** Ids whose artist, album and duration have not come back yet. */
  const [ytPending, setYtPending] = useState<ReadonlySet<string>>(new Set())
  /** The enrichment the current results belong to; anything else is stale. */
  const ytJob = useRef('')
  /** Albums, artists or playlists, and whatever their pages have said so far. */
  const [ytHitsColl, setYtHitsColl] = useState<YtCollectionHit[]>([])
  const [ytInfo, setYtInfo] = useState<Record<string, YtCollectionInfo>>({})
  const [ytCollStatus, setYtCollStatus] = useState<ScStatus>('idle')
  const ytBrowseJob = useRef('')
  const [scPlaylists, setScPlaylists] = useState<ScPlaylist[]>([])
  const [scArtists, setScArtists] = useState<ScArtist[]>([])
  const [tab, setTab] = useState<SearchTab>('all')
  /** Which of YouTube Music's sections the current tab is asking for, if any. */
  const ytSection: 'albums' | 'artists' | 'playlists' | null =
    tab === 'albums' ? 'albums' : tab === 'artists' ? 'artists' : tab === 'playlists' ? 'playlists' : null
  /** The section name without its plural, which is what a card is keyed by. */
  const ytKind: 'album' | 'artist' | 'playlist' =
    ytSection === 'albums' ? 'album' : ytSection === 'artists' ? 'artist' : 'playlist'
  const [source, setSource] = useState<SearchSource>('all')
  const trimmed = query.trim()

  useEffect(() => {
    if (trimmed.length === 0) {
      setResults(null)
      setError(null)
      setLoading(false)
      return
    }
    setResults(null)
    setError(null)
    setLoading(true)
    let cancelled = false
    const timer = window.setTimeout(() => {
      api
        .searchAll(trimmed)
        .then((r) => {
          if (cancelled) return
          setResults(r)
          setError(null)
          setLoading(false)
        })
        .catch((e: unknown) => {
          if (cancelled) return
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmed, version])

  useEffect(() => {
    if (trimmed.length === 0 || source === 'youtube') {
      setScStatus('idle')
      setScTracks([])
      setScPlaylists([])
      setScArtists([])
      return
    }
    setScStatus('loading')
    setScTracks([])
    setScPlaylists([])
    setScArtists([])
    let cancelled = false
    const timer = window.setTimeout(() => {
      // All three kinds at once, so switching tabs never waits. Searches are
      // debounced, so a burst of typing still only costs one round.
      Promise.all([
        api.scSearchTracks(trimmed, 50, 0),
        api.scSearchPlaylists(trimmed, 24, 0),
        api.scSearchArtists(trimmed, 24, 0),
      ])
        .then(([tracks, playlists, artists]) => {
          if (cancelled) return
          setScTracks(tracks)
          setScPlaylists(playlists)
          setScArtists(artists)
          setScStatus('done')
        })
        .catch(() => {
          if (cancelled) return
          setScStatus('error')
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmed, source])

  useEffect(() => {
    if (trimmed.length === 0 || source === 'soundcloud') {
      setYtStatus('idle')
      setYtHits([])
      return
    }
    setYtStatus('loading')
    setYtHits([])
    setYtPending(new Set())
    let cancelled = false
    const timer = window.setTimeout(() => {
      // A missing yt-dlp lands in the same place as a failed search: the
      // section says YouTube is unavailable rather than pretending it is empty.
      api
        .ytdlpSearch(ytdlpPath(), trimmed, 20)
        .then((hits) => {
          if (cancelled) return
          setYtHits(hits)
          setYtStatus('done')
          // The list is on screen with covers, because a cover comes from the
          // video id and costs nothing. The artist, album and duration need a
          // full extraction at about a second and a half per track, so they
          // arrive one by one on an event and the rows fill in as they land.
          if (hits.length === 0) {
            setYtPending(new Set())
            return
          }
          const previous = ytJob.current
          ytJob.current = `${Date.now()}:${trimmed}`
          // A batch of twenty takes half a minute; without this, typing one
          // more letter leaves the previous one running alongside the new one.
          if (previous) void api.ytdlpEnrichCancel(previous).catch(() => undefined)
          setYtPending(new Set(hits.map((h) => h.id)))
          void api
            .ytdlpEnrich(ytdlpPath(), ytJob.current, hits.map((h) => h.id))
            .catch(() => setYtPending(new Set()))
        })
        .catch(() => {
          if (cancelled) return
          setYtStatus('error')
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmed, source])

  // The tab picks which of YouTube Music's sections to ask. Albums, artists and
  // playlists come back as bare ids, so their metadata is fetched afterwards
  // and each card appears as soon as it resolves.
  useEffect(() => {
    if (source !== 'youtube' || ytSection === null || trimmed.length === 0) {
      setYtCollStatus('idle')
      setYtHitsColl([])
      setYtInfo({})
      return
    }
    setYtCollStatus('loading')
    setYtHitsColl([])
    setYtInfo({})
    let cancelled = false
    const timer = window.setTimeout(() => {
      api
        .ytdlpSearchCollections(ytdlpPath(), trimmed, 12, ytSection)
        .then((hits) => {
          if (cancelled) return
          setYtHitsColl(hits)
          if (hits.length === 0) {
            setYtCollStatus('done')
            return
          }
          const job = `browse:${Date.now()}:${ytSection}:${trimmed}`
          ytBrowseJob.current = job
          void api.ytdlpBrowse(ytdlpPath(), job, hits).catch(() => setYtCollStatus('done'))
        })
        .catch(() => {
          if (!cancelled) setYtCollStatus('error')
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmed, source, ytSection])

  // Results arrive one at a time rather than as a batch, so each row fills in
  // as its own track resolves instead of the whole list waiting for the last.
  useEffect(() => {
    let stop: (() => void) | null = null
    let done = false
    void listen<YtEnrichment>(YT_ENRICH_EVENT, (event) => {
      const extra = event.payload
      if (extra.jobId !== ytJob.current) return
      setYtHits((prev) =>
        prev.map((hit) =>
          hit.id === extra.id
            ? {
                ...hit,
                artist: extra.artist ?? hit.artist,
                album: extra.album ?? hit.album,
                durationMs: extra.durationMs ?? hit.durationMs,
              }
            : hit,
        ),
      )
      setYtPending((prev) => {
        if (!prev.has(extra.id)) return prev
        const next = new Set(prev)
        next.delete(extra.id)
        return next
      })
    }).then((fn) => {
      if (done) fn()
      else stop = fn
    })
    return () => {
      done = true
      stop?.()
    }
  }, [])

  // Whatever is still waiting when a run ends is never getting an answer:
  // a track yt-dlp skipped, a failure, or a cancellation. Clearing here is what
  // stops a ring hanging forever.
  useEffect(() => {
    let stop: (() => void) | null = null
    let done = false
    void listen<{ jobId: string; error: string | null }>(YT_ENRICH_DONE_EVENT, (event) => {
      const payload = event.payload
      if (payload.jobId !== ytJob.current) return
      setYtPending(new Set())
      if (payload.error) toast.show(payload.error, 'error')
    }).then((fn) => {
      if (done) fn()
      else stop = fn
    })
    return () => {
      done = true
      stop?.()
    }
  }, [])

  // One event per collection, because a page costs about three seconds and the
  // names would otherwise all arrive together at the end.
  useEffect(() => {
    let stop: (() => void) | null = null
    let done = false
    void listen<YtCollectionInfo>(YT_BROWSE_EVENT, (event) => {
      const info = event.payload
      if (info.jobId !== ytBrowseJob.current) return
      setYtInfo((prev) => ({ ...prev, [info.id]: info }))
    }).then((fn) => {
      if (done) fn()
      else stop = fn
    })
    return () => {
      done = true
      stop?.()
    }
  }, [])

  useEffect(() => {
    let stop: (() => void) | null = null
    let done = false
    void listen<{ jobId: string }>(YT_BROWSE_DONE_EVENT, (event) => {
      if (event.payload.jobId === ytBrowseJob.current) setYtCollStatus('done')
    }).then((fn) => {
      if (done) fn()
      else stop = fn
    })
    return () => {
      done = true
      stop?.()
    }
  }, [])

  /** "All" shows everything; any other tab narrows to just its own kind. */
  const showTab = (id: SearchTab): boolean => tab === 'all' || tab === id
  // SoundCloud models a release as a playlist with `playlist_type: "album"`, so
  // the two are split here rather than in the API layer.
  const scAlbums = scPlaylists.filter((p) => p.isAlbum)
  const scPlaylistOnly = scPlaylists.filter((p) => !p.isAlbum)

  const playableTracks = scTracks.filter(t => t.streamable && (t.hasProgressive || t.hasHls))
  const playableIdx = new Map<string, number>()
  playableTracks.forEach((t, i) => playableIdx.set(t.id, i))
  const [scNote, setScNote] = useState<string | null>(null)
  const scNoteTimer = useRef<number | null>(null)
  const flashSc = useCallback((text: string) => {
    setScNote(text)
    if (scNoteTimer.current !== null) window.clearTimeout(scNoteTimer.current)
    scNoteTimer.current = window.setTimeout(() => setScNote(null), 1500)
  }, [])
  useEffect(() => () => {
    if (scNoteTimer.current !== null) window.clearTimeout(scNoteTimer.current)
  }, [])
  const playSoundCloud = (clicked: ScTrack) => {
    const idx = playableIdx.get(clicked.id)
    if (idx === undefined) {
      flashSc(t('Track unavailable'))
      return
    }
    player.playTracks(scTracksToUnified(playableTracks), idx)
  }

  const libraryCounts = {
    tracks: results?.tracks.length ?? 0,
    albums: results?.albums.length ?? 0,
    playlists: 0,
    artists: results?.artists.length ?? 0,
  }
  const soundCloudCounts = {
    tracks: scTracks.length,
    albums: scAlbums.length,
    playlists: scPlaylistOnly.length,
    artists: scArtists.length,
  }
  const countCategory = (category: Exclude<SearchTab, 'all'>): number => {
    let count = 0
    if (source === 'all') count += libraryCounts[category] + soundCloudCounts[category]
    else if (source === 'soundcloud') count += soundCloudCounts[category]

    if (category === 'tracks' && source !== 'soundcloud') count += ytHits.length
    if (
      source === 'youtube' &&
      ytSection === category &&
      (category === 'albums' || category === 'artists' || category === 'playlists')
    ) {
      count += ytHitsColl.length
    }
    return count
  }
  const countTab = (category: SearchTab): number =>
    category === 'all'
      ? countCategory('tracks') + countCategory('albums') + countCategory('playlists') + countCategory('artists')
      : countCategory(category)
  const currentCount = countTab(tab)

  const localCount = tab === 'all'
    ? libraryCounts.tracks + libraryCounts.albums + libraryCounts.artists
    : libraryCounts[tab]
  const scCount = tab === 'all'
    ? soundCloudCounts.tracks + soundCloudCounts.albums + soundCloudCounts.playlists + soundCloudCounts.artists
    : soundCloudCounts[tab]
  const ytTrackMode = source !== 'soundcloud' && showTab('tracks') && ytSection === null
  const ytCollectionMode = source === 'youtube' && ytSection !== null
  const ytCount = ytCollectionMode ? ytHitsColl.length : ytTrackMode ? ytHits.length : 0

  const localRelevant = source === 'all' && tab !== 'playlists'
  const localPending = localRelevant && (loading || (results === null && error === null))
  const scRelevant = source !== 'youtube'
  const scPending = scRelevant && (scStatus === 'idle' || scStatus === 'loading')
  const ytRelevant = ytTrackMode || ytCollectionMode
  const ytProviderPending = ytTrackMode
    ? ytStatus === 'idle' || ytStatus === 'loading'
    : ytCollectionMode && (ytCollStatus === 'idle' || ytCollStatus === 'loading')
  const searchPending = localPending || scPending || ytProviderPending
  const searchError =
    (localRelevant && error !== null) ||
    (scRelevant && scStatus === 'error') ||
    (ytRelevant && (ytTrackMode ? ytStatus === 'error' : ytCollStatus === 'error'))
  const showNoResults = trimmed.length > 0 && !searchPending && currentCount === 0 && !searchError

  const providerHeading = (name: string, count: number, mark: BrandMark | null) => (
    <header className="search-provider-head">
      <span className={'search-provider-mark' + (mark === null ? ' is-library' : '')} aria-hidden="true">
        {mark ? <BrandIcon mark={mark} size={13} brand /> : 'T'}
      </span>
      <strong>{name}</strong>
      <span className="search-provider-count" aria-label={`${name}: ${count}`}>{count}</span>
    </header>
  )

  const searchSkeleton = (
    <div className="search-loading-rows" role="status" aria-label={t('Searching…')}>
      <span />
      <span />
      <span />
    </div>
  )

  return (
    <div className="page search-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('Search')}</h1>
          <div className="page-sub">{trimmed ? `${t('Results for')} "${trimmed}"` : t('Type in the search bar above')}</div>
        </div>
      </div>
      {trimmed.length === 0 ? (
        <EmptyState
          icon={<Search size={34} />}
          title={t('Search your library')}
          hint={t('Find tracks, albums, artists and playlists. Start typing above.')}
        />
      ) : null}

      {trimmed.length > 0 ? (
        <>
          <div className="seg search-sources" role="tablist" aria-label={t('Where to search')}>
            {SEARCH_SOURCES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={source === entry.id}
                className={source === entry.id ? 'seg-btn is-active' : 'seg-btn'}
                onClick={() => setSource(entry.id)}
              >
                {entry.mark ? <BrandIcon mark={entry.mark} size={13} brand={source === entry.id} /> : null}
                <span>{t(entry.label)}</span>
              </button>
            ))}
          </div>

          <div className="search-catalog-layout">
            <div className="search-type-rail" role="group" aria-label={t('Search scope')}>
              {SEARCH_TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="search-type-button"
                  aria-pressed={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                >
                  <span>{t(entry.label)}</span>
                  {entry.id !== 'all' && countTab(entry.id) > 0 ? (
                    <span className="search-type-count">{countTab(entry.id)}</span>
                  ) : null}
                </button>
              ))}
            </div>

            <div className="search-results-column">
              <h2 className="search-current-scope">
                {t(SEARCH_TABS.find((entry) => entry.id === tab)?.label ?? 'All')}
              </h2>
              {localRelevant && (localPending || error !== null || localCount > 0) ? (
                <section className="search-provider-group">
                  {providerHeading(t('Your library'), localCount, null)}
                  {localPending ? (
                    searchSkeleton
                  ) : error ? (
                    <div className="search-provider-message error-line">{error}</div>
                  ) : results ? (
                    <>
                      {showTab('tracks') && results.tracks.length > 0 ? (
                        <section className="search-result-kind">
                          {tab === 'all' ? <h3 className="search-kind-title">{t('Tracks')}</h3> : null}
                          <TrackList tracks={results.tracks} showAlbum showIndex />
                        </section>
                      ) : null}
                      {showTab('albums') && results.albums.length > 0 ? (
                        <section className="search-result-kind">
                          {tab === 'all' ? <h3 className="search-kind-title">{t('Albums')}</h3> : null}
                          <div className="cards-grid cards-grid-tight">
                            {results.albums.map((album) => (
                              <button
                                key={album.id}
                                className="card"
                                onClick={() => navigate({ name: 'album', id: album.id })}
                                title={album.title}
                              >
                                <Cover path={album.coverPath} label={album.title} size={120} />
                                <span className="card-title">{album.title}</span>
                                <span className="card-sub">{album.artistName ?? t('Unknown artist')}</span>
                              </button>
                            ))}
                          </div>
                        </section>
                      ) : null}
                      {showTab('artists') && results.artists.length > 0 ? (
                        <section className="search-result-kind">
                          {tab === 'all' ? <h3 className="search-kind-title">{t('Artists')}</h3> : null}
                          <div className="arow-list">
                            {results.artists.map((artist) => (
                              <button
                                key={artist.id}
                                className="arow"
                                onClick={() => navigate({ name: 'artist', id: artist.id })}
                              >
                                <Cover label={artist.name} size={40} rounded />
                                <span className="arow-name">{artist.name}</span>
                                <span className="arow-meta">
                                  {artist.albumCount ?? 0} {t('albums')} · {artist.trackCount ?? 0} {t('tracks')}
                                </span>
                              </button>
                            ))}
                          </div>
                        </section>
                      ) : null}
                    </>
                  ) : null}
                </section>
              ) : null}

              {scRelevant && (scPending || scStatus === 'error' || scCount > 0) ? (
                <section className="search-provider-group">
                  {providerHeading(t('SoundCloud'), scCount, 'soundcloud')}
                  {scPending ? (
                    searchSkeleton
                  ) : scStatus === 'error' ? (
                    <div className="search-provider-message muted">{t('SoundCloud is unavailable')}</div>
                  ) : (
                    <>
                      {showTab('tracks') && scTracks.length > 0 ? (
                        <section className="search-result-kind">
                          {tab === 'all' ? <h3 className="search-kind-title">{t('Tracks')}</h3> : null}
                          <div className="sc-list">
                            {scTracks.map((track) => {
                              const unified = scTrackToUnified(track)
                              const idx = playableIdx.get(track.id)
                              return (
                                <div
                                  key={track.id}
                                  className={'sc-row' + (idx === undefined ? ' is-disabled' : '')}
                                  onClick={() => playSoundCloud(track)}
                                >
                                  <ScArtwork url={track.artworkUrl} title={track.title} />
                                  <div className="sc-meta">
                                    <span className="sc-title">{track.title}</span>
                                    <span className="sc-artist">{track.artist}</span>
                                  </div>
                                  {idx === undefined ? (
                                    <span className="sc-duration"><Lock size={13} /></span>
                                  ) : (
                                    <span className="sc-duration">{fmtTime(unified.durationSec)}</span>
                                  )}
                                  {unified.externalUrl ? (
                                    <button
                                      className="icon-btn sc-open"
                                      aria-label={t('Open on SoundCloud')}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        window.open(unified.externalUrl ?? '', '_blank')
                                      }}
                                    >
                                      <ExternalLink size={14} />
                                    </button>
                                  ) : (
                                    <span className="sc-open-spacer" />
                                  )}
                                  <ScRowMenu track={track} />
                                </div>
                              )
                            })}
                          </div>
                        </section>
                      ) : null}

                      {showTab('albums') && scAlbums.length > 0 ? (
                        <section className="search-result-kind">
                          {tab === 'all' ? <h3 className="search-kind-title">{t('Albums')}</h3> : null}
                          <div className="cards-grid cards-grid-tight">
                            {scAlbums.map((playlist) => <ScPlaylistCard key={playlist.id} playlist={playlist} />)}
                          </div>
                        </section>
                      ) : null}

                      {showTab('playlists') && scPlaylistOnly.length > 0 ? (
                        <section className="search-result-kind">
                          {tab === 'all' ? <h3 className="search-kind-title">{t('Playlists')}</h3> : null}
                          <div className="cards-grid cards-grid-tight">
                            {scPlaylistOnly.map((playlist) => <ScPlaylistCard key={playlist.id} playlist={playlist} />)}
                          </div>
                        </section>
                      ) : null}

                      {showTab('artists') && scArtists.length > 0 ? (
                        <section className="search-result-kind">
                          {tab === 'all' ? <h3 className="search-kind-title">{t('Artists')}</h3> : null}
                          <div className="arow-list">
                            {scArtists.map((artist) => <ScArtistRow key={artist.id} artist={artist} />)}
                          </div>
                        </section>
                      ) : null}
                      {scNote ? <div className="sc-toast">{scNote}</div> : null}
                    </>
                  )}
                </section>
              ) : null}

              {ytRelevant && (ytProviderPending || (ytTrackMode && ytStatus === 'error') || (ytCollectionMode && ytCollStatus === 'error') || ytCount > 0) ? (
                <section className="search-provider-group">
                  {providerHeading(t('YouTube Music'), ytCount, 'youtubemusic')}
                  {ytProviderPending ? (
                    searchSkeleton
                  ) : (ytTrackMode && ytStatus === 'error') || (ytCollectionMode && ytCollStatus === 'error') ? (
                    <div className="search-provider-message muted">{t('YouTube needs yt-dlp')}</div>
                  ) : ytCollectionMode && ytSection ? (
                    <div className="cards-grid cards-grid-tight">
                      {ytHitsColl.map((hit) => {
                        const info = ytInfo[hit.id]
                        // Names come from different fields depending on collection kind.
                        const name =
                          ytSection === 'artists'
                            ? (info?.uploader ?? info?.title ?? null)
                            : ytSection === 'albums'
                              ? (info?.title?.replace(/^Album - /i, '') ?? null)
                              : (info?.title ?? null)
                        return (
                          <YtCard
                            key={hit.id}
                            kind={ytKind}
                            id={hit.id}
                            name={name}
                            sub={info?.uploader ?? null}
                            count={info?.count ?? null}
                            thumbnailUrl={info?.thumbnailUrl ?? hit.thumbnailUrl}
                            fallbackUrls={info?.thumbnailUrls ?? hit.thumbnailUrls}
                            pending={!info}
                          />
                        )
                      })}
                    </div>
                  ) : ytTrackMode && ytStatus === 'done' ? (
                    <section className="search-result-kind">
                      {tab === 'all' ? <h3 className="search-kind-title">{t('Tracks')}</h3> : null}
                      <div className="sc-list">
                        {ytHits.map((hit) => (
                          <div
                            key={hit.id}
                            className="sc-row"
                            onClick={() => player.playTracks([ytHitToUnified(hit)], 0)}
                          >
                            <ScArtwork url={hit.thumbnailUrl} title={hit.title} />
                            <div className="sc-meta">
                              <span className="sc-title">{hit.title}</span>
                              <span className="sc-artist">
                                {ytPending.has(hit.id) ? <Spinner size={10} /> : hit.artist || hit.album || ''}
                              </span>
                            </div>
                            <span className="sc-duration">
                              {ytPending.has(hit.id) ? <Spinner size={10} /> : hit.durationMs > 0 ? fmtTime(hit.durationMs / 1000) : '—'}
                            </span>
                            <button
                              className="icon-btn sc-open"
                              aria-label={t('Open on YouTube')}
                              onClick={(event) => {
                                event.stopPropagation()
                                window.open(hit.url, '_blank')
                              }}
                            >
                              <ExternalLink size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </section>
              ) : null}

              {showNoResults ? (
                <EmptyState title={`${t('No results for')} "${trimmed}"`} hint={t('Check the spelling or try a shorter term.')} />
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

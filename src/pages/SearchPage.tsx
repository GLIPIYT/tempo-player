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
import LoadingLine from '../components/common/LoadingLine'
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
    let cancelled = false
    const timer = window.setTimeout(() => {
      setScStatus('loading')
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
    let cancelled = false
    const timer = window.setTimeout(() => {
      setYtStatus('loading')
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
  // playlists come back as bare ids, so their names are fetched afterwards, one
  // page at a time.
  useEffect(() => {
    if (source !== 'youtube' || ytSection === null || trimmed.length === 0) {
      setYtCollStatus('idle')
      setYtHitsColl([])
      setYtInfo({})
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      setYtCollStatus('loading')
      setYtHitsColl([])
      setYtInfo({})
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

  const nothing =
    !loading &&
    !error &&
    results != null &&
    results.tracks.length === 0 &&
    results.albums.length === 0 &&
    results.artists.length === 0

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

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('Search')}</h1>
          <div className="page-sub">{trimmed ? `${t('Results for')} "${trimmed}"` : t('Type in the search bar above')}</div>
        </div>
      </div>

      {trimmed.length > 0 ? (
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
              {entry.mark ? (
                // The mark carries its own colour only on the chosen chip;
                // elsewhere it sits back with the label instead of shouting
                // from a row of grey buttons.
                <BrandIcon mark={entry.mark} size={13} brand={source === entry.id} />
              ) : null}
              <span>{t(entry.label)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {trimmed.length > 0 ? (
        <div className="seg search-tabs" role="tablist" aria-label={t('Search scope')}>
          {SEARCH_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? 'seg-btn is-active' : 'seg-btn'}
              onClick={() => setTab(entry.id)}
            >
              {t(entry.label)}
            </button>
          ))}
        </div>
      ) : null}

      {source !== 'all' ? null : trimmed.length === 0 ? (
        <EmptyState
          icon={<Search size={34} />}
          title={t('Search your library')}
          hint={t('Find tracks, albums and artists. Start typing above.')}
        />
      ) : loading && !results ? (
        <div className="muted">{t('Searching…')}</div>
      ) : error ? (
        <div className="error-line">{error}</div>
      ) : nothing ? (
        <EmptyState title={`${t('No results for')} "${trimmed}"`} hint={t('Check the spelling or try a shorter term.')} />
      ) : results ? (
        <>
          {showTab('tracks') && results.tracks.length > 0 ? (
            <>
              <div className="section-label">{t('Tracks')}</div>
              <TrackList tracks={results.tracks} showAlbum showIndex />
            </>
          ) : null}

          {showTab('albums') && results.albums.length > 0 ? (
            <>
              <div className="section-label">{t('Albums')}</div>
              <div className="cards-grid cards-grid-tight">
                {results.albums.map((a) => (
                  <button
                    key={a.id}
                    className="card"
                    onClick={() => navigate({ name: 'album', id: a.id })}
                    title={a.title}
                  >
                    <Cover path={a.coverPath} label={a.title} size={120} />
                    <span className="card-title">{a.title}</span>
                    <span className="card-sub">{a.artistName ?? t('Unknown artist')}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {showTab('artists') && results.artists.length > 0 ? (
            <>
              <div className="section-label">{t('Artists')}</div>
              <div className="arow-list">
                {results.artists.map((ar) => (
                  <button
                    key={ar.id}
                    className="arow"
                    onClick={() => navigate({ name: 'artist', id: ar.id })}
                  >
                    <Cover label={ar.name} size={40} rounded />
                    <span className="arow-name">{ar.name}</span>
                    <span className="arow-meta">
                      {ar.albumCount ?? 0} {t('albums')} · {ar.trackCount ?? 0} {t('tracks')}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {trimmed.length > 0 && source !== 'youtube' ? (
        <section className="sc-section">
          <div className="section-label sc-label">
            <BrandIcon mark="soundcloud" size={14} brand />
            <span>{t('SoundCloud')}</span>
          </div>
          {scStatus === 'loading' ? (
            <LoadingLine
              lines={[t('Searching SoundCloud…'), t('Reading what came back…')]}
            />
          ) : scStatus === 'error' ? (
            <div className="muted sc-status">{t('SoundCloud is unavailable')}</div>
          ) : scStatus === 'done' &&
            scTracks.length === 0 &&
            scPlaylists.length === 0 &&
            scArtists.length === 0 ? (
            <div className="muted sc-status">{t('Nothing found on SoundCloud')}</div>
          ) : scStatus === 'done' ? (
            <>
              {showTab('tracks') && scTracks.length > 0 ? (
                <div className="sc-list">
                {scTracks.map((trk) => {
                  const unified = scTrackToUnified(trk)
                  const idx = playableIdx.get(trk.id)
                  return (
                    <div
                      key={trk.id}
                      className={'sc-row' + (idx === undefined ? ' is-disabled' : '')}
                      onClick={() => playSoundCloud(trk)}
                    >
                    <ScArtwork url={trk.artworkUrl} title={trk.title} />
                    <div className="sc-meta">
                      <span className="sc-title">{trk.title}</span>
                      <span className="sc-artist">{trk.artist}</span>
                    </div>
                    {idx === undefined ? (
                      <span className="sc-duration">
                        <Lock size={13} />
                      </span>
                    ) : (
                      <span className="sc-duration">{fmtTime(unified.durationSec)}</span>
                    )}
                    {unified.externalUrl ? (
                      <button
                        className="icon-btn sc-open"
                        aria-label={t('Open on SoundCloud')}
                        onClick={(e) => {
                          e.stopPropagation()
                          window.open(unified.externalUrl ?? '', '_blank')
                        }}
                      >
                        <ExternalLink size={14} />
                      </button>
                    ) : (
                      <span className="sc-open-spacer" />
                    )}
                    <ScRowMenu track={trk} />
                  </div>
                )
              })}
                </div>
              ) : null}

              {showTab('albums') && scAlbums.length > 0 ? (
                <>
                  <div className="sc-sub-label">{t('Albums')}</div>
                  <div className="cards-grid cards-grid-tight">
                    {scAlbums.map((pl) => (
                      <ScPlaylistCard key={pl.id} playlist={pl} />
                    ))}
                  </div>
                </>
              ) : null}

              {showTab('playlists') && scPlaylistOnly.length > 0 ? (
                <>
                  <div className="sc-sub-label">{t('Playlists')}</div>
                  <div className="cards-grid cards-grid-tight">
                    {scPlaylistOnly.map((pl) => (
                      <ScPlaylistCard key={pl.id} playlist={pl} />
                    ))}
                  </div>
                </>
              ) : null}

              {showTab('artists') && scArtists.length > 0 ? (
                <>
                  <div className="sc-sub-label">{t('Artists')}</div>
                  <div className="arow-list">
                    {scArtists.map((ar) => (
                      <ScArtistRow key={ar.id} artist={ar} />
                    ))}
                  </div>
                </>
              ) : null}

              {scNote ? <div className="sc-toast">{scNote}</div> : null}
            </>
          ) : null}
        </section>
      ) : null}

      {trimmed.length > 0 && source === 'youtube' && ytSection !== null ? (
        <section className="sc-section">
          <div className="section-label sc-label">
            <BrandIcon mark="youtubemusic" size={14} brand />
            <span>
              {ytSection === 'albums'
                ? t('Albums')
                : ytSection === 'artists'
                  ? t('Artists')
                  : t('Playlists')}
            </span>
          </div>
          {ytCollStatus === 'loading' ? (
            <LoadingLine
              lines={[
                t('Asking YouTube Music…'),
                ytSection === 'albums'
                  ? t('Opening each album…')
                  : ytSection === 'artists'
                    ? t('Opening each artist…')
                    : t('Opening each playlist…'),
                t('Reading the names…'),
              ]}
            />
          ) : ytCollStatus === 'error' ? (
            <div className="muted sc-status">{t('YouTube needs yt-dlp')}</div>
          ) : ytCollStatus === 'done' && ytHitsColl.length === 0 ? (
            <div className="muted sc-status">{t('Nothing found')}</div>
          ) : (
            <div className="cards-grid cards-grid-tight">
              {ytHitsColl.map((hit) => {
                const info = ytInfo[hit.id]
                // Each kind keeps its name somewhere different: an album and a
                // playlist in the title, an artist in the uploader. An album's
                // title also arrives with the word "Album" stuck on the front.
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
                    thumbnailUrl={info?.thumbnailUrl ?? null}
                    pending={!info}
                  />
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      {trimmed.length > 0 && source !== 'soundcloud' && ytSection === null ? (
        <section className="sc-section">
          <div className="section-label sc-label">
            <BrandIcon mark="youtubemusic" size={14} brand />
            <span>{t('YouTube')}</span>
          </div>
          {ytStatus === 'loading' ? (
            <LoadingLine
              lines={[
                t('Searching YouTube…'),
                t('Looking for songs, not videos…'),
                t('Reading what came back…'),
              ]}
            />
          ) : ytStatus === 'error' ? (
            <div className="muted sc-status">{t('YouTube needs yt-dlp')}</div>
          ) : ytStatus === 'done' && ytHits.length === 0 ? (
            <div className="muted sc-status">{t('Nothing found on YouTube')}</div>
          ) : ytStatus === 'done' ? (
            <div className="sc-list">
              {ytHits.map((hit) => (
                <div
                  key={hit.id}
                  className="sc-row"
                  onClick={() => player.playTracks([ytHitToUnified(hit)], 0)}
                >
                  {/* Deliberately not `pending`: the cover comes from the
                      video id and needs no extraction, so it should never wait
                      on one. It shows its own loading ring and nothing else. */}
                  <ScArtwork url={hit.thumbnailUrl} title={hit.title} />
                  <div className="sc-meta">
                    <span className="sc-title">{hit.title}</span>
                    <span className="sc-artist">
                      {ytPending.has(hit.id) ? (
                        <Spinner size={10} />
                      ) : (
                        hit.artist || hit.album || ''
                      )}
                    </span>
                  </div>
                  <span className="sc-duration">
                    {ytPending.has(hit.id) ? (
                      <Spinner size={10} />
                    ) : hit.durationMs > 0 ? (
                      fmtTime(hit.durationMs / 1000)
                    ) : (
                      '—'
                    )}
                  </span>
                  <button
                    className="icon-btn sc-open"
                    aria-label={t('Open on YouTube')}
                    onClick={(e) => {
                      e.stopPropagation()
                      window.open(hit.url, '_blank')
                    }}
                  >
                    <ExternalLink size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

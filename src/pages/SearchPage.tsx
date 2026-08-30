import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Cloud, Ellipsis, ExternalLink, Lock, Plus, Search } from 'lucide-react'
import { api } from '../api/client'
import type { Playlist, ScTrack, SearchResults } from '../types/models'
import { useSearchQuery } from '../hooks/useSearchQuery'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import TrackList from '../components/common/TrackList'
import Cover from '../components/common/Cover'
import EmptyState from '../components/common/EmptyState'
import { useNav } from '../state/nav'
import { usePlayer } from '../player'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'
import { scTrackToUnified, scTracksToUnified } from '../utils/unified'

type ScStatus = 'idle' | 'loading' | 'error' | 'done'

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

function ScArtwork({ url, title }: { url: string | null; title: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    setBroken(false)
  }, [url])
  if (!url || broken) {
    return <span className="sc-art sc-art-fallback">{(title.trim()[0] ?? '?').toUpperCase()}</span>
  }
  return <img className="sc-art" src={url} alt="" draggable={false} onError={() => setBroken(true)} />
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
    if (trimmed.length === 0) {
      setScStatus('idle')
      setScTracks([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      setScStatus('loading')
      api
        .scSearchTracks(trimmed, 50, 0)
        .then((rows) => {
          if (cancelled) return
          setScTracks(rows)
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
  }, [trimmed])

  const nothing =
    !loading &&
    !error &&
    results != null &&
    results.tracks.length === 0 &&
    results.albums.length === 0 &&
    results.artists.length === 0

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

      {trimmed.length === 0 ? (
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
          {results.tracks.length > 0 ? (
            <>
              <div className="section-label">{t('Tracks')}</div>
              <TrackList tracks={results.tracks} showAlbum showIndex />
            </>
          ) : null}

          {results.albums.length > 0 ? (
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

          {results.artists.length > 0 ? (
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

      {trimmed.length > 0 ? (
        <section className="sc-section">
          <div className="section-label sc-label">
            <Cloud size={13} />
            <span>{t('SoundCloud')}</span>
          </div>
          {scStatus === 'loading' ? (
            <div className="muted sc-status">{t('Searching SoundCloud…')}</div>
          ) : scStatus === 'error' ? (
            <div className="muted sc-status">{t('SoundCloud is unavailable')}</div>
          ) : scStatus === 'done' && scTracks.length === 0 ? (
            <div className="muted sc-status">{t('Nothing found on SoundCloud')}</div>
          ) : scStatus === 'done' ? (
            <>
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
              {scNote ? <div className="sc-toast">{scNote}</div> : null}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

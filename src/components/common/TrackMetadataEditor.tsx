import { useCallback, useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Check, Disc3, ImagePlus, Library, LoaderCircle, Music2, RotateCcw, UserRound, X } from 'lucide-react'
import { api } from '../../api/client'
import type {
  Album,
  Artist,
  LibraryElementKind,
  Playlist,
  Track,
  TrackArtworkEdit,
  TrackMetadataEditorState,
  TrackMetadataEditRequest,
} from '../../types/models'
import { useT } from '../../i18n'
import { bumpLibraryVersion } from '../../utils/libraryVersion'
import Cover from './Cover'
import './track-metadata-editor.css'

type CoverSource = { id: number; kind: LibraryElementKind; label: string }

interface TrackMetadataEditorProps {
  track: Track
  onClose: () => void
  onSaved: (track: Track) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asOptionalNumber(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

export default function TrackMetadataEditor({ track, onClose, onSaved }: TrackMetadataEditorProps) {
  const t = useT()
  const [state, setState] = useState<TrackMetadataEditorState | null>(null)
  const [artists, setArtists] = useState<Artist[]>([])
  const [albums, setAlbums] = useState<Album[]>([])
  const [title, setTitle] = useState(track.title)
  const [artistId, setArtistId] = useState<number | null>(track.artistId)
  const [albumId, setAlbumId] = useState<number | null>(track.albumId)
  const [trackNumber, setTrackNumber] = useState(track.trackNumber?.toString() ?? '')
  const [discNumber, setDiscNumber] = useState(track.discNumber?.toString() ?? '')
  const [year, setYear] = useState(track.year?.toString() ?? '')
  const [genre, setGenre] = useState(track.genre ?? '')
  const [artwork, setArtwork] = useState<TrackArtworkEdit>({ action: 'keep' })
  const [artworkPreview, setArtworkPreview] = useState<string | null>(track.coverPath)
  const [coverChoicesOpen, setCoverChoicesOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryKind, setLibraryKind] = useState<LibraryElementKind>('track')
  const [libraryQuery, setLibraryQuery] = useState('')
  const [coverSources, setCoverSources] = useState<CoverSource[]>([])
  const [coverOffset, setCoverOffset] = useState(0)
  const [coverHasMore, setCoverHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [coverLoading, setCoverLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.getTrackMetadataEditorState(track.id),
      api.listArtists(''),
      api.listAlbums(''),
    ])
      .then(([editorState, artistList, albumList]) => {
        if (cancelled) return
        setState(editorState)
        setArtists(artistList)
        setAlbums(albumList)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [track.id])

  useEffect(() => {
    if (!libraryOpen) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      const load = async () => {
        setCoverLoading(true)
        try {
          let results: CoverSource[] = []
          if (libraryKind === 'track') {
            const list = await api.listTracks(libraryQuery.trim(), 40, coverOffset, 'title')
            results = list.map((item) => ({
              id: item.id,
              kind: 'track',
              label: `${item.title}${item.artistName ? ` — ${item.artistName}` : ''}`,
            }))
            if (!cancelled) setCoverHasMore(list.length === 40)
          } else if (libraryKind === 'album') {
            const list = await api.listAlbums(libraryQuery.trim())
            results = list.map((item) => ({
              id: item.id,
              kind: 'album',
              label: `${item.title}${item.artistName ? ` — ${item.artistName}` : ''}`,
            }))
          } else if (libraryKind === 'artist') {
            const list = await api.listArtists(libraryQuery.trim())
            results = list.map((item) => ({ id: item.id, kind: 'artist', label: item.name }))
          } else {
            const list: Playlist[] = await api.listPlaylists()
            const query = libraryQuery.trim().toLocaleLowerCase()
            results = list
              .filter((item) => item.name.toLocaleLowerCase().includes(query))
              .map((item) => ({ id: item.id, kind: 'playlist', label: item.name }))
          }
          if (!cancelled) {
            setCoverSources((current) => libraryKind === 'track' && coverOffset > 0
              ? [...current, ...results]
              : results)
            if (libraryKind !== 'track') setCoverHasMore(false)
          }
        } catch (reason: unknown) {
          if (!cancelled) setError(errorMessage(reason))
        } finally {
          if (!cancelled) setCoverLoading(false)
        }
      }
      void load()
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [coverOffset, libraryKind, libraryOpen, libraryQuery])

  const close = useCallback(() => {
    if (saving || restoring) return
    onClose()
  }, [onClose, restoring, saving])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const restoreAvailable = state?.original !== null && state?.original !== undefined
  const selectedArtist = artists.find((artist) => artist.id === artistId)
    ?? (artistId != null && artistId === track.artistId && track.artistName
      ? { id: artistId, name: track.artistName }
      : null)
  const selectedAlbum = albums.find((album) => album.id === albumId)
    ?? (albumId != null && albumId === track.albumId && track.albumTitle
      ? { id: albumId, title: track.albumTitle }
      : null)
  const isBusy = saving || restoring

  const openLocalCover = async () => {
    setError(null)
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: t('Artwork'), extensions: ['jpg', 'jpeg', 'png'] }],
      })
      if (typeof selected !== 'string') return
      setArtwork({ action: 'fromLocalPath', path: selected })
      setArtworkPreview(selected)
      setCoverChoicesOpen(false)
      setLibraryOpen(false)
      setCoverOffset(0)
      setCoverHasMore(false)
    } catch (reason: unknown) {
      setError(errorMessage(reason))
    }
  }

  const chooseLibraryCover = async (source: CoverSource) => {
    setError(null)
    setArtwork({ action: 'copyFromLibrary', kind: source.kind, id: source.id })
    setCoverChoicesOpen(false)
    setLibraryOpen(false)
    setCoverSources([])
    setCoverOffset(0)
    setCoverHasMore(false)
    try {
      const path = await api.getLibraryCover(source.kind, source.id)
      setArtworkPreview(path)
      if (!path) setError(t('No artwork found'))
    } catch (reason: unknown) {
      setError(errorMessage(reason))
    }
  }

  const chooseNoCover = () => {
    setArtwork({ action: 'remove' })
    setArtworkPreview(null)
    setCoverChoicesOpen(false)
    setLibraryOpen(false)
  }

  const save = async () => {
    if (!state) return
    const normalizedTitle = title.trim()
    if (!normalizedTitle) {
      setError(t('Title is required'))
      return
    }
    const nextTrackNumber = asOptionalNumber(trackNumber)
    const nextDiscNumber = asOptionalNumber(discNumber)
    const nextYear = asOptionalNumber(year)
    if ((trackNumber.trim() && (nextTrackNumber == null || nextTrackNumber < 1))
      || (discNumber.trim() && (nextDiscNumber == null || nextDiscNumber < 1))
      || (year.trim() && (nextYear == null || nextYear < 1 || nextYear > 9999))) {
      setError(t('Enter valid track, disc and year values'))
      return
    }
    setSaving(true)
    setError(null)
    const request: TrackMetadataEditRequest = {
      trackId: track.id,
      expectedFileSize: state.fileSize,
      expectedFileMtimeNs: state.modifiedAtNs,
      title: normalizedTitle,
      artistId,
      albumId,
      trackNumber: nextTrackNumber,
      discNumber: nextDiscNumber,
      year: nextYear,
      genre: genre.trim() || null,
      artwork,
    }
    try {
      const savedTrack = await api.updateLocalTrackMetadata(request)
      bumpLibraryVersion()
      onSaved(savedTrack)
    } catch (reason: unknown) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  const restore = async () => {
    setRestoring(true)
    setError(null)
    try {
      const restored = await api.restoreTrackMetadata(track.id)
      bumpLibraryVersion()
      onSaved(restored)
    } catch (reason: unknown) {
      setError(errorMessage(reason))
    } finally {
      setRestoring(false)
    }
  }

  const options = useMemo(() => ({
    artistId: artistId == null ? '' : String(artistId),
    albumId: albumId == null ? '' : String(albumId),
  }), [albumId, artistId])

  const kindIcon = (kind: LibraryElementKind) => {
    if (kind === 'artist') return <UserRound size={13} />
    if (kind === 'album') return <Disc3 size={13} />
    if (kind === 'playlist') return <Library size={13} />
    return <Music2 size={13} />
  }

  return (
    <div className="modal-overlay metadata-editor-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close()
    }}>
      <section className="metadata-editor-modal" role="dialog" aria-modal="true" aria-labelledby="metadata-editor-title">
        <header className="metadata-editor-head">
          <h2 id="metadata-editor-title">{t('Edit track')}</h2>
          <button className="icon-btn" onClick={close} aria-label={t('Close dialog')} disabled={isBusy}>
            <X size={16} />
          </button>
        </header>

        {loading ? (
          <div className="metadata-editor-state"><LoaderCircle className="is-spinning" size={18} /></div>
        ) : (
          <div className="metadata-editor-body">
            <div className="metadata-editor-title-row">
              <div className="metadata-editor-cover-wrap">
                <button
                  className="metadata-editor-cover-button"
                  type="button"
                  aria-label={t('Change artwork')}
                  onClick={() => setCoverChoicesOpen((openState) => !openState)}
                  disabled={isBusy}
                >
                  <Cover path={artworkPreview} label={title} size={68} loading="eager" />
                  <span className="metadata-editor-cover-badge"><ImagePlus size={13} /></span>
                </button>
              </div>
              <label className="metadata-editor-field metadata-editor-track-title">
                <span>{t('Title')}</span>
                <input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} />
              </label>
            </div>

            {coverChoicesOpen ? (
              <div className="metadata-editor-cover-choice">
                <div className="metadata-editor-choice-actions">
                  <button className="btn" type="button" onClick={() => void openLocalCover()}>
                    <ImagePlus size={14} />{t('Choose file')}
                  </button>
                  <button
                    className={'btn' + (libraryOpen ? ' is-active' : '')}
                    type="button"
                    onClick={() => {
                      setLibraryOpen((value) => !value)
                      setCoverOffset(0)
                      setCoverHasMore(false)
                      setCoverSources([])
                    }}
                  >
                    <Library size={14} />{t('Copy from library')}
                  </button>
                  <button className="btn" type="button" onClick={chooseNoCover}>{t('Remove cover')}</button>
                </div>
                {libraryOpen ? (
                  <div className="metadata-editor-library-picker">
                    <div className="metadata-editor-library-tabs" role="tablist" aria-label={t('Library item type')}>
                      {(['track', 'album', 'artist', 'playlist'] as LibraryElementKind[]).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          role="tab"
                          aria-selected={libraryKind === kind}
                          className={libraryKind === kind ? 'is-selected' : ''}
                          onClick={() => {
                            setLibraryKind(kind)
                            setCoverOffset(0)
                            setCoverSources([])
                          }}
                        >
                          {kindIcon(kind)}{t(kind === 'track' ? 'Tracks' : kind === 'album' ? 'Albums' : kind === 'artist' ? 'Artists' : 'Playlists')}
                        </button>
                      ))}
                    </div>
                    <input
                      className="metadata-editor-library-search"
                      value={libraryQuery}
                      placeholder={t('Search library')}
                      onChange={(event) => {
                        setLibraryQuery(event.target.value)
                        setCoverOffset(0)
                        setCoverSources([])
                      }}
                    />
                    <div className="metadata-editor-source-list" role="listbox" aria-label={t('Choose artwork source')}>
                      {coverLoading ? (
                        <div className="metadata-editor-state"><LoaderCircle className="is-spinning" size={16} /></div>
                      ) : coverSources.length > 0 ? coverSources.map((source) => (
                        <button
                          key={`${source.kind}-${source.id}`}
                          type="button"
                          role="option"
                          aria-selected={false}
                          className="metadata-editor-source-row"
                          onClick={() => void chooseLibraryCover(source)}
                        >
                          {kindIcon(source.kind)}<span>{source.label}</span>
                        </button>
                      )) : (
                        <div className="metadata-editor-empty">{t(libraryQuery ? 'No matches' : 'Search library')}</div>
                      )}
                      {coverHasMore && !coverLoading ? (
                        <button
                          type="button"
                          className="metadata-editor-load-more"
                          onClick={() => setCoverOffset((offset) => offset + 40)}
                        >
                          {t('Load more')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="metadata-editor-grid">
              <label className="metadata-editor-field">
                <span>{t('Artist')}</span>
                <select value={options.artistId} onChange={(event) => setArtistId(event.target.value ? Number(event.target.value) : null)}>
                  <option value="">{t('Unassigned')}</option>
                  {selectedArtist && !artists.some((artist) => artist.id === selectedArtist.id) ? (
                    <option value={selectedArtist.id}>{selectedArtist.name}</option>
                  ) : null}
                  {artists.map((artist) => <option key={artist.id} value={artist.id}>{artist.name}</option>)}
                </select>
              </label>
              <label className="metadata-editor-field">
                <span>{t('Album')}</span>
                <select value={options.albumId} onChange={(event) => setAlbumId(event.target.value ? Number(event.target.value) : null)}>
                  <option value="">{t('Unassigned')}</option>
                  {selectedAlbum && !albums.some((album) => album.id === selectedAlbum.id) ? (
                    <option value={selectedAlbum.id}>{selectedAlbum.title}</option>
                  ) : null}
                  {albums.map((album) => (
                    <option key={album.id} value={album.id}>
                      {album.title}{album.artistName ? ` — ${album.artistName}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="metadata-editor-field">
                <span>{t('Track number')}</span>
                <input inputMode="numeric" value={trackNumber} onChange={(event) => setTrackNumber(event.target.value)} />
              </label>
              <label className="metadata-editor-field">
                <span>{t('Disc number')}</span>
                <input inputMode="numeric" value={discNumber} onChange={(event) => setDiscNumber(event.target.value)} />
              </label>
              <label className="metadata-editor-field">
                <span>{t('Year')}</span>
                <input inputMode="numeric" value={year} onChange={(event) => setYear(event.target.value)} />
              </label>
              <label className="metadata-editor-field">
                <span>{t('Genre')}</span>
                <input value={genre} maxLength={120} onChange={(event) => setGenre(event.target.value)} />
              </label>
            </div>

            {error ? <div className="metadata-editor-error" role="alert">{error}</div> : null}

            <footer className="metadata-editor-actions">
              <div>
                {restoreAvailable ? (
                  <button className="btn metadata-editor-restore" type="button" onClick={() => void restore()} disabled={isBusy}>
                    <RotateCcw size={14} />{t('Restore original')}
                  </button>
                ) : null}
              </div>
              <div>
                <button className="btn" type="button" onClick={close} disabled={isBusy}>{t('Cancel')}</button>
                <button className="btn btn-primary" type="button" onClick={() => void save()} disabled={isBusy || loading || state === null}>
                  {saving ? <LoaderCircle className="is-spinning" size={14} /> : <Check size={14} />}
                  {saving ? t('Saving…') : t('Save')}
                </button>
              </div>
            </footer>
          </div>
        )}
      </section>
    </div>
  )
}

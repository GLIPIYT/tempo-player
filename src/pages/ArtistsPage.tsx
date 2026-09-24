import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { MicVocal, Play, Search, Star, StarOff } from 'lucide-react'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import type { Artist } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { tracksToUnified } from '../utils/unified'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { openContextMenu, type ContextMenuItem } from '../components/common/ContextMenu'
import Cover from '../components/common/Cover'
import EmptyState from '../components/common/EmptyState'
import CacheBadge from '../soundcloud/CacheBadge'

export default function ArtistsPage() {
  const { navigate } = useNav()
  const t = useT()
  const player = usePlayer()
  const version = useLibraryVersion()
  const { data, loading, error } = useAsync(() => api.listArtists(''), [version])
  const [query, setQuery] = useState('')
  const visibleArtists = (data ?? []).filter((artist) =>
    artist.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )

  const playArtist = async (artistId: number) => {
    try {
      const detail = await api.getArtist(artistId)
      const first = detail.albums[0]
      if (!first) return
      const albumDetail = await api.getAlbum(first.id)
      if (albumDetail.tracks.length > 0) player.playTracks(tracksToUnified(albumDetail.tracks), 0)
    } catch {}
  }

  // the favourite state has to be asked for, so the menu opens once it lands
  const artistMenu = (e: ReactMouseEvent, a: Artist) => {
    e.preventDefault()
    const x = e.clientX
    const y = e.clientY
    void api
      .isFavoriteArtist(a.id)
      .then((isFav) => {
        const items: ContextMenuItem[] = [
          {
            id: 'play',
            label: t('Play all'),
            icon: <Play size={13} />,
            onSelect: () => {
              void api
                .getArtistTracks(a.id)
                .then((rows) => {
                  if (rows.length > 0) player.playTracks(tracksToUnified(rows), 0)
                })
                .catch(() => undefined)
            },
          },
          {
            id: 'fav',
            label: isFav ? t('Remove from favorites') : t('Add to favorites'),
            icon: isFav ? <StarOff size={13} /> : <Star size={13} />,
            onSelect: () => {
              void api
                .toggleFavoriteArtist(a.id)
                .then(() => bumpLibraryVersion())
                .catch(() => undefined)
            },
          },
        ]
        openContextMenu({ x, y, title: a.name, items })
      })
      .catch(() => undefined)
  }

  return (
    <div className="page">
      <div className="artist-library-hero">
        <div className="artist-library-copy">
          <div className="section-label">{t('Your collection')}</div>
          <h1 className="page-title">{t('Artists')}</h1>
          <p className="artist-library-count">
            {data ? `${data.length} ${t('artists')}` : t('Loading…')}
          </p>
          <label className="artist-library-search">
            <Search size={15} />
            <input
              type="search"
              value={query}
              aria-label={t('Search artists')}
              placeholder={t('Search artists')}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <div className="artist-library-art" aria-hidden="true">
          {(data ?? []).slice(0, 3).map((artist, index) => (
            <span key={artist.id} className={`artist-library-orbit orbit-${index + 1}`}>
              <CacheBadge kind="artist" scId={null} localId={artist.id}>
                <Cover path={artist.imagePath} label={artist.name} size={82} rounded />
              </CacheBadge>
            </span>
          ))}
        </div>
      </div>

      {error ? <div className="error-line">{error}</div> : null}
      {loading && data === null ? (
        <div className="muted">{t('Loading…')}</div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<MicVocal size={34} />}
          title={t('No artists found')}
          hint={t('Artists appear after your library has been scanned.')}
        />
      ) : visibleArtists.length === 0 ? (
        <EmptyState
          icon={<Search size={30} />}
          title={t('No artists match')}
          hint={t('Try another artist name.')}
        />
      ) : (
        <div className="artist-library-grid">
          {visibleArtists.map((a) => (
            <div key={a.id} className="artist-library-card">
              <button
                type="button"
                className="artist-library-open"
                onClick={() => navigate({ name: 'artist', id: a.id })}
                onContextMenu={(e) => artistMenu(e, a)}
                title={a.name}
              >
                <span className="artist-library-cover">
                  <CacheBadge kind="artist" scId={null} localId={a.id}>
                    <Cover path={a.imagePath} label={a.name} size={92} rounded />
                  </CacheBadge>
                </span>
                <span className="artist-library-name">{a.name}</span>
                <span className="artist-library-meta">
                  {a.albumCount ?? 0} {t('albums')} · {a.trackCount ?? 0} {t('tracks')}
                </span>
              </button>
              <button
                type="button"
                className="artist-library-play"
                aria-label={`${t('Play')} ${a.name}`}
                onClick={() => void playArtist(a.id)}
              >
                <Play size={15} fill="currentColor" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

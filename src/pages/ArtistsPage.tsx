import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { MicVocal, Play, Search, Star, StarOff } from 'lucide-react'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import type { Artist } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { resolveLang, useT } from '../i18n'
import { formatCount } from '../i18n/count'
import { useSettings } from '../state/settings'
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
  const { settings } = useSettings()
  const lang = resolveLang(settings.lang)
  const player = usePlayer()
  const version = useLibraryVersion()
  const { data, loading, error } = useAsync(() => api.listArtists(''), [version])
  const analytics = useAsync(() => api.getAnalytics('all'), [version])
  const [query, setQuery] = useState('')
  const search = query.trim().toLocaleLowerCase()
  const visibleArtists = (data ?? []).filter((artist) => artist.name.toLocaleLowerCase().includes(search))
  const byId = new Map((data ?? []).map((artist) => [artist.id, artist]))
  const ranked = (analytics.data?.topArtists ?? [])
    .map((item) => byId.get(item.artist.id))
    .filter((artist): artist is Artist => artist !== undefined)
  const featured = (ranked.length > 0 ? ranked : data ?? []).slice(0, 3)
  const featuredIds = new Set(featured.map((artist) => artist.id))
  const remaining = search ? visibleArtists : visibleArtists.filter((artist) => !featuredIds.has(artist.id))

  const playArtist = async (artistId: number) => {
    try {
      const tracks = await api.getArtistTracks(artistId)
      if (tracks.length > 0) player.playTracks(tracksToUnified(tracks), 0)
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
    <div className="page artist-gallery-page">
      <div className="page-head collection-library-heading">
        <div>
          <h1 className="page-title">{t('Artists')}</h1>
          <div className="page-sub">{data ? formatCount(data.length, 'artist', t, lang) : t('Loading…')}</div>
        </div>
        <label className="collection-library-search">
          <Search size={15} />
          <input
            type="search"
            value={query}
            aria-label={t('Search artists')}
            placeholder={t('Search artists')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {error ? <div className="error-line">{error}</div> : null}
      {(loading && data === null) || (analytics.loading && analytics.data === null) ? (
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
        <>
          {!search && featured[0] ? (
            <section className={`artist-gallery-spotlight${featured.length === 1 ? ' is-single' : ''}`}>
              <div className="artist-gallery-lead">
                <button type="button" className="artist-gallery-lead-open" onClick={() => navigate({ name: 'artist', id: featured[0].id })} onContextMenu={(event) => artistMenu(event, featured[0])}>
                  <CacheBadge kind="artist" scId={null} localId={featured[0].id}>
                    <Cover path={featured[0].imagePath} label={featured[0].name} size={480} />
                  </CacheBadge>
                  <span className="artist-gallery-lead-copy">
                    <small>{t(ranked.length > 0 ? 'Most played' : 'Your collection')}</small>
                    <strong>{featured[0].name}</strong>
                    <span>{formatCount(featured[0].albumCount ?? 0, 'album', t, lang)} · {formatCount(featured[0].trackCount ?? 0, 'track', t, lang)}</span>
                  </span>
                </button>
                <button type="button" className="artist-gallery-lead-play" aria-label={`${t('Play all')}: ${featured[0].name}`} onClick={() => void playArtist(featured[0].id)}><Play size={18} fill="currentColor" /></button>
              </div>
              {featured.length > 1 ? (
                <div className={`artist-gallery-featured-side${featured.length === 2 ? ' is-one' : ''}`}>
                  {featured.slice(1).map((artist) => (
                    <div key={artist.id} className="artist-gallery-featured-row">
                      <button type="button" className="artist-gallery-featured-open" onClick={() => navigate({ name: 'artist', id: artist.id })} onContextMenu={(event) => artistMenu(event, artist)}>
                        <CacheBadge kind="artist" scId={null} localId={artist.id}><Cover path={artist.imagePath} label={artist.name} size={76} rounded /></CacheBadge>
                        <span><strong>{artist.name}</strong><small>{formatCount(artist.albumCount ?? 0, 'album', t, lang)} · {formatCount(artist.trackCount ?? 0, 'track', t, lang)}</small></span>
                      </button>
                      <button type="button" className="artist-gallery-inline-play" aria-label={`${t('Play all')}: ${artist.name}`} onClick={() => void playArtist(artist.id)}><Play size={15} fill="currentColor" /></button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {remaining.length > 0 ? (
            <section className="artist-gallery-section">
              {!search ? <h2>{t('Other artists')}</h2> : null}
              <div className="artist-gallery-grid">
                {remaining.map((artist) => (
                  <div key={artist.id} className="artist-gallery-card">
                    <button type="button" className="artist-gallery-card-open" onClick={() => navigate({ name: 'artist', id: artist.id })} onContextMenu={(event) => artistMenu(event, artist)}>
                      <span className="artist-gallery-card-art"><CacheBadge kind="artist" scId={null} localId={artist.id}><Cover path={artist.imagePath} label={artist.name} size={180} /></CacheBadge></span>
                      <strong title={artist.name}>{artist.name}</strong>
                      <small>{formatCount(artist.albumCount ?? 0, 'album', t, lang)} · {formatCount(artist.trackCount ?? 0, 'track', t, lang)}</small>
                    </button>
                    <button type="button" className="artist-gallery-card-play" aria-label={`${t('Play all')}: ${artist.name}`} onClick={() => void playArtist(artist.id)}><Play size={15} fill="currentColor" /></button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}

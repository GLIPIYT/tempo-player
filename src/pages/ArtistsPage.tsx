import type { MouseEvent as ReactMouseEvent } from 'react'
import { MicVocal, Play, Star, StarOff } from 'lucide-react'
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
import CardPlayButton from '../components/common/CardPlayButton'
import EmptyState from '../components/common/EmptyState'

export default function ArtistsPage() {
  const { navigate } = useNav()
  const t = useT()
  const player = usePlayer()
  const version = useLibraryVersion()
  const { data, loading, error } = useAsync(() => api.listArtists(''), [version])

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
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('Artists')}</h1>
          <div className="page-sub">{data ? `${data.length} ${t('artists')}` : t('Loading…')}</div>
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
      ) : (
        <div className="arow-list">
          {data.map((a) => (
            <button
              key={a.id}
              className="arow"
              onClick={() => navigate({ name: 'artist', id: a.id })}
              onContextMenu={(e) => artistMenu(e, a)}
            >
              <Cover label={a.name} size={44} rounded />
              <span className="arow-name">{a.name}</span>
              <span className="arow-meta">
                {a.albumCount ?? 0} {t('albums')} · {a.trackCount ?? 0} {t('tracks')}
              </span>
              <CardPlayButton
                className="arow-play"
                label={`${t('Play')} ${a.name}`}
                onPlay={() => void playArtist(a.id)}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

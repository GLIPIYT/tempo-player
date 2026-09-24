import type { MouseEvent as ReactMouseEvent } from 'react'
import { Play, Star, StarOff } from 'lucide-react'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import type { Album } from '../types/models'
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

export default function AlbumsPage() {
  const { navigate } = useNav()
  const t = useT()
  const player = usePlayer()
  const version = useLibraryVersion()
  const { data, loading, error } = useAsync(() => api.listAlbums(''), [version])

  const playAlbum = async (albumId: number) => {
    try {
      const detail = await api.getAlbum(albumId)
      if (detail.tracks.length > 0) player.playTracks(tracksToUnified(detail.tracks), 0)
    } catch {}
  }

  // the favourite state has to be asked for, so the menu opens once it lands
  const albumMenu = (e: ReactMouseEvent, a: Album) => {
    e.preventDefault()
    const x = e.clientX
    const y = e.clientY
    void api
      .isFavoriteAlbum(a.id)
      .then((isFav) => {
        const items: ContextMenuItem[] = [
          {
            id: 'play',
            label: t('Play all'),
            icon: <Play size={13} />,
            onSelect: () => void playAlbum(a.id),
          },
          {
            id: 'fav',
            label: isFav ? t('Remove from favorites') : t('Add to favorites'),
            icon: isFav ? <StarOff size={13} /> : <Star size={13} />,
            onSelect: () => {
              void api
                .toggleFavoriteAlbum(a.id)
                .then(() => bumpLibraryVersion())
                .catch(() => undefined)
            },
          },
        ]
        openContextMenu({ x, y, title: a.title, items })
      })
      .catch(() => undefined)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('Albums')}</h1>
          <div className="page-sub">{data ? `${data.length} ${t('albums')}` : t('Loading…')}</div>
        </div>
      </div>

      {error ? <div className="error-line">{error}</div> : null}
      {loading && data === null ? (
        <div className="muted">{t('Loading…')}</div>
      ) : !data || data.length === 0 ? (
        <EmptyState title={t('No albums found')} hint={t('Albums appear after your library has been scanned.')} />
      ) : (
        <div className="cards-grid">
          {data.map((a) => (
            <button
              key={a.id}
              className="card"
              onClick={() => navigate({ name: 'album', id: a.id })}
              onContextMenu={(e) => albumMenu(e, a)}
              title={a.title}
            >
              <span className="card-cover">
                <Cover path={a.coverPath} label={a.title} size={120} />
                <CardPlayButton
                  label={`${t('Play')} ${a.title}`}
                  onPlay={() => void playAlbum(a.id)}
                />
              </span>
              <span className="card-title">{a.title}</span>
              <span className="card-sub">
                {a.artistName ?? t('Unknown artist')}
                {a.year != null ? ` · ${a.year}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

import { useNav } from '../state/nav'
import { api } from '../api/client'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { tracksToUnified } from '../utils/unified'
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

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('Albums')}</h1>
          <div className="page-sub">{data ? `${data.length} ${t('albums')}` : t('Loading…')}</div>
        </div>
      </div>

      {error ? <div className="error-line">{error}</div> : null}
      {loading ? (
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

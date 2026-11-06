import { Play } from 'lucide-react'
import { api } from '../api/client'
import Cover from '../components/common/Cover'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import EmptyState from '../components/common/EmptyState'
import TrackList from '../components/common/TrackList'
import { useAsync } from '../hooks/useAsync'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { useNav } from '../state/nav'
import { tracksToUnified } from '../utils/unified'

/** Local view for a credited artist who has no filed library artist yet. */
export default function LocalArtistPage({ name, imagePath }: { name: string; imagePath: string | null }) {
  const t = useT()
  const player = usePlayer()
  const { navigate } = useNav()
  const { data, loading, error, reload } = useAsync(async () => {
    const tracks = await api.listTracks(name, 2000, 0)
    return tracks.filter(track => track.artistName?.trim().toLowerCase() === name.trim().toLowerCase())
  }, [name])
  const tracks = data ?? []

  return (
    <EditorialDetailLayout className="local-artist-page" onBack={() => navigate({ name: 'artists' })} backLabel={t('Artists')}
      round art={<Cover path={imagePath} label={name} size={232} />} kind={t('Artist')} title={name}
      meta={<span>{tracks.length} {t(tracks.length === 1 ? 'track' : 'tracks')}</span>}
      actions={tracks.length > 0 && <button className="btn btn-primary" onClick={() => player.playTracks(tracksToUnified(tracks), 0)}><Play size={14} />{t('Play all')}</button>}>
      {loading && !data ? <div className="muted">{t('Loading…')}</div> : error ? (
        <div><p className="error-line">{error}</p><button className="btn" onClick={reload}>{t('Retry')}</button></div>
      ) : tracks.length ? <TrackList tracks={tracks} showHeader /> : <EmptyState title={t('No tracks')} hint={t('No saved tracks by this artist yet.')} />}
    </EditorialDetailLayout>
  )
}

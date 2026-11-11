import { useEffect, useState } from 'react'
import { useFormatCount } from '../i18n/count'
import { MicVocal, Play } from 'lucide-react'
import { api } from '../api/client'
import { CollectionTrackHeading } from '../components/common/CollectionCatalog'
import Cover from '../components/common/Cover'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import EmptyState from '../components/common/EmptyState'
import TrackList from '../components/common/TrackList'
import { useAsync } from '../hooks/useAsync'
import { useT } from '../i18n'
import { usePlayerActions } from '../player'
import { useNav } from '../state/nav'
import { tracksToUnified } from '../utils/unified'
import { normalizeSearchText } from '../utils/searchText'

/** Local view for a credited artist who has no filed library artist yet. */
export default function LocalArtistPage({ name, imagePath }: { name: string; imagePath: string | null }) {
  const t = useT()
  const count = useFormatCount()
  const player = usePlayerActions()
  const [query, setQuery] = useState('')
  useEffect(() => setQuery(''), [name])
  const { navigate } = useNav()
  const { data, loading, error, reload } = useAsync(async () => {
    const tracks = await api.listTracks(name, 2000, 0)
    return tracks.filter(track => track.artistName?.trim().toLowerCase() === name.trim().toLowerCase())
  }, [name])
  const tracks = data ?? []
  const search = normalizeSearchText(query.trim())
  const shownTracks = tracks.filter(track => normalizeSearchText(track.title).includes(search))

  return (
    <EditorialDetailLayout variant="panorama" artworkPath={imagePath} artworkLabel={name} kindIcon={<MicVocal size={13} />} className="local-artist-page" onBack={() => navigate({ name: 'artists' })} backLabel={t('Artists')}
      round art={<Cover path={imagePath} label={name} size={232} />} kind={t('Artist')} title={name}
      meta={<span>{count(tracks.length, 'track')}</span>}
      actions={tracks.length > 0 && <button className="btn btn-primary" onClick={() => player.playTracks(tracksToUnified(tracks), 0)}><Play size={14} />{t('Play all')}</button>}>
      <CollectionTrackHeading count={shownTracks.length} query={query} onQuery={setQuery} />
      {loading && !data ? <div className="muted">{t('Loading…')}</div> : error ? (
        <div><p className="error-line">{error}</p><button className="btn" onClick={reload}>{t('Retry')}</button></div>
      ) : shownTracks.length ? <TrackList showSource tracks={shownTracks} showHeader /> : <EmptyState title={t('No tracks')} hint={t('No saved tracks by this artist yet.')} />}
    </EditorialDetailLayout>
  )
}

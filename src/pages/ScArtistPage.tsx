import { useEffect, useState } from 'react'
import { Check, ExternalLink, MicVocal } from 'lucide-react'
import { api } from '../api/client'
import type { ScArtist, ScPlaylist, ScTrack } from '../types/models'
import ScArtwork from '../components/common/ScArtwork'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import CollectionArtistTabs from '../components/common/CollectionArtistTabs'
import CollectionFavoriteButton from '../components/common/CollectionFavoriteButton'
import CollectionPlayButton from '../components/common/CollectionPlayButton'
import CollectionShuffleButton from '../components/common/CollectionShuffleButton'
import OnlineCollectionTracks from '../components/common/OnlineCollectionTracks'
import BrandIcon from '../components/common/BrandIcon'
import { ScPlaylistCard } from '../components/common/ScCards'
import { toast } from '../components/common/Toast'
import CacheBadge, { CacheProgress } from '../soundcloud/CacheBadge'
import { useNav, type ScArtistFallback } from '../state/nav'
import { usePlayerActions } from '../player'
import { useT } from '../i18n'
import { scTrackToUnified } from '../utils/unified'
import { requestArtistCache } from '../soundcloud/cacheJobs'
import { useScCollectionTracks } from '../soundcloud/useScCollectionTracks'
import { openExternalUrl } from '../utils/externalLinks'
import { canPlaySoundCloudTrack } from '../soundcloud/playability'
import { resolveLocalArtistView } from '../utils/artistNavigation'

const PAGE_LIMIT = 50

export default function ScArtistPage({ artistId, fallback }: { artistId: string; fallback?: ScArtistFallback }) {
  const t = useT()
  const { navigate } = useNav()
  const player = usePlayerActions()
  const [artist, setArtist] = useState<ScArtist | null>(null)
  const [tracks, setTracks] = useState<ScTrack[] | null>(null)
  const [releases, setReleases] = useState<ScPlaylist[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tracksError, setTracksError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState('tracks')
  const fallbackArtistName = fallback?.artistName
  const fallbackImagePath = fallback?.imagePath
  const { rows, play, onMenu, canPlay } = useScCollectionTracks(tracks ?? EMPTY_TRACKS)

  useEffect(() => {
    let cancelled = false
    setArtist(null)
    setTracks(null)
    setReleases([])
    setError(null)
    setTracksError(null)
    setTab('tracks')

    void api.scGetArtist(artistId)
      .then(who => { if (!cancelled) setArtist(who) })
      .catch(async (e: unknown) => {
        if (cancelled) return
        if (fallbackArtistName) {
          const localView = await resolveLocalArtistView(fallbackArtistName, fallbackImagePath ?? null)
          if (!cancelled) navigate(localView)
          return
        }
        setError(e instanceof Error ? e.message : String(e))
      })
    void api.scArtistTracks(artistId, PAGE_LIMIT, 0)
      .then(list => { if (!cancelled) setTracks(list) })
      .catch(e => { if (!cancelled) setTracksError(e instanceof Error ? e.message : String(e)) })
    void api.scArtistPlaylists(artistId, PAGE_LIMIT, 0)
      .then(list => { if (!cancelled) setReleases(list) })
      .catch(() => undefined)

    return () => { cancelled = true }
  }, [artistId, fallbackArtistName, fallbackImagePath, navigate])

  if (error !== null) {
    return (
      <div className="page">
        <div className="error-line">{error}</div>
        <button className="btn" onClick={() => navigate({ name: 'search' })}>{t('Back to search')}</button>
      </div>
    )
  }

  if (!artist) return <div className="page"><div className="muted">{t('Loading…')}</div></div>

  const albums = releases.filter(release => release.isAlbum)
  const playlists = releases.filter(release => !release.isAlbum)
  const tabs = [{ id: 'tracks', label: t('Tracks') }]
  if (albums.length) tabs.push({ id: 'albums', label: t('Albums') })
  if (playlists.length) tabs.push({ id: 'playlists', label: t('Playlists') })

  const keep = async (): Promise<void> => {
    setBusy(true)
    try {
      const outcome = await requestArtistCache(artist, true)
      if (outcome === 'empty') toast.show(t('Nothing to cache for this artist'), 'info')
      else if (outcome === 'started') toast.show(t('Added to favorites'))
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const playRelease = async (release: ScPlaylist) => {
    try {
      const detail = await api.scGetPlaylist(release.id)
      const queue = detail.tracks.filter(canPlaySoundCloudTrack).map(scTrackToUnified)
      if (queue.length) player.playTracks(queue, 0)
      else toast.show(t('No tracks'), 'info')
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const trackList = tracksError ? <div className="error-line">{tracksError}</div> : tracks
    ? <OnlineCollectionTracks tracks={rows} onPlay={play} onMenu={onMenu} />
    : <p className="muted">{t('Loading…')}</p>
  const releaseGrid = (list: ScPlaylist[]) => (
    <section className="collection-discography">
      <div className="collection-album-grid">
        {list.map(release => <ScPlaylistCard key={release.id} playlist={release} editorial onPlay={() => void playRelease(release)} />)}
      </div>
    </section>
  )

  return (
    <EditorialDetailLayout
      className="sc-artist-page"
      variant="panorama"
      artworkLabel={artist.avatarUrl ? artist.username : undefined}
      artworkPath={artist.avatarUrl}
      artworkPreview={<ScArtwork url={artist.avatarUrl} title={artist.username} />}
      artworkGlow={artist.avatarUrl && <ScArtwork url={artist.avatarUrl} title="" loading="lazy" fetchPriority="low" />}
      kindIcon={<MicVocal size={13} />}
      onBack={() => navigate({ name: 'search' })}
      backLabel={t('Back to search')}
      round
      art={
        <CacheBadge kind="artist" scId={artist.id}>
          <ScArtwork url={artist.avatarUrl} title={artist.username} loading="eager" fetchPriority="high" />
        </CacheBadge>
      }
      kind={
        <>
          <span>{t('Artist')}</span>
          <span className="meta-dot">·</span>
          <BrandIcon mark="soundcloud" size={12} brand />
          <span>{t('SoundCloud')}</span>
        </>
      }
      title={artist.username}
      meta={
        <>
          <span>{artist.trackCount} {t('tracks')}</span>
          {artist.verified && <>
            <span className="meta-dot">·</span>
            <span className="sc-verified-line"><Check size={12} />{t('Verified')}</span>
          </>}
        </>
      }
      actions={
        <>
          <CollectionPlayButton disabled={!canPlay} onClick={() => play()} />
          <CollectionFavoriteButton disabled={busy} onClick={() => void keep()} />
          <CollectionShuffleButton disabled={!canPlay} onPlay={play} />
          {artist.permalinkUrl && (
            <button type="button" className="collection-icon-action" title={t('Open on SoundCloud')} aria-label={t('Open on SoundCloud')}
              onClick={() => void openExternalUrl(artist.permalinkUrl ?? '').catch(() => toast.show(t('Could not open external link'), 'error'))}>
              <ExternalLink size={19} />
            </button>
          )}
        </>
      }
    >
      <CacheProgress kind="artist" scId={artist.id} />
      {tabs.length === 1 ? trackList : (
        <CollectionArtistTabs active={tab} onChange={setTab} tabs={tabs}>
          {tab === 'tracks' ? trackList : releaseGrid(tab === 'albums' ? albums : playlists)}
        </CollectionArtistTabs>
      )}
    </EditorialDetailLayout>
  )
}

const EMPTY_TRACKS: ScTrack[] = []

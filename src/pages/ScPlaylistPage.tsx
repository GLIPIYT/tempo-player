import { useEffect, useState } from 'react'
import { Disc3, Download, ExternalLink, ListMusic } from 'lucide-react'
import { api } from '../api/client'
import type { ScPlaylistDetail, ScTrack } from '../types/models'
import ScArtwork from '../components/common/ScArtwork'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import CollectionFavoriteButton from '../components/common/CollectionFavoriteButton'
import CollectionPlayButton from '../components/common/CollectionPlayButton'
import CollectionShuffleButton from '../components/common/CollectionShuffleButton'
import OnlineCollectionTracks from '../components/common/OnlineCollectionTracks'
import BrandIcon from '../components/common/BrandIcon'
import { toast } from '../components/common/Toast'
import CacheBadge, { CacheProgress } from '../soundcloud/CacheBadge'
import { useNav } from '../state/nav'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'
import { favoritePlaylist, requestPlaylistCache, type CacheRequestOutcome } from '../soundcloud/cacheJobs'
import { useScCollectionTracks } from '../soundcloud/useScCollectionTracks'
import { openExternalUrl } from '../utils/externalLinks'

const EMPTY_TRACKS: ScTrack[] = []

/**
 * A SoundCloud playlist or release, read live.
 *
 * Nothing here reaches the library until it is cached or favorited. The cover,
 * cache state, and playback actions stay together above the track list.
 */
export default function ScPlaylistPage({ playlistId }: { playlistId: string }) {
  const t = useT()
  const { navigate } = useNav()
  const [data, setData] = useState<ScPlaylistDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const { rows, play, onMenu, canPlay } = useScCollectionTracks(data?.tracks ?? EMPTY_TRACKS)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .scGetPlaylist(playlistId)
      .then((detail) => {
        if (cancelled) return
        setData(detail)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [playlistId])

  if (loading) {
    return (
      <div className="page">
        <div className="muted">{t('Loading…')}</div>
      </div>
    )
  }

  if (error !== null || !data) {
    return (
      <div className="page">
        <div className="error-line">{error ?? t('Could not load this playlist.')}</div>
        <button className="btn" onClick={() => navigate({ name: 'search' })}>
          {t('Back to search')}
        </button>
      </div>
    )
  }

  const { playlist } = data

  const run = async (action: () => Promise<CacheRequestOutcome>, done?: string) => {
    setBusy(true)
    try {
      const outcome = await action()
      if (outcome === 'empty') toast.show(t('Nothing in this playlist can be cached'), 'info')
      else if (done && outcome === 'started') toast.show(done)
      // 'asked' means the name question is up; that dialog reports its own result
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <EditorialDetailLayout
      className="sc-playlist-page"
      variant="panorama"
      artworkLabel={playlist.artworkUrl ? playlist.title : undefined}
      artworkPath={playlist.artworkUrl}
      artworkPreview={<ScArtwork url={playlist.artworkUrl} title={playlist.title} />}
      artworkGlow={playlist.artworkUrl && <ScArtwork url={playlist.artworkUrl} title="" loading="lazy" fetchPriority="low" />}
      kindIcon={playlist.isAlbum ? <Disc3 size={13} /> : <ListMusic size={13} />}
      onBack={() => navigate({ name: 'search' })}
      backLabel={t('Back to search')}
      art={
        <CacheBadge kind="playlist" scId={playlist.id}>
          <ScArtwork url={playlist.artworkUrl} title={playlist.title} loading="eager" fetchPriority="high" />
        </CacheBadge>
      }
      kind={
        <>
          <span>{playlist.isAlbum ? t('Album') : t('Playlist')}</span>
          <span className="meta-dot">·</span>
          <BrandIcon mark="soundcloud" size={12} brand />
          <span>{t('SoundCloud')}</span>
        </>
      }
      title={playlist.title}
      meta={
        <span>{[playlist.user, `${playlist.trackCount} ${t('tracks')}`, playlist.durationMs > 0 ? fmtTime(playlist.durationMs / 1000) : null].filter(Boolean).join(' · ')}</span>
      }
      actions={
        <>
          <CollectionPlayButton disabled={!canPlay} onClick={() => play()} />
          <CollectionFavoriteButton disabled={busy} onClick={() => void run(() => favoritePlaylist(playlist), t('Added to favorites'))} />
          <CollectionShuffleButton disabled={!canPlay} onPlay={play} />
          <button
            className="btn"
            disabled={busy}
            onClick={() => void run(() => requestPlaylistCache(playlist))}
          >
            <Download size={14} />
            <span>{t('Cache playlist')}</span>
          </button>
          {playlist.permalinkUrl ? (
            <button
              className="collection-icon-action"
              title={t('Open on SoundCloud')}
              aria-label={t('Open on SoundCloud')}
              onClick={() => void openExternalUrl(playlist.permalinkUrl ?? '').catch(() => toast.show(t('Could not open external link'), 'error'))}
            >
              <ExternalLink size={19} />
            </button>
          ) : null}
        </>
      }
    >
      <CacheProgress kind="playlist" scId={playlist.id} />

      <OnlineCollectionTracks key={playlist.id} tracks={rows} onPlay={play} onMenu={onMenu} />
    </EditorialDetailLayout>
  )
}

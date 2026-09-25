import { useEffect, useState } from 'react'
import { Download, ExternalLink, Lock, Play, Star } from 'lucide-react'
import { api } from '../api/client'
import type { ScPlaylistDetail, ScTrack } from '../types/models'
import ScArtwork from '../components/common/ScArtwork'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import BrandIcon from '../components/common/BrandIcon'
import { toast } from '../components/common/Toast'
import CacheBadge, { CacheProgress } from '../soundcloud/CacheBadge'
import { useNav } from '../state/nav'
import { usePlayer } from '../player'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'
import { scTrackToUnified } from '../utils/unified'
import { favoritePlaylist, requestPlaylistCache } from '../soundcloud/cacheJobs'

/**
 * A SoundCloud playlist or release, read live.
 *
 * Nothing here reaches the library until it is cached or favorited. The cover,
 * cache state, and playback actions stay together above the track list.
 */
export default function ScPlaylistPage({ playlistId }: { playlistId: string }) {
  const t = useT()
  const { navigate } = useNav()
  const player = usePlayer()
  const [data, setData] = useState<ScPlaylistDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

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

  const { playlist, tracks } = data
  // A track that is not streamable, or that only offers an encrypted stream,
  // cannot be played - it is listed but not offered.
  const playable = tracks.filter((trk) => trk.streamable && (trk.hasProgressive || trk.hasHls))

  const playFrom = (track: ScTrack): void => {
    const index = playable.findIndex((p) => p.id === track.id)
    if (index >= 0) player.playTracks(playable.map(scTrackToUnified), index)
  }

  const run = async (action: () => Promise<'started' | 'asked' | 'empty'>, done: string) => {
    setBusy(true)
    try {
      const outcome = await action()
      if (outcome === 'empty') toast.show(t('Nothing in this playlist can be cached'), 'info')
      else if (outcome === 'started') toast.show(done)
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
      onBack={() => navigate({ name: 'search' })}
      backLabel={t('Back to search')}
      art={
        <CacheBadge kind="playlist" scId={playlist.id}>
          <ScArtwork url={playlist.artworkUrl} title={playlist.title} />
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
        <span>
          {playlist.user} · {playlist.trackCount} {t('tracks')}
        </span>
      }
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={playable.length === 0}
            onClick={() => playFrom(playable[0] ?? tracks[0])}
          >
            <Play size={14} />
            <span>{t('Play')}</span>
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => void run(() => requestPlaylistCache(playlist), t('Caching started'))}
          >
            <Download size={14} />
            <span>{t('Cache playlist')}</span>
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => void run(() => favoritePlaylist(playlist), t('Added to favorites'))}
          >
            <Star size={14} />
            <span>{t('Add to favorites')}</span>
          </button>
          {playlist.permalinkUrl ? (
            <button
              className="btn"
              onClick={() => window.open(playlist.permalinkUrl ?? '', '_blank')}
            >
              <ExternalLink size={14} />
              <span>{t('Open on SoundCloud')}</span>
            </button>
          ) : null}
        </>
      }
    >
      <CacheProgress kind="playlist" scId={playlist.id} />

      <div className="detail-tracklist-heading sc-tracklist-heading">
        <h2>{t('Tracks')}</h2>
        <span>{playable.length} / {tracks.length}</span>
      </div>
      <div className="sc-list">
        {tracks.map((trk) => {
          const playableHere = trk.streamable && (trk.hasProgressive || trk.hasHls)
          return (
            <div
              key={trk.id}
              className={playableHere ? 'sc-row' : 'sc-row is-disabled'}
              onClick={() => playFrom(trk)}
            >
              <ScArtwork url={trk.artworkUrl} title={trk.title} />
              <div className="sc-meta">
                <span className="sc-title">{trk.title}</span>
                <span className="sc-artist">{trk.artist}</span>
              </div>
              <span className="sc-duration">
                {playableHere ? fmtTime(trk.durationMs / 1000) : <Lock size={13} />}
              </span>
            </div>
          )
        })}
      </div>
    </EditorialDetailLayout>
  )
}

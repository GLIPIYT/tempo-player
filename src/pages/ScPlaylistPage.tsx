import { useEffect, useState } from 'react'
import { ArrowLeft, ExternalLink, Lock, Play } from 'lucide-react'
import { api } from '../api/client'
import type { ScPlaylistDetail, ScTrack } from '../types/models'
import ScArtwork from '../components/common/ScArtwork'
import { useNav } from '../state/nav'
import { usePlayer } from '../player'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'
import { scTrackToUnified } from '../utils/unified'

/**
 * A SoundCloud playlist or release, read live.
 *
 * Nothing here touches the library - this is the look-before-you-keep view.
 * Caching and favouriting will hang off the header actions in a later stage.
 */
export default function ScPlaylistPage({ playlistId }: { playlistId: string }) {
  const t = useT()
  const { navigate } = useNav()
  const player = usePlayer()
  const [data, setData] = useState<ScPlaylistDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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

  return (
    <div className="page">
      <button className="back-link" onClick={() => navigate({ name: 'search' })}>
        <ArrowLeft size={14} />
        <span>{t('Back to search')}</span>
      </button>

      <div className="detail-hero">
        <div className="sc-hero-art">
          <ScArtwork url={playlist.artworkUrl} title={playlist.title} />
        </div>
        <div className="detail-hero-info">
          <div className="section-label">
            {playlist.isAlbum ? t('Album') : t('Playlist')} · {t('SoundCloud')}
          </div>
          <h1 className="detail-title">{playlist.title}</h1>
          <div className="detail-meta">
            {playlist.user} · {playlist.trackCount} {t('tracks')}
          </div>
          <div className="detail-actions">
            <button
              className="btn btn-primary"
              disabled={playable.length === 0}
              onClick={() => playFrom(playable[0] ?? tracks[0])}
            >
              <Play size={14} />
              <span>{t('Play')}</span>
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
          </div>
        </div>
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
    </div>
  )
}

import { useEffect, useState } from 'react'
import { ArrowLeft, Check, ExternalLink, Lock, Play } from 'lucide-react'
import { api } from '../api/client'
import type { ScArtist, ScPlaylist, ScTrack } from '../types/models'
import ScArtwork from '../components/common/ScArtwork'
import { ScPlaylistCard } from '../components/common/ScCards'
import { useNav } from '../state/nav'
import { usePlayer } from '../player'
import { useT } from '../i18n'
import { fmtTime } from '../utils/format'
import { scTrackToUnified } from '../utils/unified'

/** SoundCloud returns a user's tracks in pages; one page is plenty to look at. */
const TRACK_LIMIT = 50

/**
 * A SoundCloud artist, read live.
 *
 * The track list is capped rather than paged: this is a look-before-you-keep
 * view, and the full crawl belongs to the caching flow, where it can report
 * progress instead of blocking the page.
 */
export default function ScArtistPage({ artistId }: { artistId: string }) {
  const t = useT()
  const { navigate } = useNav()
  const player = usePlayer()
  const [artist, setArtist] = useState<ScArtist | null>(null)
  const [tracks, setTracks] = useState<ScTrack[]>([])
  const [releases, setReleases] = useState<ScPlaylist[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      api.scGetArtist(artistId),
      api.scArtistTracks(artistId, TRACK_LIMIT, 0),
      api.scArtistPlaylists(artistId, 50, 0),
    ])
      .then(([who, list, pls]) => {
        if (cancelled) return
        setArtist(who)
        setTracks(list)
        setReleases(pls)
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
  }, [artistId])

  if (loading) {
    return (
      <div className="page">
        <div className="muted">{t('Loading…')}</div>
      </div>
    )
  }

  if (error !== null || !artist) {
    return (
      <div className="page">
        <div className="error-line">{error ?? t('Could not load this artist.')}</div>
        <button className="btn" onClick={() => navigate({ name: 'search' })}>
          {t('Back to search')}
        </button>
      </div>
    )
  }

  const playable = tracks.filter((trk) => trk.streamable && (trk.hasProgressive || trk.hasHls))
  const albums = releases.filter((r) => r.isAlbum)
  const playlists = releases.filter((r) => !r.isAlbum)

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
        <div className="sc-hero-avatar">
          <ScArtwork url={artist.avatarUrl} title={artist.username} />
        </div>
        <div className="detail-hero-info">
          <div className="section-label">{t('Artist')} · {t('SoundCloud')}</div>
          <h1 className="detail-title">
            {artist.username}
            {artist.verified ? <Check size={18} className="sc-verified" /> : null}
          </h1>
          <div className="detail-meta">
            {artist.trackCount} {t('tracks')}
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
            {artist.permalinkUrl ? (
              <button className="btn" onClick={() => window.open(artist.permalinkUrl ?? '', '_blank')}>
                <ExternalLink size={14} />
                <span>{t('Open on SoundCloud')}</span>
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {tracks.length > 0 ? (
        <>
          <div className="section-label">{t('Tracks')}</div>
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
        </>
      ) : null}

      {albums.length > 0 ? (
        <>
          <div className="section-label">{t('Albums')}</div>
          <div className="cards-grid cards-grid-tight">
            {albums.map((al) => (
              <ScPlaylistCard key={al.id} playlist={al} />
            ))}
          </div>
        </>
      ) : null}

      {playlists.length > 0 ? (
        <>
          <div className="section-label">{t('Playlists')}</div>
          <div className="cards-grid cards-grid-tight">
            {playlists.map((pl) => (
              <ScPlaylistCard key={pl.id} playlist={pl} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

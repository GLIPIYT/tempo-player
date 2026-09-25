import { useRef, type MouseEvent, type PointerEvent } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, Play } from 'lucide-react'
import type { Playlist, TopTrackItem, Track } from '../../types/models'
import { useT } from '../../i18n'
import { beginTrackDrag, consumeDragClick } from '../../dnd/trackDrag'
import { isSectionHidden } from '../../utils/hiddenSections'
import { playlistDisplayName } from '../../utils/playlists'
import Cover from '../common/Cover'

type Section = { title: string; id: string; tracks?: Track[] }

interface HomeShelvesProps {
  topTracks: TopTrackItem[]
  recentAdded: Track[]
  recentPlays: Track[]
  dormantTracks: Track[]
  likedTracks: Track[]
  likesPlaylist: Playlist | null
  featuredPlaylists: Playlist[]
  hasPlaylistHistory: boolean
  unknownArtist: string
  onPlay: (tracks: Track[], index: number) => void
  onPlayPlaylist: (playlist: Playlist) => void
  onOpenPlaylist: (playlist: Playlist) => void
  onTrackMenu: (event: MouseEvent, track: Track, tracks: Track[], index: number) => void
  onSectionMenu: (event: MouseEvent, section: Section) => void
}

function startDrag(event: PointerEvent<HTMLButtonElement>, track: Track) {
  beginTrackDrag({ e: event, title: track.title, coverPath: track.coverPath, trackId: track.id, allowButtons: true })
}

interface TrackRailProps {
  title: string
  id: string
  tracks: Track[]
  unknownArtist: string
  caption?: (track: Track) => string
  onOpen?: () => void
  onPlay: (tracks: Track[], index: number) => void
  onTrackMenu: HomeShelvesProps['onTrackMenu']
  onSectionMenu: HomeShelvesProps['onSectionMenu']
}

function TrackRail({ title, id, tracks, unknownArtist, caption, onOpen, onPlay, onTrackMenu, onSectionMenu }: TrackRailProps) {
  const t = useT()
  const railRef = useRef<HTMLDivElement>(null)
  if (tracks.length === 0 || isSectionHidden(id)) return null
  const scroll = (direction: number) => railRef.current?.scrollBy({ left: direction * 460, behavior: 'smooth' })

  return (
    <section className="home-section home-rail-section">
      <div className="home-section-head" onContextMenu={(event) => onSectionMenu(event, { title, id, tracks })}>
        <span className="home-section-title">{title}</span>
        <div className="home-section-tools">
          {onOpen ? <button type="button" className="home-section-open" onClick={onOpen}>{t('Open Likes')} <ArrowUpRight size={14} /></button> : null}
          {tracks.length > 4 ? (
            <div className="home-rail-controls">
              <button type="button" aria-label={t('Scroll left')} onClick={() => scroll(-1)}><ChevronLeft size={15} /></button>
              <button type="button" aria-label={t('Scroll right')} onClick={() => scroll(1)}><ChevronRight size={15} /></button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="home-track-rail" ref={railRef} tabIndex={0} aria-label={title}>
        {tracks.map((track, index) => (
          <button
            key={track.id}
            type="button"
            className="home-rail-track"
            onClick={() => { if (!consumeDragClick()) onPlay(tracks, index) }}
            onPointerDown={(event) => startDrag(event, track)}
            onContextMenu={(event) => onTrackMenu(event, track, tracks, index)}
          >
            <Cover path={track.coverPath} label={track.title} size={118} />
            <strong title={track.title}>{track.title}</strong>
            <small title={caption?.(track) ?? track.artistName ?? unknownArtist}>{caption?.(track) ?? track.artistName ?? unknownArtist}</small>
          </button>
        ))}
      </div>
    </section>
  )
}

export default function HomeShelves({ topTracks, recentAdded, recentPlays, dormantTracks, likedTracks, likesPlaylist, featuredPlaylists, hasPlaylistHistory, unknownArtist, onPlay, onPlayPlaylist, onOpenPlaylist, onTrackMenu, onSectionMenu }: HomeShelvesProps) {
  const t = useT()
  const topList = topTracks.map((item) => item.track)
  const playCounts = new Map(topTracks.map((item) => [item.track.id, item.playCount]))
  const playedVisible = recentPlays.length > 0 && !isSectionHidden('home.played')
  const addedVisible = recentAdded.length > 0 && !isSectionHidden('home.recent')
  const playlistVisible = featuredPlaylists.length > 0 && !isSectionHidden('home.playlists')
  const playlistTitle = t(hasPlaylistHistory ? 'Frequently played playlists' : 'Your playlists')

  return (
    <>
      {playedVisible ? (
        <section className="home-section">
          <div className="home-section-head" onContextMenu={(event) => onSectionMenu(event, { title: t('Recently played'), id: 'home.played', tracks: recentPlays })}>
            <span className="home-section-title">{t('Listened recently')}</span>
          </div>
          <div className="home-return-grid" tabIndex={0} aria-label={t('Listened recently')}>
            {recentPlays.map((track, index) => (
              <button key={track.id} type="button" className="home-return-card" onClick={() => { if (!consumeDragClick()) onPlay(recentPlays, index) }} onPointerDown={(event) => startDrag(event, track)} onContextMenu={(event) => onTrackMenu(event, track, recentPlays, index)}>
                <Cover path={track.coverPath} label={track.title} size={160} />
                <span><strong>{track.title}</strong><small>{track.artistName ?? unknownArtist}</small></span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="home-content-grid">
        <div className="home-content-main">
          <TrackRail title={t('Most played')} id="home.top" tracks={topList} caption={(track) => `${track.artistName ?? unknownArtist} · ${playCounts.get(track.id) ?? 0} ${t('plays')}`} unknownArtist={unknownArtist} onPlay={onPlay} onTrackMenu={onTrackMenu} onSectionMenu={onSectionMenu} />
          <TrackRail title={t('Long time no listen')} id="home.dormant" tracks={dormantTracks} unknownArtist={unknownArtist} onPlay={onPlay} onTrackMenu={onTrackMenu} onSectionMenu={onSectionMenu} />
          <TrackRail title={t('Likes')} id="home.likes" tracks={likedTracks} unknownArtist={unknownArtist} onOpen={likesPlaylist ? () => onOpenPlaylist(likesPlaylist) : undefined} onPlay={onPlay} onTrackMenu={onTrackMenu} onSectionMenu={onSectionMenu} />
        </div>
        <div className="home-content-side">
          {addedVisible ? (
            <section className="home-section home-recent-section">
              <div className="home-section-head" onContextMenu={(event) => onSectionMenu(event, { title: t('Recently added'), id: 'home.recent', tracks: recentAdded })}>
                <span className="home-section-title">{t('Recently added')}</span>
              </div>
              <div className="home-new-list">
                {recentAdded.slice(0, 10).map((track, index) => (
                  <button key={track.id} type="button" className="home-new-track" onClick={() => { if (!consumeDragClick()) onPlay(recentAdded, index) }} onPointerDown={(event) => startDrag(event, track)} onContextMenu={(event) => onTrackMenu(event, track, recentAdded, index)}>
                    <Cover path={track.coverPath} label={track.title} size={40} />
                    <span><strong>{track.title}</strong><small>{track.artistName ?? unknownArtist}</small></span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {playlistVisible ? (
            <section className="home-section home-playlist-section">
              <div className="home-section-head" onContextMenu={(event) => onSectionMenu(event, { title: playlistTitle, id: 'home.playlists' })}>
                <span className="home-section-title">{playlistTitle}</span>
              </div>
              <div className="home-playlist-list">
                {featuredPlaylists.map((playlist) => (
                  <div key={playlist.id} className="home-playlist-card" onContextMenu={(event) => onSectionMenu(event, { title: playlistTitle, id: 'home.playlists' })}>
                    <button type="button" className="home-playlist-open" onClick={() => onOpenPlaylist(playlist)}>
                      <Cover path={playlist.coverPath} label={playlist.name} size={45} />
                      <span><strong>{playlistDisplayName(playlist, playlist.name, t)}</strong><small>{playlist.trackCount} {t('tracks')}</small></span>
                    </button>
                    <button type="button" className="home-playlist-play" aria-label={`${t('Play all')}: ${playlist.name}`} onClick={() => onPlayPlaylist(playlist)}><Play size={16} fill="currentColor" /></button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </>
  )
}

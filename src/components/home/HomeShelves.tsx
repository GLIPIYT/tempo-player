import { useMemo, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, Clock3, ListMusic, Play } from 'lucide-react'
import type { Playlist, TopTrackItem, Track } from '../../types/models'
import { useT } from '../../i18n'
import { beginTrackDrag, consumeDragClick } from '../../dnd/trackDrag'
import { isSectionHidden } from '../../utils/hiddenSections'
import { playlistDisplayName } from '../../utils/playlists'
import { fmtTime } from '../../utils/format'
import Cover from '../common/Cover'
import { HOME_RAIL_CARD_SIZE, HOME_RAIL_GAP, HOME_RAIL_STEP, homeRailLayout, onHomeRailKeyDown, scrollHomeRail, useRecommendationRail } from './useRecommendationRail'

type Section = { title: string; id: string; tracks?: Track[] }

interface HomeShelvesProps {
  topTracks: TopTrackItem[]
  recentAdded: Track[]
  recentPlays: Track[]
  likedTracks: Track[]
  likesPlaylist: Playlist | null
  featuredPlaylists: Playlist[]
  recommendations?: ReactNode
  hasPlaylistHistory: boolean
  unknownArtist: string
  onPlay: (tracks: Track[], index: number) => void
  onPlayPlaylist: (playlist: Playlist) => void
  onOpenPlaylist: (playlist: Playlist) => void
  onTrackMenu: (event: MouseEvent, track: Track, tracks: Track[], index: number) => void
  onSectionMenu: (event: MouseEvent, section: Section) => void
}

function startDrag(event: PointerEvent<HTMLButtonElement>, track: Track, scrollRail?: HTMLDivElement | null) {
  beginTrackDrag({ e: event, title: track.title, coverPath: track.coverPath, trackId: track.id, sourceTrack: track, allowButtons: true, scrollRail })
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
  const visible = tracks.length > 0 && !isSectionHidden(id)
  const { ref, start, end, canScrollLeft, canScrollRight } = useRecommendationRail(visible ? tracks.length : 0)
  if (!visible) return null

  return (
    <section className="home-section home-rail-section" aria-label={title}>
      <div className="home-section-head" onContextMenu={(event) => onSectionMenu(event, { title, id, tracks })}>
        <span className="home-section-title">{title}</span>
        <div className="home-section-tools">
          {onOpen ? <button type="button" className="home-section-open" onClick={onOpen}>{t('Open Likes')} <ArrowUpRight size={14} /></button> : null}
          <div className="home-rail-controls">
            <button type="button" aria-label={t('Play all')} title={t('Play all')} onClick={() => onPlay(tracks, 0)}><Play size={13} /></button>
            {(canScrollLeft || canScrollRight) && <>
              <button type="button" aria-label={t('Scroll left')} disabled={!canScrollLeft} onClick={() => scrollHomeRail(ref.current, -1)}><ChevronLeft size={15} /></button>
              <button type="button" aria-label={t('Scroll right')} disabled={!canScrollRight} onClick={() => scrollHomeRail(ref.current, 1)}><ChevronRight size={15} /></button>
            </>}
          </div>
        </div>
      </div>
      <div className="home-track-rail" ref={ref} tabIndex={0} aria-label={title} onKeyDown={onHomeRailKeyDown} style={homeRailLayout}>
        <div className="home-rail-row" style={{ width: tracks.length * HOME_RAIL_STEP - HOME_RAIL_GAP, paddingInlineStart: start * HOME_RAIL_STEP }}>
          {tracks.slice(start, end).map((track, offset) => {
            const index = start + offset
            const subtitle = caption?.(track) ?? track.artistName ?? unknownArtist
            return (
              <button
                key={track.id}
                type="button"
                className="home-rail-track"
                onClick={() => { if (!consumeDragClick()) onPlay(tracks, index) }}
                onPointerDown={(event) => startDrag(event, track, ref.current)}
                onContextMenu={(event) => onTrackMenu(event, track, tracks, index)}
              >
                <Cover path={track.coverPath} label={track.title} size={HOME_RAIL_CARD_SIZE} />
                <strong title={track.title}>{track.title}</strong>
                <small title={subtitle}>{subtitle}</small>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export default function HomeShelves({ topTracks, recentAdded, recentPlays, likedTracks, likesPlaylist, featuredPlaylists, recommendations, hasPlaylistHistory, unknownArtist, onPlay, onPlayPlaylist, onOpenPlaylist, onTrackMenu, onSectionMenu }: HomeShelvesProps) {
  const t = useT()
  const topList = useMemo(() => topTracks.map((item) => item.track), [topTracks])
  const playCounts = useMemo(() => new Map(topTracks.map((item) => [item.track.id, item.playCount])), [topTracks])
  const addedVisible = recentAdded.length > 0 && !isSectionHidden('home.recent')
  const playlistVisible = featuredPlaylists.length > 0 && !isSectionHidden('home.playlists')
  const playlistTitle = t(hasPlaylistHistory ? 'Frequently played playlists' : 'Your playlists')
  const trackActions = { unknownArtist, onPlay, onTrackMenu, onSectionMenu }

  return (
    <>
      <div className={`home-content-grid${recommendations && (addedVisible || playlistVisible) ? ' has-two-columns' : ''}`}>
        {recommendations && <div className="home-content-main">{recommendations}</div>}
        {(addedVisible || playlistVisible) && <div className="home-content-side">
          {addedVisible ? (
            <section className="home-section home-recent-section" aria-label={t('Recently added')}>
              <div className="home-section-head" onContextMenu={(event) => onSectionMenu(event, { title: t('Recently added'), id: 'home.recent', tracks: recentAdded })}>
                <span className="home-section-title">{t('Recently added')}</span><Clock3 size={15} />
              </div>
              <div className="home-new-list">
                {recentAdded.map((track, index) => (
                  <button key={track.id} type="button" className="home-new-track" onClick={() => { if (!consumeDragClick()) onPlay(recentAdded, index) }} onPointerDown={(event) => startDrag(event, track)} onContextMenu={(event) => onTrackMenu(event, track, recentAdded, index)}>
                    <Cover path={track.coverPath} label={track.title} size={33} />
                    <span><strong>{track.title}</strong><small>{track.artistName ?? unknownArtist}</small></span>
                    <small className="home-new-track-duration">{fmtTime(track.durationSec)}</small>
                    <Play size={13} className="home-new-track-play" />
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {playlistVisible ? (
            <section className="home-section home-playlist-section" aria-label={playlistTitle}>
              <div className="home-section-head" onContextMenu={(event) => onSectionMenu(event, { title: playlistTitle, id: 'home.playlists' })}>
                <span className="home-section-title">{playlistTitle}</span><ListMusic size={15} />
              </div>
              <div className="home-playlist-list">
                {featuredPlaylists.map((playlist) => (
                  <div key={playlist.id} className="home-playlist-card" onContextMenu={(event) => onSectionMenu(event, { title: playlistTitle, id: 'home.playlists' })}>
                    <button type="button" className="home-playlist-open" onClick={() => onOpenPlaylist(playlist)}>
                      <Cover path={playlist.coverPath} label={playlist.name} size={33} />
                      <span><strong>{playlistDisplayName(playlist, playlist.name, t)}</strong><small>{playlist.trackCount} {t('tracks')}</small></span>
                    </button>
                    <button type="button" className="home-playlist-play" aria-label={`${t('Play all')}: ${playlist.name}`} onClick={() => onPlayPlaylist(playlist)}><Play size={16} fill="currentColor" /></button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>}
      </div>
      <div className="home-library-shelves">
        <TrackRail title={t('Listened recently')} id="home.played" tracks={recentPlays} {...trackActions} />
        <TrackRail title={t('Most played')} id="home.top" tracks={topList}
          caption={(track) => `${track.artistName ?? unknownArtist} · ${playCounts.get(track.id) ?? 0} ${t('plays')}`} {...trackActions} />
        <TrackRail title={t('Likes')} id="home.likes" tracks={likedTracks}
          onOpen={likesPlaylist ? () => onOpenPlaylist(likesPlaylist) : undefined} {...trackActions} />
      </div>
    </>
  )
}

import { useState, type MouseEvent, type PointerEvent } from 'react'
import { ChevronDown, Play } from 'lucide-react'
import type { TopTrackItem, Track } from '../../types/models'
import { useT } from '../../i18n'
import { beginTrackDrag, consumeDragClick } from '../../dnd/trackDrag'
import { isSectionHidden } from '../../utils/hiddenSections'
import Cover from '../common/Cover'

interface HomeShelvesProps {
  topTracks: TopTrackItem[]
  recentAdded: Track[]
  recentPlays: Track[]
  unknownArtist: string
  onPlay: (tracks: Track[], index: number) => void
  onTrackMenu: (event: MouseEvent, track: Track, tracks: Track[], index: number) => void
  onSectionMenu: (event: MouseEvent, section: { title: string; id: string; tracks: Track[] }) => void
}

export default function HomeShelves({
  topTracks,
  recentAdded,
  recentPlays,
  unknownArtist,
  onPlay,
  onTrackMenu,
  onSectionMenu,
}: HomeShelvesProps) {
  const t = useT()
  const [showAllPlayed, setShowAllPlayed] = useState(false)
  const [showAllTop, setShowAllTop] = useState(false)
  const [showAllAdded, setShowAllAdded] = useState(false)
  const topList = topTracks.map((item) => item.track)
  const playedVisible = recentPlays.length > 0 && !isSectionHidden('home.played')
  const topVisible = topTracks.length > 0 && !isSectionHidden('home.top')
  const addedVisible = recentAdded.length > 0 && !isSectionHidden('home.recent')

  const startDrag = (event: PointerEvent<HTMLButtonElement>, track: Track) => {
    beginTrackDrag({
      e: event,
      title: track.title,
      coverPath: track.coverPath,
      trackId: track.id,
      allowButtons: true,
    })
  }

  const playIfNotDragged = (tracks: Track[], index: number) => {
    if (!consumeDragClick()) onPlay(tracks, index)
  }

  return (
    <>
      {playedVisible ? (
        <section className="home-section">
          <div
            className="home-section-head"
            onContextMenu={(event) => onSectionMenu(event, { title: t('Recently played'), id: 'home.played', tracks: recentPlays })}
          >
            <span className="home-section-title">{t('Listened recently')}</span>
            {recentPlays.length > 3 ? (
              <button type="button" className="home-section-more" onClick={() => setShowAllPlayed((value) => !value)}>
                {t(showAllPlayed ? 'Show less' : 'Show all')}
                <ChevronDown size={14} className={showAllPlayed ? 'is-open' : undefined} />
              </button>
            ) : null}
          </div>
          <div className="home-return-grid">
            {recentPlays.slice(0, showAllPlayed ? recentPlays.length : 3).map((track, index) => (
              <button
                key={track.id}
                type="button"
                className="home-return-card"
                onClick={() => playIfNotDragged(recentPlays, index)}
                onPointerDown={(event) => startDrag(event, track)}
                onContextMenu={(event) => onTrackMenu(event, track, recentPlays, index)}
              >
                <Cover path={track.coverPath} label={track.title} size={54} />
                <span><strong>{track.title}</strong><small>{track.artistName ?? unknownArtist}</small></span>
                <Play size={15} />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {topVisible || addedVisible ? (
        <div className={`home-lower-grid${topVisible && addedVisible ? '' : ' is-single'}`}>
          {topVisible ? (
            <section className="home-section">
              <div
                className="home-section-head"
                onContextMenu={(event) => onSectionMenu(event, { title: t('Most played'), id: 'home.top', tracks: topList })}
              >
                <span className="home-section-title">{t('Most played')}</span>
                {topTracks.length > 4 ? (
                  <button type="button" className="home-section-more" onClick={() => setShowAllTop((value) => !value)}>
                    {t(showAllTop ? 'Show less' : 'Show all')}
                    <ChevronDown size={14} className={showAllTop ? 'is-open' : undefined} />
                  </button>
                ) : null}
              </div>
              <div className="home-favorites-grid">
                {topTracks.slice(0, showAllTop ? topTracks.length : 4).map((item, index) => (
                  <button
                    key={item.track.id}
                    type="button"
                    className="home-favorite-card"
                    onClick={() => playIfNotDragged(topList, index)}
                    onPointerDown={(event) => startDrag(event, item.track)}
                    onContextMenu={(event) => onTrackMenu(event, item.track, topList, index)}
                  >
                    <Cover path={item.track.coverPath} label={item.track.title} size={150} />
                    <strong>{item.track.title}</strong>
                    <small>{item.track.artistName ?? unknownArtist} · {item.playCount} {t('plays')}</small>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {addedVisible ? (
            <section className="home-section">
              <div
                className="home-section-head"
                onContextMenu={(event) => onSectionMenu(event, { title: t('Recently added'), id: 'home.recent', tracks: recentAdded })}
              >
                <span className="home-section-title">{t('Recently added')}</span>
                {recentAdded.length > 4 ? (
                  <button type="button" className="home-section-more" onClick={() => setShowAllAdded((value) => !value)}>
                    {t(showAllAdded ? 'Show less' : 'Show all')}
                    <ChevronDown size={14} className={showAllAdded ? 'is-open' : undefined} />
                  </button>
                ) : null}
              </div>
              <div className="home-new-list">
                {recentAdded.slice(0, showAllAdded ? recentAdded.length : 4).map((track, index) => (
                  <button
                    key={track.id}
                    type="button"
                    className="home-new-track"
                    onClick={() => playIfNotDragged(recentAdded, index)}
                    onPointerDown={(event) => startDrag(event, track)}
                    onContextMenu={(event) => onTrackMenu(event, track, recentAdded, index)}
                  >
                    <Cover path={track.coverPath} label={track.title} size={40} />
                    <span><strong>{track.title}</strong><small>{track.artistName ?? unknownArtist}</small></span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

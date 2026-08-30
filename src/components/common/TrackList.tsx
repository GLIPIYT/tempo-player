import { Play } from 'lucide-react'
import type { Track } from '../../types/models'
import { usePlayer } from '../../player'
import { useT } from '../../i18n'
import { fmtTime } from '../../utils/format'
import { trackToUnified } from '../../utils/unified'
import Cover from './Cover'
import TrackMenu from './TrackMenu'

interface TrackListProps {
  tracks: Track[]
  showAlbum?: boolean
  showIndex?: boolean
  onPlayAt?: (index: number) => void
}

export default function TrackList({ tracks, showAlbum = true, showIndex = true, onPlayAt }: TrackListProps) {
  const t = useT()
  const player = usePlayer()

  const playAt = (index: number) => {
    if (onPlayAt) onPlayAt(index)
    else player.playTracks(tracks.map((t) => trackToUnified(t)), index)
  }

  const playAria = t('Play')
  const unknownArtist = t('Unknown artist')

  const cls = ['tl']
  if (!showAlbum) cls.push('tl-noalbum')
  if (!showIndex) cls.push('tl-noindex')

  return (
    <div className={cls.join(' ')}>
      {tracks.map((t, i) => {
        const playing = player.currentTrack?.sourceId === String(t.id)
        return (
          <div
            key={t.id}
            className={'tl-row' + (playing ? ' is-playing' : '')}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData('application/x-tempo-track', String(t.id))
            }}
            onDoubleClick={() => playAt(i)}
          >
            {showIndex ? (
              <div className="tl-index">
                <span className="tl-num">{i + 1}</span>
                <span className="tl-eq" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <button
                  className="tl-play"
                  aria-label={`${playAria} ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    playAt(i)
                  }}
                >
                  <Play size={13} />
                </button>
              </div>
            ) : null}
            <div className="tl-main">
              <Cover path={t.coverPath} label={t.title} size={30} />
              <div className="tl-meta">
                <span className="tl-title">{t.title}</span>
                <span className="tl-artist">{t.artistName ?? unknownArtist}</span>
              </div>
            </div>
            {showAlbum ? <div className="tl-album">{t.albumTitle ?? '—'}</div> : null}
            <div className="tl-duration">{fmtTime(t.durationSec)}</div>
            <TrackMenu track={t} tracks={tracks} index={i} />
          </div>
        )
      })}
    </div>
  )
}

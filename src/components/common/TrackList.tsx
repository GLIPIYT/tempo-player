import { useRef } from 'react'
import { Play } from 'lucide-react'
import type { Track } from '../../types/models'
import { usePlayer } from '../../player'
import { useT } from '../../i18n'
import { fmtTime } from '../../utils/format'
import { trackToUnified } from '../../utils/unified'
import { beginTrackDrag } from '../../dnd/trackDrag'
import Cover from './Cover'
import TrackMenu from './TrackMenu'
import type { TrackMenuHandle } from './TrackMenu'

interface TrackListProps {
  tracks: Track[]
  showAlbum?: boolean
  showIndex?: boolean
  onPlayAt?: (index: number) => void
}

export default function TrackList({ tracks, showAlbum = true, showIndex = true, onPlayAt }: TrackListProps) {
  const t = useT()
  const player = usePlayer()
  // one handle per rendered row, so right-clicking a row opens that row's menu
  const menus = useRef(new Map<number, TrackMenuHandle | null>())

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
            onPointerDown={(e) => {
              if (e.button !== 0) return
              beginTrackDrag({
                e,
                title: t.title,
                coverPath: t.coverPath,
                trackId: t.id,
              })
            }}
            onDoubleClick={() => playAt(i)}
            onContextMenu={(e) => {
              const handle = menus.current.get(t.id)
              if (!handle) return
              e.preventDefault()
              handle.open()
            }}
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
            <TrackMenu
              ref={(h) => {
                if (h) menus.current.set(t.id, h)
                else menus.current.delete(t.id)
              }}
              track={t}
              tracks={tracks}
              index={i}
            />
          </div>
        )
      })}
    </div>
  )
}

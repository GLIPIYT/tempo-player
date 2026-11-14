import { useMemo, useState } from 'react'
import { Ellipsis, Lock, Music2, Play } from 'lucide-react'
import { useT } from '../../i18n'
import { usePlayerField } from '../../player'
import CacheBadge from '../../soundcloud/CacheBadge'
import type { UnifiedTrack } from '../../types/models'
import { fmtTime } from '../../utils/format'
import { normalizeSearchText } from '../../utils/searchText'
import { CollectionTrackHeading } from './CollectionCatalog'
import CollectionTrackTableHeader from './CollectionTrackTableHeader'
import type { ContextMenuRequest } from './ContextMenu'
import EmptyState from './EmptyState'
import ScArtwork from './ScArtwork'
import TrackSourceIcon from './TrackSourceIcon'

export type OnlineCollectionTrack = Pick<UnifiedTrack,
  'source' | 'sourceId' | 'title' | 'artists' | 'album' | 'durationSec' | 'coverPath' | 'playable'>

export default function OnlineCollectionTracks({ tracks, onPlay, onMenu }: {
  tracks: readonly OnlineCollectionTrack[]
  onPlay: (index: number) => void
  onMenu: (point: Pick<ContextMenuRequest, 'x' | 'y' | 'trigger'>, index: number) => void
}) {
  const t = useT()
  const current = usePlayerField('currentTrack')
  const [query, setQuery] = useState('')
  const showAlbum = tracks.some(track => Boolean(track.album))
  const term = normalizeSearchText(query.trim())
  const shown = useMemo(() => tracks.flatMap((track, index) =>
    !term || normalizeSearchText([track.title, ...track.artists, track.album].join(' ')).includes(term)
      ? [{ track, index }] : [],
  ), [tracks, term])

  return (
    <section>
      <CollectionTrackHeading count={shown.length} query={query} onQuery={setQuery} />
      {shown.length === 0 ? (
        <EmptyState icon={<Music2 size={26} />} title={t(term ? 'No tracks found' : 'No tracks')} />
      ) : (
        <div className={`tl tl-has-header collection-online-tracks${showAlbum ? '' : ' tl-noalbum'}`}>
          <CollectionTrackTableHeader showAlbum={showAlbum} />
          {shown.map(({ track, index }) => {
            const playing = current?.source === track.source && current.sourceId === track.sourceId
            const artwork = <ScArtwork url={track.coverPath} title={track.title} compact loading="lazy" />
            return (
              <div
                key={`${track.sourceId}:${index}`}
                className={`tl-row${playing ? ' is-playing' : ''}${track.playable ? '' : ' is-unavailable'}`}
                onClick={track.playable ? () => onPlay(index) : undefined}
                onContextMenu={event => {
                  event.preventDefault()
                  onMenu({ x: event.clientX, y: event.clientY }, index)
                }}
              >
                <div className="tl-index">
                  <span className="tl-num">{index + 1}</span>
                  <span className="tl-eq" aria-hidden="true"><i /><i /><i /></span>
                  {track.playable && <button type="button" className="tl-play" aria-label={`${t('Play')} ${track.title}`} onClick={event => {
                    event.stopPropagation()
                    onPlay(index)
                  }}><Play size={13} /></button>}
                </div>
                <div className="tl-main">
                  <span className="collection-online-track-art">
                    {track.source === 'soundcloud' ? <CacheBadge kind="track" scId={track.sourceId}>{artwork}</CacheBadge> : artwork}
                  </span>
                  <div className="tl-meta">
                    <span className="tl-title">{track.title}</span>
                    <span className="tl-artist">
                      <span className="tl-artist-name">{track.artists.join(', ') || t('Unknown artist')}</span>
                      <TrackSourceIcon source={track.source} />
                    </span>
                  </div>
                </div>
                {showAlbum && <div className="tl-album">{track.album ?? '—'}</div>}
                <div className="tl-duration">{track.playable ? fmtTime(track.durationSec) : <Lock size={13} aria-label={t('Unavailable')} />}</div>
                <button type="button" className="tm-btn" aria-label={`${t('More actions')}: ${track.title}`} onClick={event => {
                  event.stopPropagation()
                  const bounds = event.currentTarget.getBoundingClientRect()
                  onMenu({ x: bounds.left, y: bounds.bottom, trigger: event.currentTarget }, index)
                }}>
                  <Ellipsis size={16} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

import { memo, useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { ListeningPeriodTopTrack, SourceId, Track } from '../../types/models'
import Cover from '../../components/common/Cover'
import { useT } from '../../i18n'
import { historyHours } from './period'

function SourceIcon({ source }: { source: SourceId }) {
  const label = source === 'soundcloud' ? 'SoundCloud' : source === 'youtube' ? 'YouTube Music' : 'Local file'
  const t = useT()
  return <span className="history-track-source" data-source={source} title={t(label)}>
    {source === 'local' ? <FolderOpen size={13} role="img" aria-label={t(label)} />
      : <svg viewBox="0 0 24 24" width="13" height="13" role="img" aria-label={label} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {source === 'youtube' ? <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="7" /><path d="m10 8 6 4-6 4Z" fill="currentColor" stroke="none" /></>
          : <><path d="M11 18h8a4 4 0 0 0 .1-8A6 6 0 0 0 9 8v10" /><path d="M6 10v8M3 12v6M.5 14v3" /></>}
      </svg>}
  </span>
}

interface TrackSlideProps {
  minutes: boolean
  lang: 'ru' | 'en'
  onTrack: (track: Track) => void
}

function TrackSlide({ entry, outgoing, entering, lang, minutes, onTrack }: TrackSlideProps & {
  entry: ListeningPeriodTopTrack; outgoing?: boolean; entering?: boolean
}) {
  const t = useT()
  return <button type="button"
    className={`history-featured-track history-track-slide${outgoing ? ' is-leaving' : entering ? ' is-entering' : ''}`}
    aria-hidden={outgoing || undefined} tabIndex={outgoing ? -1 : undefined}
    onClick={() => onTrack(entry.track)}>
    <span className="history-track-art"><Cover path={entry.track.coverPath} label={entry.track.title} size={54}
      youtubeVideoId={entry.track.source === 'youtube' ? entry.track.externalId : undefined} /></span>
    <span className="history-track-copy">
      <span className="history-track-title"><strong>{entry.track.title}</strong><SourceIcon source={entry.track.source} /></span>
      <small>{entry.track.artistName ?? t('Unknown artist')}</small>
      <em>{minutes ? (entry.listenedSec / 60).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 2 }) : historyHours(entry.listenedSec, lang)} {minutes ? t('Minutes') : lang === 'ru' ? 'ч' : 'h'} · {entry.playCount} {t('plays')}</em>
    </span>
  </button>
}

function featuredPools<T>(tracks: readonly T[], paired: boolean): readonly (readonly T[])[] {
  if (!paired || tracks.length < 2) return [tracks.slice(0, 3)]
  if (tracks.length === 2) return [[tracks[0]], [tracks[1]]]
  // The shorter pair shares a loop so the third track can move into the first slot.
  if (tracks.length === 3) return [[tracks[0], tracks[2], tracks[1]], [tracks[2], tracks[1], tracks[0]]]
  const ranked = tracks.slice(0, 6)
  return [ranked.filter((_, index) => index % 2 === 0), ranked.filter((_, index) => index % 2 === 1)]
}

export const FeaturedTracks = memo(function FeaturedTracks({ tracks, paired = false, ...props }: TrackSlideProps & {
  tracks: readonly ListeningPeriodTopTrack[]; paired?: boolean
}) {
  const t = useT()
  const [rotation, setRotation] = useState({ step: 0, transitioning: false })
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const pools = featuredPools(tracks, paired)
  const rotating = pools.some(pool => pool.length > 1)
  useEffect(() => {
    if (!rotating || hovered || focused) return
    const timer = window.setInterval(() => {
      if (!document.hidden) setRotation(old => ({ step: old.step + 1, transitioning: true }))
    }, 3000)
    return () => window.clearInterval(timer)
  }, [rotating, hovered, focused])
  useEffect(() => {
    if (!rotation.transitioning) return
    const timer = window.setTimeout(() => setRotation(old => ({ ...old, transitioning: false })), 420)
    return () => window.clearTimeout(timer)
  }, [rotation.step, rotation.transitioning])
  return pools.map((pool, slot) => {
    const current = pool[rotation.step % pool.length]
    const previous = rotation.transitioning && pool.length > 1 ? pool[(rotation.step - 1) % pool.length] : undefined
    return <div className="history-favorite" key={slot}>
      <span className="history-favorite-label">{t(slot ? 'More most-listened tracks' : 'Most-listened track')}</span>
      <div className="history-track-rotation" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}>
        {previous && <TrackSlide key={previous.track.id} entry={previous} outgoing {...props} />}
        {current ? <TrackSlide key={current.track.id} entry={current} entering={Boolean(previous)} {...props} /> : <span className="muted">—</span>}
      </div>
    </div>
  })
})

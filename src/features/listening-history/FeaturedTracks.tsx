import { memo, useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { ListeningPeriodTopTrack, SourceId } from '../../types/models'
import Cover from '../../components/common/Cover'
import { playerController } from '../../player/controller'
import { trackToUnified } from '../../utils/unified'
import { useT } from '../../i18n'
import { historyHours } from './period'

function SourceIcon({ source }: { source: SourceId }) {
  const label = source === 'soundcloud' ? 'SoundCloud' : source === 'youtube' ? 'YouTube Music' : 'Local file'
  const t = useT()
  return <span className="history-track-source" title={t(label)}>
    {source === 'local' ? <FolderOpen size={13} role="img" aria-label={t(label)} />
      : <svg viewBox="0 0 24 24" width="13" height="13" role="img" aria-label={label} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {source === 'youtube' ? <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="7" /><path d="m10 8 6 4-6 4Z" fill="currentColor" stroke="none" /></>
          : <><path d="M11 18h8a4 4 0 0 0 .1-8A6 6 0 0 0 9 8v10" /><path d="M6 10v8M3 12v6M.5 14v3" /></>}
      </svg>}
  </span>
}

export const FeaturedTracks = memo(function FeaturedTracks({ tracks, lang }: { tracks: readonly ListeningPeriodTopTrack[]; lang: 'ru' | 'en' }) {
  const t = useT()
  const [rotation, setRotation] = useState({ index: 0, previous: -1 })
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (tracks.length < 2 || hovered || focused) return
    const timer = window.setInterval(() => {
      if (!document.hidden) setRotation(old => ({ previous: old.index, index: (old.index + 1) % tracks.length }))
    }, 3000)
    return () => clearInterval(timer)
  }, [tracks.length, hovered, focused])
  useEffect(() => {
    if (rotation.previous < 0) return
    const timer = window.setTimeout(() => setRotation(old => ({ ...old, previous: -1 })), 420)
    return () => clearTimeout(timer)
  }, [rotation.previous, rotation.index])
  const current = tracks[rotation.index % Math.max(1, tracks.length)]
  const previous = tracks[rotation.previous]
  if (!current) return <span className="muted">—</span>
  const item = (entry: ListeningPeriodTopTrack, outgoing: boolean) => <button key={entry.track.id} type="button"
    className={`history-featured-track history-track-slide${outgoing ? ' is-leaving' : rotation.previous >= 0 ? ' is-entering' : ''}`}
    aria-hidden={outgoing || undefined} tabIndex={outgoing ? -1 : undefined}
    onClick={() => playerController.playTracks(tracks.map(entry => trackToUnified(entry.track)), tracks.indexOf(entry))}>
    <span className="history-track-art"><Cover path={entry.track.coverPath} label={entry.track.title} size={54} /></span>
    <span className="history-track-copy">
      <span className="history-track-title"><strong>{entry.track.title}</strong><SourceIcon source={entry.track.source} /></span>
      <small>{entry.track.artistName ?? t('Unknown artist')}</small>
      <em>{historyHours(entry.listenedSec, lang)} {lang === 'ru' ? 'ч' : 'h'} · {entry.playCount} {t('plays')}</em>
    </span>
  </button>
  return <div className="history-track-rotation" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}>
    {previous && item(previous, true)}
    {item(current, false)}
  </div>
})

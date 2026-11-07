import { useEffect, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { ArrowLeft, AudioLines, Clock3, Cloud, Disc3, FileMusic, Gauge, Layers, Maximize2, Tags } from 'lucide-react'
import ArtworkView from '../components/artwork-view/ArtworkView'
import ArtistLinks from '../components/common/ArtistLinks'
import Cover from '../components/common/Cover'
import WaveProgress from '../components/common/WaveProgress'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { useDisplayPosition } from '../player/useDisplayPosition'
import type { UnifiedTrack } from '../types/models'
import { fmtTime } from '../utils/format'
import './track-detail-page.css'

const trackKey = (track: UnifiedTrack | null) => track ? `${track.source}:${track.sourceId}` : null

function TrackFacts({ track, duration, exiting = false }: { track: UnifiedTrack; duration: number | null; exiting?: boolean }) {
  const t = useT()
  const source = track.source === 'local' ? t('Local files') : track.source === 'soundcloud' ? 'SoundCloud' : 'YouTube Music'
  const bpm = track.traits?.bpm
  const fields = [
    { label: t('Album'), value: track.album?.trim(), icon: Disc3 },
    { label: t('Genre'), value: track.traits?.genre?.trim(), icon: AudioLines },
    { label: 'BPM', value: bpm != null && Number.isFinite(bpm) && bpm > 0 ? String(bpm) : null, icon: Gauge },
    { label: t('Version'), value: track.traits?.version?.trim(), icon: Layers },
    { label: t('Duration'), value: duration != null && duration > 0 ? fmtTime(duration) : null, icon: Clock3 },
    { label: t('Source'), value: source, icon: track.source === 'local' ? FileMusic : Cloud },
    { label: t('Tags'), value: track.traits?.tags?.map(tag => tag.trim()).filter(Boolean).join(', '), icon: Tags },
  ].filter(({ value }) => value)

  return (
    <dl className={`track-page-facts${exiting ? ' track-page-facts--outgoing' : ''}`} aria-hidden={exiting || undefined}>
      {fields.map(({ label, value, icon: Icon }) => (
        <div className="track-page-fact" key={label}>
          <dt><span className="track-page-fact-icon" aria-hidden="true"><Icon size={20} strokeWidth={1.65} /></span>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function TrackDetailPage({ track, onBack }: { track: UnifiedTrack; onBack: () => void }) {
  const t = useT()
  const player = usePlayer()
  const displayPosition = useDisplayPosition(player)
  const [transition, setTransition] = useState<{ selected: UnifiedTrack; previous: UnifiedTrack | null }>({
    selected: player.currentTrack ?? track, previous: null,
  })
  const { selected, previous } = transition
  const [artworkOpen, setArtworkOpen] = useState(false)
  const displayed = useRef(selected)
  const current = player.currentTrack
  // Synchronize before committing the render. Transitions follow the player
  // snapshot for every navigation path, including manual skips and restoration.
  if (current && trackKey(current) !== trackKey(selected)) {
    setTransition({ selected: current, previous: displayed.current })
  }
  const nextArtwork = player.queue?.[player.queueIndex + 1]?.coverPath

  useEffect(() => {
    if (!nextArtwork) return
    const image = new Image()
    image.src = /^https?:/.test(nextArtwork) ? nextArtwork : convertFileSrc(nextArtwork)
  }, [nextArtwork])

  useEffect(() => {
    if (!previous) return
    const timer = setTimeout(() => {
      setTransition(value => value.selected === selected ? { selected: value.selected, previous: null } : value)
    }, 480)
    return () => clearTimeout(timer)
  }, [selected, previous])

  const isCurrent = trackKey(current) === trackKey(selected)
  const details = isCurrent && current ? current : selected
  displayed.current = details
  const duration = isCurrent && Number.isFinite(player.duration) && player.duration > 0 ? player.duration : details.durationSec
  const hasDuration = duration != null && Number.isFinite(duration) && duration > 0
  const position = isCurrent && Number.isFinite(displayPosition) ? Math.max(0, Math.min(displayPosition, duration ?? 0)) : 0

  return (
    <div className={`page track-page${previous ? ' is-changing-track' : ''}`}>
      <button className="back-link" type="button" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" />{t('Back')}</button>
      <article className="track-page-sheet" aria-labelledby="track-page-title">
        <div className="track-page-ambience" aria-hidden="true">
          {previous && <div className="track-page-ambience-old"><Cover path={previous.coverPath} label={previous.title} size={480} loading="eager" /></div>}
          <Cover key={trackKey(details)} path={details.coverPath} label={details.title} size={480} loading="eager" />
        </div>
        <header className="track-page-header">
          <button className="track-page-artwork" type="button" onClick={() => setArtworkOpen(true)} aria-label={t('View artwork')}>
            {previous && <span className="track-page-cover-old" aria-hidden="true"><Cover path={previous.coverPath} label={previous.title} size={300} loading="eager" /></span>}
            <span key={trackKey(details)} className="track-page-cover-current"><Cover path={details.coverPath} label={details.title} size={300} loading="eager" /></span>
            <span className="track-page-artwork-hint" aria-hidden="true"><Maximize2 size={17} /></span>
          </button>
          <div className="track-page-heading-wrap">
            {previous && <div className="track-page-heading-old" aria-hidden="true"><div className="track-page-title">{previous.title}</div><p className="track-page-artist">{previous.artists.join(', ') || t('Unknown artist')}</p></div>}
            <div key={trackKey(details)} className="track-page-heading-current">
              <h1 id="track-page-title" className="track-page-title">{details.title}</h1>
              <p className="track-page-artist"><ArtistLinks track={details} /></p>
            </div>
          </div>
        </header>
        <section className="track-page-waveform" aria-label={t('Position')}>
          <WaveProgress key={trackKey(details)} seed={details.sourceId} soundCloudTrackId={details.source === 'soundcloud' ? details.sourceId : null}
            waveformEnabled position={position} duration={hasDuration ? duration : 0} disabled={!isCurrent || !hasDuration} onSeek={player.seek} />
          <div className="track-page-times" aria-hidden="true"><span>{fmtTime(position)}</span><span>{fmtTime(duration)}</span></div>
        </section>
        <div className="track-page-facts-wrap">
          {previous && <TrackFacts track={previous} duration={previous.durationSec} exiting />}
          <div key={trackKey(details)} className="track-page-facts-current"><TrackFacts track={details} duration={duration} /></div>
        </div>
      </article>
      {artworkOpen && <ArtworkView track={details} onClose={() => setArtworkOpen(false)} />}
    </div>
  )
}

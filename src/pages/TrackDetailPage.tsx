import { useState } from 'react'
import { ArrowLeft, AudioLines, Clock3, Cloud, Disc3, FileMusic, Gauge, Layers, Maximize2, Tags } from 'lucide-react'
import ArtworkView from '../components/artwork-view/ArtworkView'
import Cover from '../components/common/Cover'
import WaveProgress from '../components/common/WaveProgress'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { useDisplayPosition } from '../player/useDisplayPosition'
import type { UnifiedTrack } from '../types/models'
import { fmtTime } from '../utils/format'
import './track-detail-page.css'

export default function TrackDetailPage({ track, onBack }: { track: UnifiedTrack; onBack: () => void }) {
  const t = useT()
  const player = usePlayer()
  const displayPosition = useDisplayPosition(player)
  const [artworkOpen, setArtworkOpen] = useState(false)
  const current = player.currentTrack
  const isCurrent = current?.source === track.source && current.sourceId === track.sourceId
  const details = isCurrent ? current : track
  const duration = isCurrent && Number.isFinite(player.duration) && player.duration > 0
    ? player.duration
    : details.durationSec
  const hasDuration = duration != null && Number.isFinite(duration) && duration > 0
  const position = isCurrent && Number.isFinite(displayPosition) ? Math.max(0, Math.min(displayPosition, duration ?? 0)) : 0
  const artist = details.artists.map((name) => name.trim()).filter(Boolean).join(', ')
  const source = details.source === 'local' ? t('Local files') : details.source === 'soundcloud' ? 'SoundCloud' : 'YouTube Music'
  const bpm = details.traits?.bpm
  const fields = [
    { label: t('Album'), value: details.album?.trim(), icon: Disc3 },
    { label: t('Genre'), value: details.traits?.genre?.trim(), icon: AudioLines },
    { label: 'BPM', value: bpm != null && Number.isFinite(bpm) && bpm > 0 ? String(bpm) : null, icon: Gauge },
    { label: t('Version'), value: details.traits?.version?.trim(), icon: Layers },
    { label: t('Duration'), value: hasDuration ? fmtTime(duration) : null, icon: Clock3 },
    { label: t('Source'), value: source, icon: details.source === 'local' ? FileMusic : Cloud },
    { label: t('Tags'), value: details.traits?.tags?.map((tag) => tag.trim()).filter(Boolean).join(', '), icon: Tags },
  ].filter(({ value }) => value)

  return (
    <div className="page track-page">
      <button className="back-link" type="button" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />{t('Back')}
      </button>
      <article className="track-page-sheet" aria-labelledby="track-page-title">
        <div className="track-page-ambience" aria-hidden="true">
          <Cover path={details.coverPath} label={details.title} size={480} loading="eager" />
        </div>
        <header className="track-page-header">
          <button className="track-page-artwork" type="button" onClick={() => setArtworkOpen(true)} aria-label={t('View artwork')}>
            <Cover path={details.coverPath} label={details.title} size={300} loading="eager" />
            <span className="track-page-artwork-hint" aria-hidden="true"><Maximize2 size={17} /></span>
          </button>
          <h1 id="track-page-title">{details.title}</h1>
          <p className="track-page-artist">{artist || t('Unknown artist')}</p>
        </header>
        <section className="track-page-waveform" aria-label={t('Position')}>
          <WaveProgress
            key={`${details.source}:${details.sourceId}`}
            seed={details.sourceId}
            soundCloudTrackId={details.source === 'soundcloud' ? details.sourceId : null}
            waveformEnabled
            position={position}
            duration={hasDuration ? duration : 0}
            disabled={!isCurrent || !hasDuration}
            onSeek={player.seek}
          />
          <div className="track-page-times" aria-hidden="true">
            <span>{fmtTime(position)}</span><span>{fmtTime(duration)}</span>
          </div>
        </section>
        <dl className="track-page-facts">
          {fields.map(({ label, value, icon: Icon }) => (
            <div className="track-page-fact" key={label}>
              <dt>
                <span className="track-page-fact-icon" aria-hidden="true"><Icon size={20} strokeWidth={1.65} /></span>
                {label}
              </dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </article>
      {artworkOpen && <ArtworkView track={details} onClose={() => setArtworkOpen(false)} />}
    </div>
  )
}

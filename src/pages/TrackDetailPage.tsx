import Cover from '../components/common/Cover'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import type { UnifiedTrack } from '../types/models'
import { fmtTime } from '../utils/format'
import './track-detail-page.css'

export default function TrackDetailPage({ track, onBack }: { track: UnifiedTrack; onBack: () => void }) {
  const t = useT()
  const player = usePlayer()
  const current = player.currentTrack
  const isCurrent = current?.source === track.source && current.sourceId === track.sourceId
  const details = isCurrent ? current : track
  const duration = isCurrent && Number.isFinite(player.duration) && player.duration > 0
    ? player.duration
    : details.durationSec
  const hasDuration = duration != null && Number.isFinite(duration) && duration > 0
  const showPlayback = isCurrent && hasDuration && Number.isFinite(player.position) && player.position >= 0
  const artist = details.artists.map((name) => name.trim()).filter(Boolean).join(', ')
  const source = details.source === 'local' ? t('Local files') : details.source === 'soundcloud' ? 'SoundCloud' : 'YouTube Music'
  const bpm = details.traits?.bpm
  const fields = [
    { label: t('Album'), value: details.album?.trim() },
    { label: t('Genre'), value: details.traits?.genre?.trim() },
    { label: 'BPM', value: bpm != null && Number.isFinite(bpm) && bpm > 0 ? String(bpm) : null },
    { label: t('Version'), value: details.traits?.version?.trim() },
    { label: t('Duration'), value: hasDuration && !showPlayback ? fmtTime(duration) : null },
    { label: t('Source'), value: source },
  ].filter(({ value }) => value)
  const tags = details.traits?.tags?.map((tag) => tag.trim()).filter(Boolean).join(', ')
  const position = showPlayback ? Math.min(player.position, duration) : 0

  return (
    <EditorialDetailLayout
      className="track-page"
      onBack={onBack}
      backLabel={t('Back')}
      art={<Cover path={details.coverPath} label={details.title} size={288} loading="eager" />}
      kind={t('Track details')}
      title={details.title}
      meta={<span>{artist || t('Unknown artist')}</span>}
      actions={showPlayback && (
        <div className="track-page-timeline">
          <progress aria-label={t('Position')} value={position} max={duration} />
          <div className="track-page-times">
            <span>{fmtTime(position)}</span>
            <span>{fmtTime(duration)}</span>
          </div>
        </div>
      )}
    >
      <dl className="track-page-metadata">
        {fields.map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {tags && <div className="track-page-tags"><dt>{t('Tags')}</dt><dd>{tags}</dd></div>}
      </dl>
    </EditorialDetailLayout>
  )
}

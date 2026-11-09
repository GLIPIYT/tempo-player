import { Folder } from 'lucide-react'
import { useT } from '../../i18n'
import type { SourceId } from '../../types/models'
import BrandIcon from './BrandIcon'

export default function TrackSourceIcon({ source }: { source: SourceId }) {
  const t = useT()
  const label = source === 'soundcloud' ? 'SoundCloud' : source === 'youtube' ? 'YouTube Music' : t('Local file')
  return <span className="collection-track-source" role="img" aria-label={label} title={label}>
    {source === 'local' ? <Folder size={12} aria-hidden="true" /> : <BrandIcon mark={source === 'soundcloud' ? 'soundcloud' : 'youtubemusic'} size={14} brand />}
  </span>
}

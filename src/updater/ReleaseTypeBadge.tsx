import { Cog, Crown, Sparkles, Wrench } from 'lucide-react'
import { useT } from '../i18n'
import { RELEASE_TYPE_LABELS, type ReleaseType } from './releaseType'

const ICONS = { bugfix: Cog, minor: Wrench, average: Sparkles, major: Crown }

export default function ReleaseTypeBadge({ type }: { type: ReleaseType }) {
  const t = useT()
  const Icon = ICONS[type]
  return (
    <span className={`update-release-kind is-${type}`}>
      <Icon size={10} strokeWidth={1.7} aria-hidden="true" />
      <span className="update-release-kind-label">
        {t(RELEASE_TYPE_LABELS[type])}
        {type === 'major' && <span className="update-release-kind-particles" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>}
      </span>
    </span>
  )
}

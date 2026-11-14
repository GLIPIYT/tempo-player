import { Play } from 'lucide-react'
import { useT } from '../../i18n'

export default function CollectionPlayButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const t = useT()
  return <button type="button" className="btn btn-primary collection-play-all" disabled={disabled} onClick={onClick}>
    <Play size={15} fill="currentColor" aria-hidden="true" />
    <span>{t('Play all')}</span>
  </button>
}

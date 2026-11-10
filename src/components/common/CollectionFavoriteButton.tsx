import { Heart } from 'lucide-react'
import type { MouseEventHandler } from 'react'
import { useT } from '../../i18n'

export default function CollectionFavoriteButton({ active, onClick, label, className = '' }: {
  active: boolean
  onClick: MouseEventHandler<HTMLButtonElement>
  label?: string
  className?: string
}) {
  const t = useT()
  const action = active ? t('Remove from favorites') : t('Add to favorites')
  return <button type="button" className={`collection-icon-action collection-favorite${active ? ' is-active' : ''} ${className}`.trim()} title={action} aria-label={label ? `${action}: ${label}` : action} aria-pressed={active} onClick={onClick}>
    <Heart size={21} fill={active ? 'currentColor' : 'none'} aria-hidden="true" />
  </button>
}

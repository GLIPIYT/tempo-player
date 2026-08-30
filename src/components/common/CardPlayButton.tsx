import { Play } from 'lucide-react'
import { useT } from '../../i18n'

interface CardPlayButtonProps {
  onPlay: () => void
  label?: string
  className?: string
}

export default function CardPlayButton({ onPlay, label, className }: CardPlayButtonProps) {
  const t = useT()
  const cls = className ? `card-play ${className}` : 'card-play'
  return (
    <span
      className={cls}
      role="button"
      tabIndex={-1}
      aria-label={label ?? t('Play')}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        onPlay()
      }}
    >
      <Play size={16} />
    </span>
  )
}

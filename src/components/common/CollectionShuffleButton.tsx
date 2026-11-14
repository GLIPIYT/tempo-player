import { Shuffle } from 'lucide-react'
import { useT } from '../../i18n'
import { usePlayerActions, usePlayerField } from '../../player'

export default function CollectionShuffleButton({ disabled, onPlay }: {
  disabled?: boolean
  onPlay: () => void
}) {
  const t = useT()
  const player = usePlayerActions()
  const shuffle = usePlayerField('shuffle')
  return (
    <button type="button" className={`collection-icon-action${shuffle ? ' is-active' : ''}`} disabled={disabled}
      title={t('Shuffle')} aria-label={t('Shuffle')} onClick={() => {
        if (!shuffle) player.toggleShuffle()
        onPlay()
      }}>
      <Shuffle size={19} />
    </button>
  )
}

import { ChartNoAxesColumnIncreasing } from 'lucide-react'
import { historyDialogState, type ListeningSubject } from '../../features/listening-history/dialogState'
import { localDateKey } from '../../features/listening-history/period'
import { useT } from '../../i18n'

export default function CollectionStatisticsButton({ subject }: { subject: ListeningSubject }) {
  const t = useT()
  return (
    <button type="button" className="collection-icon-action" title={t('Show statistics')} aria-label={t('Show statistics')}
      onClick={() => historyDialogState.open({ kind: 'month', date: localDateKey(new Date()) }, subject)}>
      <ChartNoAxesColumnIncreasing size={19} aria-hidden="true" />
    </button>
  )
}

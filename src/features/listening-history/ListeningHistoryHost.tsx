import { useSyncExternalStore } from 'react'
import ListeningHistoryDialog from './ListeningHistoryDialog'
import { historyDialogState } from './dialogState'

export default function ListeningHistoryHost() {
  const current = useSyncExternalStore(historyDialogState.subscribe, historyDialogState.getSnapshot)
  return current ? <ListeningHistoryDialog key={current.id} initialSelection={current.selection}
    initialSubject={current.subject} onClose={() => historyDialogState.close(current.id)} /> : null
}

import { useSyncExternalStore } from 'react'
import ListeningHistoryDialog from './ListeningHistoryDialog'
import { historyDialogState } from './dialogState'

/** Keep the details open while an artist page changes behind its backdrop. */
export default function ListeningHistoryHost() {
  const current = useSyncExternalStore(historyDialogState.subscribe, historyDialogState.getSnapshot)
  return current ? <ListeningHistoryDialog key={current.id} initialSelection={current.selection} onClose={() => historyDialogState.close(current.id)} /> : null
}

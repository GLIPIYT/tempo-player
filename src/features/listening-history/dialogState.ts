import type { ListeningSelection } from './period'
import type { ListeningScope } from '../../types/models'

export interface ListeningSubject extends ListeningScope {
  title: string
  coverPath?: string | null
  youtubeVideoId?: string | null
}

let sequence = 0
let current: { selection: ListeningSelection; subject?: ListeningSubject; id: number } | null = null
const listeners = new Set<() => void>()
export const historyDialogState = {
  getSnapshot: () => current,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  open(selection: ListeningSelection, subject?: ListeningSubject) {
    current = { selection, ...(subject ? { subject } : {}), id: ++sequence }
    listeners.forEach(listener => listener())
  },
  close(id: number) {
    if (current?.id !== id) return
    current = null
    listeners.forEach(listener => listener())
  },
}

import type { ListeningSelection } from './period'

let sequence = 0
let current: { selection: ListeningSelection; id: number } | null = null
const listeners = new Set<() => void>()
export const historyDialogState = {
  getSnapshot: () => current,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  open(selection: ListeningSelection) {
    current = { selection, id: ++sequence }
    listeners.forEach(listener => listener())
  },
  close(id: number) {
    if (current?.id !== id) return
    current = null
    listeners.forEach(listener => listener())
  },
}

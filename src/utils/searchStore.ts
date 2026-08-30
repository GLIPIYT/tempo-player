type Listener = () => void

let value = ''
const listeners = new Set<Listener>()

export const searchStore = {
  get(): string {
    return value
  },
  set(next: string): void {
    if (next === value) return
    value = next
    listeners.forEach((l) => l())
  },
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
}

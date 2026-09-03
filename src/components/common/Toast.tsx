import { useSyncExternalStore } from 'react'
import { CheckCircle2, Info, TriangleAlert, Undo2 } from 'lucide-react'

export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastItem {
  id: number
  text: string
  kind: 'success' | 'info' | 'error'
  action?: ToastAction
}

let nextId = 1
let items: ToastItem[] = []
const listeners = new Set<() => void>()
const timers = new Map<number, number>()

function emit(): void {
  listeners.forEach((l) => l())
}

function dismiss(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timers.delete(id)
  }
  if (!items.some((t) => t.id === id)) return
  items = items.filter((t) => t.id !== id)
  emit()
}

export const toast = {
  show(
    text: string,
    kind: ToastItem['kind'] = 'success',
    ms = 2600,
    action?: ToastAction,
  ): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const id = nextId++
    items = [...items.slice(-3), { id, text: trimmed, kind, action }]
    emit()
    timers.set(
      id,
      // an actionable toast has to outlive a glance, so it gets longer unless the
      // caller asked for a specific duration
      window.setTimeout(() => dismiss(id), action && ms === 2600 ? 6000 : ms),
    )
  },
  subscribe(l: () => void): () => void {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  getItems: (): ToastItem[] => items,
}

export function ToastHost() {
  const list = useSyncExternalStore(toast.subscribe, toast.getItems)
  if (list.length === 0) return null
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.kind === 'success' ? (
            <CheckCircle2 size={14} />
          ) : t.kind === 'error' ? (
            <TriangleAlert size={14} />
          ) : (
            <Info size={14} />
          )}
          <span>{t.text}</span>
          {t.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation()
                t.action?.run()
                dismiss(t.id)
              }}
            >
              <Undo2 size={12} />
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

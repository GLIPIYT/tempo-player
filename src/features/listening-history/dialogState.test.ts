import { expect, it, vi } from 'vitest'
import { historyDialogState } from './dialogState'

it('keeps a newer history dialog open when an older close animation completes', () => {
  const listener = vi.fn()
  const stop = historyDialogState.subscribe(listener)
  historyDialogState.open({ kind: 'month', date: '2026-11-01' })
  const first = historyDialogState.getSnapshot()!
  historyDialogState.open({ kind: 'day', date: '2026-11-08' })
  const next = historyDialogState.getSnapshot()!
  historyDialogState.close(first.id)
  expect(historyDialogState.getSnapshot()).toBe(next)
  historyDialogState.close(next.id)
  expect(historyDialogState.getSnapshot()).toBeNull()
  expect(listener).toHaveBeenCalledTimes(3)
  stop()
})

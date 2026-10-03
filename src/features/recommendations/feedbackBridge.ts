import type { ExplicitActionKind } from './types'
import { invoke } from '@tauri-apps/api/core'

export interface ExplicitActionIntent { trackKey: string; action: ExplicitActionKind; intent: 'manual'; dbId?: number; playlistId?: number; at: number; generation?: number }
let boundary = 0
let accepting = true
const operations = new Set<Promise<unknown>>()
if (typeof window !== 'undefined') window.addEventListener('tempo:listening-history-cleared', () => { boundary += 1 })

/** Successful explicit UI operations only. Precache/import/playback callers do not use this bridge. */
type IntentDetails = Omit<ExplicitActionIntent, 'at'> | Omit<ExplicitActionIntent, 'at'>[]
export async function withExplicitFeedback<T>(operation: () => Promise<T>, detail: IntentDetails | ((result: T) => IntentDetails)): Promise<T> {
  if (!accepting) throw new Error('Player is exiting')
  const captured = boundary, at = Date.now()
  // Capture the DB generation before the actual action. An asynchronous clear can
  // commit before its frontend event arrives; a UI epoch alone cannot guard that gap.
  const capturedGeneration = invoke<number>('get_recommendation_generation')
  const actionFlight = capturedGeneration.then(async generation => {
    const result = await operation()
    if (captured === boundary) {
      const details = typeof detail === 'function' ? detail(result) : detail
      for (const item of Array.isArray(details) ? details : [details]) window.dispatchEvent(new CustomEvent('tempo:explicit-action', { detail: { ...item, at, generation } }))
    }
    return result
  })
  operations.add(actionFlight)
  try { return await actionFlight } finally { operations.delete(actionFlight) }
}
export function stopFeedbackOperations() { accepting = false }
export async function flushFeedbackOperations() {
  while (operations.size) await Promise.allSettled([...operations])
}

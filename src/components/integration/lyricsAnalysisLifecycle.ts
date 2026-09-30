import type { ModelState } from '../../features/lyrics/analysis/contract'

export interface AnalysisLifecycleDependencies {
  runner: { setEnabled(enabled: boolean): void }
  status(): Promise<ModelState>
  setEnabled(enabled: boolean): Promise<ModelState>
  listen(handler: (state: ModelState) => void): Promise<() => void>
}
const ABSENT: ModelState = { enabled: false, phase: 'absent', loadedBytes: 0, totalBytes: 0, error: null }

export function createLyricsAnalysisLifecycle(deps: AnalysisLifecycleDependencies) {
  let snapshot = ABSENT
  let active = false
  let preference: boolean | undefined
  let nativeEnabled = false
  let allowed = false
  let transition = 0
  let revision = 0
  let command = Promise.resolve()
  const listeners = new Set<() => void>()
  const publish = (value: ModelState) => { snapshot = value; revision++; listeners.forEach(listener => listener()) }
  const schedule = () => deps.runner.setEnabled(active && preference === true && nativeEnabled && allowed)
  return {
    start(): () => void {
      active = true
      preference = undefined
      nativeEnabled = false
      schedule()
      let disposed = false
      let unlisten: (() => void) | undefined
      void deps.listen(value => { if (!disposed) publish(value) })
        .then(remove => { if (disposed) remove(); else unlisten = remove })
        .catch(() => {})
      const initialRevision = revision
      void deps.status().then(value => {
        if (!disposed && revision === initialRevision) publish(value)
      }).catch(() => {})
      return () => { disposed = true; active = false; transition++; revision++; nativeEnabled = false; schedule(); unlisten?.() }
    },
    setPreference(value: boolean | null): void {
      const enabled = value === true
      if (enabled === preference) return
      preference = enabled
      const job = ++transition
      revision++
      nativeEnabled = false
      // Synchronous: cancellation and Worker disposal precede any native await.
      schedule()
      // Serialize native mutations so a slow enable cannot finish after deletion.
      command = command.then(async () => {
        if (!active || job !== transition) return
        const before = revision
        try {
          const value = await deps.setEnabled(enabled)
          if (!active || job !== transition) return
          nativeEnabled = enabled && value.enabled
          if (revision === before) publish(value)
          schedule()
        } catch (error) {
          if (active && job === transition) publish({ ...ABSENT, phase: 'error', error: String(error) })
        }
      })
    },
    setSchedulingAllowed(value: boolean): void { allowed = value; schedule() },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
  }
}

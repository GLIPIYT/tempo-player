/** Keeps full candidate scans behind foreground library hydration. */
export interface MixForegroundGate {
  libraryVersion: number
  ready: boolean
  requiresReadyCycle: boolean
  sawNotReady: boolean
  waiters: Set<() => void>
}

export interface MixForegroundWait {
  promise: Promise<void>
  cancel: () => void
}

export function createMixForegroundGate(
  libraryVersion: number,
  requiresReadyCycle = false,
): MixForegroundGate {
  return { libraryVersion, ready: false, requiresReadyCycle, sawNotReady: false, waiters: new Set() }
}

export function updateMixForegroundGate(
  gate: MixForegroundGate,
  foregroundReady: boolean,
  editorOpen = false,
): void {
  if (gate.ready) return
  if (!foregroundReady && !editorOpen) {
    gate.sawNotReady = true
    return
  }
  if (gate.requiresReadyCycle && !gate.sawNotReady && !editorOpen) return

  gate.ready = true
  for (const wake of gate.waiters) wake()
  gate.waiters.clear()
}

/** Register a cancellable wait so an abandoned hook effect cannot retain work. */
export function waitForMixForegroundReady(gate: MixForegroundGate): MixForegroundWait {
  if (gate.ready) return { promise: Promise.resolve(), cancel: () => undefined }

  let resolve!: () => void
  const promise = new Promise<void>((finish) => { resolve = finish })
  const wake = () => {
    gate.waiters.delete(wake)
    resolve()
  }
  gate.waiters.add(wake)
  return { promise, cancel: wake }
}

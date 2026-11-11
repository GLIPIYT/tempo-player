import { Profiler, type ReactNode } from 'react'
import { recordReactCommit, type DevProfileId } from './metrics'

/** Adds React render timings in dev builds; production markup stays unchanged. */
export function DevProfile({ id, children }: { id: DevProfileId; children: ReactNode }) {
  if (!import.meta.env.DEV) return <>{children}</>
  return <Profiler id={id} onRender={recordReactCommit}>{children}</Profiler>
}

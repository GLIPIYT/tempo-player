import { useEffect, useState } from 'react'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { onScanProgress } from '../api/events'
import type { ScanProgress } from '../types/models'

export interface ScanState {
  progress: ScanProgress | null
  active: boolean
}

export function useScanProgress(): ScanState {
  const [progress, setProgress] = useState<ScanProgress | null>(null)

  useEffect(() => {
    let cancelled = false
    let unlisten: UnlistenFn | null = null
    onScanProgress((p) => {
      if (!cancelled) setProgress(p)
    }).then((u) => {
      if (cancelled) u()
      else unlisten = u
    })
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  return { progress, active: progress !== null && progress.phase !== 'completed' }
}

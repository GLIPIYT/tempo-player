import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ScanProgress } from '../types/models'

export const SCAN_EVENT = 'scan://progress'

export function onScanProgress(handler: (p: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>(SCAN_EVENT, (e) => handler(e.payload))
}

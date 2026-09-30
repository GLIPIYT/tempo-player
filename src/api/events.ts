import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ScanProgress } from '../types/models'
import { LYRIC_MODEL_STATE_EVENT, type ModelState } from '../features/lyrics/analysis/contract'

export function onLyricsAnalysisModelState(handler: (state: ModelState) => void): Promise<UnlistenFn> {
  return listen<ModelState>(LYRIC_MODEL_STATE_EVENT, event => handler(event.payload))
}

export const SCAN_EVENT = 'scan://progress'
export const LIBRARY_CHANGED_EVENT = 'library://changed'

export function onScanProgress(handler: (p: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>(SCAN_EVENT, (e) => handler(e.payload))
}

/** Emitted when a background change adds library-visible data (e.g. a SoundCloud track finished caching). */
export function onLibraryChanged(handler: () => void): Promise<UnlistenFn> {
  return listen(LIBRARY_CHANGED_EVENT, () => handler())
}

/** soundcloud_store emits the completed track ID, or '' for a whole job. */
export function onSoundcloudCacheReady(handler: (sourceId: string) => void): Promise<UnlistenFn> {
  return listen<unknown>(LIBRARY_CHANGED_EVENT, event => {
    if (typeof event.payload === 'string' && event.payload.length > 0) handler(event.payload)
  })
}

export const TRAY_EVENT = 'tray://command'

/**
 * Playback commands from the tray menu. The tray lives in Rust and has no
 * access to the queue, so it forwards the command here instead.
 */
export function onTrayCommand(handler: (command: string) => void): Promise<UnlistenFn> {
  return listen<string>(TRAY_EVENT, (e) => handler(e.payload))
}

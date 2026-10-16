import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isNativePlayback } from '../player/nativeController'

export interface NativeAnalysisFrame {
  frequencyBins: number[]
  sampleRate: number
  minDecibels: number
  maxDecibels: number
  position: number
}

const listeners = new Set<(frame: NativeAnalysisFrame) => void>()
let unlisten: UnlistenFn | null = null
let sync = Promise.resolve()

function syncSubscription(): void {
  // Serialize enable/disable across rapid editor mounts and React StrictMode.
  sync = sync.then(async () => {
    if (listeners.size > 0 && !unlisten) {
      unlisten = await listen<NativeAnalysisFrame>('native-audio://analysis', ({ payload }) => {
        if (!Array.isArray(payload.frequencyBins) || payload.frequencyBins.length !== 512
          || !Number.isFinite(payload.position) || !Number.isFinite(payload.sampleRate)) return
        for (const listener of listeners) listener(payload)
      })
    }
    await invoke('native_audio_command', { command: { op: 'analysis', enabled: listeners.size > 0 } })
    if (listeners.size === 0) {
      unlisten?.()
      unlisten = null
    }
  }).catch(error => console.warn('[tempo native analysis]', error))
}

/** Raw linear FFT for the lyric editor, separate from the visualizer's 64 bins. */
export function subscribeNativeAnalysis(listener: (frame: NativeAnalysisFrame) => void): () => void {
  if (!isNativePlayback()) return () => {}
  listeners.add(listener)
  syncSubscription()
  return () => {
    listeners.delete(listener)
    syncSubscription()
  }
}

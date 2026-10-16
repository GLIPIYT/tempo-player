import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { PlayerSnapshot } from '../player/controller'
import { getSettings } from '../state/settings'
import { resolveLang } from '../i18n'
import type { MiniPlayerAction, MiniPlayerState } from './contract'

let volumeBeforeMute = 0.8
type NativeMiniSnapshot = PlayerSnapshot & { buffering?: boolean }

/** This module never imports the player singleton into the mini WebView. */
export function nativeMiniState(base: MiniPlayerState | null, snapshot: NativeMiniSnapshot): MiniPlayerState {
  const settings = getSettings()
  const artwork = (path: string | null | undefined) => !path ? null : /^https?:\/\//.test(path) ? path : convertFileSrc(path)
  const track = snapshot.currentTrack
  const next = snapshot.queue[snapshot.queueIndex + 1] ?? null
  const state: MiniPlayerState = {
    ...(base ?? {
      theme: settings.theme,
      lang: resolveLang(settings.lang),
      alwaysShowButton: settings.miniPlayer.alwaysShowButton,
      showNowPlaying: settings.miniPlayer.showNowPlaying,
      autoShowDurationMs: settings.miniPlayer.autoShowDurationMs,
    }),
    track: track ? {
      key: track.sourceId,
      dbId: track.dbId,
      title: track.title,
      artist: track.artists.filter(Boolean).join(', '),
      album: track.album,
      durationSec: snapshot.duration || track.durationSec || 0,
      artwork: artwork(track.coverPath),
      nextArtwork: artwork(next?.coverPath),
    } : null,
    liked: base?.track?.dbId === track?.dbId ? base?.liked ?? false : false,
    isPlaying: snapshot.isPlaying,
    shuffle: snapshot.shuffle,
    repeat: snapshot.repeat,
    volume: snapshot.volume,
    buffering: snapshot.preparing || snapshot.buffering === true || snapshot.bufferPct !== null,
  }
  return base && JSON.stringify(base) === JSON.stringify(state) ? base : state
}

export function connectNativeMini(onSnapshot: (snapshot: PlayerSnapshot) => void): () => void {
  if (!isTauri()) return () => {}
  let disposed = false
  const listeners: Array<() => void> = []
  let version = -1
  let latest: NativeMiniSnapshot | null = null
  const receive = (snapshot: NativeMiniSnapshot) => {
    if (disposed || snapshot.version < version) return
    version = snapshot.version
    latest = snapshot
    onSnapshot(snapshot)
  }
  const addListener = async <T>(name: string, callback: (value: T) => void) => {
    const stop = await listen<T>(name, event => callback(event.payload))
    if (disposed) stop()
    else listeners.push(stop)
  }
  void Promise.all([
    addListener<NativeMiniSnapshot>('native-audio://state', receive),
    addListener<Partial<NativeMiniSnapshot> & { version: number }>('native-audio://clock', clock => {
      if (latest) receive({ ...latest, ...clock })
    }),
  ]).then(async () => {
    if (!disposed) receive(await invoke<NativeMiniSnapshot>('native_audio_snapshot'))
  }).catch(error => console.warn('[tempo mini native]', error))
  return () => { disposed = true; for (const stop of listeners) stop() }
}

/** Return false only for actions still handled by the main window's UI. */
export async function nativeMiniAction(action: MiniPlayerAction, state: MiniPlayerState | null): Promise<boolean> {
  if (!isTauri()) return false
  let command: Record<string, unknown>
  switch (action.type) {
    case 'toggle_play': command = { op: 'toggle' }; break
    case 'prev': command = { op: 'previous' }; break
    case 'next': command = { op: 'next' }; break
    case 'seek': command = { op: 'seek', position: action.seconds }; break
    case 'set_volume': command = { op: 'settings', volume: action.volume }; break
    case 'toggle_shuffle': command = { op: 'settings', shuffle: !state?.shuffle }; break
    case 'toggle_repeat': command = { op: 'settings', repeat: state?.repeat === 'off' ? 'all' : state?.repeat === 'all' ? 'one' : 'off' }; break
    case 'toggle_mute': {
      const volume = state?.volume ?? 0.8
      if (volume > 0) volumeBeforeMute = volume
      command = { op: 'settings', volume: volume > 0 ? 0 : volumeBeforeMute }
      break
    }
    case 'show_main': {
      const window = await WebviewWindow.getByLabel('main')
      if (window) { await window.show(); await window.unminimize(); await window.setFocus() }
      return true
    }
    default: return false
  }
  await invoke('native_audio_command', { command })
  return true
}

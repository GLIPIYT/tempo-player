import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import {
  LogicalPosition,
  LogicalSize,
  currentMonitor,
  primaryMonitor,
  type Window,
} from '@tauri-apps/api/window'
import type { RepeatMode } from '../types/models'
import type { ActiveTheme } from '../types/theme'

/**
 * Contract between the main window (owns the audio and all state) and the
 * floating mini player (owns nothing but its own pixels).
 *
 * The two are separate webviews with no shared JS context, so everything
 * crosses as a Tauri event. The main window is the single source of truth.
 */

export const MINI_PLAYER_LABEL = 'mini-player'
export const MAIN_WINDOW_LABEL = 'main'

/** Pill resting at the top edge of the screen. */
export const MINI_COLLAPSED_SIZE = { width: 124, height: 20 } as const
/**
 * What the window shrinks to while the pill is parked off-screen. Only a few
 * pixels stay behind as the hover trigger, so the window does not sit there
 * swallowing clicks meant for whatever is underneath.
 */
export const MINI_HIDDEN_SIZE = { width: 124, height: 4 } as const
/** Expanded card: head row, centred transport row, progress row. */
export const MINI_EXPANDED_SIZE = { width: 428, height: 112 } as const
/**
 * Collapsed and expanded windows are anchored to the very top of the work area
 * rather than inset: the pill slides out from under the screen edge, and the
 * hover strip has to stay inside the window when the window grows.
 */
export const MINI_TOP_MARGIN = 0
/** Window resize happens once the open/close animation has finished. */
export const OPEN_ANIMATION_MS = 180
/** Unfold/fold of the card itself. */
export const UNFOLD_ANIMATION_MS = 220

export const EV_STATE = 'mini-player:state'
export const EV_TICK = 'mini-player:tick'
export const EV_ACTION = 'mini-player:action'
export const EV_READY = 'mini-player:ready'
export const EV_PEEK = 'mini-player:peek'

/** Main window asks the mini player to expand for a moment (track change). */
export interface MiniPeek {
  /** Collapse again after this many ms; 0 means stay expanded. */
  autoCollapseMs: number
}

/**
 * Deliberately not the full `UnifiedTrack`: sending the whole object (with its
 * queue bookkeeping) over IPC on every change is wasteful. `artwork` and
 * `nextArtwork` are already resolved to loadable URLs by the bridge, so the
 * window never has to touch the asset protocol itself.
 */
export interface MiniTrack {
  key: string
  dbId: number | null
  title: string
  artist: string
  album: string | null
  durationSec: number
  artwork: string | null
  /** Cover of the next queue entry — preloaded so the swap is instant. */
  nextArtwork: string | null
}

export interface MiniPlayerState {
  track: MiniTrack | null
  isPlaying: boolean
  liked: boolean
  shuffle: boolean
  repeat: RepeatMode
  volume: number
  /** True while the engine is waiting on data; drives a subtle indicator. */
  buffering: boolean
  theme: ActiveTheme
  lang: 'ru' | 'en'
  /** Keep the pill visible instead of parking it off-screen. */
  alwaysShowButton: boolean
  /** Show a "now playing" heading for the first half of an automatic peek. */
  showNowPlaying: boolean
  /** How long an automatic peek lasts; the heading uses half of it. */
  autoShowDurationMs: number
}

export type MiniPlayerAction =
  | { type: 'toggle_play' }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'seek'; seconds: number }
  | { type: 'set_volume'; volume: number }
  | { type: 'toggle_mute' }
  | { type: 'toggle_like' }
  | { type: 'toggle_shuffle' }
  | { type: 'toggle_repeat' }
  | { type: 'show_main' }

export function emitToMini<T>(event: string, payload: T): Promise<void> {
  return emitTo(MINI_PLAYER_LABEL, event, payload)
}

export function emitToMain<T>(event: string, payload: T): Promise<void> {
  return emitTo(MAIN_WINDOW_LABEL, event, payload)
}

export function listenFor<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload))
}

export function getMiniWindow(): Promise<WebviewWindow | null> {
  return WebviewWindow.getByLabel(MINI_PLAYER_LABEL)
}

/**
 * Top-centre of the work area of the primary monitor.
 *
 * `monitor.workArea` is in physical pixels while `setPosition` takes logical
 * ones, so both the offset and the size have to be divided by the scale
 * factor — otherwise the pill lands off-screen at 125%/150% scaling.
 */
async function computeAnchor(width: number): Promise<{ x: number; y: number } | null> {
  const monitor = (await primaryMonitor()) ?? (await currentMonitor())
  if (!monitor) return null
  const scale = monitor.scaleFactor || 1
  const area = monitor.workArea ?? { position: monitor.position, size: monitor.size }
  return {
    x: Math.round(area.position.x / scale + (area.size.width / scale - width) / 2),
    y: Math.round(area.position.y / scale + MINI_TOP_MARGIN),
  }
}

export async function positionMiniWindow(
  win: Window,
  width: number,
  height: number,
): Promise<void> {
  const anchor = await computeAnchor(width)
  if (anchor) await win.setPosition(new LogicalPosition(anchor.x, anchor.y))
  await win.setSize(new LogicalSize(width, height))
}

/**
 * Returns the mini player window, creating it on first use.
 *
 * The window is created from JS rather than declared in `tauri.conf.json` so it
 * costs nothing when the feature is switched off.
 */
export async function ensureMiniWindow(visible: boolean): Promise<WebviewWindow> {
  const existing = await getMiniWindow()
  if (existing) {
    if (visible) await existing.show()
    return existing
  }

  const anchor = await computeAnchor(MINI_COLLAPSED_SIZE.width)
  const win = new WebviewWindow(MINI_PLAYER_LABEL, {
    url: 'mini-player.html',
    title: 'Tempo Mini Player',
    width: MINI_COLLAPSED_SIZE.width,
    height: MINI_COLLAPSED_SIZE.height,
    ...(anchor ? { x: anchor.x, y: anchor.y } : {}),
    resizable: false,
    decorations: false,
    transparent: true,
    shadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // never steal focus: the mini player pops up on every track change and
    // would otherwise interrupt typing in the main window
    focus: false,
    visible,
  })

  await new Promise<void>((resolve, reject) => {
    const ok = win.once('tauri://created', () => resolve())
    const fail = win.once('tauri://error', (e) => reject(e))
    void ok
    void fail
  })
  return win
}

export async function hideMiniWindow(): Promise<void> {
  const win = await getMiniWindow()
  if (win) await win.hide()
}

/**
 * Cold-start fallback.
 *
 * The two windows are separate webviews, so the mini player can come up before
 * the bridge in the main window has attached its listeners. Both share the same
 * origin and therefore the same `localStorage`, which is a cheap place to leave
 * the last known state — no extra plugin needed.
 */
export const MINI_SNAPSHOT_KEY = 'tempo.mini.snapshot.v1'

export interface MiniSnapshot {
  state: MiniPlayerState
  position: number
}

export function saveMiniSnapshot(snapshot: MiniSnapshot): void {
  try {
    window.localStorage.setItem(MINI_SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    /* storage full or unavailable */
  }
}

export function loadMiniSnapshot(): MiniSnapshot | null {
  try {
    const raw = window.localStorage.getItem(MINI_SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as MiniSnapshot
    if (!parsed || typeof parsed !== 'object' || !parsed.state) return null
    return parsed
  } catch {
    return null
  }
}

import { useEffect, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { playerController } from '../../player/controller'
import { likesStore } from '../../utils/likesStore'
import { useSettings } from '../../state/settings'
import { resolveLang } from '../../i18n'
import type { RepeatMode, UnifiedTrack } from '../../types/models'
import type { ActiveTheme } from '../../types/theme'
import {
  EV_ACTION,
  EV_PEEK,
  EV_READY,
  EV_STATE,
  EV_TICK,
  MINI_COLLAPSED_SIZE,
  emitToMini,
  ensureMiniWindow,
  hideMiniWindow,
  listenFor,
  positionMiniWindow,
  saveMiniSnapshot,
  type MiniPlayerAction,
  type MiniPlayerState,
  type MiniTrack,
} from '../../mini-player/contract'

/**
 * Drives the floating mini player window.
 *
 * The mini player owns no state at all — it renders whatever arrives on
 * `mini-player:state` and sends commands back on `mini-player:action`. This
 * component is the only place that talks to it.
 *
 * Renders `null`; mounted once inside the app shell.
 */

const TICK_MS_PLAYING = 180
const TICK_MS_PAUSED = 900
const DISK_SNAPSHOT_MS = 1500
const WINDOW_CREATE_DELAY_MS = 400

function artworkUrl(path: string | null): string | null {
  if (!path) return null
  return /^https?:\/\//.test(path) ? path : convertFileSrc(path)
}

function toMiniTrack(track: UnifiedTrack, next: UnifiedTrack | null): MiniTrack {
  return {
    key: track.sourceId,
    dbId: track.dbId,
    title: track.title,
    artist: track.artists.filter((a) => a.trim()).join(', '),
    album: track.album,
    durationSec: track.durationSec ?? 0,
    artwork: artworkUrl(track.coverPath),
    nextArtwork: artworkUrl(next?.coverPath ?? null),
  }
}

/**
 * Cheap identity for "has anything the mini player draws changed?".
 *
 * Deliberately excludes `position` and the theme: position has its own throttled
 * channel, and the theme object is compared by reference. `snapshot.version` is
 * useless here — it increments on every audio frame, ~60 times a second.
 */
function signatureOf(state: MiniPlayerState): string {
  return [
    state.track?.key ?? '',
    state.track?.title ?? '',
    state.track?.artist ?? '',
    state.track?.artwork ?? '',
    state.track?.nextArtwork ?? '',
    state.isPlaying ? 1 : 0,
    state.liked ? 1 : 0,
    state.shuffle ? 1 : 0,
    state.repeat,
    state.volume.toFixed(3),
    state.buffering ? 1 : 0,
    state.lang,
  ].join('|')
}

export default function MiniPlayerBridge(): null {
  const { settings } = useSettings()
  const enabled = settings.miniPlayer.enabled
  const autoShowOnTrackChange = settings.miniPlayer.autoShowOnTrackChange
  const autoShowDurationMs = settings.miniPlayer.autoShowDurationMs

  const [, setWindowReady] = useState(false)

  // Everything the 60Hz audio loop needs is read through refs so that the
  // subscription is never torn down and rebuilt mid-playback.
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const lastSignatureRef = useRef<string | null>(null)
  const lastThemeRef = useRef<ActiveTheme | null>(null)
  const lastTickAtRef = useRef(0)
  const lastTickValueRef = useRef(-1)
  const lastDiskAtRef = useRef(0)
  const lastTrackKeyRef = useRef<string | null>(null)
  const volumeBeforeMuteRef = useRef(0.8)
  const positionRef = useRef(0)

  const buildState = (): MiniPlayerState => {
    const snap = playerController.getSnapshot()
    const track = snap.currentTrack
    const next = track ? (snap.queue[snap.queueIndex + 1] ?? null) : null
    const current = settingsRef.current
    return {
      track: track ? toMiniTrack(track, next) : null,
      isPlaying: snap.isPlaying,
      liked: track?.dbId != null ? likesStore.isLiked(track.dbId) : false,
      shuffle: snap.shuffle,
      repeat: snap.repeat,
      volume: snap.volume,
      buffering: snap.bufferPct !== null,
      theme: current.theme,
      lang: resolveLang(current.lang),
    }
  }

  const syncState = (force = false): void => {
    if (!settingsRef.current.miniPlayer.enabled) return
    const state = buildState()
    const themeChanged = state.theme !== lastThemeRef.current
    const signature = signatureOf(state)
    if (!force && !themeChanged && signature === lastSignatureRef.current) return
    lastSignatureRef.current = signature
    lastThemeRef.current = state.theme
    void emitToMini(EV_STATE, state).catch(() => {})

    const now = performance.now()
    if (force || now - lastDiskAtRef.current > DISK_SNAPSHOT_MS) {
      lastDiskAtRef.current = now
      saveMiniSnapshot({ state, position: positionRef.current })
    }
  }

  /**
   * Position has its own channel so the state payload (track, theme, flags)
   * isn't re-serialised on every audio frame. On pause the mini player doesn't
   * need a moving number, so the gap widens.
   */
  const syncTick = (position: number, isPlaying: boolean): void => {
    const now = performance.now()
    const minGap = isPlaying ? TICK_MS_PLAYING : TICK_MS_PAUSED
    const jumped = Math.abs(position - lastTickValueRef.current) >= 0.04
    if (!jumped && now - lastTickAtRef.current < minGap) return
    if (now - lastTickAtRef.current < minGap * 0.75) return
    lastTickAtRef.current = now
    lastTickValueRef.current = position
    positionRef.current = position
    void emitToMini(EV_TICK, position).catch(() => {})
  }

  const peek = (): void => {
    const current = settingsRef.current.miniPlayer
    if (!current.enabled || !current.autoShowOnTrackChange) return
    void emitToMini(EV_PEEK, { autoCollapseMs: current.autoShowDurationMs }).catch(() => {})
  }

  const handleAction = async (action: MiniPlayerAction): Promise<void> => {
    switch (action.type) {
      case 'toggle_play':
        await playerController.toggle()
        break
      case 'prev':
        await playerController.previous()
        break
      case 'next':
        await playerController.next()
        break
      case 'seek':
        playerController.seek(action.seconds)
        break
      case 'set_volume':
        playerController.setVolume(action.volume)
        break
      case 'toggle_mute': {
        const volume = playerController.getSnapshot().volume
        if (volume > 0) {
          volumeBeforeMuteRef.current = volume
          playerController.setVolume(0)
        } else {
          playerController.setVolume(volumeBeforeMuteRef.current || 0.8)
        }
        break
      }
      case 'toggle_like': {
        const dbId = playerController.getSnapshot().currentTrack?.dbId ?? null
        if (dbId !== null) likesStore.toggle(dbId)
        break
      }
      case 'toggle_shuffle':
        playerController.toggleShuffle()
        break
      case 'toggle_repeat': {
        const mode = playerController.getSnapshot().repeat
        const next: RepeatMode = mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off'
        playerController.setRepeat(next)
        break
      }
      case 'show_main': {
        const win = getCurrentWindow()
        await win.show()
        await win.unminimize()
        await win.setFocus()
        break
      }
    }
    syncState(true)
  }

  // create / destroy the window when the feature is toggled
  useEffect(() => {
    if (!enabled) {
      setWindowReady(false)
      void hideMiniWindow().catch(() => {})
      return
    }
    let cancelled = false
    // let the main window paint first; creating the webview too early competes
    // with startup and can leave the mini player briefly blank
    const timer = window.setTimeout(() => {
      void ensureMiniWindow(false)
        .then(async (win) => {
          if (cancelled) return
          await positionMiniWindow(win, MINI_COLLAPSED_SIZE.width, MINI_COLLAPSED_SIZE.height)
          await win.show()
          if (!cancelled) setWindowReady(true)
        })
        .catch((err) => console.error('[tempo mini player]', err))
    }, WINDOW_CREATE_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [enabled])

  // listeners: commands from the window, and its "I'm up" ping
  useEffect(() => {
    if (!enabled) return
    let unlistenAction: UnlistenFn | null = null
    let unlistenReady: UnlistenFn | null = null
    let disposed = false
    void listenFor<MiniPlayerAction>(EV_ACTION, (action) => {
      void handleAction(action).catch((err) => console.error('[tempo mini player]', err))
    }).then((fn) => {
      if (disposed) fn()
      else unlistenAction = fn
    })
    void listenFor<unknown>(EV_READY, () => syncState(true)).then((fn) => {
      if (disposed) fn()
      else unlistenReady = fn
    })
    return () => {
      disposed = true
      unlistenAction?.()
      unlistenReady?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // the audio loop: state on real change, position on its own throttle
  useEffect(() => {
    if (!enabled) return
    likesStore.ensureLoaded()
    syncState(true)
    return playerController.subscribe(() => {
      if (!settingsRef.current.miniPlayer.enabled) return
      const snap = playerController.getSnapshot()
      const key = snap.currentTrack?.sourceId ?? null
      if (key !== lastTrackKeyRef.current) {
        lastTrackKeyRef.current = key
        lastTickValueRef.current = -1
        syncState(true)
        if (key !== null) peek()
      } else {
        syncState()
      }
      syncTick(snap.position, snap.isPlaying)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // likes change outside the player loop (main window heart button, another view)
  useEffect(() => {
    if (!enabled) return
    return likesStore.subscribe(() => syncState(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // theme / language / auto-show settings
  useEffect(() => {
    if (!enabled) return
    syncState(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, settings.theme, settings.lang, autoShowOnTrackChange, autoShowDurationMs])

  return null
}

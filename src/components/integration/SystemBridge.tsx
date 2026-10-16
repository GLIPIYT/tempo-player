import { useEffect, useRef } from 'react'
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart'
import { api } from '../../api/client'
import { syncNativeAudioSettings } from '../../player/nativeController'
import { useSettings } from '../../state/settings'
import { useT } from '../../i18n'

/**
 * Wires the OS-level preferences: launch at login, stay in the tray, and the
 * tray menu.
 *
 * Playback and tray controls are owned by the native service. This bridge
 * syncs app-level audio preferences and OS settings.
 * Renders `null`; mounted once inside the app shell.
 */
export default function SystemBridge(): null {
  const { settings } = useSettings()
  const { audio, soundcloud, ytdlp } = settings
  const t = useT()
  // the translator is not stable across renders, and re-pushing the labels on
  // every render would be an IPC call per render
  const tRef = useRef(t)
  tRef.current = t

  // Closing the window parks Tempo in the tray when this is on. Rust reads the
  // flag from its own state, so it has to be pushed over on every change.
  useEffect(() => {
    void api.setCloseToTray(settings.system.closeToTray).catch(() => {})
  }, [settings.system.closeToTray])

  // Send all app-owned audio preferences together. Partial transport updates
  // such as volume and EQ then merge without losing loudness or cache options.
  useEffect(() => {
    syncNativeAudioSettings({ audio, soundcloud, ytdlp })
  }, [audio, soundcloud, ytdlp])

  // Tray labels follow the UI language.
  useEffect(() => {
    const tr = tRef.current
    void api
      .setTrayLabels({
        show: tr('Show Tempo'),
        toggle: tr('Play / Pause'),
        prev: tr('Previous'),
        next: tr('Next'),
        quit: tr('Quit'),
      })
      .catch(() => {})
  }, [settings.lang])

  // Launch at login. Only touched when the OS disagrees with the setting, so
  // this does not rewrite the registry on every start.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const actual = await isAutostartEnabled()
        if (cancelled || actual === settings.system.autostart) return
        if (settings.system.autostart) await enableAutostart()
        else await disableAutostart()
      } catch {
        /* plugin unavailable outside the Tauri shell */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [settings.system.autostart])

  return null
}

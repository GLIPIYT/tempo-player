import { useEffect, useRef } from 'react'
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart'
import { api } from '../../api/client'
import { onTrayCommand } from '../../api/events'
import { playerController } from '../../player/controller'
import { useSettings } from '../../state/settings'
import { useT } from '../../i18n'

/**
 * Wires the OS-level preferences: launch at login, stay in the tray, and the
 * tray menu.
 *
 * The tray itself is built in Rust, but it owns no playback state, so its
 * menu items arrive here as events and are applied to the player controller.
 * Renders `null`; mounted once inside the app shell.
 */
export default function SystemBridge(): null {
  const { settings } = useSettings()
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

  // Playback commands from the tray menu.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    void onTrayCommand((command) => {
      if (command === 'toggle') void playerController.toggle()
      else if (command === 'next') void playerController.next()
      else if (command === 'prev') void playerController.previous()
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return null
}

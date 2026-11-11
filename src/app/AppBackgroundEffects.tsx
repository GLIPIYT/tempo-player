import { useEffect } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { api } from '../api/client'
import { onLibraryChanged, onScanProgress } from '../api/events'
import { playerController } from '../player/controller'
import { composePlayerApi } from '../player/usePlayer'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { likesStore } from '../utils/likesStore'

function Shortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target
      if (target instanceof Element && (
        (target instanceof HTMLElement && target.isContentEditable) || target.closest(
          'input, textarea, select, button, a, [role="button"], [role="link"], [role="slider"], [role="switch"], [role="textbox"], [contenteditable="true"], [contenteditable=""]',
        )
      )) return

      const player = composePlayerApi(playerController.getSnapshot())
      const noModifiers = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
      if (e.code === 'Space' && noModifiers) {
        if (e.repeat) return
        e.preventDefault()
        player.toggle()
      } else if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.code === 'ArrowRight') {
        e.preventDefault()
        player.seek(player.position + 1)
      } else if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.code === 'ArrowLeft') {
        e.preventDefault()
        player.seek(player.position - 1)
      } else if (noModifiers && e.code === 'ArrowRight') {
        if (e.repeat) return
        e.preventDefault()
        player.next()
      } else if (noModifiers && e.code === 'ArrowLeft') {
        if (e.repeat) return
        e.preventDefault()
        player.previous()
      } else if (e.code === 'ArrowUp') {
        e.preventDefault()
        player.setVolume(Math.min(1, player.volume + 0.05))
      } else if (e.code === 'ArrowDown') {
        e.preventDefault()
        player.setVolume(Math.max(0, player.volume - 0.05))
      } else if (e.code === 'KeyM') {
        player.setVolume(player.volume > 0 ? 0 : 0.8)
      } else if (e.code === 'KeyS') {
        player.toggleShuffle()
      } else if (e.code === 'KeyR') {
        player.setRepeat(player.repeat === 'off' ? 'all' : player.repeat === 'all' ? 'one' : 'off')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return null
}

function ScanWatcher() {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void onScanProgress((p) => {
      if (p.phase === 'completed') bumpLibraryVersion()
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
  return null
}

function LibraryChangeWatcher() {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void onLibraryChanged(() => {
      bumpLibraryVersion()
      likesStore.reload()
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
  return null
}

function FolderDropWatcher() {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return
        const paths = event.payload.paths
        if (paths.length === 0) return
        void api
          .addLibraryFolder(paths[0])
          .then(() => api.rescanLibrary())
          .then(() => bumpLibraryVersion())
          .catch(() => {})
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
  return null
}

function TaskbarProgress() {
  useEffect(() => {
    let lastSent = ''
    const sync = () => {
      const { currentTrack, position, duration, isPlaying } = playerController.getSnapshot()
      if (!currentTrack) {
        if (lastSent) {
          lastSent = ''
          void api.setTaskbarProgress(0, 0, false).catch(() => {})
        }
        return
      }
      const seconds = Math.round(position)
      const total = Math.round(duration)
      const next = `${currentTrack.source}:${currentTrack.sourceId}:${seconds}:${total}:${isPlaying}`
      if (next === lastSent) return
      lastSent = next
      void api.setTaskbarProgress(seconds, total, isPlaying).catch(() => {})
    }
    sync()
    return playerController.subscribe(sync)
  }, [])
  return null
}

export default function AppBackgroundEffects() {
  useEffect(() => {
    likesStore.ensureLoaded()
  }, [])

  return <>
    <Shortcuts />
    <ScanWatcher />
    <LibraryChangeWatcher />
    <FolderDropWatcher />
    <TaskbarProgress />
  </>
}

import { useCallback, useEffect, useSyncExternalStore, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { api } from '../api/client'
import type { LibraryFolder } from '../types/models'
import { libraryVersion } from '../utils/libraryVersion'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface FoldersApi {
  folders: LibraryFolder[]
  loading: boolean
  error: string | null
  busy: boolean
  reload: () => void
  addFolder: () => Promise<void>
  removeFolder: (id: number) => Promise<void>
}

export function useFolders(): FoldersApi {
  const version = useSyncExternalStore(libraryVersion.subscribe, libraryVersion.get)
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false
    api
      .listLibraryFolders()
      .then((list) => {
        if (cancelled) return
        setFolders(list)
        setError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(errText(e))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tick, version])

  const addFolder = useCallback(async () => {
    setBusy(true)
    try {
      const path = await open({ directory: true })
      if (typeof path === 'string') {
        await api.addLibraryFolder(path)
        await api.rescanLibrary()
      }
      const list = await api.listLibraryFolders()
      setFolders(list)
      setError(null)
    } catch (e: unknown) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const removeFolder = useCallback(async (id: number) => {
    setBusy(true)
    try {
      await api.removeLibraryFolder(id)
      const list = await api.listLibraryFolders()
      setFolders(list)
      setError(null)
    } catch (e: unknown) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }, [])

  return { folders, loading, error, busy, reload, addFolder, removeFolder }
}

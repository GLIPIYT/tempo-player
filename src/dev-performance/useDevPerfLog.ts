import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  acknowledgeDevPerfLogBatch,
  getDevPerfLogBatch,
  getPendingDevPerfLogIds,
  isDevPerfAutoWriteEnabled,
  setDevPerfAutoWriteEnabled,
} from './metrics'

const MAX_ENTRIES_PER_CALL = 64
const MAX_AUTO_FLUSH_ENTRIES = 128

export function useDevPerfLog(capturing: boolean) {
  const [autoWrite, setAutoWrite] = useState(isDevPerfAutoWriteEnabled)
  const [saving, setSaving] = useState(false)
  const [autoWriteBlocked, setAutoWriteBlocked] = useState(false)
  const [status, setStatus] = useState('')
  const [path, setPath] = useState<string | null>(null)
  const savingRef = useRef(false)
  const autoWriteFailedRef = useRef(false)

  const save = useCallback(async (mode: 'manual' | 'automatic' = 'manual') => {
    if (savingRef.current || (mode === 'automatic' && autoWriteFailedRef.current)) return
    const queued = getPendingDevPerfLogIds()
    const ids = mode === 'automatic' ? queued.slice(0, MAX_AUTO_FLUSH_ENTRIES) : queued
    if (!ids.length) return

    savingRef.current = true
    setSaving(true)
    let saved = 0
    try {
      for (let offset = 0; offset < ids.length; offset += MAX_ENTRIES_PER_CALL) {
        const batch = ids.slice(offset, offset + MAX_ENTRIES_PER_CALL)
        const entries = getDevPerfLogBatch(batch)
        if (!entries.length) continue
        const path = await invoke<string>('dev_perf_append', { entries })
        acknowledgeDevPerfLogBatch(batch)
        saved += entries.length
        setPath(path)
      }
      autoWriteFailedRef.current = false
      setAutoWriteBlocked(false)
      if (saved) setStatus(`Saved ${saved} events`)
    } catch {
      autoWriteFailedRef.current = true
      setAutoWriteBlocked(true)
      setStatus('Could not write the log. Save log can retry.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [])

  useEffect(() => {
    if (!capturing || !autoWrite || autoWriteBlocked) return
    const timer = window.setInterval(() => { void save('automatic') }, 2500)
    return () => window.clearInterval(timer)
  }, [capturing, autoWrite, autoWriteBlocked, save])

  function toggleAutoWrite(enabled: boolean) {
    if (enabled) {
      autoWriteFailedRef.current = false
      setAutoWriteBlocked(false)
    }
    setDevPerfAutoWriteEnabled(enabled)
    setAutoWrite(isDevPerfAutoWriteEnabled())
  }

  return { autoWrite, toggleAutoWrite, saving, save, path, status }
}

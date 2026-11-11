import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { startDevPerfCapture } from './metrics'

type Phase = 'idle' | 'starting' | 'recording' | 'saving'
const MAX_RECORDING_MS = 60_000

function errorMessage(error: unknown, fallback: string): string {
  return typeof error === 'string' && error ? error.slice(0, 240) : fallback
}

export function useDevCpuTrace() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [path, setPath] = useState<string | null>(null)
  const [error, setError] = useState('')
  const currentPhase = useRef<Phase>('idle')
  const timer = useRef<number | undefined>(undefined)

  const changePhase = useCallback((next: Phase) => {
    currentPhase.current = next
    setPhase(next)
  }, [])

  const stop = useCallback(async () => {
    if (currentPhase.current !== 'recording') return
    window.clearTimeout(timer.current)
    timer.current = undefined
    changePhase('saving')
    setError('')
    try {
      setPath(await invoke<string>('dev_perf_stop_trace'))
    } catch (error) {
      setError(errorMessage(error, 'Could not save the CPU profile.'))
    } finally {
      changePhase('idle')
    }
  }, [changePhase])

  const start = useCallback(async () => {
    if (currentPhase.current !== 'idle') return
    changePhase('starting')
    setError('')
    try {
      await invoke('dev_perf_start_trace')
      startDevPerfCapture()
      changePhase('recording')
      timer.current = window.setTimeout(() => { void stop() }, MAX_RECORDING_MS)
    } catch (error) {
      setError(errorMessage(error, 'Could not start the CPU profiler.'))
      changePhase('idle')
    }
  }, [changePhase, stop])

  useEffect(() => () => {
    window.clearTimeout(timer.current)
    if (currentPhase.current === 'recording') {
      void invoke('dev_perf_stop_trace').catch(() => {})
    }
  }, [])

  return {
    phase,
    path,
    error,
    recording: phase === 'recording',
    pending: phase === 'starting' || phase === 'saving',
    available: isTauri(),
    start,
    stop,
  }
}

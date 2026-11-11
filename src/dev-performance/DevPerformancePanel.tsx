import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import {
  acknowledgeDevPerfLogBatch,
  getDevPerfLogBatch,
  getDevPerfSnapshot,
  getPendingDevPerfLogIds,
  isDevPerfAutoStartEnabled,
  isDevPerfAutoWriteEnabled,
  startDevPerfCapture,
  stopDevPerfCapture,
  subscribeDevPerf,
  setDevPerfAutoStartEnabled,
  setDevPerfAutoWriteEnabled,
  type DevPerfKind,
} from './metrics'
import './devPerformance.css'

const MAX_ENTRIES_PER_CALL = 64
const MAX_AUTO_FLUSH_ENTRIES = 128

const KIND_LABELS: Record<DevPerfKind, string> = {
  react: 'React render',
  longtask: 'Long task',
  'frame-gap': 'Frame gap',
  'event-loop': 'Event loop',
}

function DevPerformancePanel() {
  const snapshot = useSyncExternalStore(subscribeDevPerf, getDevPerfSnapshot, getDevPerfSnapshot)
  const [collapsed, setCollapsed] = useState(true)
  const [autoStart, setAutoStart] = useState(isDevPerfAutoStartEnabled)
  const [autoWrite, setAutoWrite] = useState(isDevPerfAutoWriteEnabled)
  const [saving, setSaving] = useState(false)
  const [autoWriteBlocked, setAutoWriteBlocked] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [logPath, setLogPath] = useState<string | null>(null)
  const savingRef = useRef(false)
  const autoWriteFailedRef = useRef(false)

  useEffect(() => () => stopDevPerfCapture(), [])

  const counts = useMemo(() => ({
    react: snapshot.entries.filter(entry => entry.kind === 'react').length,
    longtask: snapshot.entries.filter(entry => entry.kind === 'longtask').length,
    frameGap: snapshot.entries.filter(entry => entry.kind === 'frame-gap').length,
    eventLoop: snapshot.entries.filter(entry => entry.kind === 'event-loop').length,
  }), [snapshot.entries])

  const saveLog = useCallback(async (mode: 'manual' | 'automatic' = 'manual') => {
    if (savingRef.current || (mode === 'automatic' && autoWriteFailedRef.current)) return
    const queuedIds = getPendingDevPerfLogIds()
    const pendingIds = mode === 'automatic' ? queuedIds.slice(0, MAX_AUTO_FLUSH_ENTRIES) : queuedIds
    if (!pendingIds.length) {
      if (mode === 'manual') setSaveStatus('No queued events to save.')
      return
    }

    savingRef.current = true
    setSaving(true)
    if (mode === 'manual') setSaveStatus('')
    let savedCount = 0
    try {
      for (let offset = 0; offset < pendingIds.length; offset += MAX_ENTRIES_PER_CALL) {
        const ids = pendingIds.slice(offset, offset + MAX_ENTRIES_PER_CALL)
        const entries = getDevPerfLogBatch(ids)
        if (!entries.length) continue
        const path = await invoke<string>('dev_perf_append', { entries })
        acknowledgeDevPerfLogBatch(ids)
        savedCount += entries.length
        setLogPath(path.slice(0, 512))
      }
      if (savedCount) {
        autoWriteFailedRef.current = false
        setAutoWriteBlocked(false)
        setSaveStatus(`Saved ${savedCount} events.`)
      } else if (mode === 'manual') {
        setSaveStatus('No queued events to save.')
      }
    } catch {
      autoWriteFailedRef.current = true
      setAutoWriteBlocked(true)
      setSaveStatus('Desktop logging failed; events remain queued. Manual Save log can retry.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [])

  useEffect(() => {
    if (!snapshot.capturing || !autoWrite || autoWriteBlocked) return
    const timer = window.setInterval(() => { void saveLog('automatic') }, 2500)
    return () => window.clearInterval(timer)
  }, [snapshot.capturing, autoWrite, autoWriteBlocked, saveLog])

  const toggleCapture = () => {
    if (snapshot.capturing) {
      stopDevPerfCapture()
    } else {
      setSaveStatus('')
      startDevPerfCapture()
    }
  }

  const toggleAutoStart = (enabled: boolean) => {
    setDevPerfAutoStartEnabled(enabled)
    setAutoStart(isDevPerfAutoStartEnabled())
  }

  const toggleAutoWrite = (enabled: boolean) => {
    if (enabled) autoWriteFailedRef.current = false
    if (enabled) setAutoWriteBlocked(false)
    setDevPerfAutoWriteEnabled(enabled)
    setAutoWrite(isDevPerfAutoWriteEnabled())
  }

  const recentEntries = [...snapshot.entries].reverse().slice(0, 16)

  if (collapsed) {
    return (
      <button
        type="button"
        className="tempo-dev-perf-pill"
        aria-expanded="false"
        aria-label="Expand development performance panel"
        onClick={() => setCollapsed(false)}
      >
        <span className={`tempo-dev-perf-dot${snapshot.capturing ? ' is-capturing' : ''}`} />
        <span>Dev perf</span>
        {snapshot.capturing ? <span className="tempo-dev-perf-live">CAPTURING</span> : null}
      </button>
    )
  }

  return (
    <section className="tempo-dev-perf-panel" aria-label="Development performance diagnostics">
      <header className="tempo-dev-perf-header">
        <div>
          <strong>Dev performance</strong>
          <span className={`tempo-dev-perf-state${snapshot.capturing ? ' is-capturing' : ''}`}>
            {snapshot.capturing ? 'Capturing' : 'Stopped'}
          </span>
        </div>
        <button type="button" className="tempo-dev-perf-icon-button" aria-label="Collapse panel" onClick={() => setCollapsed(true)}>−</button>
      </header>

      <p className="tempo-dev-perf-explainer">
        React rows show Profiler render duration. Other rows measure browser stalls.
      </p>

      <div className="tempo-dev-perf-counts" aria-label="Recent event counts">
        <div><span>React renders</span><strong>{counts.react}</strong></div>
        <div><span>Long tasks</span><strong>{counts.longtask}</strong></div>
        <div><span>Frame gaps</span><strong>{counts.frameGap}</strong></div>
        <div><span>Event-loop delays</span><strong>{counts.eventLoop}</strong></div>
      </div>

      <div className="tempo-dev-perf-actions">
        <button type="button" className="tempo-dev-perf-primary" onClick={toggleCapture}>
          {snapshot.capturing ? 'Stop capture' : 'Start capture'}
        </button>
        <button type="button" onClick={() => void saveLog()} disabled={saving || snapshot.queuedEntries === 0}>
          {saving ? 'Saving…' : `Save log (${snapshot.queuedEntries})`}
        </button>
      </div>

      <label className="tempo-dev-perf-autostart">
        <input type="checkbox" checked={autoStart} onChange={event => toggleAutoStart(event.target.checked)} />
        Capture automatically on dev launch
      </label>
      <label className="tempo-dev-perf-autostart">
        <input type="checkbox" checked={autoWrite} onChange={event => toggleAutoWrite(event.target.checked)} />
        Write to log during capture
      </label>

      <div className="tempo-dev-perf-list-wrap">
        {recentEntries.length ? (
          <ul className="tempo-dev-perf-list">
            {recentEntries.map((entry, index) => (
              <li key={`${entry.atMs}-${entry.kind}-${index}`}>
                <time>{(entry.atMs / 1000).toFixed(2)}s</time>
                <span className={`tempo-dev-perf-kind is-${entry.kind}`}>{KIND_LABELS[entry.kind]}</span>
                <span className="tempo-dev-perf-label" title={entry.label}>{entry.label}</span>
                <strong>{entry.durationMs.toFixed(0)} ms</strong>
              </li>
            ))}
          </ul>
        ) : (
          <div className="tempo-dev-perf-empty">Start capture to collect timings.</div>
        )}
      </div>

      <div className="tempo-dev-perf-footer" role="status">
        {snapshot.droppedLogEntries ? `${snapshot.droppedLogEntries} log events dropped at queue limit. ` : ''}
        {saveStatus}
      </div>
      {logPath ? (
        <div className="tempo-dev-perf-log-path">
          <span>Log file</span>
          <code title={logPath}>{logPath}</code>
        </div>
      ) : null}
    </section>
  )
}

export function mountDevPerformancePanel(): void {
  if (!import.meta.env.DEV || document.getElementById('tempo-dev-performance-root')) return
  const container = document.createElement('div')
  container.id = 'tempo-dev-performance-root'
  document.body.append(container)
  createRoot(container).render(<DevPerformancePanel />)
}

export { startDevPerfCapture as startDevPerformanceCapture } from './metrics'

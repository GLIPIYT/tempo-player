import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, ChevronLeft, ChevronRight, Circle, Cpu, Download, Square, X } from 'lucide-react'
import {
  getDevPerfSnapshot,
  isDevPerfAutoStartEnabled,
  startDevPerfCapture,
  stopDevPerfCapture,
  subscribeDevPerf,
  setDevPerfAutoStartEnabled,
  type DevPerfEntry,
  type DevPerfKind,
} from './metrics'
import { useDevPerfLog } from './useDevPerfLog'
import { useDevCpuTrace } from './useDevCpuTrace'
import './devPerformance.css'

const KIND_LABELS: Record<DevPerfKind, string> = {
  react: 'React',
  longtask: 'Task',
  'long-frame': 'Long frame',
  'frame-gap': 'Frame gap',
  'event-loop': 'Event loop',
}

function milliseconds(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`
  return `${value > 0 && value < 10 ? value.toFixed(1) : Math.round(value)} ms`
}

const EventRow = memo(function EventRow({ entry }: { entry: DevPerfEntry }) {
  const { kind, label, atMs, durationMs, scripts, blockingMs, renderMs, styleAndLayoutMs } = entry
  const content = <>
    <time title="Time since window opened">{(atMs / 1000).toFixed(2)}s</time>
    <span className={`tempo-perf-kind is-${kind}`}>{KIND_LABELS[kind]}</span>
    <span className="tempo-perf-event-label" title={label}>{kind === 'react' ? label.replace('page:', '') : label}</span>
    <strong className={durationMs >= 150 ? 'is-spike' : ''}>{milliseconds(durationMs)}</strong>
  </>
  const timings = [
    ['Blocking', blockingMs],
    ['Rendering', renderMs],
    ['Style / layout', styleAndLayoutMs],
  ] as const
  const hasDetails = timings.some(([, value]) => value !== undefined) || Boolean(scripts?.length)
  return <li>
    {hasDetails ? (
      <details className="tempo-perf-event-details">
        <summary className="tempo-perf-event-row">{content}<ChevronRight size={12} className="tempo-perf-detail-arrow" /></summary>
        <div className="tempo-perf-attribution">
          <div className="tempo-perf-breakdown">
            {timings.map(([name, value]) => value !== undefined && <span key={name}>{name} <b>{milliseconds(value)}</b></span>)}
          </div>
          {scripts?.map((script, index) => (
            <div className="tempo-perf-script" key={`${script.source}:${script.sourceCharPosition}:${index}`}>
              <div><b>{script.functionName || '(anonymous)'}</b><span>{milliseconds(script.durationMs)}</span></div>
              <code title={script.source}>{script.source}{script.sourceCharPosition >= 0 ? ` · char ${script.sourceCharPosition}` : ''}</code>
              {script.forcedStyleAndLayoutMs > 0 && <small>Forced layout {milliseconds(script.forcedStyleAndLayoutMs)}</small>}
            </div>
          ))}
        </div>
      </details>
    ) : <div className="tempo-perf-event-row">{content}</div>}
  </li>
})

function SavedFile({ label, path }: { label: string; path: string }) {
  return <div className="tempo-perf-file"><span>{label}</span><code title={path}>{path}</code></div>
}

function DevPerformancePanel() {
  const snapshot = useSyncExternalStore(subscribeDevPerf, getDevPerfSnapshot, getDevPerfSnapshot)
  const [open, setOpen] = useState(false)
  const [allEvents, setAllEvents] = useState(false)
  const [autoStart, setAutoStart] = useState(isDevPerfAutoStartEnabled)
  const edge = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const log = useDevPerfLog(snapshot.capturing)
  const trace = useDevCpuTrace()
  const active = snapshot.capturing || trace.recording

  useEffect(() => () => stopDevPerfCapture(), [])

  const totals = useMemo(() => {
    let peak = 0
    let react = 0
    for (const entry of snapshot.entries) {
      if (entry.kind === 'react') react = Math.max(react, entry.durationMs)
      else if (entry.kind !== 'event-loop') peak = Math.max(peak, entry.durationMs)
    }
    return { peak, react }
  }, [snapshot.entries])

  const entries = useMemo(() => {
    const occurrences = new Map<string, number>()
    return snapshot.entries
      .filter(entry => allEvents || entry.kind !== 'react' || entry.durationMs >= 16)
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, 24)
      .map(entry => {
        const id = `${entry.atMs}-${entry.kind}-${entry.label}-${entry.durationMs}`
        const occurrence = occurrences.get(id) ?? 0
        occurrences.set(id, occurrence + 1)
        return { entry, key: `${id}-${occurrence}` }
      })
  }, [allEvents, snapshot.entries])

  function collapse() {
    setOpen(false)
    edge.current?.focus()
  }

  function toggleAutoStart(enabled: boolean) {
    setDevPerfAutoStartEnabled(enabled)
    setAutoStart(isDevPerfAutoStartEnabled())
  }

  function toggleCapture() {
    if (snapshot.capturing) {
      stopDevPerfCapture()
      if (log.autoWrite) void log.save()
    } else {
      startDevPerfCapture()
    }
  }

  return <>
    <button
      ref={edge}
      type="button"
      className={`tempo-perf-edge${active ? ' is-active' : ''}`}
      aria-expanded={open}
      aria-controls="tempo-perf-panel"
      aria-label={open ? 'Collapse performance panel' : 'Expand development performance panel'}
      title={open ? 'Collapse performance panel' : 'Dev performance'}
      onClick={() => {
        if (open) collapse()
        else {
          setOpen(true)
          requestAnimationFrame(() => panel.current?.focus())
        }
      }}
    >
      {active && <span className="tempo-perf-edge-light" />}
      {open ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
    </button>

    {open && (
      <section
        ref={panel}
        tabIndex={-1}
        id="tempo-perf-panel"
        className="tempo-perf-panel"
        aria-labelledby="tempo-perf-title"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            collapse()
          }
        }}
      >
        <header className="tempo-perf-header">
          <span className="tempo-perf-heading-icon"><Activity size={17} /></span>
          <h2 id="tempo-perf-title">Dev performance</h2>
          <span className={`tempo-perf-state${active ? ' is-active' : ''}`}>
            <span />{trace.recording ? 'Profiling' : snapshot.capturing ? 'Capturing' : 'Stopped'}
          </span>
          <button type="button" className="tempo-perf-close" onClick={collapse} aria-label="Collapse panel"><X size={16} /></button>
        </header>

        <div className="tempo-perf-content">
          <div className="tempo-perf-metrics">
            <div><span>Longest task / frame</span><strong className={totals.peak >= 150 ? 'is-spike' : ''}>{totals.peak ? milliseconds(totals.peak) : '—'}</strong></div>
            <div><span>Slowest React render</span><strong className={totals.react >= 16 ? 'is-spike' : ''}>{totals.react ? milliseconds(totals.react) : '—'}</strong></div>
          </div>

          <div className="tempo-perf-actions">
            <button type="button" className="tempo-perf-primary" onClick={toggleCapture} disabled={trace.recording || trace.pending}>
              {snapshot.capturing ? <Square size={13} /> : <Circle size={13} />} {snapshot.capturing ? 'Stop capture' : 'Start capture'}
            </button>
            <button type="button" onClick={() => void log.save()} disabled={log.saving || snapshot.queuedEntries === 0}>
              <Download size={13} /> {log.saving ? 'Saving…' : `Save log (${snapshot.queuedEntries})`}
            </button>
          </div>

          <div className="tempo-perf-profile">
            <Cpu size={17} />
            <div><strong>CPU profile</strong><span>{trace.available ? 'JavaScript call stacks · up to 60 s' : 'Available in the desktop dev build'}</span></div>
            <button type="button" className={trace.recording ? 'tempo-perf-primary' : ''} disabled={!trace.available || trace.pending}
              onClick={() => void (trace.recording ? trace.stop() : trace.start())}>
              {trace.phase === 'starting' ? 'Starting…' : trace.phase === 'saving' ? 'Saving…' : trace.recording ? 'Save profile' : 'Record profile'}
            </button>
          </div>

          <div className="tempo-perf-options">
            <label><input type="checkbox" checked={autoStart} onChange={event => toggleAutoStart(event.target.checked)} /> Capture on launch</label>
            <label><input type="checkbox" checked={log.autoWrite} onChange={event => log.toggleAutoWrite(event.target.checked)} /> Write to log during capture</label>
          </div>
        </div>

        <div className="tempo-perf-timeline-head">
          <h3>Timeline</h3>
          <div className="tempo-perf-filter" role="group" aria-label="Timeline filter">
            <button type="button" aria-pressed={!allEvents} onClick={() => setAllEvents(false)}>Spikes</button>
            <button type="button" aria-pressed={allEvents} onClick={() => setAllEvents(true)}>All</button>
          </div>
        </div>
        <div className="tempo-perf-timeline">
          {entries.length ? (
            <ul>{entries.map(({ entry, key }) => <EventRow key={key} entry={entry} />)}</ul>
          ) : <p>{snapshot.capturing ? (allEvents ? 'Waiting for events…' : 'No spikes recorded yet') : 'Start a capture to see timings'}</p>}
        </div>

        {(log.path || trace.path || log.status || trace.error || snapshot.droppedLogEntries > 0) && <footer className="tempo-perf-footer">
          {log.path && <SavedFile label="Log" path={log.path} />}
          {trace.path && <SavedFile label="CPU profile" path={trace.path} />}
          <div role="status">{trace.error || log.status}{snapshot.droppedLogEntries > 0 && ` · ${snapshot.droppedLogEntries} events dropped`}</div>
        </footer>}
      </section>
    )}
  </>
}

export function mountDevPerformancePanel(): void {
  if (!import.meta.env.DEV || document.getElementById('tempo-dev-performance-root')) return
  const container = document.createElement('div')
  container.id = 'tempo-dev-performance-root'
  document.body.append(container)
  createRoot(container).render(<DevPerformancePanel />)
}

export { startDevPerfCapture as startDevPerformanceCapture } from './metrics'

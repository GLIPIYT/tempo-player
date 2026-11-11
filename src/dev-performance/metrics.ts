import type { ProfilerOnRenderCallback } from 'react'
import type { View } from '../state/nav'

export type DevProfileId = 'player' | 'lyrics' | 'updates' | `page:${View['name']}`
export type DevPerfKind = 'react' | 'longtask' | 'frame-gap' | 'event-loop'

export interface DevPerfEntry {
  kind: DevPerfKind
  label: string
  durationMs: number
  atMs: number
}

export interface DevPerfSnapshot {
  capturing: boolean
  entries: readonly DevPerfEntry[]
  queuedEntries: number
  droppedLogEntries: number
}

const MAX_VISIBLE_ENTRIES = 300
const MAX_QUEUED_ENTRIES = 512
const FRAME_GAP_THRESHOLD_MS = 150
const EVENT_LOOP_INTERVAL_MS = 500
const EVENT_LOOP_THRESHOLD_MS = 250
const MAX_DURATION_MS = 60_000
export const DEV_PERF_AUTO_START_KEY = 'tempo.devPerformance.autoStart.v1'
const AUTO_WRITE_KEY = 'tempo.devPerformance.writeDuringCapture.v1'

const REACT_LABELS = new Set([
  'player', 'lyrics', 'updates',
  'page:home', 'page:library', 'page:albums', 'page:artists', 'page:playlists',
  'page:profile', 'page:settings', 'page:search', 'page:album', 'page:artist',
  'page:local-artist', 'page:playlist', 'page:hour-mix', 'page:sc-playlist',
  'page:sc-artist', 'page:yt-collection', 'page:track-details',
])

interface QueuedEntry {
  sequence: number
  entry: DevPerfEntry
}

const listeners = new Set<() => void>()
let isCapturing = false
let recentEntries: DevPerfEntry[] = []
let logQueue: QueuedEntry[] = []
let nextSequence = 0
let droppedLogEntries = 0
let snapshotTimer = 0
let longTaskObserver: PerformanceObserver | null = null
let frameRequest: number | null = null
let eventLoopTimer: number | null = null
let visibilityHandler: (() => void) | null = null
let lastVisibleFrameAt: number | null = null
let nextEventLoopAt = 0

let snapshot: DevPerfSnapshot = {
  capturing: false,
  entries: [],
  queuedEntries: 0,
  droppedLogEntries: 0,
}

export function subscribeDevPerf(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getDevPerfSnapshot(): DevPerfSnapshot {
  return snapshot
}

function publishSnapshot(): void {
  if (snapshotTimer) {
    window.clearTimeout(snapshotTimer)
    snapshotTimer = 0
  }
  snapshot = {
    capturing: isCapturing,
    entries: [...recentEntries],
    queuedEntries: logQueue.length,
    droppedLogEntries,
  }
  for (const listener of listeners) listener()
}

function scheduleSnapshot(): void {
  if (snapshotTimer) return
  snapshotTimer = window.setTimeout(() => {
    snapshotTimer = 0
    publishSnapshot()
  }, 250)
}

function safeDuration(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_DURATION_MS, Math.max(0, value)) : 0
}

function recordEvent(kind: DevPerfKind, label: string, durationMs: number, atMs: number): void {
  if (!isCapturing) return

  const entry: DevPerfEntry = {
    kind,
    label: label.slice(0, 96),
    durationMs: safeDuration(durationMs),
    atMs: Number.isFinite(atMs) ? Math.max(0, atMs) : performance.now(),
  }
  recentEntries.push(entry)
  if (recentEntries.length > MAX_VISIBLE_ENTRIES) recentEntries.shift()

  if (logQueue.length >= MAX_QUEUED_ENTRIES) {
    logQueue.shift()
    droppedLogEntries = Math.min(Number.MAX_SAFE_INTEGER, droppedLogEntries + 1)
  }
  logQueue.push({ sequence: ++nextSequence, entry })
  scheduleSnapshot()
}

export const recordReactCommit: ProfilerOnRenderCallback = (id, _phase, actualDuration, _baseDuration, _startTime, commitTime) => {
  if (!REACT_LABELS.has(id)) return
  recordEvent('react', id, actualDuration, commitTime)
}

function scheduleFrameWatchdog(): void {
  if (!isCapturing || document.visibilityState !== 'visible' || frameRequest !== null) return
  frameRequest = window.requestAnimationFrame(measureFrame)
}

function measureFrame(atMs: number): void {
  frameRequest = null
  if (!isCapturing || document.visibilityState !== 'visible') {
    lastVisibleFrameAt = null
    return
  }

  if (lastVisibleFrameAt !== null) {
    const gap = atMs - lastVisibleFrameAt
    if (gap >= FRAME_GAP_THRESHOLD_MS) recordEvent('frame-gap', 'visible frame gap', gap, atMs)
  }
  lastVisibleFrameAt = atMs
  scheduleFrameWatchdog()
}

function onVisibilityChange(): void {
  lastVisibleFrameAt = null
  nextEventLoopAt = performance.now() + EVENT_LOOP_INTERVAL_MS
  if (document.visibilityState === 'visible') {
    scheduleFrameWatchdog()
  } else if (frameRequest !== null) {
    window.cancelAnimationFrame(frameRequest)
    frameRequest = null
  }
}

export function startDevPerfCapture(): void {
  if (isCapturing) return
  recentEntries = []
  isCapturing = true
  publishSnapshot()

  try {
    if (typeof PerformanceObserver !== 'undefined') {
      longTaskObserver = new PerformanceObserver(list => {
        if (document.visibilityState !== 'visible') return
        for (const entry of list.getEntries()) {
          recordEvent('longtask', 'main-thread long task', entry.duration, entry.startTime)
        }
      })
      longTaskObserver.observe({ entryTypes: ['longtask'] })
    }
  } catch {
    longTaskObserver?.disconnect()
    longTaskObserver = null
  }

  visibilityHandler = onVisibilityChange
  document.addEventListener('visibilitychange', visibilityHandler)
  nextEventLoopAt = performance.now() + EVENT_LOOP_INTERVAL_MS
  eventLoopTimer = window.setInterval(() => {
    const now = performance.now()
    const lag = now - nextEventLoopAt
    nextEventLoopAt = now + EVENT_LOOP_INTERVAL_MS
    if (document.visibilityState === 'visible' && lag >= EVENT_LOOP_THRESHOLD_MS) {
      recordEvent('event-loop', 'visible event-loop delay', lag, now)
    }
  }, EVENT_LOOP_INTERVAL_MS)
  scheduleFrameWatchdog()
}

export function stopDevPerfCapture(): void {
  if (!isCapturing) return
  isCapturing = false
  longTaskObserver?.disconnect()
  longTaskObserver = null
  if (frameRequest !== null) window.cancelAnimationFrame(frameRequest)
  frameRequest = null
  if (eventLoopTimer !== null) window.clearInterval(eventLoopTimer)
  eventLoopTimer = null
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
  visibilityHandler = null
  lastVisibleFrameAt = null
  publishSnapshot()
}

export function isDevPerfAutoStartEnabled(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    return window.localStorage.getItem(DEV_PERF_AUTO_START_KEY) === '1'
  } catch {
    return false
  }
}

export function setDevPerfAutoStartEnabled(enabled: boolean): void {
  if (!import.meta.env.DEV) return
  try {
    if (enabled) window.localStorage.setItem(DEV_PERF_AUTO_START_KEY, '1')
    else window.localStorage.removeItem(DEV_PERF_AUTO_START_KEY)
  } catch {
    /* local storage is optional */
  }
}

export function isDevPerfAutoWriteEnabled(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    return window.localStorage.getItem(AUTO_WRITE_KEY) === '1'
  } catch {
    return false
  }
}

export function setDevPerfAutoWriteEnabled(enabled: boolean): void {
  if (!import.meta.env.DEV) return
  try {
    if (enabled) window.localStorage.setItem(AUTO_WRITE_KEY, '1')
    else window.localStorage.removeItem(AUTO_WRITE_KEY)
  } catch {
    /* local storage is optional */
  }
}

export function getPendingDevPerfLogIds(): number[] {
  return logQueue.map(item => item.sequence)
}

export function getDevPerfLogBatch(ids: readonly number[]): DevPerfEntry[] {
  const requested = new Set(ids)
  return logQueue.filter(item => requested.has(item.sequence)).map(item => item.entry)
}

export function acknowledgeDevPerfLogBatch(ids: readonly number[]): void {
  const acknowledged = new Set(ids)
  logQueue = logQueue.filter(item => !acknowledged.has(item.sequence))
  publishSnapshot()
}

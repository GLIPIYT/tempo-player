import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, ChevronDown, Clock3, GripVertical, MicVocal, MoreHorizontal, Pause, Play, Plus, Save, Search, SkipBack, SkipForward, Trash2 } from 'lucide-react'
import { subscribeSpectrum } from '../../audio/spectrum'
import { getEngine } from '../../player/engine'
import { useT } from '../../i18n'
import {
  fromPlainLyrics,
  cloneLyricsDocument,
  editSyncedLineTime,
  setSyncedLineText,
  setSyncedLineTimeAtPlaybackPosition,
  toPlainText,
  validateLyricsDocument,
} from './editorDocument'
import type {
  LyricsEditorDocument,
  LyricsEditorIssue,
  SyncedLyricsDocument,
} from './editorDocument'
import { estimateVocalActivity, findVocalActivitySegments } from './vocalActivity'
import type { VocalActivitySample } from './vocalActivity'
import './lyrics-editor.css'

export interface LyricsEditorSourceOption {
  id: string
  label: string
  document: LyricsEditorDocument
}

export interface LyricsEditorPanelProps {
  initialDocument: LyricsEditorDocument
  initialSourceId?: string | null
  sourceOptions: LyricsEditorSourceOption[]
  durationMs?: number | null
  currentTimeSec: number
  isPlaying: boolean
  playbackRate: number
  onSeek: (timeSec: number) => void
  onTogglePlayback: () => void
  onPlaybackRateChange: (rate: number) => void
  onSave: (document: LyricsEditorDocument, sourceId: string | null) => void | Promise<void>
  onPublish?: (document: LyricsEditorDocument, sourceId: string | null) => void | Promise<void>
  onCancel: () => void
  saving?: boolean
  publishing?: boolean
}

type TimeField = 'startMs' | 'endMs'
type TimeDraft = { start: string; end: string }
type LocalAction = 'save' | 'publish' | null

function cloneDocument(document: LyricsEditorDocument): LyricsEditorDocument {
  return cloneLyricsDocument(document)
}

function formatTimecode(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return ''
  const centiseconds = Math.round(milliseconds / 10)
  const minutes = Math.floor(centiseconds / 6000)
  const seconds = Math.floor((centiseconds % 6000) / 100)
  const fraction = centiseconds % 100
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`
}

function readPlaybackPositionMs(fallbackPositionSec: number): number {
  const engineTime = getEngine()?.getCurrentTime()
  const positionSec = Number.isFinite(engineTime) ? engineTime! : fallbackPositionSec
  return Number.isFinite(positionSec) ? Math.max(0, Math.round(positionSec * 1000)) : 0
}

function parseTimecode(value: string): number {
  const match = value.trim().match(/^(\d{1,4}):([0-5]?\d)(?:[.,](\d{1,3}))?$/)
  if (!match) return Number.NaN
  const fraction = match[3] ?? ''
  const fractionMs = fraction ? Number.parseInt(fraction.padEnd(3, '0'), 10) : 0
  return Number.parseInt(match[1], 10) * 60_000 + Number.parseInt(match[2], 10) * 1000 + fractionMs
}

function makeTimeDrafts(document: LyricsEditorDocument): TimeDraft[] {
  if (document.mode !== 'synced') return []
  return document.lines.map((line) => ({
    start: formatTimecode(line.startMs),
    end: formatTimecode(line.endMs),
  }))
}

function plainToSynced(document: Extract<LyricsEditorDocument, { mode: 'plain' }>, durationMs?: number | null): SyncedLyricsDocument {
  const duration = Number.isFinite(durationMs) && (durationMs ?? 0) > 0 ? Math.round(durationMs!) : null
  const interval = duration === null ? null : duration / Math.max(document.lines.length, 1)
  return {
    mode: 'synced',
    lines: document.lines.map((line, index) => {
      const startMs = interval === null ? index * 3000 : Math.round(index * interval)
      return {
        text: line.text,
        startMs,
        endMs: null,
        endOrigin: 'auto',
        ...(line.text.trim() ? {} : { explicitPause: true }),
      }
    }),
  }
}

function issueMessage(issue: LyricsEditorIssue, t: (key: string) => string): string {
  switch (issue.code) {
    case 'empty_document':
      return t('Add at least one lyric line')
    case 'invalid_line':
      return t('Fix the invalid lyric line')
    case 'invalid_start':
      return t('Enter a valid start time')
    case 'invalid_end':
      return t('Enter a valid end time')
    case 'end_before_start':
      return t('End time must be after start time')
    case 'start_after_duration':
      return t('Line starts after the track ends')
    case 'end_after_duration':
      return t('Line ends after the track ends')
    case 'lines_not_sorted':
      return t('Sort lines by start time')
  }
}

export default function LyricsEditorPanel({
  initialDocument,
  initialSourceId,
  sourceOptions,
  durationMs,
  currentTimeSec,
  isPlaying,
  playbackRate,
  onSeek,
  onTogglePlayback,
  onPlaybackRateChange,
  onSave,
  onPublish,
  onCancel,
  saving = false,
  publishing = false,
}: LyricsEditorPanelProps) {
  const t = useT()
  const id = useId()
  const publishMenuRef = useRef<HTMLDetailsElement>(null)
  const sourcePickerRef = useRef<HTMLDivElement>(null)
  const initialDocumentJson = JSON.stringify(initialDocument)
  const [document, setDocument] = useState<LyricsEditorDocument>(() => cloneDocument(initialDocument))
  const [timeDrafts, setTimeDrafts] = useState<TimeDraft[]>(() => makeTimeDrafts(initialDocument))
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [localAction, setLocalAction] = useState<LocalAction>(null)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [sourceQuery, setSourceQuery] = useState('')
  const [dragOverLine, setDragOverLine] = useState<number | null>(null)
  const dragLineIndex = useRef<number | null>(null)
  const pointerDragCleanup = useRef<(() => void) | null>(null)
  const vocalSamples = useRef<VocalActivitySample[]>([])
  const vocalFrequencyBins = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const initialPlaybackRate = useRef(playbackRate).current

  useEffect(() => () => pointerDragCleanup.current?.(), [])

  useEffect(() => {
    const next = JSON.parse(initialDocumentJson) as LyricsEditorDocument
    setDocument(next)
    setTimeDrafts(makeTimeDrafts(next))
    setSelectedSourceId(initialSourceId ?? '')
    setSourceOpen(false)
    setSourceQuery('')
    setActionError('')
    setActionNotice('')
  }, [initialDocumentJson, initialSourceId])

  useEffect(() => {
    if (!sourceOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (sourcePickerRef.current && !sourcePickerRef.current.contains(event.target as Node)) {
        setSourceOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setSourceOpen(false)
      }
    }
    window.document.addEventListener('pointerdown', onPointerDown)
    window.document.addEventListener('keydown', onKeyDown)
    return () => {
      window.document.removeEventListener('pointerdown', onPointerDown)
      window.document.removeEventListener('keydown', onKeyDown)
    }
  }, [sourceOpen])

  const issues = useMemo(() => validateLyricsDocument(document, durationMs), [document, durationMs])
  const firstIssue = issues[0]
  const validationText = firstIssue ? issueMessage(firstIssue, t) : ''
  const saveBusy = saving || localAction === 'save'
  const publishBusy = publishing || localAction === 'publish'
  const busy = saveBusy || publishBusy
  const invalidLineIndexes = new Set(issues.flatMap((issue) => issue.lineIndex === undefined ? [] : [issue.lineIndex]))
  const selectedSource = sourceOptions.find((source) => source.id === selectedSourceId)
  const filteredSources = sourceOptions.filter((source) => source.label.toLocaleLowerCase().includes(sourceQuery.trim().toLocaleLowerCase()))
  const currentPositionMs = Number.isFinite(currentTimeSec) ? Math.max(0, Math.round(currentTimeSec * 1000)) : null
  const trackDurationMs = Number.isFinite(durationMs) && (durationMs ?? 0) > 0 ? Math.round(durationMs!) : null
  const playbackSpeedMax = Math.max(1, initialPlaybackRate)
  const activeLineIndex = document.mode === 'synced'
    ? document.lines.reduce((latest, line, index) => line.startMs <= (currentPositionMs ?? 0) ? index : latest, -1)
    : -1

  const replaceDocument = (next: LyricsEditorDocument): void => {
    setDocument(next)
    setTimeDrafts(makeTimeDrafts(next))
    setActionError('')
    setActionNotice('')
  }

  const changeMode = (mode: LyricsEditorDocument['mode']): void => {
    if (document.mode === mode) return
    if (mode === 'plain' && document.mode === 'synced') {
      replaceDocument(fromPlainLyrics(toPlainText(document)))
      return
    }
    if (mode === 'synced' && document.mode === 'plain') {
      replaceDocument(plainToSynced(document, durationMs))
    }
  }

  const selectSource = (sourceId: string): void => {
    setSelectedSourceId(sourceId)
    setSourceOpen(false)
    setSourceQuery('')
    setActionError('')
    setActionNotice('')
    const source = sourceOptions.find((option) => option.id === sourceId)
    if (source) replaceDocument(cloneDocument(source.document))
  }

  const setLineTimeToCurrentPosition = (lineIndex: number, field: TimeField): void => {
    if (document.mode !== 'synced') return
    const timeMs = readPlaybackPositionMs(currentTimeSec)
    const currentLine = document.lines[lineIndex]
    if (!currentLine || (field === 'endMs' && timeMs <= currentLine.startMs)) return
    const clearEnd = field === 'startMs' && currentLine.endMs !== null && currentLine.endMs <= timeMs
    setDocument((current) => current.mode === 'synced'
      ? setSyncedLineTimeAtPlaybackPosition(current, lineIndex, field, timeMs)
      : current)
    setTimeDrafts((current) => current.map((draft, index) => index === lineIndex
      ? {
          ...draft,
          [field === 'startMs' ? 'start' : 'end']: formatTimecode(timeMs),
          ...(clearEnd ? { end: '' } : {}),
        }
      : draft))
    setActionError('')
    setActionNotice('')
  }

  const editSyncedText = (lineIndex: number, text: string): void => {
    setDocument((current) => {
      if (current.mode !== 'synced') return current
      return setSyncedLineText(current, lineIndex, text)
    })
    setActionError('')
    setActionNotice('')
  }

  const editTime = (lineIndex: number, field: TimeField, value: string): void => {
    const draftField = field === 'startMs' ? 'start' : 'end'
    const parsed = field === 'endMs' && value.trim() === '' ? null : parseTimecode(value)
    const line = document.mode === 'synced' ? document.lines[lineIndex] : undefined
    const clearEnd = field === 'startMs' && parsed !== null && line?.endMs != null && line.endMs <= parsed
    setTimeDrafts((current) => current.map((draft, index) => index === lineIndex
      ? { ...draft, [draftField]: value, ...(clearEnd ? { end: '' } : {}) } : draft))
    setDocument((current) => {
      if (current.mode !== 'synced') return current
      return editSyncedLineTime(current, lineIndex, field, parsed)
    })
    setActionError('')
    setActionNotice('')
  }

  const addLine = (): void => {
    if (document.mode !== 'synced') return
    const lastLine = document.lines.at(-1)
    const lastStart = lastLine && Number.isFinite(lastLine.startMs) ? lastLine.startMs : -3000
    const proposedStart = lastLine?.endMs != null && Number.isFinite(lastLine.endMs)
      ? lastLine.endMs
      : lastStart + 3000
    const duration = Number.isFinite(durationMs) && (durationMs ?? 0) > 0 ? Math.round(durationMs!) : null
    const startMs = duration === null
      ? Math.max(0, proposedStart)
      : Math.min(Math.max(0, proposedStart), Math.max(0, duration - 1000))
    replaceDocument({ mode: 'synced', lines: [...document.lines,
      { text: '', startMs, endMs: null, endOrigin: 'auto', explicitPause: true }] })
  }

  const removeLine = (lineIndex: number): void => {
    if (document.mode !== 'synced') return
    replaceDocument({ mode: 'synced', lines: document.lines.filter((_, index) => index !== lineIndex) })
  }

  const moveLineText = (fromIndex: number, toIndex: number): void => {
    if (document.mode !== 'synced' || fromIndex === toIndex
      || fromIndex < 0 || toIndex < 0 || fromIndex >= document.lines.length || toIndex >= document.lines.length) return
    const lyricTexts = document.lines.map((line, index) => ({ text: line.text, explicitPause: line.explicitPause, sourceIndex: index }))
    const [moved] = lyricTexts.splice(fromIndex, 1)
    if (!moved) return
    lyricTexts.splice(toIndex, 0, moved)
    const lines = document.lines.map((line, index) => {
      const lyric = lyricTexts[index]
      if (!lyric || lyric.sourceIndex === index) return line
      const updated = { ...line, text: lyric.text }
      if (lyric.text.trim() || lyric.explicitPause !== true) delete updated.explicitPause
      else updated.explicitPause = true
      delete updated.words
      if (updated.endOrigin === 'source') updated.endOrigin = 'auto'
      return updated
    })
    setDocument({ mode: 'synced', lines })
    setActionError('')
    setActionNotice('')
  }

  const startLineDrag = (lineIndex: number, event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (busy || !event.isPrimary || event.button !== 0) return
    event.preventDefault()
    pointerDragCleanup.current?.()

    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    let activated = false
    let targetIndex: number | null = null
    dragLineIndex.current = lineIndex

    const readTarget = (x: number, y: number): number | null => {
      const row = window.document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-lyrics-line-index]')
      if (!row) return null
      const index = Number(row.dataset.lyricsLineIndex)
      return Number.isInteger(index) ? index : null
    }

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      dragLineIndex.current = null
      setDragOverLine(null)
      if (pointerDragCleanup.current === cleanup) pointerDragCleanup.current = null
    }

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      if (!activated) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return
        activated = true
      }
      targetIndex = readTarget(moveEvent.clientX, moveEvent.clientY)
      setDragOverLine(targetIndex)
    }

    const onPointerUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return
      if (activated) {
        const finalTarget = readTarget(upEvent.clientX, upEvent.clientY)
        if (finalTarget !== null) targetIndex = finalTarget
        if (targetIndex !== null) moveLineText(lineIndex, targetIndex)
      }
      cleanup()
    }

    const onPointerCancel = (cancelEvent: PointerEvent): void => {
      if (cancelEvent.pointerId === pointerId) cleanup()
    }

    pointerDragCleanup.current = cleanup
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
  }

  const correctLineTiming = (): void => {
    setActionError('')
    setActionNotice('')
    if (document.mode !== 'synced') return
    const positionMs = readPlaybackPositionMs(currentTimeSec)
    const engine = getEngine()
    if (!engine || engine.getActiveChannel() !== 'local' || !engine.getAnalyser()) {
      setActionError(t('Vocal correction requires a cached track'))
      return
    }

    const samples = vocalSamples.current.filter((sample) => (
      sample.positionMs >= positionMs - 12_000 && sample.positionMs <= positionMs + 80
    ))
    if (samples.length < 12) {
      setActionError(t('Play the local track for a few seconds before correcting'))
      return
    }

    const latestStartedLine = document.lines.reduce((latest, line, index) => (
      line.text.trim() && line.startMs <= positionMs ? index : latest
    ), -1)
    if (latestStartedLine < 0) {
      setActionError(t('No lyric line near the current position'))
      return
    }

    const line = document.lines[latestStartedLine]
    const previousLine = document.lines.slice(0, latestStartedLine).reverse()
      .find((candidate) => candidate.startMs < line.startMs)
    const nextLine = document.lines.slice(latestStartedLine + 1)
      .find((candidate) => candidate.startMs > line.startMs)
    const positionWindowStart = samples[0]?.positionMs ?? positionMs
    const positionWindowEnd = samples.at(-1)?.positionMs ?? positionMs
    const lineBoundary = line.endMs !== null && line.endOrigin !== 'auto'
      ? line.endMs
      : nextLine?.startMs ?? trackDurationMs
    const previousBoundary = previousLine
      ? previousLine.endMs !== null && previousLine.endOrigin !== 'auto'
        ? previousLine.endMs
        : Math.max(previousLine.startMs, line.startMs - 900)
      : 0
    const analysisEnd = Math.min(positionMs + 80, lineBoundary ?? positionMs + 80)
    const analysisStart = Math.max(positionWindowStart, Math.max(0, line.startMs - 1800), previousBoundary)
    const segments = findVocalActivitySegments(samples)
      .filter((segment) => segment.endMs >= analysisStart && segment.startMs <= analysisEnd)
      .map((segment) => ({
        startMs: Math.max(segment.startMs, analysisStart),
        endMs: Math.min(segment.endMs, analysisEnd),
      }))
      .filter((segment) => segment.endMs > segment.startMs)
    if (segments.length === 0) {
      setActionError(t('No clear vocal phrase found near this line'))
      return
    }

    const startCandidate = segments
      .filter((segment) => Math.abs(segment.startMs - line.startMs) <= 1800)
      .sort((a, b) => Math.abs(a.startMs - line.startMs) - Math.abs(b.startMs - line.startMs))[0]
    const coversLineStart = positionWindowStart <= line.startMs + 180
      && positionWindowEnd >= line.startMs - 180
    const nextBoundary = nextLine?.startMs ?? trackDurationMs ?? Number.POSITIVE_INFINITY
    const newStartMs = coversLineStart && startCandidate
      ? Math.min(nextBoundary - 1, Math.max(previousBoundary, startCandidate.startMs))
      : line.startMs
    const boundaryWasHeard = lineBoundary !== null
      && lineBoundary <= positionMs + 80
      && positionWindowEnd >= lineBoundary - 180
    const lastLineActivity = segments.filter((segment) => segment.endMs > newStartMs).at(-1)
    const vocalTailObserved = (line.endMs === null || line.endOrigin === 'auto')
      && lastLineActivity !== undefined
      && positionWindowEnd - lastLineActivity.endMs >= 600
    const lineEndObserved = boundaryWasHeard || vocalTailObserved
    const newEndMs = lineEndObserved && lineBoundary !== null && lastLineActivity
      ? Math.min(lineBoundary, nextLine?.startMs ?? Number.POSITIVE_INFINITY, lastLineActivity.endMs)
      : line.endOrigin === 'auto' ? null : line.endMs
    if (newEndMs !== null && newEndMs <= newStartMs) {
      setActionError(t('No clear vocal phrase found near this line'))
      return
    }
    if (newStartMs === line.startMs && newEndMs === line.endMs) {
      setActionError(t('No clear vocal phrase found near this line'))
      return
    }

    setDocument((current) => {
      if (current.mode !== 'synced') return current
      const currentLine = current.lines[latestStartedLine]
      if (!currentLine) return current
      const updatedLine = { ...currentLine, startMs: newStartMs, endMs: newEndMs }
      if (newEndMs !== line.endMs) {
        if (newEndMs === null) {
          if (line.endOrigin === 'auto') updatedLine.endOrigin = 'auto'
          else delete updatedLine.endOrigin
        } else updatedLine.endOrigin = 'manual'
      }
      delete updatedLine.words
      return {
        mode: 'synced',
        lines: current.lines.map((item, index) => index === latestStartedLine ? updatedLine : item),
      }
    })
    setTimeDrafts((current) => current.map((draft, index) => index === latestStartedLine
      ? { start: formatTimecode(newStartMs), end: formatTimecode(newEndMs) }
      : draft))
    setActionNotice(t(newStartMs !== line.startMs && newEndMs !== line.endMs
      ? 'Vocal timing adjusted'
      : newStartMs !== line.startMs ? 'Vocal start adjusted' : 'Vocal end adjusted'))
  }

  const runAction = async (action: 'save' | 'publish'): Promise<void> => {
    if (busy || issues.length > 0) return
    const callback = action === 'save' ? onSave : onPublish
    if (!callback) return
    setLocalAction(action)
    setActionError('')
    try {
      await callback(cloneDocument(document), selectedSourceId || null)
      if (action === 'publish') setActionNotice(t('Lyrics published to LRCLIB'))
    } catch (error) {
      if (action === 'publish' && error instanceof Error && error.message === 'LRCLIB_DURATION_INVALID') {
        setActionError(t('Track duration must be between 1 and 3600 seconds to publish'))
      } else if (action === 'publish' && error instanceof Error && error.message === 'LRCLIB_METADATA_INVALID') {
        setActionError(t('Track title and artist are required to publish lyrics'))
      } else {
        setActionError(t(action === 'save' ? 'Could not save lyrics' : 'Could not publish lyrics'))
      }
    } finally {
      setLocalAction(null)
    }
  }

  const validationId = `${id}-validation`
  const errorId = `${id}-action-error`

  useEffect(() => {
    if (!isPlaying || document.mode !== 'synced') return
    const engine = getEngine()
    if (!engine) return
    let unsubscribe: (() => void) | null = null
    let sampleTimer = 0
    let lastSampleAt = 0

    const onSpectrum = (): void => {
      const analyser = engine.getAnalyser()
      if (engine.getActiveChannel() !== 'local' || !analyser) return
      const now = performance.now()
      if (now - lastSampleAt < 50) return
      const positionMs = Math.round(engine.getCurrentTime() * 1000)
      const previous = vocalSamples.current.at(-1)
      if (previous && (positionMs < previous.positionMs - 250 || positionMs - previous.positionMs > 1500)) {
        vocalSamples.current = []
      }
      if (previous?.positionMs === positionMs) return
      if (!vocalFrequencyBins.current || vocalFrequencyBins.current.length !== analyser.frequencyBinCount) {
        vocalFrequencyBins.current = new Uint8Array(analyser.frequencyBinCount)
      }
      analyser.getByteFrequencyData(vocalFrequencyBins.current)
      vocalSamples.current.push({ positionMs, score: estimateVocalActivity(
        vocalFrequencyBins.current, analyser.context.sampleRate, analyser.minDecibels, analyser.maxDecibels,
      ) })
      const cutoffMs = positionMs - 12_500
      while (vocalSamples.current[0] && vocalSamples.current[0].positionMs < cutoffMs) {
        vocalSamples.current.shift()
      }
      lastSampleAt = now
    }

    const subscribeWhenLocal = (): void => {
      if (!unsubscribe && engine.getActiveChannel() === 'local') unsubscribe = subscribeSpectrum(onSpectrum)
    }
    subscribeWhenLocal()
    sampleTimer = window.setInterval(subscribeWhenLocal, 300)
    return () => {
      window.clearInterval(sampleTimer)
      unsubscribe?.()
    }
  }, [document.mode, isPlaying])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
        || (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight')) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const deltaSec = event.code === 'ArrowLeft' ? -0.05 : 0.05
      const maxSec = trackDurationMs === null ? Number.POSITIVE_INFINITY : trackDurationMs / 1000
      const currentSec = readPlaybackPositionMs(currentTimeSec) / 1000
      onSeek(Math.min(maxSec, Math.max(0, currentSec + deltaSec)))
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [currentTimeSec, onSeek, trackDurationMs])

  const seekByMs = (deltaMs: number): void => {
    const maxSec = trackDurationMs === null ? Number.POSITIVE_INFINITY : trackDurationMs / 1000
    const currentSec = readPlaybackPositionMs(currentTimeSec) / 1000
    onSeek(Math.min(maxSec, Math.max(0, currentSec + deltaMs / 1000)))
  }

  return (
    <section className="lyr-editor-panel" aria-label={t('Lyrics editor')}>
      <div className="lyr-editor-toolbar">
        {sourceOptions.length > 0 ? (
          <div className="lyr-editor-source" ref={sourcePickerRef}>
            <span className="lyr-editor-source-label">{t('Source')}</span>
            <button
              type="button"
              className="lyr-editor-source-trigger"
              aria-haspopup="listbox"
              aria-expanded={sourceOpen}
              aria-label={`${t('Source')}: ${selectedSource?.label ?? t('Choose a source')}`}
              onClick={() => setSourceOpen((open) => !open)}
              disabled={busy}
            >
              <span>{selectedSource?.label ?? t('Choose a source')}</span>
              <ChevronDown size={14} className={sourceOpen ? 'is-open' : ''} />
            </button>
            {sourceOpen ? (
              <div className="lyr-editor-source-menu">
                {sourceOptions.length > 5 ? (
                  <label className="lyr-editor-source-search">
                    <Search size={13} aria-hidden="true" />
                    <input
                      autoFocus
                      value={sourceQuery}
                      onChange={(event) => setSourceQuery(event.target.value)}
                      placeholder={t('Search')}
                      aria-label={t('Search')}
                    />
                  </label>
                ) : null}
                <div className="lyr-editor-source-options" role="listbox" aria-label={t('Lyrics sources')}>
                  {filteredSources.length > 0 ? filteredSources.map((source) => (
                    <button
                      key={source.id}
                      type="button"
                      role="option"
                      aria-selected={source.id === selectedSourceId}
                      className={source.id === selectedSourceId ? 'is-selected' : ''}
                      onClick={() => selectSource(source.id)}
                    >
                      <span>{source.label}</span>
                      {source.id === selectedSourceId ? <Check size={13} /> : null}
                    </button>
                  )) : <span className="lyr-editor-source-empty">{t('No matches')}</span>}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="lyr-editor-mode" role="group" aria-label={t('Lyrics format')}>
          <button
            type="button"
            className={document.mode === 'plain' ? 'is-active' : ''}
            aria-pressed={document.mode === 'plain'}
            onClick={() => changeMode('plain')}
            disabled={busy}
          >
            {t('Plain text')}
          </button>
          <button
            type="button"
            className={document.mode === 'synced' ? 'is-active' : ''}
            aria-pressed={document.mode === 'synced'}
            onClick={() => changeMode('synced')}
            disabled={busy}
          >
            {t('Synced lyrics')}
          </button>
        </div>
      </div>

      {document.mode === 'synced' ? <div className="lyr-editor-transport" aria-label={t('Playback timing controls')}>
        <div className="lyr-editor-transport-head">
          <span className="lyr-editor-transport-time">
            {formatTimecode(currentPositionMs)} <i>/</i> {formatTimecode(trackDurationMs)}
          </span>
          <div className="lyr-editor-transport-controls">
            <button type="button" className="lyr-editor-transport-button" onClick={() => seekByMs(-50)} aria-label={t('Seek back 50 ms')} title={t('Seek back 50 ms')}>
              <SkipBack size={14} /><small>50 ms</small>
            </button>
            <button type="button" className="lyr-editor-transport-button is-play" onClick={onTogglePlayback} aria-label={isPlaying ? t('Pause') : t('Play')} title={isPlaying ? t('Pause') : t('Play')}>
              {isPlaying ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button type="button" className="lyr-editor-transport-button" onClick={() => seekByMs(50)} aria-label={t('Seek forward 50 ms')} title={t('Seek forward 50 ms')}>
              <small>50 ms</small><SkipForward size={14} />
            </button>
            <label className="lyr-editor-speed-control">
              <span>{playbackRate.toFixed(2)}×</span>
              <input
                type="range"
                min={0.5}
                max={playbackSpeedMax}
                step={0.05}
                value={Math.min(playbackSpeedMax, Math.max(0.5, playbackRate))}
                onChange={(event) => onPlaybackRateChange(event.currentTarget.valueAsNumber)}
                aria-label={t('Editing playback speed')}
                style={{ '--fill': `${((playbackRate - 0.5) / (playbackSpeedMax - 0.5)) * 100}%` } as React.CSSProperties}
              />
            </label>
            <button
              type="button"
              className="lyr-editor-correct-button"
              onClick={correctLineTiming}
              disabled={busy || document.mode !== 'synced'}
              aria-label={t('Correct lyric timing')}
              title={t('Correct lyric timing')}
            >
              <MicVocal size={14} /> {t('Correct')}
            </button>
          </div>
        </div>
        <input
          className="lyr-editor-seek"
          type="range"
          min={0}
          max={trackDurationMs ?? Math.max(currentPositionMs ?? 0, 1)}
          step={50}
          value={Math.min(currentPositionMs ?? 0, trackDurationMs ?? Number.POSITIVE_INFINITY)}
          onChange={(event) => onSeek(event.currentTarget.valueAsNumber / 1000)}
          disabled={trackDurationMs === null}
          aria-label={t('Seek')}
          title={t('Ctrl arrows seek by 50 ms')}
          style={{ '--fill': `${trackDurationMs ? Math.min(100, ((currentPositionMs ?? 0) / trackDurationMs) * 100) : 0}%` } as React.CSSProperties}
        />
      </div> : null}

      {document.mode === 'plain' ? (
        <textarea
          className="lyr-editor-plain"
          aria-label={t('Plain text')}
          value={toPlainText(document)}
          onChange={(event) => {
            setDocument(fromPlainLyrics(event.target.value))
            setActionError('')
          }}
          disabled={busy}
          spellCheck={false}
        />
      ) : (
        <div className="lyr-editor-synced-wrap">
          <div className="lyr-editor-column-labels" aria-hidden="true">
            <span />
            <span>{t('Lyric line')}</span>
            <div className="lyr-editor-time-labels">
            <span>{t('Start time')}</span><i>—</i><span>{t('End time')}</span>
            </div>
            <span />
          </div>
          <div className="lyr-editor-lines" role="list" aria-describedby={firstIssue ? validationId : undefined}>
            {document.lines.map((line, lineIndex) => (
              <div
                className={'lyr-editor-line' + (lineIndex === activeLineIndex ? ' is-current' : '')
                  + (dragLineIndex.current === lineIndex && dragOverLine !== null ? ' is-dragging' : '')
                  + (dragOverLine === lineIndex && dragOverLine !== dragLineIndex.current ? ' is-drop-target' : '')}
                role="listitem"
                key={lineIndex}
                data-lyrics-line-index={lineIndex}
                data-invalid={invalidLineIndexes.has(lineIndex) || undefined}
              >
                <button
                  type="button"
                  className="lyr-editor-drag-handle"
                  disabled={busy}
                  aria-label={`${t('Move lyric line')} ${lineIndex + 1}`}
                  title={t('Move lyric line')}
                  onPointerDown={(event) => startLineDrag(lineIndex, event)}
                  onKeyDown={(event) => {
                    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
                    event.preventDefault()
                    event.stopPropagation()
                    moveLineText(lineIndex, lineIndex + (event.key === 'ArrowUp' ? -1 : 1))
                  }}
                >
                  <GripVertical size={15} />
                </button>
                <input
                  className="lyr-editor-line-text"
                  type="text"
                  aria-label={`${t('Lyric line')} ${lineIndex + 1}`}
                  value={line.text}
                  onChange={(event) => editSyncedText(lineIndex, event.target.value)}
                  disabled={busy}
                />
                <div className="lyr-editor-time-pair">
                  <div className="lyr-editor-time-wrap">
                    <input
                      className="lyr-editor-time"
                      type="text"
                      inputMode="numeric"
                      placeholder="00:00.00"
                      aria-label={`${t('Start time')}, ${lineIndex + 1}`}
                      aria-invalid={!Number.isSafeInteger(line.startMs) || line.startMs < 0 || undefined}
                      value={timeDrafts[lineIndex]?.start ?? formatTimecode(line.startMs)}
                      onChange={(event) => editTime(lineIndex, 'startMs', event.target.value)}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="lyr-editor-capture-time"
                      title={t('Set line start to current position')}
                      aria-label={`${t('Set line start to current position')}, ${lineIndex + 1}`}
                      onClick={() => setLineTimeToCurrentPosition(lineIndex, 'startMs')}
                      disabled={busy || currentPositionMs === null}
                    >
                      <Clock3 size={13} />
                    </button>
                  </div>
                  <span className="lyr-editor-time-separator" aria-hidden="true">—</span>
                  <div className="lyr-editor-time-wrap">
                    <input
                      className="lyr-editor-time"
                      type="text"
                      inputMode="numeric"
                      placeholder={t('Auto')}
                      aria-label={`${t('End time (optional)')}, ${lineIndex + 1}`}
                      aria-invalid={line.endMs !== null && (!Number.isSafeInteger(line.endMs) || line.endMs <= line.startMs) || undefined}
                      value={timeDrafts[lineIndex]?.end ?? formatTimecode(line.endMs)}
                      onChange={(event) => editTime(lineIndex, 'endMs', event.target.value)}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="lyr-editor-capture-time"
                      title={t('Set line end to current position')}
                      aria-label={`${t('Set line end to current position')}, ${lineIndex + 1}`}
                      onClick={() => setLineTimeToCurrentPosition(lineIndex, 'endMs')}
                      disabled={busy || currentPositionMs === null || currentPositionMs <= line.startMs}
                    >
                      <Clock3 size={13} />
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="lyr-editor-remove"
                  aria-label={`${t('Remove lyric line')} ${lineIndex + 1}`}
                  title={t('Remove lyric line')}
                  onClick={() => removeLine(lineIndex)}
                  disabled={busy}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="lyr-editor-add" onClick={addLine} disabled={busy}>
            <Plus size={14} />
            {t('Add lyric line')}
          </button>
        </div>
      )}

      {validationText ? <div className="lyr-editor-validation" id={validationId} role="status">{validationText}</div> : null}
      {actionError ? <div className="lyr-editor-action-error" id={errorId} role="alert">{actionError}</div> : null}
      {actionNotice ? <div className="lyr-editor-action-notice" role="status">{actionNotice}</div> : null}

      <footer className="lyr-editor-footer">
        <div className="lyr-editor-more">
          {onPublish ? (
            <details ref={publishMenuRef} className="lyr-editor-menu">
              <summary aria-label={t('More actions')} title={t('More actions')}>
                <MoreHorizontal size={17} />
              </summary>
              <div className="lyr-editor-menu-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (publishMenuRef.current) publishMenuRef.current.open = false
                    void runAction('publish')
                  }}
                  disabled={busy || issues.length > 0}
                >
                  {t('Publish to LRCLIB')}
                </button>
              </div>
            </details>
          ) : null}
        </div>
        <div className="lyr-editor-actions">
          <button type="button" className="lyr-editor-cancel" onClick={onCancel} disabled={busy}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="lyr-editor-save"
            onClick={() => void runAction('save')}
            disabled={busy || issues.length > 0}
            aria-busy={saveBusy}
            aria-describedby={[firstIssue ? validationId : '', actionError ? errorId : ''].filter(Boolean).join(' ') || undefined}
          >
            <Save size={14} />
            {t('Save')}
          </button>
        </div>
      </footer>
    </section>
  )
}

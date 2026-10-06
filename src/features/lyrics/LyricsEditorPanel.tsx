import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Activity, AudioLines, Check, ChevronDown, Clock3, Eye, GripVertical, MicVocal, MoreHorizontal, Play, Plus, Save, Search, SkipBack, SkipForward, Trash2 } from 'lucide-react'
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
  trackTitle?: string
  trackArtist?: string
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

function formatPreciseTime(milliseconds: number): string {
  const safe = Math.max(0, Math.round(milliseconds))
  const minutes = Math.floor(safe / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1000)
  const fraction = safe % 1000
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`
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
      const proposedEnd = interval === null
        ? null
        : index + 1 < document.lines.length
          ? Math.round((index + 1) * interval)
          : duration
      return {
        text: line.text,
        startMs,
        endMs: proposedEnd !== null && proposedEnd > startMs ? proposedEnd : null,
        endOrigin: 'auto',
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
  trackTitle = '',
  trackArtist = '',
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
  const [previewMode, setPreviewMode] = useState(false)

  useEffect(() => {
    const next = JSON.parse(initialDocumentJson) as LyricsEditorDocument
    setDocument(next)
    setTimeDrafts(makeTimeDrafts(next))
    setSelectedSourceId(initialSourceId ?? '')
    setSourceOpen(false)
    setSourceQuery('')
    setActionError('')
    setActionNotice('')
    setPreviewMode(false)
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

  const previewRows = useMemo<Array<{ text: string; startMs: number; endMs: number }>>(() => {
    const sourceLines: Array<{ text: string; startMs?: number; endMs?: number | null }> = document.mode === 'synced'
      ? document.lines.filter((line) => line.text.trim()).slice(0, 7)
        .map((line) => ({ text: line.text, startMs: line.startMs, endMs: line.endMs }))
      : document.lines.filter((line) => line.text.trim()).slice(0, 7)
        .map((line) => ({ text: line.text }))
    const examples = [
      t('Light reaches the window'), t('The city wakes up'), t('I keep moving forward'),
      t('The night gives way to morning'), t('And the lights come back on'), t('I can hear the silence'),
    ]
    const count = Math.max(6, document.lines.filter((line) => line.text.trim()).length)
    const trackDuration = Number.isFinite(durationMs) && (durationMs ?? 0) > 0 ? durationMs! : 180_000
    const span = Math.max(1, Math.round(trackDuration / count))
    return Array.from({ length: Math.min(7, count) }, (_, index) => {
      const line = sourceLines[index]
      const startMs = typeof line?.startMs === 'number' && Number.isFinite(line.startMs)
        ? line.startMs : Math.round(span * index)
      const nextLine = sourceLines[index + 1]
      const nextStart = typeof nextLine?.startMs === 'number' && Number.isFinite(nextLine.startMs)
        ? nextLine.startMs : startMs + span
      const sourceEnd = typeof line?.endMs === 'number' && Number.isFinite(line.endMs) ? line.endMs : null
      return {
        text: line?.text.trim() || examples[index % examples.length],
        startMs,
        endMs: sourceEnd !== null && sourceEnd > startMs ? sourceEnd : Math.max(startMs + 1000, nextStart),
      }
    })
  }, [document, durationMs, t])

  const previewWindowStart = Math.max(0, previewRows[0]?.startMs ?? 0)
  const previewWindowEnd = Math.max(previewRows.at(-1)?.endMs ?? previewWindowStart + 12_000, previewWindowStart + 12_000)
  const previewWindowSpan = previewWindowEnd - previewWindowStart
  const previewPosition = previewWindowStart + previewWindowSpan * 0.44
  const previewActiveIndex = Math.max(0, previewRows.findIndex((row) => previewPosition >= row.startMs && previewPosition < row.endMs))

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
    const timeMs = currentPositionMs
    if (timeMs === null) return
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
    const proposedEnd = duration === null ? null : Math.min(duration, startMs + 3000)
    const endMs = proposedEnd !== null && proposedEnd > startMs ? proposedEnd : null
    replaceDocument({ mode: 'synced', lines: [...document.lines, { text: '', startMs, endMs, endOrigin: 'auto' }] })
  }

  const removeLine = (lineIndex: number): void => {
    if (document.mode !== 'synced') return
    replaceDocument({ mode: 'synced', lines: document.lines.filter((_, index) => index !== lineIndex) })
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
  const currentPositionMs = Number.isFinite(currentTimeSec) ? Math.max(0, Math.round(currentTimeSec * 1000)) : null

  return (
    <section className={'lyr-editor-panel' + (previewMode ? ' is-preview' : '')} aria-label={t('Lyrics editor')}>
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
        <button
          type="button"
          className={'lyr-editor-preview-toggle' + (previewMode ? ' is-active' : '')}
          aria-pressed={previewMode}
          onClick={() => { setSourceOpen(false); setPreviewMode((value) => !value) }}
          disabled={busy}
        >
          <Eye size={14} />
          {t(previewMode ? 'Back to editing' : 'Preview layout')}
        </button>
      </div>

      {previewMode ? (
        <div className="lyr-editor-preview">
          <div className="lyr-editor-preview-heading">
            <div>
              <span className="lyr-editor-preview-kicker">{t('Lyrics timing')}</span>
              <strong>{trackTitle || t('Lyrics editor')}</strong>
              <small>{trackArtist || t('Adjust line timing while listening')}</small>
            </div>
            <span className="lyr-editor-preview-badge">{t('Layout preview')}</span>
          </div>

          <section className="lyr-editor-preview-transport" aria-label={t('Playback timing controls')}>
            <div className="lyr-editor-preview-transport-head">
              <span><AudioLines size={15} /> {t('Timing preview')}</span>
              <span className="lyr-editor-preview-time">{formatPreciseTime(previewPosition)} <i>/</i> {formatPreciseTime(durationMs ?? 180_000)}</span>
            </div>
            <div className="lyr-editor-preview-wave" aria-hidden="true">
              {Array.from({ length: 64 }, (_, index) => <i key={index} style={{ '--bar-height': `${18 + ((index * 37 + 13) % 67)}%` } as React.CSSProperties} />)}
              <span style={{ left: '44%' }} />
            </div>
            <div className="lyr-editor-preview-transport-controls">
              <div className="lyr-editor-preview-nudge">
                <button type="button" disabled aria-label={t('Seek back 50 ms')}><SkipBack size={14} /><small>−50 ms</small></button>
                <button type="button" className="lyr-editor-preview-play" disabled aria-label={t('Play or pause')}><Play size={16} /></button>
                <button type="button" disabled aria-label={t('Seek forward 50 ms')}><small>+50 ms</small><SkipForward size={14} /></button>
                <small className="lyr-editor-preview-shortcut">Ctrl + ← / →</small>
              </div>
              <div className="lyr-editor-preview-speed">
                <span>{t('Editing speed')}</span>
                <div className="lyr-editor-preview-speed-track"><i /></div>
                <strong>0.70×</strong>
              </div>
            </div>
            <small className="lyr-editor-preview-note">{t('Preview controls are visual only')}</small>
          </section>

          <div className="lyr-editor-preview-workspace">
            <section className="lyr-editor-preview-timeline">
              <div className="lyr-editor-preview-section-head">
                <div><strong>{t('Line timing')}</strong><small>{t('Drag rows to reorder')}</small></div>
                <span><Activity size={14} /> {t('Song timeline')}</span>
              </div>
              <div className="lyr-editor-preview-ruler"><span>{formatPreciseTime(previewWindowStart)}</span><span>{formatPreciseTime(previewWindowStart + previewWindowSpan / 2)}</span><span>{formatPreciseTime(previewWindowEnd)}</span></div>
              <div className="lyr-editor-preview-timing-rows">
                {previewRows.map((row, index) => {
                  const left = Math.max(0, ((row.startMs - previewWindowStart) / previewWindowSpan) * 100)
                  const width = Math.min(100 - left, Math.max(5, ((row.endMs - row.startMs) / previewWindowSpan) * 100))
                  return (
                    <div className={'lyr-editor-preview-timing-row' + (index === previewActiveIndex ? ' is-active' : '')} key={`${row.startMs}-${index}`}>
                      <GripVertical size={15} className="lyr-editor-preview-grip" />
                      <span className="lyr-editor-preview-row-index">{String(index + 1).padStart(2, '0')}</span>
                      <div className="lyr-editor-preview-row-track"><i style={{ left: `${left}%`, width: `${width}%` }} /></div>
                      <span className="lyr-editor-preview-row-time">{formatPreciseTime(row.startMs)}</span>
                    </div>
                  )
                })}
              </div>
              <div className="lyr-editor-preview-vocal-lane">
                <div className="lyr-editor-preview-vocal-title"><MicVocal size={14} /><span>{t('Vocal activity')}</span><small>{t('Voice/music markers without transcription')}</small></div>
                <div className="lyr-editor-preview-vocal-track" aria-label={t('Example voice and instrumental sections')}>
                  {[['voice', 18], ['voice', 12], ['music', 9], ['voice', 24], ['music', 11], ['voice', 26]].map(([kind, width], index) => (
                    <i key={index} className={kind === 'voice' ? 'is-voice' : 'is-music'} style={{ width: `${width}%` }} />
                  ))}
                </div>
                <div className="lyr-editor-preview-vocal-legend"><span><i className="is-voice" />{t('Voice')}</span><span><i className="is-music" />{t('Instrumental')}</span></div>
              </div>
            </section>

            <section className="lyr-editor-preview-text">
              <div className="lyr-editor-preview-section-head">
                <div><strong>{t('Lyrics lines')}</strong><small>{t('Text stays aligned with timing')}</small></div>
                <span>{previewRows.length}</span>
              </div>
              <div className="lyr-editor-preview-text-rows">
                {previewRows.map((row, index) => (
                  <div className={'lyr-editor-preview-text-row' + (index === previewActiveIndex ? ' is-active' : '')} key={`${row.startMs}-${index}`}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <div><small>{formatPreciseTime(row.startMs)} – {formatPreciseTime(row.endMs)}</small><p>{row.text}</p></div>
                  </div>
                ))}
              </div>
            </section>
          </div>
          <div className="lyr-editor-preview-disclaimer"><MicVocal size={13} />{t('Vocal detection is a layout sample, not active analysis')}</div>
        </div>
      ) : document.mode === 'plain' ? (
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
            <span>{t('Lyric line')}</span>
            <span>{t('Start time')}</span>
            <span>{t('End time')}</span>
            <span />
          </div>
          <div className="lyr-editor-lines" role="list" aria-describedby={firstIssue ? validationId : undefined}>
            {document.lines.map((line, lineIndex) => (
              <div
                className="lyr-editor-line"
                role="listitem"
                key={lineIndex}
                data-invalid={invalidLineIndexes.has(lineIndex) || undefined}
              >
                <input
                  className="lyr-editor-line-text"
                  type="text"
                  aria-label={`${t('Lyric line')} ${lineIndex + 1}`}
                  value={line.text}
                  onChange={(event) => editSyncedText(lineIndex, event.target.value)}
                  disabled={busy}
                />
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
                    title={`${t('Start time')}: ${formatTimecode(currentPositionMs)}`}
                    aria-label={`${t('Start time')}: ${formatTimecode(currentPositionMs)}`}
                    onClick={() => setLineTimeToCurrentPosition(lineIndex, 'startMs')}
                    disabled={busy || currentPositionMs === null}
                  >
                    <Clock3 size={13} />
                  </button>
                </div>
                <div className="lyr-editor-time-wrap">
                  <input
                    className="lyr-editor-time"
                    type="text"
                    inputMode="numeric"
                    placeholder="00:00.00"
                    aria-label={`${t('End time')}, ${lineIndex + 1}`}
                    aria-invalid={line.endMs !== null && (!Number.isSafeInteger(line.endMs) || line.endMs <= line.startMs) || undefined}
                    value={timeDrafts[lineIndex]?.end ?? formatTimecode(line.endMs)}
                    onChange={(event) => editTime(lineIndex, 'endMs', event.target.value)}
                    disabled={busy}
                  />
                  <button
                    type="button"
                    className="lyr-editor-capture-time"
                    title={`${t('End time')}: ${formatTimecode(currentPositionMs)}`}
                    aria-label={`${t('End time')}: ${formatTimecode(currentPositionMs)}`}
                    onClick={() => setLineTimeToCurrentPosition(lineIndex, 'endMs')}
                    disabled={busy || currentPositionMs === null || currentPositionMs <= line.startMs}
                  >
                    <Clock3 size={13} />
                  </button>
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

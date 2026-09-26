import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Plus, Save, Trash2 } from 'lucide-react'
import { useT } from '../../i18n'
import {
  fromPlainLyrics,
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
  return document.mode === 'plain'
    ? { mode: 'plain', lines: document.lines.map((line) => ({ text: line.text })) }
    : {
        mode: 'synced',
        lines: document.lines.map((line) => ({
          text: line.text,
          startMs: line.startMs,
          endMs: line.endMs,
        })),
      }
}

function formatTimecode(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return ''
  const centiseconds = Math.round(milliseconds / 10)
  const minutes = Math.floor(centiseconds / 6000)
  const seconds = Math.floor((centiseconds % 6000) / 100)
  const fraction = centiseconds % 100
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`
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
  onSave,
  onPublish,
  onCancel,
  saving = false,
  publishing = false,
}: LyricsEditorPanelProps) {
  const t = useT()
  const id = useId()
  const publishMenuRef = useRef<HTMLDetailsElement>(null)
  const initialDocumentJson = JSON.stringify(initialDocument)
  const [document, setDocument] = useState<LyricsEditorDocument>(() => cloneDocument(initialDocument))
  const [timeDrafts, setTimeDrafts] = useState<TimeDraft[]>(() => makeTimeDrafts(initialDocument))
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [localAction, setLocalAction] = useState<LocalAction>(null)

  useEffect(() => {
    const next = JSON.parse(initialDocumentJson) as LyricsEditorDocument
    setDocument(next)
    setTimeDrafts(makeTimeDrafts(next))
    setSelectedSourceId(initialSourceId ?? '')
    setActionError('')
    setActionNotice('')
  }, [initialDocumentJson, initialSourceId])

  const issues = useMemo(() => validateLyricsDocument(document, durationMs), [document, durationMs])
  const firstIssue = issues[0]
  const validationText = firstIssue ? issueMessage(firstIssue, t) : ''
  const saveBusy = saving || localAction === 'save'
  const publishBusy = publishing || localAction === 'publish'
  const busy = saveBusy || publishBusy
  const invalidLineIndexes = new Set(issues.flatMap((issue) => issue.lineIndex === undefined ? [] : [issue.lineIndex]))

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
    setActionError('')
    setActionNotice('')
    const source = sourceOptions.find((option) => option.id === sourceId)
    if (source) replaceDocument(cloneDocument(source.document))
  }

  const editSyncedText = (lineIndex: number, text: string): void => {
    setDocument((current) => {
      if (current.mode !== 'synced') return current
      return {
        mode: 'synced',
        lines: current.lines.map((line, index) => (index === lineIndex ? { ...line, text } : line)),
      }
    })
    setActionError('')
    setActionNotice('')
  }

  const editTime = (lineIndex: number, field: TimeField, value: string): void => {
    const draftField = field === 'startMs' ? 'start' : 'end'
    setTimeDrafts((current) => current.map((draft, index) => index === lineIndex ? { ...draft, [draftField]: value } : draft))
    const parsed = field === 'endMs' && value.trim() === '' ? null : parseTimecode(value)
    setDocument((current) => {
      if (current.mode !== 'synced') return current
      return {
        mode: 'synced',
        lines: current.lines.map((line, index) => index === lineIndex ? { ...line, [field]: parsed } : line),
      }
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
    replaceDocument({ mode: 'synced', lines: [...document.lines, { text: '', startMs, endMs }] })
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

  return (
    <section className="lyr-editor-panel" aria-label={t('Lyrics editor')}>
      <div className="lyr-editor-toolbar">
        {sourceOptions.length > 0 ? (
          <div className="lyr-editor-source">
            <label htmlFor={`${id}-source`}>{t('Source')}</label>
            <select
              id={`${id}-source`}
              value={selectedSourceId}
              onChange={(event) => selectSource(event.target.value)}
              disabled={busy}
            >
              <option value="">{t('Choose a source')}</option>
              {sourceOptions.map((source) => (
                <option key={source.id} value={source.id}>{source.label}</option>
              ))}
            </select>
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

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, FileText, LoaderCircle, Music2, Search, X } from 'lucide-react'
import { api } from '../../api/client'
import { useT } from '../../i18n'
import { toLyricsCandidates } from './onlineProvider'
import type { LyricsCandidate } from './onlineProvider'
import type { LyricsResult } from './types'
import './stitch-lyrics-dialog.css'

type SearchSide = 'timed' | 'plain'
type QueryField = 'artist' | 'title'

interface SearchState {
  artist: string
  title: string
  candidates: LyricsCandidate[]
  loading: boolean
  error: boolean
  searched: boolean
}

type SearchStates = Record<SearchSide, SearchState>
type SelectedCandidates = Record<SearchSide, LyricsCandidate | null>

export interface StitchLyricsDialogProps {
  onClose: () => void
  onApply: (timed: LyricsResult, text: string) => void
}

const initialSearchState = (): SearchState => ({
  artist: '',
  title: '',
  candidates: [],
  loading: false,
  error: false,
  searched: false,
})

function candidateDuration(duration: number | null | undefined): string | null {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null
  const minutes = Math.floor(duration / 60)
  const seconds = Math.floor(duration % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
}

export default function StitchLyricsDialog({ onClose, onApply }: StitchLyricsDialogProps) {
  const t = useT()
  const id = useId()
  const dialogRef = useRef<HTMLElement | null>(null)
  const [searches, setSearches] = useState<SearchStates>(() => ({ timed: initialSearchState(), plain: initialSearchState() }))
  const [selected, setSelected] = useState<SelectedCandidates>({ timed: null, plain: null })
  const requestIds = useRef<Record<SearchSide, number>>({ timed: 0, plain: 0 })

  useEffect(() => () => {
    requestIds.current.timed += 1
    requestIds.current.plain += 1
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const updateQuery = (side: SearchSide, field: QueryField, value: string) => {
    requestIds.current[side] += 1
    setSearches((current) => ({
      ...current,
      [side]: { ...current[side], [field]: value, candidates: [], loading: false, error: false, searched: false },
    }))
    setSelected((current) => ({ ...current, [side]: null }))
  }

  const search = async (side: SearchSide, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const query = searches[side]
    const artist = query.artist.trim()
    const title = query.title.trim()
    if (!title) return

    const requestId = requestIds.current[side] + 1
    requestIds.current[side] = requestId
    setSearches((current) => ({
      ...current,
      [side]: { ...current[side], candidates: [], loading: true, error: false, searched: false },
    }))
    setSelected((current) => ({ ...current, [side]: null }))

    try {
      const raw = await api.fetchOnlineLyricsAll(artist, title, null, null)
      const matching = toLyricsCandidates(raw).filter((candidate) => side === 'timed'
        ? candidate.result.kind === 'synced'
        : Boolean(candidate.plain?.trim()))
      if (requestIds.current[side] !== requestId) return
      setSearches((current) => ({
        ...current,
        [side]: { ...current[side], candidates: matching, loading: false, error: false, searched: true },
      }))
    } catch {
      if (requestIds.current[side] !== requestId) return
      setSearches((current) => ({
        ...current,
        [side]: { ...current[side], candidates: [], loading: false, error: true, searched: true },
      }))
    }
  }

  const apply = () => {
    const timedResult = selected.timed?.result
    const plainText = selected.plain?.plain?.trim()
    if (timedResult?.kind !== 'synced' || !plainText) return
    onApply(timedResult, plainText)
  }

  const trapTab = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return
    const elements = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ))
    const radios = elements.filter((element): element is HTMLInputElement => element instanceof HTMLInputElement && element.type === 'radio')
    const firstByGroup = new Map<string, HTMLInputElement>()
    const selectedRadios = new Set<HTMLInputElement>()
    for (const radio of radios) {
      if (!firstByGroup.has(radio.name)) firstByGroup.set(radio.name, radio)
      if (radio.checked) selectedRadios.add(radio)
    }
    const tabbable = elements.filter((element) => {
      if (!(element instanceof HTMLInputElement) || element.type !== 'radio') return true
      return selectedRadios.has(element) || (!Array.from(selectedRadios).some((radio) => radio.name === element.name)
        && firstByGroup.get(element.name) === element)
    })
    const first = tabbable[0]
    const last = tabbable[tabbable.length - 1]
    if (!first || !last) return
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  }

  const renderSearch = (side: SearchSide) => {
    const state = searches[side]
    const isTimed = side === 'timed'
    const headingId = `${id}-${side}-heading`
    const formId = `${id}-${side}-form`
    const selectedCandidate = selected[side]
    const emptyText = isTimed ? t('No timed lyrics found for this song') : t('No plain lyrics found for this song')

    return (
      <section className={`stitch-lyrics-source is-${side}`} aria-labelledby={headingId}>
        <header className="stitch-lyrics-source-head">
          <span className="stitch-lyrics-source-icon" aria-hidden="true">
            {isTimed ? <Music2 size={15} /> : <FileText size={15} />}
          </span>
          <div>
            <h3 id={headingId}>{isTimed ? t('Timed lyrics source') : t('Plain lyrics source')}</h3>
            <p>{isTimed ? t('Choose the song that has the timing') : t('Choose the song that has the lyrics text')}</p>
          </div>
        </header>

        <form id={formId} className="stitch-lyrics-search" onSubmit={(event) => void search(side, event)}>
          <label>
            <span>{t('Artist (optional)')}</span>
            <input
              autoFocus={isTimed}
              autoComplete="off"
              value={state.artist}
              onChange={(event) => updateQuery(side, 'artist', event.target.value)}
              placeholder={t('Artist name')}
            />
          </label>
          <label>
            <span>{t('Song title')}</span>
            <input
              autoComplete="off"
              value={state.title}
              onChange={(event) => updateQuery(side, 'title', event.target.value)}
              placeholder={t('Track title')}
              required
            />
          </label>
          <button className="stitch-lyrics-search-button" type="submit" disabled={state.loading || !state.title.trim()}>
            {state.loading ? <LoaderCircle className="stitch-lyrics-spin" size={14} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
            {state.loading ? t('Searching…') : t('Search')}
          </button>
        </form>

        <div className="stitch-lyrics-results" aria-live="polite" aria-busy={state.loading}>
          {state.loading ? (
            <div className="stitch-lyrics-status"><LoaderCircle className="stitch-lyrics-spin" size={16} aria-hidden="true" />{t('Searching lyrics…')}</div>
          ) : state.error ? (
            <div className="stitch-lyrics-status is-error" role="alert">
              <span>{t('Could not search lyrics. Check your connection and try again.')}</span>
              <button type="button" onClick={() => {
                const form = document.getElementById(formId)
                if (form instanceof HTMLFormElement) form.requestSubmit()
              }}>{t('Try again')}</button>
            </div>
          ) : state.searched && state.candidates.length === 0 ? (
            <div className="stitch-lyrics-status">{emptyText}</div>
          ) : state.candidates.length > 0 ? (
            <div className="stitch-lyrics-candidate-list" role="radiogroup" aria-label={isTimed ? t('Timed lyrics results') : t('Plain lyrics results')}>
              {state.candidates.map((candidate, index) => {
                const candidateId = `${id}-${side}-${index}`
                const trackTitle = candidate.trackName?.trim() || state.title.trim()
                const artistName = candidate.artistName?.trim() || state.artist.trim() || t('Artist unavailable')
                const duration = candidateDuration(candidate.duration)
                const snippet = !isTimed ? candidate.plain?.trim().replace(/\s+/g, ' ') : null
                const chosen = selectedCandidate === candidate
                return (
                  <label key={`${candidate.provider}-${candidate.id ?? 'unknown'}-${index}`} className={`stitch-lyrics-candidate${chosen ? ' is-selected' : ''}`} htmlFor={candidateId}>
                    <input
                      id={candidateId}
                      type="radio"
                      name={`${id}-${side}-candidate`}
                      checked={chosen}
                      onChange={() => setSelected((current) => ({ ...current, [side]: candidate }))}
                    />
                    <span className="stitch-lyrics-candidate-copy">
                      <span className="stitch-lyrics-candidate-title">{trackTitle}</span>
                      <span className="stitch-lyrics-candidate-artist">{artistName}</span>
                      {snippet ? <span className="stitch-lyrics-candidate-snippet">{snippet}</span> : null}
                    </span>
                    <span className="stitch-lyrics-candidate-meta">
                      <span>{candidate.provider}</span>
                      {duration ? <span>{duration}</span> : null}
                      {chosen ? <Check size={14} aria-label={t('Selected')} /> : null}
                    </span>
                  </label>
                )
              })}
            </div>
          ) : (
            <div className="stitch-lyrics-status">{isTimed ? t('Search for a song to find timed lyrics') : t('Search for a song to find plain lyrics')}</div>
          )}
        </div>
      </section>
    )
  }

  return createPortal((
    <div
      className="stitch-lyrics-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="stitch-lyrics-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onKeyDown={trapTab}
      >
        <header className="stitch-lyrics-dialog-head">
          <div>
            <h2 id={`${id}-title`}>{t('Stitch lyric timing')}</h2>
            <p>{t('Select a timed source and a plain source. Applying replaces the current draft; close to keep it unchanged.')}</p>
          </div>
          <button type="button" className="stitch-lyrics-close" onClick={onClose} aria-label={t('Close dialog')}>
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="stitch-lyrics-sources">
          {renderSearch('timed')}
          {renderSearch('plain')}
        </div>

        <footer className="stitch-lyrics-dialog-foot">
          <span className="stitch-lyrics-selection-summary" role="status">
            {selected.timed && selected.plain ? t('Two sources selected') : t('Select one result from each source')}
          </span>
          <div className="stitch-lyrics-dialog-actions">
            <button type="button" className="stitch-lyrics-cancel" onClick={onClose}>{t('Cancel')}</button>
            <button
              type="button"
              className="stitch-lyrics-apply"
              onClick={apply}
              disabled={selected.timed?.result.kind !== 'synced' || !selected.plain?.plain?.trim()}
            >
              {t('Apply to editor')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  ), document.body)
}

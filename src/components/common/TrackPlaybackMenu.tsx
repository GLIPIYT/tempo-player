import { ChevronLeft, ChevronRight, Gauge, SlidersVertical, Volume2 } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { resolveLang, useT } from '../../i18n'
import { useSettings } from '../../state/settings'
import { usePlayerField } from '../../player'
import { playerController } from '../../player/controller'
import {
  EMPTY_TRACK_PLAYBACK_PREFERENCES, getTrackPlaybackPreferences, samePlaybackTrack, setTrackPlaybackPreferences,
  type TrackPlaybackPatch, type TrackPlaybackPreferences,
} from '../../player/trackPlaybackPreferences'
import type { UnifiedTrack } from '../../types/models'
import Cover from './Cover'
import PlaybackRange from './PlaybackRange'
import { toast } from './Toast'
import './trackPlaybackMenu.css'

export type TrackPlaybackMenuTrack = Pick<UnifiedTrack, 'source' | 'sourceId' | 'title' | 'artists' | 'coverPath'>

export default function TrackPlaybackMenu({ children, track, showEntry = true }: {
  children: ReactNode
  track: TrackPlaybackMenuTrack
  showEntry?: boolean
}) {
  const t = useT()
  const panelId = useId()
  const [editing, setEditing] = useState(false)
  const [opened, setOpened] = useState(false)
  const [height, setHeight] = useState<number>()
  const actions = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const entry = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const pane = editing ? panel.current : actions.current
    if (!pane) return
    const measure = () => setHeight(Math.ceil(pane.getBoundingClientRect().height))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [editing])
  useLayoutEffect(() => {
    if (actions.current) actions.current.inert = editing
    if (panel.current) panel.current.inert = !editing
    if (editing) back.current?.focus({ preventScroll: true })
    else if (opened) entry.current?.focus({ preventScroll: true })
  }, [editing, opened])

  return (
    <div className="track-playback-menu" style={{ height }}>
      <div className={`track-playback-menu-panes${editing ? ' is-editing' : ''}`}>
        <div ref={actions} className="track-playback-menu-actions" role="menu" aria-hidden={editing}>
          {children}
          {showEntry && <>
            <div className="menu-sep" />
            <button ref={entry} type="button" className="menu-item track-playback-menu-entry" role="menuitem"
              aria-controls={panelId} aria-expanded={editing} onClick={() => {
                setOpened(true)
                setEditing(true)
              }}>
              <SlidersVertical size={14} />
              <span>{t('Track settings')}</span>
              <ChevronRight size={13} />
            </button>
          </>}
        </div>
        <div ref={panel} id={panelId} role="group" aria-label={t('Track settings')} aria-hidden={!editing} className="track-playback-menu-editor">
          {opened && <>
            <header className="track-playback-menu-heading">
              <button ref={back} type="button" className="icon-btn" onClick={() => setEditing(false)} aria-label={t('Back to track menu')}>
                <ChevronLeft size={16} />
              </button>
              <strong>{t('Track settings')}</strong>
            </header>
            <div className="track-playback-menu-track">
              <Cover path={track.coverPath} label={track.title} size={34} loading="eager" />
              <span><strong title={track.title}>{track.title}</strong><small>{track.artists.join(', ')}</small></span>
            </div>
            <TrackPlaybackFaders track={track} />
          </>}
        </div>
      </div>
    </div>
  )
}

type Field = keyof TrackPlaybackPatch
const fields = ['volume', 'playbackRate'] as const
const rememberField = { volume: 'savedVolume', playbackRate: 'savedPlaybackRate' } as const
const speedFormat = {
  ru: new Intl.NumberFormat('ru', { maximumFractionDigits: 2 }),
  en: new Intl.NumberFormat('en', { maximumFractionDigits: 2 }),
}

function TrackPlaybackFaders({ track }: { track: TrackPlaybackMenuTrack }) {
  const t = useT()
  const { settings } = useSettings()
  const formatSpeed = speedFormat[resolveLang(settings.lang)]
  const id = useId()
  const current = usePlayerField('currentTrack')
  const activePreferences = usePlayerField('trackPlaybackPreferences')
  const globalVolume = usePlayerField('globalVolume')
  const globalPlaybackRate = usePlayerField('globalPlaybackRate')
  const isCurrentTrack = samePlaybackTrack(current, track)
  const live = isCurrentTrack ? activePreferences : undefined
  const identity = useMemo(() => ({ source: track.source, sourceId: track.sourceId }), [track.source, track.sourceId])
  const [stored, setStored] = useState<TrackPlaybackPreferences | null>(live ?? null)
  const [draft, setDraft] = useState<TrackPlaybackPatch>({})
  const mounted = useRef(false)
  const revision = useRef(0)
  const waiting = useRef<TrackPlaybackPatch>({})
  const rememberedOnDisable = useRef<Partial<Record<Field, number>>>({})
  const timer = useRef<number | undefined>(undefined)
  const flush = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
    const sent = waiting.current
    waiting.current = {}
    if (!Object.keys(sent).length) return
    const settle = () => {
      if (!mounted.current) return
      setDraft(previous => {
        const next = { ...previous }
        for (const field of fields) {
          if (sent[field] !== undefined && previous[field] === sent[field]) delete next[field]
        }
        return next
      })
    }
    void setTrackPlaybackPreferences(identity, sent).then(next => {
      if (!isTauri() && 'refreshTrackPlaybackPreferences' in playerController) {
        playerController.refreshTrackPlaybackPreferences(identity)
      }
      if (mounted.current) setStored(next)
    }).catch(() => toast.show(t('Could not save track settings'), 'error')).finally(settle)
  }, [identity, t])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      flush()
    }
  }, [flush])

  useEffect(() => {
    const readAt = revision.current
    let cancelled = false
    void getTrackPlaybackPreferences(identity).then(prefs => {
      if (!cancelled && readAt === revision.current) setStored(prefs)
    }).catch(() => {
      if (!cancelled) toast.show(t('Could not load track settings'), 'error')
    })
    return () => { cancelled = true }
  }, [identity, t])
  useEffect(() => {
    if (!live) return
    setStored(previous => previous && fields.every(field =>
      live[field] === previous[field] && live[rememberField[field]] === previous[rememberField[field]]
    ) ? previous : live)
  }, [live])

  const preferences = stored ?? EMPTY_TRACK_PLAYBACK_PREFERENCES
  const update = (field: Field, value: number | null, immediately = false) => {
    if (value === null) {
      const previous = draft[field] ?? preferences[field]
      if (previous !== null) rememberedOnDisable.current[field] = previous
      if (waiting.current[field] != null) flush()
    }
    revision.current += 1
    setDraft(previous => ({ ...previous, [field]: value }))
    waiting.current = { ...waiting.current, [field]: value }
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    if (immediately) flush()
    else timer.current = window.setTimeout(flush, 80)
  }

  return (
    <div className="track-playback-faders">
      {fields.map(field => {
        const volume = field === 'volume'
        const Icon = volume ? Volume2 : Gauge
        const name = t(volume ? 'Volume' : 'Track speed')
        const personal = draft[field] !== undefined ? draft[field] : preferences[field]
        const enabled = personal !== null
        const base = volume ? globalVolume ?? 0.8 : globalPlaybackRate ?? 1
        const value = personal ?? base
        const saved = (draft[field] === null ? rememberedOnDisable.current[field] : undefined)
          ?? preferences[rememberField[field]] ?? base
        const readout = volume ? `${Math.round(value * 100)}%`
          : `${formatSpeed.format(value)}×`
        return (
            <div key={field} className={`track-playback-fader${enabled ? '' : ' is-off'}`}>
              <label htmlFor={`${id}-${field}`}><Icon size={16} />{name}</label>
              <output htmlFor={`${id}-${field}`}>{readout}</output>
              <div className={`track-playback-scale${volume ? '' : ' is-speed'}`}>
                <PlaybackRange id={`${id}-${field}`} vertical min={volume ? 0 : 0.5} max={volume ? 1 : 2}
                  step={volume ? 0.01 : 0.05} value={value} label={name} valueText={readout} disabled={!enabled}
                  onChange={next => update(field, next)} onCommit={flush} />
                <span className="track-playback-scale-labels" aria-hidden="true">
                  {(volume ? ['100', '50', '0'] : ['2×', '1×', '0.5×']).map(label => <span key={label}>{label}</span>)}
                </span>
              </div>
              <button
                type="button" className={`pb-speed-switch track-playback-toggle${enabled ? ' is-on' : ''}`}
                role="switch" aria-label={t(volume ? 'Personal volume' : 'Personal speed')} aria-checked={enabled}
                disabled={stored === null}
                onClick={() => update(field, enabled ? null : saved, true)}
              ><span /></button>
            </div>
        )
      })}
    </div>
  )
}

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Check, ChevronDown, MicVocal, Music2, Pause, Pin, Play, RotateCcw, Search, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react'
import type { TouchEvent as ReactTouchEvent, WheelEvent as ReactWheelEvent } from 'react'
import { usePlayer } from '../../player'
import { useT } from '../../i18n'
import { useSettings } from '../../state/settings'
import Cover from '../../components/common/Cover'
import { fmtTime } from '../../utils/format'
import { api } from '../../api/client'
import type { LyricsOverride } from '../../types/models'
import { EmbeddedTagsLyricsProvider } from './embeddedProvider'
import { fetchOnlineLyricsCandidates } from './onlineProvider'
import type { LyricsCandidate } from './onlineProvider'
import type { LyricsLine, LyricsResult } from './types'
import { formatLrc, parseLrc } from './lrc'
import { lyricsService } from './lyricsService'
import './lyrics.css'

interface LyricsOverlayProps {
  onClose: () => void
}

type OverlayMode = 'synced' | 'plain' | 'empty' | 'loading'

interface LyricSegment {
  kind: 'line' | 'notes'
  timeSec: number
  endTimeSec: number
  text: string
  seekToSec: number
}

const GAP_THRESHOLD_SEC = 5
const ANCHOR_RATIO = 0.38
const PAUSE_MS = 4000
const END_HOLD_SEC = 3
const OFFSET_STEP_MS = 500
const OFFSET_LIMIT_MS = 30000

const overlayCache = new Map<string, { candidates: LyricsCandidate[]; selectedIndex: number }>()

/**
 * The raw text a candidate would be pinned as. Online candidates carry their
 * original body; an embedded one only ever existed as parsed lines, so it is
 * written back out. A plain candidate pins as its own text.
 */
function candidateLrc(c: LyricsCandidate): string {
  if (c.syncedLrc && c.syncedLrc.trim()) return c.syncedLrc
  if (c.result.kind === 'synced') return formatLrc(c.result.lines)
  if (c.plain && c.plain.trim()) return c.plain
  return c.result.kind === 'plain' ? c.result.text : ''
}

/**
 * Re-times an already-parsed candidate by `offsetMs`. The pinned row keeps the
 * unshifted body plus an offset, so the offset has to be re-applied whenever the
 * overlay renders - and re-applied from the original, not stacked on the last
 * render, which is why this re-parses instead of nudging in place.
 */
function shiftCandidate(c: LyricsCandidate, offsetMs: number): LyricsCandidate {
  if (offsetMs === 0 || c.result.kind !== 'synced') return c
  const raw = candidateLrc(c)
  const lines = raw ? parseLrc(raw, offsetMs) : null
  if (!lines || lines.length === 0) return c
  return { ...c, result: { kind: 'synced', lines } }
}

/** A pinned row rendered as a candidate, so the dropdown can show what it is. */
function overrideCandidate(pinned: LyricsOverride): LyricsCandidate | null {
  const lines = parseLrc(pinned.lrc)
  if (lines && lines.length > 0) {
    return { provider: pinned.provider, result: { kind: 'synced', lines }, plain: null, syncedLrc: pinned.lrc }
  }
  const text = pinned.lrc.trim()
  if (!text) return null
  return { provider: pinned.provider, result: { kind: 'plain', text }, plain: pinned.lrc, syncedLrc: null }
}

/**
 * Whether a candidate is the one currently pinned. Compared on provider plus the
 * head of the body: a re-fetch of the same provider hands back an equal but not
 * identical object, and the pinned row's own copy went through the DB.
 */
function samePin(c: LyricsCandidate, pinned: LyricsOverride | null): boolean {
  if (!pinned) return false
  if (c.provider !== pinned.provider) return false
  const a = candidateLrc(c).trim().slice(0, 200)
  const b = pinned.lrc.trim().slice(0, 200)
  return a === b
}

function providerLabel(provider: string, t: (k: string) => string): string {
  if (provider === 'embedded') return t('Embedded')
  if (provider === 'lrclib') return 'LRCLib'
  if (provider === 'textyl') return 'Textyl'
  if (provider === 'musixmatch') return 'Musixmatch'
  if (provider === 'lyrics.ovh' || provider === 'lyrics_ovh') return 'lyrics.ovh'
  if (provider === 'genius') return 'Genius'
  return provider
}

function buildSegments(lines: LyricsLine[]): LyricSegment[] {
  const segs: LyricSegment[] = []
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1]
    const gap = next ? Math.max(0, next.timeSec - lines[i].timeSec) : 0
    // a timecode with no text is the file's own instrumental marker - drawn as
    // notes rather than a blank row, and it needs no gap threshold to qualify
    if (!lines[i].text.trim()) {
      const end = next ? next.timeSec : lines[i].timeSec + 6
      const prev = segs[segs.length - 1]
      if (prev && prev.kind === 'notes' && prev.endTimeSec >= lines[i].timeSec) {
        // consecutive markers collapse into one run of notes, and the click target
        // moves with it so it always lands on the next sung line
        prev.endTimeSec = end
        prev.seekToSec = next ? next.timeSec : lines[i].timeSec
        continue
      }
      segs.push({
        kind: 'notes',
        timeSec: lines[i].timeSec,
        endTimeSec: end,
        text: '',
        seekToSec: next ? next.timeSec : lines[i].timeSec,
      })
      continue
    }
    if (next && gap > GAP_THRESHOLD_SEC) {
      const dotsAt = lines[i].timeSec + gap * 0.5
      segs.push({ kind: 'line', timeSec: lines[i].timeSec, endTimeSec: dotsAt, text: lines[i].text, seekToSec: lines[i].timeSec })
      segs.push({ kind: 'notes', timeSec: dotsAt, endTimeSec: next.timeSec, text: '', seekToSec: next.timeSec })
    } else {
      segs.push({
        kind: 'line',
        timeSec: lines[i].timeSec,
        endTimeSec: next ? next.timeSec : lines[i].timeSec + 6,
        text: lines[i].text,
        seekToSec: lines[i].timeSec,
      })
    }
  }
  const last = segs[segs.length - 1]
  if (last && last.kind === 'line') {
    segs.push({
      kind: 'notes',
      timeSec: last.endTimeSec + END_HOLD_SEC,
      endTimeSec: Number.POSITIVE_INFINITY,
      text: '',
      seekToSec: last.seekToSec,
    })
  }
  return segs
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function resolveCoverSrc(src: string): string {
  return /^https?:\/\//.test(src) ? src : convertFileSrc(src)
}

const Backdrop = memo(function Backdrop({ coverPath }: { coverPath: string | null }) {
  const [layers, setLayers] = useState<Array<{ id: number; src: string | null }>>([])
  const nextId = useRef(1)

  useEffect(() => {
    const id = nextId.current++
    setLayers((ls) => [...ls.slice(-1), { id, src: coverPath }])
    const tm = window.setTimeout(() => {
      setLayers((ls) => ls.filter((l) => l.id === id))
    }, 900)
    return () => window.clearTimeout(tm)
  }, [coverPath])

  return (
    <div className="lyr-bg" aria-hidden="true">
      {layers.map((l) =>
        l.src ? (
          <img key={l.id} className="lyr-bg-img" src={resolveCoverSrc(l.src)} alt="" draggable={false} />
        ) : (
          <div key={l.id} className="lyr-bg-fallback" />
        ),
      )}
      <div className="lyr-bg-shade" />
      <div className="lyr-bg-vignette" />
    </div>
  )
})

function SideTimeline() {
  const p = usePlayer()
  const dur = p.duration > 0 ? p.duration : (p.currentTrack?.durationSec ?? 0)
  const pct = dur > 0 ? clamp((p.position / dur) * 100, 0, 100) : 0
  return (
    <div className="lyr-time-row">
      <span className="lyr-time lyr-time-cur">{fmtTime(p.position)}</span>
      <div className="lyr-mini-bar">
        <div className="lyr-mini-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="lyr-time lyr-time-total">{fmtTime(dur)}</span>
    </div>
  )
}

function LyricsVolumeRow() {
  const p = usePlayer()
  const t = useT()
  const pct = Math.round(clamp(p.volume, 0, 1) * 100)
  const Icon = p.volume === 0 ? VolumeX : Volume2
  return (
    <div className="lyr-volume-row">
      <Icon size={16} className="lyr-volume-icon" />
      <input
        className="lyr-volume-range"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={p.volume}
        onChange={(e) => p.setVolume(parseFloat(e.target.value))}
        style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, var(--border) ${pct}%)` }}
        aria-label={t('Volume')}
      />
      <span className="lyr-volume-pct">{pct}%</span>
    </div>
  )
}

function SyncedView({ lines }: { lines: LyricsLine[] }) {
  const p = usePlayer()
  const t = useT()
  const seek = p.seek
  const segments = useMemo(() => buildSegments(lines), [lines])
  const stageRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const itemEls = useRef<Array<HTMLElement | null>>([])
  const offsetsRef = useRef<Array<{ top: number; height: number }>>([])
  const metaRef = useRef<{ stageH: number; contentH: number }>({ stageH: 0, contentH: 0 })
  const segIdxRef = useRef(-1)
  const underlineRef = useRef<HTMLSpanElement | null>(null)
  const textRef = useRef<HTMLSpanElement | null>(null)
  const pctRef = useRef(0)
  const pausedRef = useRef(false)
  const pauseTimerRef = useRef(0)
  const userOffsetRef = useRef(0)
  const touchYRef = useRef(0)
  const [segIdx, setSegIdx] = useState(-1)
  const [paused, setPaused] = useState(false)

  const applyTransform = useCallback((instant: boolean) => {
    const c = containerRef.current
    const stage = stageRef.current
    if (!c || !stage) return
    const idx = segIdxRef.current
    const offsets = offsetsRef.current
    if (idx < 0 || !offsets[idx]) return
    const o = offsets[idx]
    const anchor = stage.clientHeight * ANCHOR_RATIO
    const baseTy = anchor - (o.top + o.height / 2)
    const minTy = stage.clientHeight - metaRef.current.contentH
    const ty = clamp(baseTy + userOffsetRef.current, minTy, 0)
    const target = `translate3d(0, ${ty.toFixed(2)}px, 0)`
    if (instant) {
      c.style.transition = 'none'
      c.style.transform = target
      void c.offsetHeight
      c.style.transition = ''
    } else if (c.style.transform !== target) {
      c.style.transform = target
    }
  }, [])

  const measureAll = useCallback(
    (instant: boolean) => {
      const c = containerRef.current
      const stage = stageRef.current
      if (!c || !stage) return
      const offsets = offsetsRef.current
      for (let i = 0; i < itemEls.current.length; i++) {
        const el = itemEls.current[i]
        offsets[i] = el ? { top: el.offsetTop, height: el.offsetHeight } : { top: 0, height: 0 }
      }
      metaRef.current = { stageH: stage.clientHeight, contentH: c.scrollHeight }
      applyTransform(instant)
    },
    [applyTransform],
  )

  useEffect(() => {
    const raf = requestAnimationFrame(() => measureAll(true))
    return () => cancelAnimationFrame(raf)
  }, [segments, measureAll])

  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => measureAll(true))
    }
    window.addEventListener('resize', onResize)
    let alive = true
    document.fonts.ready.then(() => {
      if (alive) measureAll(true)
    })
    return () => {
      alive = false
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
    }
  }, [measureAll])

  useEffect(() => {
    if (segments.length === 0) return
    const pos = p.position
    let lo = 0
    let hi = segments.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (segments[mid].timeSec <= pos) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (found !== segIdxRef.current) {
      segIdxRef.current = found
      setSegIdx(found)
      if (!pausedRef.current) applyTransform(false)
    }
    const seg = found >= 0 ? segments[found] : null
    const ul = underlineRef.current
    const tx = textRef.current
    if (seg && seg.kind === 'line' && seg.endTimeSec > seg.timeSec) {
      const pct = Math.floor(clamp(((pos - seg.timeSec) / (seg.endTimeSec - seg.timeSec)) * 100, 0, 100))
      if (pct !== pctRef.current) {
        pctRef.current = pct
        if (ul) ul.style.width = `${pct}%`
        if (tx) tx.style.setProperty('--lyr-fill', `${pct}%`)
      }
    } else if (pctRef.current !== 0) {
      pctRef.current = 0
      if (ul) ul.style.width = '0%'
      if (tx) tx.style.setProperty('--lyr-fill', '0%')
    }
  }, [p.position, segments, applyTransform])

  const endPause = useCallback(() => {
    if (pauseTimerRef.current !== 0) {
      window.clearTimeout(pauseTimerRef.current)
      pauseTimerRef.current = 0
    }
    pausedRef.current = false
    setPaused(false)
    userOffsetRef.current = 0
    applyTransform(false)
  }, [applyTransform])

  useEffect(
    () => () => {
      if (pauseTimerRef.current !== 0) window.clearTimeout(pauseTimerRef.current)
    },
    [],
  )

  const engagePause = useCallback(() => {
    if (pauseTimerRef.current !== 0) window.clearTimeout(pauseTimerRef.current)
    pausedRef.current = true
    setPaused(true)
    pauseTimerRef.current = window.setTimeout(endPause, PAUSE_MS)
  }, [endPause])

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    engagePause()
    userOffsetRef.current -= e.deltaY
    applyTransform(false)
  }

  const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    touchYRef.current = e.touches[0].clientY
  }

  const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    engagePause()
    const y = e.touches[0].clientY
    userOffsetRef.current += touchYRef.current - y
    touchYRef.current = y
    applyTransform(false)
  }

  const itemsNode = useMemo(
    () =>
      segments.map((s, i) => {
        if (s.kind === 'notes') {
          const isActive = i === segIdx
          return (
            <button
              key={`n${i}`}
              ref={(el) => {
                itemEls.current[i] = el
              }}
              className={'lyr-notes' + (isActive ? ' is-active' : '')}
              onClick={() => {
                endPause()
                seek(s.seekToSec)
              }}
              aria-label={t('Skip instrumental')}
            >
              <Music2 size={17} className="lyr-note" />
              <Music2 size={17} className="lyr-note" />
              <Music2 size={17} className="lyr-note" />
            </button>
          )
        }
        const cls = 'lyr-line' + (i === segIdx ? ' is-active' : i < segIdx ? ' is-past' : '')
        return (
          <div
            key={`l${i}`}
            ref={(el) => {
              itemEls.current[i] = el
            }}
            className={cls}
            onClick={() => {
              endPause()
              seek(s.seekToSec)
            }}
          >
            <span
              className="lyr-line-text"
              ref={
                i === segIdx
                  ? (el) => {
                      textRef.current = el
                    }
                  : null
              }
            >
              {s.text}
            </span>
            <span
              className="lyr-underline"
              ref={
                i === segIdx
                  ? (el) => {
                      underlineRef.current = el
                    }
                  : null
              }
            />
          </div>
        )
      }),
    [segments, segIdx, seek, t, endPause],
  )

  return (
    <div className="lyr-synced" ref={stageRef} onWheel={onWheel} onTouchStart={onTouchStart} onTouchMove={onTouchMove}>
      <div className="lyr-track" ref={containerRef}>
        {itemsNode}
      </div>
      {paused && (
        <button className="lyr-pill" onClick={endPause}>
          {t('Return to current')}
        </button>
      )}
    </div>
  )
}

function PlainView({ text }: { text: string }) {
  return <div className="lyr-plain">{text}</div>
}

function LoadingMark() {
  return (
    <div className="lyr-loading" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  )
}

function EmptyLyrics({ unavailable }: { unavailable: boolean }) {
  const t = useT()
  return (
    <div className="lyr-empty">
      <MicVocal size={46} strokeWidth={1.5} className="lyr-empty-icon" />
      <div className="lyr-empty-title">{t('No lyrics for this track')}</div>
      <div className="lyr-empty-hint">
        {unavailable ? t('Lyrics search is unavailable right now') : t('Lyrics search arrives with online sources')}
      </div>
    </div>
  )
}

function ProviderDropdown({
  candidates,
  selectedIndex,
  onSelect,
  onReset,
  pinnedIndex,
  canPin,
}: {
  candidates: LyricsCandidate[]
  selectedIndex: number
  onSelect: (idx: number) => void
  onReset: () => void
  /** index of the candidate that is pinned, or -1 */
  pinnedIndex: number
  canPin: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const selected = candidates[selectedIndex] ?? candidates[0]
  const isSyncedSelected = selected ? Boolean(selected.syncedLrc) || selected.result.kind === 'synced' : false

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!selected) return null

  return (
    <div className="lyr-prov-dropdown" ref={wrapRef}>
      <button className="lyr-prov-trigger" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <span className="lyr-prov-trigger-name">{providerLabel(selected.provider, t)}</span>
        <span className={'lyr-prov-badge' + (isSyncedSelected ? ' is-synced' : ' is-plain')}>
          {isSyncedSelected ? t('SYNCED') : t('TEXT')}
        </span>
        <ChevronDown size={14} className={'lyr-prov-chevron' + (open ? ' is-open' : '')} />
      </button>
      {open && (
        <div className="lyr-prov-menu" role="menu">
          {/* Selecting a row pins it, so the way back to automatic lyrics has to be
              a row of its own. Shown only when pinning is possible at all. */}
          {canPin && (
            <button
              role="menuitemradio"
              aria-checked={pinnedIndex < 0}
              className={'lyr-prov-item lyr-prov-item-auto' + (pinnedIndex < 0 ? ' is-selected' : '')}
              onClick={() => {
                onReset()
                setOpen(false)
              }}
            >
              <span className="lyr-prov-item-main">
                <RotateCcw size={13} className="lyr-prov-item-glyph" />
                <span className="lyr-prov-item-name">{t('Auto (reset)')}</span>
              </span>
              {pinnedIndex < 0 && <Check size={14} className="lyr-prov-item-check" />}
            </button>
          )}
          {candidates.map((c, i) => {
            const isSelected = i === selectedIndex
            const isSynced = Boolean(c.syncedLrc) || c.result.kind === 'synced'
            return (
              <button
                key={`${c.provider}-${i}`}
                role="menuitemradio"
                aria-checked={isSelected}
                className={'lyr-prov-item' + (isSelected ? ' is-selected' : '')}
                onClick={() => {
                  onSelect(i)
                  setOpen(false)
                }}
              >
                <span className="lyr-prov-item-main">
                  <span className="lyr-prov-item-name">{providerLabel(c.provider, t)}</span>
                  <span className={'lyr-prov-badge' + (isSynced ? ' is-synced' : ' is-plain')}>
                    {isSynced ? t('SYNCED') : t('TEXT')}
                  </span>
                  {i === pinnedIndex && <Pin size={12} className="lyr-prov-item-pin" />}
                </span>
                {isSelected && <Check size={14} className="lyr-prov-item-check" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Pinned marker plus the ±0.5s nudge. Editing the offset of automatic lyrics pins
 * the current selection first - there is nowhere else to keep an offset.
 */
function OffsetControls({
  offsetMs,
  pinned,
  onNudge,
}: {
  offsetMs: number
  pinned: boolean
  onNudge: (deltaMs: number) => void
}) {
  const t = useT()
  const label = offsetMs === 0 ? '0.0s' : `${offsetMs > 0 ? '+' : '−'}${(Math.abs(offsetMs) / 1000).toFixed(1)}s`
  return (
    <div className="lyr-offset">
      {pinned && (
        <span className="lyr-pinned-badge" title={t('These lyrics are pinned to this track')}>
          <Pin size={11} />
          {t('Pinned')}
        </span>
      )}
      <button
        className="lyr-offset-btn"
        onClick={() => onNudge(-OFFSET_STEP_MS)}
        aria-label={t('Lyrics earlier by 0.5s')}
        title={t('Lyrics earlier by 0.5s')}
      >
        −0.5s
      </button>
      <span className={'lyr-offset-value' + (offsetMs === 0 ? '' : ' is-shifted')}>{label}</span>
      <button
        className="lyr-offset-btn"
        onClick={() => onNudge(OFFSET_STEP_MS)}
        aria-label={t('Lyrics later by 0.5s')}
        title={t('Lyrics later by 0.5s')}
      >
        +0.5s
      </button>
    </div>
  )
}

export default function LyricsOverlay({ onClose }: LyricsOverlayProps) {
  const p = usePlayer()
  const t = useT()
  const track = p.currentTrack
  const trackKey = track ? `${track.source}|${track.sourceId}|${track.title}|${track.artists.join(',')}` : ''
  const [candidates, setCandidates] = useState<LyricsCandidate[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [unavailableHint, setUnavailableHint] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [manualArtist, setManualArtist] = useState(track?.artists[0] ?? '')
  const [manualTitle, setManualTitle] = useState(track?.title ?? '')
  const [searching, setSearching] = useState(false)
  const [pinned, setPinned] = useState<LyricsOverride | null>(null)
  /** the terms the last manual search actually used, for the pinned row's provenance */
  const [searchedAs, setSearchedAs] = useState<{ artist: string; title: string } | null>(null)
  const { settings } = useSettings()
  // Only tracks with a database row can pin - there is nothing to pin to otherwise,
  // so SoundCloud results that were never cached keep the session-only dropdown.
  const canPin = track?.dbId != null

  useEffect(() => {
    let cancelled = false
    const id = p.currentTrack?.dbId ?? null
    if (id == null) {
      setPinned(null)
      return
    }
    api
      .getLyricsOverride(id)
      .then((row) => {
        if (!cancelled) setPinned(row)
      })
      .catch(() => {
        if (!cancelled) setPinned(null)
      })
    return () => {
      cancelled = true
    }
    // the track identity is the trigger; dbId is a function of it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey])

  useEffect(() => {
    const tr = p.currentTrack
    if (tr) {
      setManualArtist(tr.artists[0] ?? '')
      setManualTitle(tr.title)
    } else {
      setManualArtist('')
      setManualTitle('')
    }
    setShowManual(false)
    setSearchedAs(null)
  }, [trackKey, p.currentTrack])

  useEffect(() => {
    let cancelled = false
    const tr = p.currentTrack
    const key = tr ? `${tr.source}|${tr.sourceId}|${tr.title}|${tr.artists.join(',')}` : ''
    if (!tr) {
      setCandidates([])
      setSelectedIndex(0)
      setLoading(false)
      setUnavailableHint(false)
      return
    }
    const cached = overlayCache.get(key)
    if (cached) {
      setCandidates(cached.candidates)
      setSelectedIndex(cached.selectedIndex)
      setLoading(false)
      setUnavailableHint(false)
      return
    }
    setCandidates([])
    setSelectedIndex(0)
    setUnavailableHint(false)
    setLoading(true)
    let list: LyricsCandidate[] = []
    EmbeddedTagsLyricsProvider.getLyrics(tr)
      .catch(() => null)
      .then((embedded: LyricsResult | null) => {
        if (cancelled) return
        if (embedded) {
          list = [{ provider: 'embedded', result: embedded, plain: null, syncedLrc: null }]
          setCandidates([...list])
          setSelectedIndex(0)
          setLoading(false)
          overlayCache.set(key, { candidates: [...list], selectedIndex: 0 })
        }
        const artist = tr.artists[0] ?? ''
        const title = tr.title
        return fetchOnlineLyricsCandidates(artist, title, tr)
          .then((online) => {
            if (cancelled) return
            if (online.length === 0) {
              if (list.length === 0) {
                setUnavailableHint(true)
                setLoading(false)
              }
              return
            }
            const combined = [...list, ...online]
            let sel = 0
            if (list.length === 0) {
              const firstSynced = combined.findIndex((c) => c.result.kind === 'synced')
              sel = firstSynced >= 0 ? firstSynced : 0
            }
            setCandidates(combined)
            setSelectedIndex(sel)
            setLoading(false)
            setUnavailableHint(false)
            overlayCache.set(key, { candidates: combined, selectedIndex: sel })
          })
          .catch(() => {
            if (cancelled) return
            if (list.length === 0) {
              setLoading(false)
              setUnavailableHint(true)
            } else {
              setLoading(false)
            }
          })
      })
      .catch(() => {
        if (cancelled) return
        const artist = tr.artists[0] ?? ''
        const title = tr.title
        fetchOnlineLyricsCandidates(artist, title, tr)
          .then((online) => {
            if (cancelled) return
            if (online.length === 0) {
              setLoading(false)
              setUnavailableHint(true)
              return
            }
            const firstSynced = online.findIndex((c) => c.result.kind === 'synced')
            const sel = firstSynced >= 0 ? firstSynced : 0
            setCandidates(online)
            setSelectedIndex(sel)
            setLoading(false)
            overlayCache.set(key, { candidates: online, selectedIndex: sel })
          })
          .catch(() => {
            if (!cancelled) {
              setLoading(false)
              setUnavailableHint(true)
            }
          })
      })
    return () => {
      cancelled = true
    }
  }, [trackKey])

  useEffect(() => {
    const prev = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.documentElement.style.overflow = prev
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pinnedIndex = useMemo(
    () => (pinned ? candidates.findIndex((c) => samePin(c, pinned)) : -1),
    [candidates, pinned],
  )
  const offsetMs = pinned?.offsetMs ?? 0

  /**
   * A pin whose source is not in the fetched list - pinned from another song's
   * search, or fetched from a provider that has since stopped answering. It gets
   * prepended so the dropdown can still show and render it.
   */
  const pinnedExtra = useMemo(
    () => (pinned && pinnedIndex < 0 ? overrideCandidate(pinned) : null),
    [pinned, pinnedIndex],
  )
  const viewPinnedIndex = pinnedExtra ? 0 : pinnedIndex
  /** The dropdown's list: fetched candidates, with the stray pin in front if any. */
  const baseCandidates = useMemo(
    () => (pinnedExtra ? [pinnedExtra, ...candidates] : candidates),
    [pinnedExtra, candidates],
  )
  const viewCandidates = useMemo(() => {
    if (offsetMs === 0 || viewPinnedIndex < 0) return baseCandidates
    // Only the pinned row carries the offset; the others are still their own timing.
    return baseCandidates.map((c, i) => (i === viewPinnedIndex ? shiftCandidate(c, offsetMs) : c))
  }, [baseCandidates, offsetMs, viewPinnedIndex])
  // A pin is the selection, by definition - selecting is what pinning is.
  const viewSelectedIndex =
    viewPinnedIndex >= 0 ? viewPinnedIndex : selectedIndex + (pinnedExtra ? 1 : 0)
  const selected = viewCandidates[viewSelectedIndex] ?? null
  const mode: OverlayMode =
    loading && viewCandidates.length === 0 ? 'loading' : selected ? selected.result.kind : 'empty'

  /**
   * Writes the pin and tells the lyrics service to forget what it cached, so the
   * Discord presence follows the same choice instead of waiting for a track change.
   */
  const persistPin = useCallback(
    async (candidate: LyricsCandidate, nextOffsetMs: number) => {
      const tr = p.currentTrack
      if (!tr || tr.dbId == null) return
      const lrc = candidateLrc(candidate)
      if (!lrc.trim()) return
      try {
        await api.setLyricsOverride({
          trackId: tr.dbId,
          provider: candidate.provider,
          sourceArtist: searchedAs?.artist ?? tr.artists[0] ?? null,
          sourceTitle: searchedAs?.title ?? tr.title,
          lrc,
          offsetMs: nextOffsetMs,
        })
        setPinned({
          provider: candidate.provider,
          sourceArtist: searchedAs?.artist ?? tr.artists[0] ?? null,
          sourceTitle: searchedAs?.title ?? tr.title,
          lrc,
          offsetMs: nextOffsetMs,
          updatedAt: Math.floor(Date.now() / 1000),
        })
        lyricsService.invalidate(tr.sourceId)
        lyricsService.ensure(tr, settings.lyrics.cacheOnline)
      } catch {}
    },
    [p.currentTrack, searchedAs, settings.lyrics.cacheOnline],
  )

  /**
   * `viewIdx` addresses the rendered list, which may carry a stray pin in front of
   * the fetched ones. Selecting that row is a no-op - it is already the pin.
   */
  const handleSelect = useCallback(
    (viewIdx: number) => {
      const idx = pinnedExtra ? viewIdx - 1 : viewIdx
      if (idx < 0) return
      setSelectedIndex(idx)
      const tr = p.currentTrack
      const key = tr ? `${tr.source}|${tr.sourceId}|${tr.title}|${tr.artists.join(',')}` : ''
      if (key && candidates.length > 0) {
        overlayCache.set(key, { candidates, selectedIndex: idx })
      }
      // Choosing a provider is the pin gesture - there is no separate confirm.
      // The offset is dropped, since it was tuned against the previous lines.
      const candidate = candidates[idx]
      if (candidate) void persistPin(candidate, 0)
    },
    [p.currentTrack, candidates, persistPin, pinnedExtra],
  )

  /** Back to automatic: drops the row and lets the normal chain resolve again. */
  const handleResetPin = useCallback(() => {
    const tr = p.currentTrack
    if (!tr || tr.dbId == null) return
    setPinned(null)
    api
      .clearLyricsOverride(tr.dbId)
      .then(() => {
        lyricsService.invalidate(tr.sourceId)
        lyricsService.ensure(tr, settings.lyrics.cacheOnline)
      })
      .catch(() => {})
  }, [p.currentTrack, settings.lyrics.cacheOnline])

  /**
   * Nudging automatic lyrics has to pin them first - `offset_ms` lives on the
   * pinned row, and there is no other place to keep a per-track offset.
   */
  const handleNudgeOffset = useCallback(
    (deltaMs: number) => {
      const tr = p.currentTrack
      if (!tr || tr.dbId == null) return
      const next = clamp((pinned?.offsetMs ?? 0) + deltaMs, -OFFSET_LIMIT_MS, OFFSET_LIMIT_MS)
      if (pinned) {
        setPinned({ ...pinned, offsetMs: next })
        api
          .setLyricsOverrideOffset(tr.dbId, next)
          .then(() => {
            lyricsService.invalidate(tr.sourceId)
            lyricsService.ensure(tr, settings.lyrics.cacheOnline)
          })
          .catch(() => {})
        return
      }
      const candidate = candidates[selectedIndex]
      if (candidate) void persistPin(candidate, next)
    },
    [p.currentTrack, pinned, candidates, selectedIndex, persistPin, settings.lyrics.cacheOnline],
  )

  const handleManualSearch = useCallback(
    async (artist: string, title: string) => {
      const a = artist.trim()
      const tt = title.trim()
      if (!a || !tt) return
      setSearching(true)
      setUnavailableHint(false)
      try {
        const raw = await api.fetchOnlineLyricsAll(a, tt)
        const out: LyricsCandidate[] = []
        const seen = new Set<string>()
        for (const entry of raw) {
          let res: LyricsResult | null = null
          if (entry.syncedLrc) {
            const lines = parseLrc(entry.syncedLrc)
            if (lines && lines.length > 0) res = { kind: 'synced', lines }
          }
          if (!res) {
            const plain = entry.plain?.trim()
            if (plain) res = { kind: 'plain', text: plain }
          }
          if (!res) continue
          if (entry.syncedLrc) {
            const norm = entry.syncedLrc.trim().toLowerCase().slice(0, 120)
            if (seen.has(norm)) continue
            seen.add(norm)
          }
          out.push({ provider: entry.provider, result: res, plain: entry.plain, syncedLrc: entry.syncedLrc })
        }
        const embeddedOnly = candidates.filter((c) => c.provider === 'embedded')
        const combined = [...embeddedOnly, ...out]
        setSearchedAs({ artist: a, title: tt })
        if (combined.length === 0) {
          setCandidates([])
          setSelectedIndex(0)
          setUnavailableHint(true)
          const tr2 = p.currentTrack
          const key2 = tr2 ? `${tr2.source}|${tr2.sourceId}|${tr2.title}|${tr2.artists.join(',')}` : ''
          if (key2) overlayCache.set(key2, { candidates: [], selectedIndex: 0 })
        } else {
          const firstSynced = combined.findIndex((c) => c.result.kind === 'synced')
          const sel = firstSynced >= 0 ? firstSynced : 0
          setCandidates(combined)
          setSelectedIndex(sel)
          setUnavailableHint(false)
          const tr2 = p.currentTrack
          const key2 = tr2 ? `${tr2.source}|${tr2.sourceId}|${tr2.title}|${tr2.artists.join(',')}` : ''
          if (key2) overlayCache.set(key2, { candidates: combined, selectedIndex: sel })
        }
      } catch {
        if (candidates.filter((c) => c.provider === 'embedded').length === 0) {
          setUnavailableHint(true)
        }
      } finally {
        setSearching(false)
      }
    },
    [candidates, p.currentTrack],
  )

  const manualForm = (
    <div className="lyr-manual">
      <div className="lyr-manual-row">
        <input
          className="lyr-manual-input"
          value={manualArtist}
          onChange={(e) => setManualArtist(e.target.value)}
          placeholder={t('Artist')}
          aria-label={t('Artist')}
        />
        <input
          className="lyr-manual-input"
          value={manualTitle}
          onChange={(e) => setManualTitle(e.target.value)}
          placeholder={t('Title')}
          aria-label={t('Title')}
        />
      </div>
      <button
        className="lyr-manual-btn"
        onClick={() => void handleManualSearch(manualArtist, manualTitle)}
        disabled={searching || !manualArtist.trim() || !manualTitle.trim()}
      >
        <Search size={14} />
        {searching ? t('Searching…') : t('Search')}
      </button>
    </div>
  )

  return (
    <div className="lyr-overlay" role="dialog" aria-modal="true" aria-label={t('Lyrics')}>
      <Backdrop coverPath={track?.coverPath ?? null} />
      <button className="lyr-close" onClick={onClose} aria-label={t('Close')}>
        <X size={20} />
      </button>
      <div className="lyr-body">
        <aside className="lyr-side">
          <div className="lyr-cover">
            <Cover path={track?.coverPath ?? null} label={track?.title ?? '?'} size={260} />
          </div>
          <h2 className="lyr-title">{track ? track.title : t('Nothing playing')}</h2>
          <p className="lyr-artists">{track ? track.artists.join(', ') || t('Unknown artist') : t('Unknown artist')}</p>
          <SideTimeline />
          <div className="lyr-controls">
            <button className="lyr-skip" onClick={p.previous} aria-label={t('Previous')}>
              <SkipBack size={22} />
            </button>
            <button className="lyr-play" onClick={p.toggle} aria-label={p.isPlaying ? t('Pause') : t('Play')}>
              {p.isPlaying ? <Pause size={26} /> : <Play size={26} className="lyr-play-glyph" />}
            </button>
            <button className="lyr-skip" onClick={p.next} aria-label={t('Next')}>
              <SkipForward size={22} />
            </button>
          </div>
          <LyricsVolumeRow />
        </aside>
        <section className="lyr-stage-col">
          {viewCandidates.length > 0 && (
            <div className="lyr-head">
              {canPin && (
                <OffsetControls offsetMs={offsetMs} pinned={pinned !== null} onNudge={handleNudgeOffset} />
              )}
              <ProviderDropdown
                candidates={viewCandidates}
                selectedIndex={viewSelectedIndex}
                onSelect={handleSelect}
                onReset={handleResetPin}
                pinnedIndex={viewPinnedIndex}
                canPin={canPin}
              />
              <button className="lyr-manual-toggle" onClick={() => setShowManual((v) => !v)}>
                {showManual ? t('Hide') : t('Search manually')}
              </button>
              {showManual && manualForm}
            </div>
          )}
          {searching && viewCandidates.length > 0 && <LoadingMark />}
          {mode === 'synced' && selected?.result.kind === 'synced' && (
            <SyncedView key={`${trackKey}-${viewSelectedIndex}-${offsetMs}`} lines={selected.result.lines} />
          )}
          {mode === 'plain' && selected?.result.kind === 'plain' && <PlainView text={selected.result.text} />}
          {mode === 'loading' && !searching && <LoadingMark />}
          {mode === 'empty' && (
            <>
              <EmptyLyrics unavailable={unavailableHint} />
              {searching ? <LoadingMark /> : manualForm}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Check, ChevronDown, ChevronLeft, MicVocal, Music2, Pause, Pencil, Pin, Play, RotateCcw, Search, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react'
import type { CSSProperties, TouchEvent as ReactTouchEvent, WheelEvent as ReactWheelEvent } from 'react'
import { usePlayer } from '../../player'
import { useT } from '../../i18n'
import { useSettings } from '../../state/settings'
import Cover from '../../components/common/Cover'
import { fmtTime } from '../../utils/format'
import { api } from '../../api/client'
import type { LyricsEditedVersion, LyricsOverride, LrclibPublishRequest } from '../../types/models'
import { EmbeddedTagsLyricsProvider } from './embeddedProvider'
import { fetchOnlineLyricsCandidates, toLyricsCandidates } from './onlineProvider'
import type { LyricsCandidate } from './onlineProvider'
import type { LyricsResult } from './types'
import { formatLrc, shiftLyricsLines } from './lrc'
import { lyricSourceKey, lyricsService } from './lyricsService'
import {
  LYRICS_RATE_MAX,
  LYRICS_RATE_MIN,
  LYRICS_RATE_STEP,
  lyricTimeAtMediaPosition,
  lyricsRateStorageKey,
  mediaPositionAtLyricTime,
  normalizeLyricsRate,
  readLyricsRate,
  writeLyricsRate,
} from './lyricsRate'
import { activeOverrideDocument, candidatePlaybackDocument as candidateDocument, overridePlaybackResult } from './playbackDocument'
import { lyricTimingAt, type ResolvedLyricsTiming } from './timingResolver'
import LyricsEditorPanel from './LyricsEditorPanel'
import { fromLrc, fromPlainLyrics, toLrclibLyricsfile, toPlainText, toPlaybackLrc } from './editorDocument'
import type { LyricsEditorDocument } from './editorDocument'
import './lyrics.css'

interface LyricsOverlayProps {
  onClose: () => void
}

type OverlayMode = 'synced' | 'plain' | 'empty' | 'loading'

const ANCHOR_RATIO = 0.38
const PAUSE_MS = 4000
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
 * render. Shift the rich fields together without serializing them to LRC.
 */
function shiftCandidate(c: LyricsCandidate, offsetMs: number): LyricsCandidate {
  if (offsetMs === 0 || c.result.kind !== 'synced') return c
  return { ...c, result: { kind: 'synced', lines: shiftLyricsLines(c.result.lines, offsetMs) } }
}

type OverlayCandidate = LyricsCandidate & {
  displayLabel?: string
  isEditedVersion?: boolean
  savedSourceArtist?: string | null
  savedSourceTitle?: string | null
  savedOffsetMs?: number
}

type PersistedEditedVersion = LyricsEditedVersion & {
  editorDocument: LyricsEditorDocument
}

/** A pinned row rendered as a candidate, so the dropdown can show what it is. */
function overrideCandidate(
  pinned: LyricsOverride,
  metadata: {
    displayLabel?: string
    isEditedVersion?: boolean
    sourceArtist?: string | null
    sourceTitle?: string | null
    offsetMs?: number
  } = {},
): LyricsCandidate | null {
  const overlayMetadata: Partial<OverlayCandidate> = {
    ...(metadata.displayLabel ? { displayLabel: metadata.displayLabel } : {}),
    ...(metadata.isEditedVersion ? { isEditedVersion: true } : {}),
    ...(metadata.sourceArtist !== undefined ? { savedSourceArtist: metadata.sourceArtist } : {}),
    ...(metadata.sourceTitle !== undefined ? { savedSourceTitle: metadata.sourceTitle } : {}),
    ...(metadata.offsetMs !== undefined ? { savedOffsetMs: metadata.offsetMs } : {}),
    ...(metadata.sourceArtist ? { artistName: metadata.sourceArtist } : {}),
  }
  const result = overridePlaybackResult(pinned)
  const lines = result.kind === 'synced' ? result.lines : null
  if (lines && lines.length > 0) {
    return {
      provider: pinned.provider,
      result: { kind: 'synced', lines },
      plain: null,
      syncedLrc: pinned.lrc,
      ...overlayMetadata,
    }
  }
  const text = pinned.lrc.trim()
  if (!text) return null
  return {
    provider: pinned.provider,
    result: { kind: 'plain', text },
    plain: pinned.lrc,
    syncedLrc: null,
    ...overlayMetadata,
  }
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
  // An edited document must render its exact saved body. The prefix heuristic is
  // only for matching a freshly fetched copy of an unedited provider result.
  return pinned.editorDocument
    ? candidateLrc(c).trim() === pinned.lrc.trim()
    : a === b
}

function sameExactPin(c: LyricsCandidate | null, pinned: LyricsOverride | null): boolean {
  return Boolean(c && pinned && c.provider === pinned.provider && candidateLrc(c).trim() === pinned.lrc.trim())
}

function providerLabel(provider: string, t: (k: string) => string): string {
  if (provider === 'embedded') return t('Embedded')
  if (provider === 'online') return t('Online lyrics')
  if (provider === 'lrclib') return 'LRCLib'
  if (provider === 'textyl') return 'Textyl'
  if (provider === 'musixmatch') return 'Musixmatch'
  if (provider === 'lyrics.ovh' || provider === 'lyrics_ovh') return 'lyrics.ovh'
  if (provider === 'genius') return 'Genius'
  return provider
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
  const t = useT()
  const dur = p.duration > 0 ? p.duration : (p.currentTrack?.durationSec ?? 0)
  const pct = dur > 0 ? clamp((p.position / dur) * 100, 0, 100) : 0
  return (
    <div className="lyr-time-row">
      <span className="lyr-time lyr-time-cur">{fmtTime(p.position)}</span>
      <input
        className="lyr-seek-range"
        type="range"
        min={0}
        max={dur}
        step={0.1}
        value={clamp(p.position, 0, dur)}
        onChange={(event) => p.seek(Number(event.target.value))}
        disabled={dur <= 0}
        aria-label={t('Seek')}
        style={{ '--lyr-seek-progress': `${pct}%` } as CSSProperties}
      />
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
        style={{ '--fill': `${pct}%` } as CSSProperties}
        aria-label={t('Volume')}
      />
      <span className="lyr-volume-pct">{pct}%</span>
    </div>
  )
}

function SyncedView({
  timing,
  lyricsRate,
  offsetMs,
}: {
  timing: ResolvedLyricsTiming
  lyricsRate: number
  offsetMs: number
}) {
  const p = usePlayer()
  const t = useT()
  const seek = p.seek
  const segments = timing.segments
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
  const seekToLyricTime = useCallback((timeSec: number) => {
    seek(mediaPositionAtLyricTime(timeSec, lyricsRate, offsetMs))
  }, [seek, lyricsRate, offsetMs])

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
      offsets.length = segments.length
      for (let i = 0; i < segments.length; i++) {
        const el = itemEls.current[i]
        offsets[i] = el ? { top: el.offsetTop, height: el.offsetHeight } : { top: 0, height: 0 }
      }
      metaRef.current = { stageH: stage.clientHeight, contentH: c.scrollHeight }
      if (!pausedRef.current) applyTransform(instant)
    },
    [applyTransform, segments.length],
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
    const stage = stageRef.current
    const track = containerRef.current
    if (!stage || !track) return
    let raf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => measureAll(false))
    })
    observer.observe(stage)
    observer.observe(track)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [measureAll])

  useEffect(() => {
    if (segments.length === 0) return
    // p.position already advances at the track playback rate. Keep the manual
    // offset in seconds, then apply the independent lyrics multiplier around it.
    const pos = p.position
    const lyricsPosition = lyricTimeAtMediaPosition(pos, lyricsRate, offsetMs)
    const { segmentIndex: found, progress } = lyricTimingAt(timing, lyricsPosition)
    if (found !== segIdxRef.current) {
      segIdxRef.current = found
      setSegIdx(found)
      if (!pausedRef.current) applyTransform(false)
    }
    const seg = found >= 0 ? segments[found] : null
    const ul = underlineRef.current
    const tx = textRef.current
    if (seg && seg.kind === 'line' && seg.endTimeSec > seg.timeSec) {
      const pct = Math.floor(progress * 100)
      pctRef.current = pct
      if (ul) ul.style.width = `${pct}%`
      if (tx) tx.style.setProperty('--lyr-fill', `${pct}%`)
    } else if (pctRef.current !== 0) {
      pctRef.current = 0
      if (ul) ul.style.width = '0%'
      if (tx) tx.style.setProperty('--lyr-fill', '0%')
    }
  }, [p.position, timing, segments, applyTransform, segIdx, lyricsRate, offsetMs])

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
              className={'lyr-notes' + (s.skipPool ? ' is-skip-pool' : '') + (isActive ? ' is-active' : '')}
              tabIndex={isActive ? 0 : -1}
              onTransitionEnd={(event) => {
                if (event.target === event.currentTarget && event.propertyName === 'height') measureAll(false)
              }}
              onClick={() => {
                endPause()
                seekToLyricTime(s.seekToSec)
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
              seekToLyricTime(s.seekToSec)
            }}
          >
            <span
              className="lyr-line-text"
              style={{ whiteSpace: 'pre-line' }}
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
    [segments, segIdx, seekToLyricTime, t, endPause, measureAll],
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
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  const [versionQuery, setVersionQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const selected = candidates[selectedIndex] ?? (selectedIndex >= 0 ? candidates[0] : null)
  const isSyncedSelected = selected ? Boolean(selected.syncedLrc) || selected.result.kind === 'synced' : false
  const providerGroups = useMemo(() => {
    const groups = new Map<string, { key: string; provider: string; displayLabel?: string; indices: number[] }>()
    candidates.forEach((candidate, index) => {
      const displayLabel = (candidate as OverlayCandidate).displayLabel
      const key = displayLabel ? `display:${index}` : candidate.provider
      const group = groups.get(key) ?? { key, provider: candidate.provider, displayLabel, indices: [] }
      group.indices.push(index)
      groups.set(key, group)
    })
    return Array.from(groups.values())
  }, [candidates])
  const activeGroup = providerGroups.find((group) => group.key === activeProvider && group.indices.length > 1)
  const matchingVersionIndices = useMemo(() => {
    if (!activeGroup) return []
    const query = versionQuery.trim().toLocaleLowerCase()
    if (!query) return activeGroup.indices
    return activeGroup.indices.filter((index) => {
      const candidate = candidates[index]
      if (!candidate) return false
      return [candidate.trackName, candidate.artistName, candidate.albumName, candidate.duration, candidate.id]
        .some((value) => String(value ?? '').toLocaleLowerCase().includes(query))
    })
  }, [activeGroup, candidates, versionQuery])

  const closeDropdown = useCallback(() => {
    setOpen(false)
    setActiveProvider(null)
    setVersionQuery('')
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) closeDropdown()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeDropdown()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, closeDropdown])

  if (!selected && candidates.length === 0) return null

  const renderCandidate = (index: number) => {
    const candidate = candidates[index]
    if (!candidate) return null
    const displayLabel = (candidate as OverlayCandidate).displayLabel
    const isSelected = index === selectedIndex
    const isSynced = Boolean(candidate.syncedLrc) || candidate.result.kind === 'synced'
    const metadata = [
      candidate.artistName,
      candidate.albumName,
      candidate.duration != null ? fmtTime(candidate.duration) : null,
      candidate.instrumental ? t('Instrumental') : null,
    ]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(' · ')
    return (
      <button
        key={`${candidate.provider}-${index}`}
        role="menuitemradio"
        aria-checked={isSelected}
        className={'lyr-prov-item' + (isSelected ? ' is-selected' : '')}
        onClick={() => {
          onSelect(index)
          closeDropdown()
        }}
      >
        <span className="lyr-prov-item-main">
          <span className="lyr-prov-item-heading">
            <span className="lyr-prov-item-name" title={displayLabel ?? candidate.trackName?.trim()}>
              {(displayLabel ?? candidate.trackName?.trim()) || providerLabel(candidate.provider, t)}
            </span>
            <span className={'lyr-prov-badge' + (isSynced ? ' is-synced' : ' is-plain')}>
              {isSynced ? t('SYNCED') : t('TEXT')}
            </span>
            {index === pinnedIndex && <Pin size={12} className="lyr-prov-item-pin" />}
          </span>
          {metadata && <span className="lyr-prov-item-meta" title={metadata}>{metadata}</span>}
        </span>
        {isSelected && <Check size={14} className="lyr-prov-item-check" />}
      </button>
    )
  }

  return (
    <div className="lyr-prov-dropdown" ref={wrapRef}>
      <button
        className="lyr-prov-trigger"
        onClick={() => {
          if (open) closeDropdown()
          else setOpen(true)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="lyr-prov-trigger-name">
          {selected
            ? (selected as OverlayCandidate).displayLabel ?? providerLabel(selected.provider, t)
            : t('Auto (reset)')}
        </span>
        {selected && (
          <span className={'lyr-prov-badge' + (isSyncedSelected ? ' is-synced' : ' is-plain')}>
            {isSyncedSelected ? t('SYNCED') : t('TEXT')}
          </span>
        )}
        <ChevronDown size={14} className={'lyr-prov-chevron' + (open ? ' is-open' : '')} />
      </button>
      {open && (
        <div className="lyr-prov-panels">
          <div className="lyr-prov-menu" role="menu" aria-label={t('Lyrics sources')}>
            {/* Selecting a row pins it, so the way back to automatic lyrics has to be
                a row of its own. Shown only when pinning is possible at all. */}
            {canPin && (
              <button
                role="menuitemradio"
                aria-checked={pinnedIndex < 0}
                className={'lyr-prov-item lyr-prov-item-auto' + (pinnedIndex < 0 ? ' is-selected' : '')}
                onClick={() => {
                  onReset()
                  closeDropdown()
                }}
              >
                <span className="lyr-prov-item-main">
                  <RotateCcw size={13} className="lyr-prov-item-glyph" />
                  <span className="lyr-prov-item-name">{t('Auto (reset)')}</span>
                </span>
                {pinnedIndex < 0 && <Check size={14} className="lyr-prov-item-check" />}
              </button>
            )}
            {providerGroups.map((group) => {
              const hasVariants = group.indices.length > 1
              const isSelected = group.indices.includes(selectedIndex)
              const isActive = activeProvider === group.key
              const onlyCandidate = candidates[group.indices[0]]
              const isSynced = onlyCandidate
                ? Boolean(onlyCandidate.syncedLrc) || onlyCandidate.result.kind === 'synced'
                : false
              return (
                <button
                  key={group.key}
                  role={hasVariants ? 'menuitem' : 'menuitemradio'}
                  aria-checked={hasVariants ? undefined : isSelected}
                  aria-haspopup={hasVariants ? 'menu' : undefined}
                  aria-expanded={hasVariants ? isActive : undefined}
                  className={'lyr-prov-item lyr-prov-provider-row' + (isSelected ? ' is-selected' : '') + (isActive ? ' is-active' : '')}
                  onClick={() => {
                    if (hasVariants) {
                      setVersionQuery('')
                      setActiveProvider((current) => current === group.key ? null : group.key)
                    }
                    else {
                      onSelect(group.indices[0])
                      closeDropdown()
                    }
                  }}
                >
                  <span className="lyr-prov-item-main">
                    <span className="lyr-prov-item-heading">
                      <span className="lyr-prov-item-name">
                        {group.displayLabel ?? providerLabel(group.provider, t)}
                      </span>
                      {!hasVariants && (
                        <span className={'lyr-prov-badge' + (isSynced ? ' is-synced' : ' is-plain')}>
                          {isSynced ? t('SYNCED') : t('TEXT')}
                        </span>
                      )}
                    </span>
                  </span>
                  {hasVariants ? (
                    <>
                      <span className="lyr-prov-count">{group.indices.length}</span>
                      <ChevronLeft size={14} className="lyr-prov-submenu-chevron" aria-hidden="true" />
                    </>
                  ) : isSelected ? <Check size={14} className="lyr-prov-item-check" /> : null}
                </button>
              )
            })}
          </div>
          {activeGroup && (
            <div className="lyr-prov-versions" role="menu" aria-label={activeGroup.displayLabel ?? providerLabel(activeGroup.provider, t)}>
              <div className="lyr-prov-versions-heading">
                {activeGroup.displayLabel ?? providerLabel(activeGroup.provider, t)}
              </div>
              {activeGroup.indices.length > 5 ? (
                <label className="lyr-prov-version-search">
                  <Search size={13} aria-hidden="true" />
                  <input
                    autoFocus
                    value={versionQuery}
                    onChange={(event) => setVersionQuery(event.target.value)}
                    placeholder={t('Search')}
                    aria-label={t('Search')}
                  />
                </label>
              ) : null}
              {matchingVersionIndices.length > 0
                ? matchingVersionIndices.map(renderCandidate)
                : <span className="lyr-prov-empty">{t('No matches')}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Icon only: the pin glyph in the header says "these words are pinned" at a
 * glance, and the word next to it said the same thing twice. The full sentence
 * lives in the tooltip.
 */
function PinnedBadge() {
  const t = useT()
  return (
    <span className="lyr-pinned-badge" title={t('These lyrics are pinned to this track')}>
      <Pin size={12} />
    </span>
  )
}

/**
 * The ±0.5s nudge, behind a deliberately faint pencil in the bottom-right corner.
 * Timing is something you touch once for a badly synced file and never again, so
 * it earns a corner rather than a permanent seat in the header.
 *
 * Nudging automatic lyrics pins the current selection first - the offset has
 * nowhere else to live.
 */
function LyricsEditMenu({
  offsetMs,
  lyricsRate,
  onNudge,
  onLyricsRateChange,
  onEdit,
}: {
  offsetMs: number
  lyricsRate: number | null
  onNudge: (deltaMs: number) => void
  onLyricsRateChange: (rate: number) => void
  onEdit: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    // Escape closes the menu before the overlay's own handler closes the overlay
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const label = offsetMs === 0 ? '0.0s' : `${offsetMs > 0 ? '+' : '−'}${(Math.abs(offsetMs) / 1000).toFixed(1)}s`

  return (
    <div className="lyr-edit" ref={wrapRef}>
      {open && (
        <div className="lyr-edit-menu" role="dialog" aria-label={t('Lyrics timing')}>
          <div className="lyr-edit-title">{t('Lyrics timing')}</div>
          <button
            className="lyr-edit-content-btn"
            onClick={() => {
              setOpen(false)
              onEdit()
            }}
          >
            <Pencil size={13} />
            {t('Edit lyrics')}
          </button>
          <div className="lyr-offset">
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
          {lyricsRate !== null && (
            <label className="lyr-speed">
              <span className="lyr-speed-label">{t('Lyrics speed')}</span>
              <span className="lyr-speed-value">{lyricsRate.toFixed(2)}×</span>
              <input
                className="lyr-speed-range"
                type="range"
                min={LYRICS_RATE_MIN}
                max={LYRICS_RATE_MAX}
                step={LYRICS_RATE_STEP}
                value={lyricsRate}
                onChange={(event) => onLyricsRateChange(Number(event.currentTarget.value))}
                style={{
                  '--fill': `${((lyricsRate - LYRICS_RATE_MIN) / (LYRICS_RATE_MAX - LYRICS_RATE_MIN)) * 100}%`,
                } as CSSProperties}
                aria-label={t('Lyrics speed')}
              />
            </label>
          )}
          <p className="lyr-edit-hint">{t('Shifting the timing pins these lyrics to the track.')}</p>
        </div>
      )}
      <button
        className={'lyr-edit-btn' + (open || offsetMs !== 0 ? ' is-active' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-label={t('Lyrics timing')}
        title={t('Lyrics timing')}
        aria-expanded={open}
      >
        <Pencil size={15} />
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
  const [candidatesTrackKey, setCandidatesTrackKey] = useState('')
  const candidateRequest = useRef(0)
  const pinRequest = useRef(0)
  const currentTrackKey = useRef(trackKey)
  currentTrackKey.current = trackKey
  useSyncExternalStore(lyricsService.subscribe, lyricsService.getVersion)
  const [loading, setLoading] = useState(false)
  const [unavailableHint, setUnavailableHint] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [manualArtist, setManualArtist] = useState(track?.artists[0] ?? '')
  const [manualTitle, setManualTitle] = useState(track?.title ?? '')
  const [searching, setSearching] = useState(false)
  const [pinned, setPinned] = useState<LyricsOverride | null>(null)
  const [editedVersion, setEditedVersion] = useState<PersistedEditedVersion | null>(null)
  const [pinnedLoaded, setPinnedLoaded] = useState(false)
  const [editingLyrics, setEditingLyrics] = useState(false)
  const [savingLyrics, setSavingLyrics] = useState(false)
  const [publishingLyrics, setPublishingLyrics] = useState(false)
  /** the terms the last manual search actually used, for the pinned row's provenance */
  const [searchedAs, setSearchedAs] = useState<{ artist: string; title: string } | null>(null)
  const { settings } = useSettings()
  // Only tracks with a database row can pin - there is nothing to pin to otherwise,
  // so SoundCloud results that were never cached keep the session-only dropdown.
  const canPin = track?.dbId != null
  const sharedLyrics = lyricsService.getCurrent()
  const activeLyrics = sharedLyrics?.trackId === track?.sourceId ? sharedLyrics : null
  const activeServiceCandidate = useMemo((): LyricsCandidate | null => {
    const result = activeLyrics?.sourceResult ?? activeLyrics?.result
    if (!result) return null
    return {
      provider: activeLyrics?.provider || 'online',
      result,
      plain: result.kind === 'plain' ? result.text : null,
      syncedLrc: result.kind === 'synced' ? formatLrc(result.lines) : null,
    }
  }, [activeLyrics?.generation, activeLyrics?.provider, activeLyrics?.sourceResult, activeLyrics?.result])
  const selectionCandidates = candidates.length > 0
    ? candidates
    : activeServiceCandidate ? [activeServiceCandidate] : []

  useEffect(() => {
    let cancelled = false
    pinRequest.current++
    const id = p.currentTrack?.dbId ?? null
    if (id == null) {
      setPinned(null)
      setEditedVersion(null)
      setPinnedLoaded(true)
      return
    }
    setPinned(null)
    setEditedVersion(null)
    setPinnedLoaded(false)
    api
      .getLyricsOverride(id)
      .then((row) => {
        if (!cancelled) {
          const response = row
          const document = response?.editorDocument ?? null
          const version = response?.editedVersion
          const savedDocument = document && response
            ? {
                provider: version?.provider ?? response.provider,
                sourceArtist: version?.sourceArtist ?? response.sourceArtist,
                sourceTitle: version?.sourceTitle ?? response.sourceTitle,
                lrc: version?.lrc ?? response.lrc,
                offsetMs: version?.offsetMs ?? response.offsetMs,
                updatedAt: version?.updatedAt ?? response.updatedAt,
                editorDocument: document,
              }
            : null
          setPinned(response && response.isActive !== false ? response : null)
          setEditedVersion(savedDocument)
          setPinnedLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPinned(null)
          setEditedVersion(null)
          setPinnedLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
    // the track identity is the trigger; dbId is a function of it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey])

  useEffect(() => {
    setEditingLyrics(false)
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
    const request = ++candidateRequest.current
    setCandidatesTrackKey('')
    setSearching(false)
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
      setCandidatesTrackKey(key)
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
        if (cancelled || request !== candidateRequest.current) return
        if (embedded) {
          list = [{ provider: 'embedded', result: embedded, plain: null, syncedLrc: null }]
          setCandidatesTrackKey(key)
          setCandidates([...list])
          setSelectedIndex(0)
          setLoading(false)
          overlayCache.set(key, { candidates: [...list], selectedIndex: 0 })
        }
        const artist = tr.artists[0] ?? ''
        const title = tr.title
        return fetchOnlineLyricsCandidates(artist, title, tr)
          .then((online) => {
            if (cancelled || request !== candidateRequest.current) return
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
            setCandidatesTrackKey(key)
            setCandidates(combined)
            setSelectedIndex(sel)
            setLoading(false)
            setUnavailableHint(false)
            overlayCache.set(key, { candidates: combined, selectedIndex: sel })
          })
          .catch(() => {
            if (cancelled || request !== candidateRequest.current) return
            if (list.length === 0) {
              setLoading(false)
              setUnavailableHint(true)
            } else {
              setLoading(false)
            }
          })
      })
      .catch(() => {
        if (cancelled || request !== candidateRequest.current) return
        const artist = tr.artists[0] ?? ''
        const title = tr.title
        fetchOnlineLyricsCandidates(artist, title, tr)
          .then((online) => {
            if (cancelled || request !== candidateRequest.current) return
            if (online.length === 0) {
              setLoading(false)
              setUnavailableHint(true)
              return
            }
            const firstSynced = online.findIndex((c) => c.result.kind === 'synced')
            const sel = firstSynced >= 0 ? firstSynced : 0
            setCandidatesTrackKey(key)
            setCandidates(online)
            setSelectedIndex(sel)
            setLoading(false)
            overlayCache.set(key, { candidates: online, selectedIndex: sel })
          })
          .catch(() => {
            if (!cancelled && request === candidateRequest.current) {
              setLoading(false)
              setUnavailableHint(true)
            }
          })
      })
    return () => {
      cancelled = true
    }
    // Keyed on the track's identity rather than on `p.currentTrack`, so a
    // player snapshot does not restart a lyrics fetch, and so a track that
    // gains a dbId after being cached does not either.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackKey is the deliberate key
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
    () => (pinned ? selectionCandidates.findIndex((c) => samePin(c, pinned)) : -1),
    [selectionCandidates, pinned],
  )
  const offsetMs = pinned?.offsetMs ?? 0

  const editedCandidate = useMemo(() => {
    if (!editedVersion) return null
    const editedPin: LyricsOverride = {
      provider: editedVersion.provider,
      sourceArtist: editedVersion.sourceArtist,
      sourceTitle: editedVersion.sourceTitle,
      lrc: editedVersion.lrc,
      offsetMs: editedVersion.offsetMs,
      updatedAt: editedVersion.updatedAt,
      editorDocument: editedVersion.editorDocument,
    }
    return overrideCandidate(editedPin, {
      displayLabel: t('Current version'),
      isEditedVersion: true,
      sourceArtist: editedVersion.sourceArtist,
      sourceTitle: editedVersion.sourceTitle,
      offsetMs: editedVersion.offsetMs,
    })
  }, [editedVersion, t])

  /** An active pin that no provider returned is kept as its own selectable row. */
  const pinnedExtra = useMemo(
    () => pinned && pinnedIndex < 0 && !sameExactPin(editedCandidate, pinned)
      ? overrideCandidate(pinned, {
          sourceArtist: pinned.sourceArtist,
          sourceTitle: pinned.sourceTitle,
          offsetMs: pinned.offsetMs,
        })
      : null,
    [editedCandidate, pinned, pinnedIndex],
  )
  const baseCandidates = useMemo(
    () => (pinnedExtra ? [pinnedExtra, ...selectionCandidates] : selectionCandidates),
    [pinnedExtra, selectionCandidates],
  )
  const rawViewCandidates = useMemo(
    () => editedCandidate ? [...baseCandidates, editedCandidate] : baseCandidates,
    [baseCandidates, editedCandidate],
  )
  const viewPinnedIndex = pinned
    ? editedCandidate && sameExactPin(editedCandidate, pinned)
      ? rawViewCandidates.length - 1
      : baseCandidates.findIndex((candidate) => samePin(candidate, pinned))
    : -1
  const viewCandidates = useMemo(() => {
    if (offsetMs === 0 || viewPinnedIndex < 0) return rawViewCandidates
    // Only the pinned row carries the offset; the others are still their own timing.
    return rawViewCandidates.map((c, i) => (i === viewPinnedIndex ? shiftCandidate(c, offsetMs) : c))
  }, [rawViewCandidates, offsetMs, viewPinnedIndex])
  const viewSelectedIndex =
    viewPinnedIndex >= 0
      ? viewPinnedIndex
      : baseCandidates.length > 0 ? selectedIndex + (pinnedExtra ? 1 : 0) : -1
  const selected = viewCandidates[viewSelectedIndex] ?? null
  const sourceSelected = rawViewCandidates[viewSelectedIndex] ?? null
  useEffect(() => {
    if (!track || !pinnedLoaded || candidatesTrackKey !== trackKey) return
    const result = pinned ? overridePlaybackResult(pinned) : sourceSelected?.result ?? null
    if (!result) return
    lyricsService.setActiveCandidate(track.sourceId, result, track.durationSec ?? null,
      lyricSourceKey(result, pinned?.provider ?? sourceSelected?.provider ?? ''), pinned?.offsetMs ?? 0,
      pinned?.provider ?? sourceSelected?.provider ?? '')
  }, [track, trackKey, candidatesTrackKey, pinnedLoaded, pinned, sourceSelected])
  const lyricsRateKey = activeLyrics?.result?.kind === 'synced'
    ? lyricsRateStorageKey(track, activeLyrics.sourceLyricKey)
    : ''
  const [lyricsRateState, setLyricsRateState] = useState<{ key: string; value: number }>({ key: '', value: 1 })
  const lyricsRate = lyricsRateKey
    ? lyricsRateState.key === lyricsRateKey ? lyricsRateState.value : readLyricsRate(lyricsRateKey)
    : 1
  const handleLyricsRateChange = useCallback((value: number) => {
    const rate = normalizeLyricsRate(value)
    writeLyricsRate(lyricsRateKey, rate)
    setLyricsRateState({ key: lyricsRateKey, value: rate })
  }, [lyricsRateKey])
  const mode: OverlayMode =
    activeLyrics?.result?.kind ?? (loading && viewCandidates.length === 0 ? 'loading' : 'empty')
  const durationMs = track?.durationSec != null ? track.durationSec * 1000 : null
  const editorSourceOptions = useMemo(
    () => {
      const options = baseCandidates.flatMap((candidate, index) => {
        const modes: Array<'plain' | 'synced'> = []
        if (candidate.result.kind === 'synced') modes.push('synced')
        if (candidate.plain?.trim() || candidate.result.kind === 'plain') modes.push('plain')
        const details = [
          candidate.trackName?.trim(),
          candidate.artistName?.trim(),
          candidate.albumName?.trim(),
          candidate.duration != null ? `${Math.round(candidate.duration)}s` : null,
        ].filter((part): part is string => Boolean(part))
        return modes.map((mode) => ({
          id: `candidate:${index}:${mode}`,
          label: `${providerLabel(candidate.provider, t)} · ${mode === 'synced' ? t('SYNCED') : t('TEXT')}${details.length > 0 ? ` · ${details.join(' / ')}` : ''}`,
          document: candidateDocument(candidate, durationMs, mode),
        }))
      })
      if (editedVersion) {
        options.unshift({
          id: 'edited',
          label: `${providerLabel(editedVersion.provider, t)} · ${t('Current version')}`,
          document: editedVersion.editorDocument,
        })
      }
      return options
    },
    [baseCandidates, durationMs, editedVersion, t],
  )
  const editorInitialSourceId = editedVersion
    ? 'edited'
    : viewSelectedIndex >= 0 && baseCandidates[viewSelectedIndex]
      ? `candidate:${viewSelectedIndex}:${selected?.result.kind ?? 'plain'}`
      : null
  const editorInitialDocument = useMemo(() => {
    if (editedVersion) return editedVersion.editorDocument
    if (pinned) return fromLrc(pinned.lrc, durationMs)
    if (selected) return candidateDocument(selected, durationMs, selected.result.kind)
    return fromPlainLyrics('')
  }, [pinned, selected, durationMs, editedVersion])

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
      const overlayCandidate = candidate as OverlayCandidate
      const mutation = ++pinRequest.current
      const requestTrackKey = trackKey
      const document = overlayCandidate.isEditedVersion ? editedVersion?.editorDocument
        : pinned && sameExactPin(candidate, pinned) ? activeOverrideDocument(pinned) : null
      const sourceArtist = overlayCandidate.isEditedVersion
        ? overlayCandidate.savedSourceArtist || tr.artists[0] || null
        : overlayCandidate.savedSourceArtist ?? searchedAs?.artist ?? tr.artists[0] ?? null
      const sourceTitle = overlayCandidate.isEditedVersion
        ? overlayCandidate.savedSourceTitle || tr.title
        : overlayCandidate.savedSourceTitle ?? searchedAs?.title ?? tr.title
      try {
        await api.setLyricsOverride({
          trackId: tr.dbId,
          provider: candidate.provider,
          sourceArtist,
          sourceTitle,
          lrc,
          offsetMs: nextOffsetMs,
        })
        if (mutation !== pinRequest.current || currentTrackKey.current !== requestTrackKey) return
        setPinned({
          provider: candidate.provider,
          sourceArtist,
          sourceTitle,
          lrc,
          offsetMs: nextOffsetMs,
          updatedAt: Math.floor(Date.now() / 1000),
          ...(document ? { editorDocument: document } : {}),
        })
        lyricsService.invalidate(tr.sourceId)
        lyricsService.ensure(tr, settings.lyrics.cacheOnline)
      } catch {}
    },
    [p.currentTrack, searchedAs, settings.lyrics.cacheOnline, trackKey, pinned, editedVersion],
  )

  /**
   * `viewIdx` addresses the rendered list, which may carry a stray pin in front of
   * the fetched ones. Selecting that row is a no-op - it is already the pin.
   */
  const handleSelect = useCallback(
    (viewIdx: number) => {
      const candidate = rawViewCandidates[viewIdx]
      if (!candidate) return
      const idx = viewIdx - (pinnedExtra ? 1 : 0)
      if (idx >= 0 && idx < selectionCandidates.length) {
        setSelectedIndex(idx)
        if (candidates.length === 0) setCandidates(selectionCandidates)
        const tr = p.currentTrack
        const key = tr ? `${tr.source}|${tr.sourceId}|${tr.title}|${tr.artists.join(',')}` : ''
        if (key) {
          overlayCache.set(key, { candidates: selectionCandidates, selectedIndex: idx })
        }
      }
      // Choosing a provider is the pin gesture - there is no separate confirm.
      // The offset is dropped, since it was tuned against the previous lines.
      void persistPin(candidate, (candidate as OverlayCandidate).savedOffsetMs ?? 0)
    },
    [p.currentTrack, candidates, persistPin, pinnedExtra, rawViewCandidates, selectionCandidates],
  )

  /** Back to automatic: drops the row and lets the normal chain resolve again. */
  const handleResetPin = useCallback(() => {
    const tr = p.currentTrack
    if (!tr || tr.dbId == null) return
    const mutation = ++pinRequest.current
    const requestTrackKey = trackKey
    setPinned(null)
    api
      .clearLyricsOverride(tr.dbId)
      .then(() => {
        if (mutation !== pinRequest.current || currentTrackKey.current !== requestTrackKey) return
        lyricsService.invalidate(tr.sourceId)
        lyricsService.ensure(tr, settings.lyrics.cacheOnline)
      })
      .catch(() => {})
  }, [p.currentTrack, settings.lyrics.cacheOnline, trackKey])

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
        const mutation = ++pinRequest.current
        const requestTrackKey = trackKey
        setPinned({ ...pinned, offsetMs: next })
        api
          .setLyricsOverrideOffset(tr.dbId, next)
          .then(() => {
            if (mutation !== pinRequest.current || currentTrackKey.current !== requestTrackKey) return
            lyricsService.invalidate(tr.sourceId)
            lyricsService.ensure(tr, settings.lyrics.cacheOnline)
          })
          .catch(() => {})
        return
      }
      const candidate = candidates[selectedIndex]
      if (candidate) void persistPin(candidate, next)
    },
    [p.currentTrack, pinned, candidates, selectedIndex, persistPin, settings.lyrics.cacheOnline, trackKey],
  )

  const handleManualSearch = useCallback(
    async (artist: string, title: string) => {
      const a = artist.trim()
      const tt = title.trim()
      if (!a || !tt) return
      const request = ++candidateRequest.current
      const searchTrackKey = trackKey
      setSearching(true)
      setUnavailableHint(false)
      try {
        const raw = await api.fetchOnlineLyricsAll(a, tt)
        if (currentTrackKey.current !== searchTrackKey || request !== candidateRequest.current) return
        setCandidatesTrackKey(searchTrackKey)
        const out = toLyricsCandidates(raw)
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
        if (currentTrackKey.current !== searchTrackKey || request !== candidateRequest.current) return
        if (candidates.filter((c) => c.provider === 'embedded').length === 0) {
          setUnavailableHint(true)
        }
      } finally {
        if (currentTrackKey.current === searchTrackKey && request === candidateRequest.current) setSearching(false)
      }
    },
    [candidates, p.currentTrack, trackKey],
  )

  const selectedEditorSource = (sourceId: string | null): LyricsCandidate | null => {
    if (sourceId === 'edited') return editedCandidate
    if (sourceId !== null) {
      const match = sourceId.match(/^candidate:(\d+):/)
      const index = match ? Number.parseInt(match[1], 10) : -1
      if (Number.isInteger(index) && index >= 0) return baseCandidates[index] ?? null
    }
    if (viewSelectedIndex >= baseCandidates.length && editedCandidate) return editedCandidate
    return viewSelectedIndex >= 0 ? baseCandidates[viewSelectedIndex] ?? null : null
  }

  const sourceMetadata = (sourceId: string | null) => {
    const source = selectedEditorSource(sourceId)
    if (sourceId === 'edited' && editedVersion) {
      return {
        source,
        provider: editedVersion.provider,
        artist: editedVersion.sourceArtist || track?.artists[0] || '',
        title: editedVersion.sourceTitle || track?.title || '',
        offsetMs: editedVersion.offsetMs,
      }
    }
    const isSamePinnedSource = sourceId === editorInitialSourceId || sourceId === null
    return {
      source,
      provider: source?.provider ?? pinned?.provider ?? 'manual',
      artist: source?.artistName?.trim()
        || (source?.provider === pinned?.provider ? pinned?.sourceArtist : null)
        || searchedAs?.artist
        || track?.artists[0]
        || '',
      title: source?.trackName?.trim()
        || (source?.provider === pinned?.provider ? pinned?.sourceTitle : null)
        || searchedAs?.title
        || track?.title
        || '',
      offsetMs: isSamePinnedSource ? pinned?.offsetMs ?? 0 : 0,
    }
  }

  const saveEditedLyrics = async (document: LyricsEditorDocument, sourceId: string | null): Promise<void> => {
    const tr = p.currentTrack
    if (!tr || tr.dbId == null) throw new Error('Track cannot store lyrics')
    const source = sourceMetadata(sourceId)
    const lrc = toPlaybackLrc(document)
    const mutation = ++pinRequest.current
    const requestTrackKey = trackKey
    setSavingLyrics(true)
    try {
      await api.saveLyricsEditorDocument({
        trackId: tr.dbId,
        provider: source.provider,
        sourceArtist: source.artist || null,
        sourceTitle: source.title || null,
        lrc,
        offsetMs: source.offsetMs,
        editorDocument: document,
      })
      if (mutation !== pinRequest.current || currentTrackKey.current !== requestTrackKey) return
      const updatedAt = Math.floor(Date.now() / 1000)
      setEditedVersion({
        provider: source.provider,
        sourceArtist: source.artist || null,
        sourceTitle: source.title || null,
        lrc,
        offsetMs: source.offsetMs,
        updatedAt,
        editorDocument: document,
      })
      setPinned({
        provider: source.provider,
        sourceArtist: source.artist || null,
        sourceTitle: source.title || null,
        lrc,
        offsetMs: source.offsetMs,
        updatedAt,
        editorDocument: document,
      })
      setEditingLyrics(false)
      lyricsService.invalidate(tr.sourceId)
      lyricsService.ensure(tr, settings.lyrics.cacheOnline)
    } finally {
      setSavingLyrics(false)
    }
  }

  const publishEditedLyrics = async (document: LyricsEditorDocument, sourceId: string | null): Promise<void> => {
    const tr = p.currentTrack
    if (!tr) throw new Error('No track is selected')
    const source = sourceMetadata(sourceId)
    const title = source.title || tr.title
    const artist = source.artist || tr.artists[0] || ''
    const album = source.source?.albumName?.trim() || tr.album || ''
    const duration = source.source?.duration ?? tr.durationSec ?? Number.NaN
    if (!title.trim() || !artist.trim()) throw new Error('LRCLIB_METADATA_INVALID')
    if (!Number.isFinite(duration) || duration < 1 || duration > 3600) {
      throw new Error('LRCLIB_DURATION_INVALID')
    }
    const plainLyrics = toPlainText(document)
    const request: LrclibPublishRequest = {
      trackName: title,
      artistName: artist,
      albumName: album,
      duration,
      plainLyrics,
      ...(document.mode === 'synced' ? { syncedLyrics: toPlaybackLrc(document) } : {}),
      lyricsfile: toLrclibLyricsfile(document, {
        title,
        artist,
        album,
        durationMs: tr.durationSec == null ? null : tr.durationSec * 1000,
      }),
    }
    setPublishingLyrics(true)
    try {
      await api.publishLyricsToLrclib(request)
    } finally {
      setPublishingLyrics(false)
    }
  }

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
        <section className={'lyr-stage-col' + (editingLyrics ? ' lyr-stage-col-editing' : '')}>
          {editingLyrics ? (
            <LyricsEditorPanel
              key={`${trackKey}-${pinned?.updatedAt ?? 'unpinned'}`}
              initialDocument={editorInitialDocument}
              initialSourceId={editorInitialSourceId}
              sourceOptions={editorSourceOptions}
              durationMs={durationMs}
              currentTimeSec={p.position}
              onSave={saveEditedLyrics}
              onPublish={publishEditedLyrics}
              onCancel={() => setEditingLyrics(false)}
              saving={savingLyrics}
              publishing={publishingLyrics}
            />
          ) : (
            <>
              {(viewCandidates.length > 0 || mode !== 'empty') && (!canPin || pinnedLoaded) && (
                <div className="lyr-head">
                  {canPin && pinned !== null && <PinnedBadge />}
                  {viewCandidates.length > 0 ? (
                    <ProviderDropdown
                      candidates={viewCandidates}
                      selectedIndex={viewSelectedIndex}
                      onSelect={handleSelect}
                      onReset={handleResetPin}
                      pinnedIndex={viewPinnedIndex}
                      canPin={canPin}
                    />
                  ) : null}
                  <button className="lyr-manual-toggle" onClick={() => setShowManual((v) => !v)}>
                    {showManual ? t('Hide') : t('Search manually')}
                  </button>
                  {showManual && manualForm}
                </div>
              )}
              {selected?.copyright?.trim() && (
                <div className="lyr-copyright">{selected.copyright}</div>
              )}
              {searching && viewCandidates.length > 0 && <LoadingMark />}
              {mode === 'synced' && activeLyrics?.result?.kind === 'synced' && (
                <SyncedView
                  key={trackKey}
                  timing={activeLyrics.timing}
                  lyricsRate={lyricsRate}
                  offsetMs={activeLyrics.offsetMs}
                />
              )}
              {activeLyrics?.result?.kind === 'plain' && <PlainView text={activeLyrics.result.text} />}
              {mode === 'loading' && !searching && <LoadingMark />}
              {mode === 'empty' && (
                <>
                  <EmptyLyrics unavailable={unavailableHint} />
                  {searching ? <LoadingMark /> : manualForm}
                </>
              )}
            </>
          )}
        </section>
      </div>
      {canPin && pinnedLoaded && !editingLyrics && (
        <LyricsEditMenu
          offsetMs={offsetMs}
          lyricsRate={activeLyrics?.result?.kind === 'synced' ? lyricsRate : null}
          onNudge={handleNudgeOffset}
          onLyricsRateChange={handleLyricsRateChange}
          onEdit={() => setEditingLyrics(true)}
        />
      )}
    </div>
  )
}

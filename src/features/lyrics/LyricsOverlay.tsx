import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Check, ChevronDown, MicVocal, Music2, Pause, Play, Search, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react'
import type { TouchEvent as ReactTouchEvent, WheelEvent as ReactWheelEvent } from 'react'
import { usePlayer } from '../../player'
import { useT } from '../../i18n'
import Cover from '../../components/common/Cover'
import { fmtTime } from '../../utils/format'
import { api } from '../../api/client'
import { EmbeddedTagsLyricsProvider } from './embeddedProvider'
import { fetchOnlineLyricsCandidates } from './onlineProvider'
import type { LyricsCandidate } from './onlineProvider'
import type { LyricsLine, LyricsResult } from './types'
import { parseLrc } from './lrc'
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

const overlayCache = new Map<string, { candidates: LyricsCandidate[]; selectedIndex: number }>()

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
}: {
  candidates: LyricsCandidate[]
  selectedIndex: number
  onSelect: (idx: number) => void
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

  const selected = candidates[selectedIndex] ?? null
  const mode: OverlayMode = loading && candidates.length === 0 ? 'loading' : selected ? selected.result.kind : 'empty'

  const handleSelect = useCallback(
    (idx: number) => {
      setSelectedIndex(idx)
      const tr = p.currentTrack
      const key = tr ? `${tr.source}|${tr.sourceId}|${tr.title}|${tr.artists.join(',')}` : ''
      if (key && candidates.length > 0) {
        overlayCache.set(key, { candidates, selectedIndex: idx })
      }
      requestAnimationFrame(() => {})
    },
    [p.currentTrack, candidates],
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
          {candidates.length > 0 && (
            <div className="lyr-head">
              <ProviderDropdown candidates={candidates} selectedIndex={selectedIndex} onSelect={handleSelect} />
              <button className="lyr-manual-toggle" onClick={() => setShowManual((v) => !v)}>
                {showManual ? t('Hide') : t('Search manually')}
              </button>
              {showManual && manualForm}
            </div>
          )}
          {searching && candidates.length > 0 && <LoadingMark />}
          {mode === 'synced' && selected?.result.kind === 'synced' && (
            <SyncedView key={`${trackKey}-${selectedIndex}`} lines={selected.result.lines} />
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

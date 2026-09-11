import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  ChevronDown,
  ChevronUp,
  Heart,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { fmtTime } from '../utils/format'
import { applyTheme } from '../theme/engine'
import { en } from '../i18n/en'
import { ru } from '../i18n/ru'
import {
  EV_ACTION,
  EV_PEEK,
  EV_READY,
  EV_STATE,
  EV_TICK,
  MINI_COLLAPSED_SIZE,
  MINI_EXPANDED_SIZE,
  OPEN_ANIMATION_MS,
  emitToMain,
  listenFor,
  loadMiniSnapshot,
  positionMiniWindow,
  type MiniPeek,
  type MiniPlayerAction,
  type MiniPlayerState,
} from './contract'

/** Read once, before React mounts: covers the cold start described in contract.ts. */
const boot = loadMiniSnapshot()

/** Ignore incoming ticks for a moment after a seek, they describe the old position. */
const SEEK_LOCK_MS = 1200
const SMOOTH_FACTOR = 0.28
const SMOOTH_SNAP_SEC = 0.9
const READY_PING_ATTEMPTS = 10
const READY_PING_MS = 250

export default function MiniPlayerApp() {
  const [state, setState] = useState<MiniPlayerState | null>(boot?.state ?? null)
  const [expanded, setExpanded] = useState(false)
  const [renderExpanded, setRenderExpanded] = useState(false)
  const [position, setPosition] = useState(boot?.position ?? 0)
  const [visual, setVisual] = useState(boot?.position ?? 0)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [cover, setCover] = useState<string | null>(boot?.state.track?.artwork ?? null)

  const gotStateRef = useRef(boot !== null)
  const seekLockRef = useRef(0)
  const visualRef = useRef(boot?.position ?? 0)
  const collapseTimerRef = useRef(0)
  const closeTimerRef = useRef(0)
  const barRef = useRef<HTMLDivElement | null>(null)
  const volumeRef = useRef<HTMLDivElement | null>(null)
  const scrubbingRef = useRef(false)

  const track = state?.track ?? null
  const duration = track?.durationSec ?? 0

  const t = useMemo(() => {
    const dict = state?.lang === 'ru' ? ru : en
    return (key: string) => dict[key] ?? en[key] ?? key
  }, [state?.lang])

  const emitAction = useCallback((action: MiniPlayerAction) => {
    void emitToMain(EV_ACTION, action).catch(() => {})
  }, [])

  // --- window shape -------------------------------------------------------

  const resize = useCallback(async (next: boolean) => {
    const size = next ? MINI_EXPANDED_SIZE : MINI_COLLAPSED_SIZE
    try {
      await positionMiniWindow(getCurrentWindow(), size.width, size.height)
    } catch {
      /* window may be gone while the app shuts down */
    }
  }, [])

  const expand = useCallback(() => {
    window.clearTimeout(collapseTimerRef.current)
    window.clearTimeout(closeTimerRef.current)
    setRenderExpanded(true)
    // mount the card first, then flip the class a frame later - setting both in
    // the same commit skips the entrance transition entirely
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setExpanded(true))
    })
    void resize(true)
  }, [resize])

  const collapse = useCallback(() => {
    window.clearTimeout(collapseTimerRef.current)
    window.clearTimeout(closeTimerRef.current)
    setExpanded(false)
    // shrink the window only after the closing animation has played, otherwise
    // the card gets clipped mid-transition
    closeTimerRef.current = window.setTimeout(() => {
      void resize(false)
      setRenderExpanded(false)
    }, OPEN_ANIMATION_MS)
  }, [resize])

  // --- events from the main window ---------------------------------------

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    let timer = 0
    const ping = () => {
      if (cancelled || gotStateRef.current) return
      void emitToMain(EV_READY, {}).catch(() => {})
      attempts += 1
      if (!gotStateRef.current && attempts < READY_PING_ATTEMPTS) {
        timer = window.setTimeout(ping, READY_PING_MS)
      }
    }
    // the bridge may not have attached its listeners yet - keep asking until a
    // state arrives, otherwise the window stays empty until the next track
    ping()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    void listenFor<MiniPlayerState>(EV_STATE, (next) => {
      gotStateRef.current = true
      setState(next)
      applyTheme(next.theme)
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    void listenFor<number>(EV_TICK, (seconds) => {
      if (Date.now() < seekLockRef.current) return
      setPosition(seconds)
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    void listenFor<MiniPeek>(EV_PEEK, (peek) => {
      expand()
      window.clearTimeout(collapseTimerRef.current)
      if (peek.autoCollapseMs > 0) {
        collapseTimerRef.current = window.setTimeout(() => collapse(), peek.autoCollapseMs)
      }
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [expand, collapse])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') collapse()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [collapse])

  // --- cover: swap only once the new file has decoded ---------------------

  useEffect(() => {
    const url = track?.artwork ?? null
    if (!url) {
      setCover(null)
      return
    }
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setCover(url)
    }
    img.src = url
    return () => {
      cancelled = true
    }
  }, [track?.artwork])

  useEffect(() => {
    const url = track?.nextArtwork
    if (!url) return
    // warm the next track's cover while the current one plays, so the swap on
    // track change is instant instead of showing an empty square
    const img = new Image()
    img.src = url
  }, [track?.nextArtwork])

  // --- progress smoothing -------------------------------------------------

  useEffect(() => {
    const target = position
    const current = visualRef.current
    if (Math.abs(target - current) > SMOOTH_SNAP_SEC || scrubbingRef.current) {
      visualRef.current = target
      setVisual(target)
      return
    }
    let raf = 0
    const step = () => {
      const diff = target - visualRef.current
      if (Math.abs(diff) <= 0.02) {
        visualRef.current = target
        setVisual(target)
        return
      }
      visualRef.current += diff * SMOOTH_FACTOR
      setVisual(visualRef.current)
      raf = window.requestAnimationFrame(step)
    }
    raf = window.requestAnimationFrame(step)
    return () => window.cancelAnimationFrame(raf)
  }, [position])

  useEffect(
    () => () => {
      window.clearTimeout(collapseTimerRef.current)
      window.clearTimeout(closeTimerRef.current)
    },
    [],
  )

  // --- seeking ------------------------------------------------------------

  const seekFromClientX = useCallback(
    (clientX: number, bar: HTMLDivElement | null) => {
      if (!bar || duration <= 0) return
      const rect = bar.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const seconds = ratio * duration
      seekLockRef.current = Date.now() + SEEK_LOCK_MS
      visualRef.current = seconds
      setVisual(seconds)
      setPosition(seconds)
      emitAction({ type: 'seek', seconds })
    },
    [duration, emitAction],
  )

  const onBarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubbingRef.current = true
    seekFromClientX(e.clientX, barRef.current)
  }
  const onBarPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return
    seekFromClientX(e.clientX, barRef.current)
  }
  const onBarPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId)
    scrubbingRef.current = false
  }

  const onVolumePointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const bar = volumeRef.current
    if (!bar) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    emitAction({ type: 'set_volume', volume: ratio })
  }

  // --- render -------------------------------------------------------------

  const pct = duration > 0 ? Math.min(100, Math.max(0, (visual / duration) * 100)) : 0
  const volume = state?.volume ?? 0
  const repeat = state?.repeat ?? 'off'

  return (
    <div className="mini-root" data-expanded={expanded ? 'true' : 'false'}>
      {renderExpanded && (
        <div className={`mini-card${expanded ? ' is-open' : ''}`}>
          <div className="mini-row mini-row-top">
            <button
              type="button"
              className="mini-cover"
              onClick={() => emitAction({ type: 'show_main' })}
              title={t('Show Tempo')}
            >
              {cover ? <img src={cover} alt="" draggable={false} /> : <Music size={20} />}
            </button>

            <div className="mini-meta">
              <div className="mini-title" title={track?.title ?? ''}>
                {track?.title ?? t('Nothing playing')}
              </div>
              <div className="mini-artist" title={track?.artist ?? ''}>
                {track?.artist || track?.album || '\u00a0'}
              </div>
            </div>

            <div className="mini-transport">
              <button type="button" className="mini-btn" onClick={() => emitAction({ type: 'prev' })} title={t('Previous')}>
                <SkipBack size={15} />
              </button>
              <button
                type="button"
                className="mini-btn mini-btn-play"
                onClick={() => emitAction({ type: 'toggle_play' })}
                title={state?.isPlaying ? t('Pause') : t('Play')}
              >
                {state?.isPlaying ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <button type="button" className="mini-btn" onClick={() => emitAction({ type: 'next' })} title={t('Next')}>
                <SkipForward size={15} />
              </button>
              <button
                type="button"
                className={`mini-btn${state?.liked ? ' is-active' : ''}`}
                onClick={() => emitAction({ type: 'toggle_like' })}
                disabled={track?.dbId == null}
                title={t('Like')}
              >
                <Heart size={15} fill={state?.liked ? 'currentColor' : 'none'} />
              </button>
              <button type="button" className="mini-btn" onClick={collapse} title={t('Collapse')}>
                <ChevronUp size={15} />
              </button>
            </div>
          </div>

          <div className="mini-row mini-row-progress">
            <span className="mini-time">{fmtTime(visual)}</span>
            <div
              className="mini-bar"
              ref={barRef}
              onPointerDown={onBarPointerDown}
              onPointerMove={onBarPointerMove}
              onPointerUp={onBarPointerUp}
              onPointerCancel={onBarPointerUp}
            >
              <div className="mini-bar-fill" style={{ width: `${pct}%` }} />
              <div className="mini-bar-knob" style={{ left: `${pct}%` }} />
            </div>
            <span className="mini-time mini-time-right">{fmtTime(duration)}</span>
          </div>

          <div className="mini-row mini-row-bottom">
            <button
              type="button"
              className={`mini-btn mini-btn-sm${state?.shuffle ? ' is-active' : ''}`}
              onClick={() => emitAction({ type: 'toggle_shuffle' })}
              title={t('Shuffle')}
            >
              <Shuffle size={14} />
            </button>
            <button
              type="button"
              className={`mini-btn mini-btn-sm${repeat !== 'off' ? ' is-active' : ''}`}
              onClick={() => emitAction({ type: 'toggle_repeat' })}
              title={t('Repeat')}
            >
              {repeat === 'one' ? <Repeat1 size={14} /> : <Repeat size={14} />}
            </button>

            <div
              className={`mini-volume${volumeOpen ? ' is-open' : ''}`}
              onMouseEnter={() => setVolumeOpen(true)}
              onMouseLeave={() => setVolumeOpen(false)}
            >
              <button
                type="button"
                className="mini-btn mini-btn-sm"
                onClick={() => emitAction({ type: 'toggle_mute' })}
                title={t('Mute')}
              >
                {volume > 0 ? <Volume2 size={14} /> : <VolumeX size={14} />}
              </button>
              <div
                className="mini-volume-bar"
                ref={volumeRef}
                onPointerDown={onVolumePointer}
                onPointerMove={(e) => {
                  if (e.buttons === 1) onVolumePointer(e)
                }}
              >
                <div className="mini-volume-fill" style={{ width: `${Math.round(volume * 100)}%` }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {!renderExpanded && (
        <button
          type="button"
          className="mini-pill"
          onClick={expand}
          title={track?.title ?? t('Expand')}
        >
          <span className="mini-pill-fill" style={{ width: `${pct}%` }} />
          <span className="mini-pill-label">
            {track?.title ? <span className="mini-pill-title">{track.title}</span> : null}
            <ChevronDown size={13} />
          </span>
        </button>
      )}
    </div>
  )
}

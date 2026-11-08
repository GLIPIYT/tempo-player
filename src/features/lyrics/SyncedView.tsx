import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TouchEvent as ReactTouchEvent, WheelEvent as ReactWheelEvent } from 'react'
import { useT } from '../../i18n'
import type { LyricProgressDirection, LyricMotionStyle, LyricTextFillMode } from '../../state/settings'
import { lyricAnchorIndex, lyricTimingAt, type ResolvedLyricsTiming } from './timingResolver'
import { lyricTimeAtMediaPosition, mediaPositionAtLyricTime } from './lyricsRate'
import { resolveLyricProgressGeometry } from './progressGeometry'
import { lyricTransitionDuration } from './lyricsMotion'
import { wordIndexAtProgress, wordStartsFromWidths } from './wordFill'
import { SyncedRow } from './SyncedRow'
import { lyricPaintRange } from './paintRange'

const ANCHOR_RATIO = 0.38
const PAUSE_MS = 4000
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const SyncedView = memo(function SyncedView({
  timing,
  lyricsRate,
  offsetMs,
  alignment,
  progressClipToText,
  progressDirection,
  fillEnabled,
  motionStyle = 'smooth',
  textFillMode = 'continuous',
  playbackRate,
  onSeek,
  getPosition,
}: {
  timing: ResolvedLyricsTiming
  lyricsRate: number
  offsetMs: number
  alignment: 'left' | 'center' | 'right'
  progressClipToText: boolean
  progressDirection: LyricProgressDirection
  fillEnabled: boolean
  motionStyle?: LyricMotionStyle
  textFillMode?: LyricTextFillMode
  playbackRate: number
  onSeek: (timeSec: number) => void
  getPosition: () => number
}) {
  const t = useT()
  const segments = timing.segments
  const stageRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const itemEls = useRef<Array<HTMLElement | null>>([])
  const wordsRef = useRef<{ elements: HTMLElement[]; starts: number[]; current: number }>({ elements: [], starts: [], current: -2 })
  const positionedRef = useRef(false)
  const previousTyRef = useRef(0)
  const collapsingNotesRef = useRef(new Set<number>())
  const underlineRef = useRef<HTMLSpanElement | null>(null)
  const textRef = useRef<HTMLSpanElement | null>(null)
  const pausedRef = useRef(false)
  const pauseTimerRef = useRef(0)
  const userOffsetRef = useRef(0)
  const touchYRef = useRef(0)
  const [segIdx, setSegIdx] = useState(() => {
    const position = getPosition()
    return lyricTimingAt(timing, lyricTimeAtMediaPosition(position, lyricsRate, offsetMs)).segmentIndex
  })
  const segIdxRef = useRef(segIdx)
  const [paintRange, setPaintRange] = useState({ start: Math.max(0, segIdx - 24), end: Math.max(48, segIdx + 24) })
  const [paused, setPaused] = useState(false)
  const registerRow = useCallback((index: number, element: HTMLElement | null) => {
    itemEls.current[index] = element
  }, [])
  const setTextRef = useCallback((element: HTMLSpanElement | null) => {
    textRef.current = element
  }, [])
  const setUnderlineRef = useCallback((el: HTMLSpanElement | null) => {
    if (underlineRef.current === el) return
    underlineRef.current = el
    if (el) {
      el.classList.remove('has-progress')
      el.style.transform = 'scaleX(0)'
    }
  }, [])
  const seekToLyricTime = useCallback((timeSec: number) => {
    onSeek(mediaPositionAtLyricTime(timeSec, lyricsRate, offsetMs))
  }, [onSeek, lyricsRate, offsetMs])

  const measureProgressGeometry = useCallback(() => {
    const row = underlineRef.current?.parentElement
    const text = textRef.current
    const path = underlineRef.current
    if (!row || !text || !path) return
    const range = document.createRange()
    range.selectNodeContents(text)
    const rowBounds = row.getBoundingClientRect()
    const textBounds = range.getBoundingClientRect()
    // getBoundingClientRect() is screen-scaled by .app-root's CSS zoom, while
    // inline left/width values are interpreted in the row's local CSS pixels.
    // Convert both measurements back before deriving the underline geometry.
    const measuredZoom = row.offsetWidth > 0 ? rowBounds.width / row.offsetWidth : 1
    const zoom = Number.isFinite(measuredZoom) && measuredZoom > 0 ? measuredZoom : 1
    const textBox = text.getBoundingClientRect()
    const scale = text.offsetWidth > 0 ? textBox.width / text.offsetWidth / zoom : 1
    const origin = textBox.left + textBox.width * (alignment === 'center' ? 0.5 : alignment === 'right' ? 1 : 0)
    const geometry = resolveLyricProgressGeometry(
      { left: 0, width: row.offsetWidth },
      {
        left: (origin + (textBounds.left - origin) / scale - rowBounds.left) / zoom,
        width: textBounds.width / scale / zoom,
      },
      alignment,
      progressClipToText,
      progressDirection,
    )
    // Finish all layout reads before changing the underline's styles.
    if (textFillMode === 'words') {
      const tokens = [...text.querySelectorAll<HTMLElement>('[data-lyric-token]')]
      wordsRef.current = {
        elements: tokens.filter(token => token.dataset.lyricToken === 'word'),
        starts: wordStartsFromWidths(tokens.map(token => ({ width: token.offsetWidth, word: token.dataset.lyricToken === 'word' }))),
        current: -2,
      }
    }
    path.style.left = `${geometry.leftPx}px`
    path.style.width = `${geometry.widthPx}px`
  }, [alignment, progressClipToText, progressDirection, textFillMode])

  const applyTransform = useCallback((instant: boolean) => {
    const c = containerRef.current
    const stage = stageRef.current
    if (!c || !stage) return
    const idx = lyricAnchorIndex(segments, segIdxRef.current)
    const row = itemEls.current[idx]
    if (idx < 0 || !row) return
    const measuredZoom = stage.offsetWidth > 0 ? stage.getBoundingClientRect().width / stage.offsetWidth : 1
    const zoom = Number.isFinite(measuredZoom) && measuredZoom > 0 ? measuredZoom : 1
    const rowBounds = row.getBoundingClientRect()
    const trackBounds = c.getBoundingClientRect()
    let collapsingBefore = 0
    let collapsingTotal = 0
    for (const index of collapsingNotesRef.current) {
      if (segments[index]?.kind !== 'notes' || !segments[index].skipPool) {
        collapsingNotesRef.current.delete(index)
        continue
      }
      const height = (itemEls.current[index]?.getBoundingClientRect().height ?? 0) / zoom
      if (height === 0) collapsingNotesRef.current.delete(index)
      collapsingTotal += height
      if (index < idx) collapsingBefore += height
    }
    const anchor = stage.clientHeight * ANCHOR_RATIO
    // Target the settled layout while outgoing compact pauses collapse. Using
    // their animated height restarted the accelerated easing on every frame.
    const baseTy = anchor - ((rowBounds.top - trackBounds.top) / zoom - collapsingBefore + rowBounds.height / zoom / 2)
    const minTy = stage.clientHeight - (trackBounds.height / zoom - collapsingTotal)
    const ty = clamp(baseTy + userOffsetRef.current, minTy, 0)
    const range = lyricPaintRange(segments.length, -ty - stage.clientHeight, -ty + stage.clientHeight * 2,
      index => itemEls.current[index]?.offsetTop ?? 0)
    setPaintRange(previous => previous.start === range.start && previous.end === range.end ? previous : range)
    const target = `translate3d(0, ${ty.toFixed(2)}px, 0)`
    if (instant || !positionedRef.current || Math.abs(ty - previousTyRef.current) > stage.clientHeight) {
      c.style.transition = 'none'
      c.style.transform = target
      void c.offsetHeight
      c.style.transition = ''
    } else if (Math.abs(ty - previousTyRef.current) > 0.25) {
      c.style.transform = target
    } else {
      return
    }
    positionedRef.current = true
    previousTyRef.current = ty
  }, [segments])

  const measureAll = useCallback(
    (instant: boolean) => {
      if (!pausedRef.current) applyTransform(instant)
    },
    [applyTransform],
  )

  useLayoutEffect(() => {
    // Measure after the new active row commits. Timing refinements and rapid
    // changes continue from the visible position instead of snapping to it.
    measureAll(false)
    measureProgressGeometry()
  }, [segments, segIdx, measureAll, measureProgressGeometry])

  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        measureAll(false)
        measureProgressGeometry()
      })
    }
    window.addEventListener('resize', onResize)
    document.fonts.addEventListener('loadingdone', onResize)
    let alive = true
    document.fonts.ready.then(() => {
      if (alive) {
        measureAll(false)
        measureProgressGeometry()
      }
    })
    return () => {
      alive = false
      window.removeEventListener('resize', onResize)
      document.fonts.removeEventListener('loadingdone', onResize)
      cancelAnimationFrame(raf)
    }
  }, [measureAll, measureProgressGeometry])

  useEffect(() => {
    const stage = stageRef.current
    const track = containerRef.current
    if (!stage || !track) return
    let raf = 0
    let previousWidth = -1
    let geometryChanged = false
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === textRef.current) geometryChanged = true
        if (entry.target === stage && entry.contentRect.width !== previousWidth) {
          previousWidth = entry.contentRect.width
          geometryChanged = true
        }
      }
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        measureAll(false)
        if (geometryChanged) measureProgressGeometry()
        geometryChanged = false
      })
    })
    observer.observe(stage)
    observer.observe(track)
    const activeText = textRef.current
    if (activeText) observer.observe(activeText)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [measureAll, measureProgressGeometry, segIdx])

  useEffect(() => {
    if (segments.length === 0) return
    let frame = 0
    const update = () => {
      frame = requestAnimationFrame(update)
      if (!document.hidden) {
        // Animate this small DOM surface at display cadence. Native clock
        // interpolation does not require frame-rate updates of the React tree.
        const pos = getPosition()
        const lyricsPosition = lyricTimeAtMediaPosition(pos, lyricsRate, offsetMs)
        const { segmentIndex: found, progress, underlineProgress } = lyricTimingAt(timing, lyricsPosition)
        if (found !== segIdxRef.current) {
          const duration = lyricTransitionDuration(segments, found, lyricsPosition, lyricsRate * playbackRate, motionStyle)
          // Inherited custom properties on the stage invalidated every row's
          // style on every cue (including hundreds of offscreen rows).
          if (containerRef.current) containerRef.current.style.transitionDuration = `${duration}ms`
          for (const index of [segIdxRef.current, found]) {
            itemEls.current[index]?.style.setProperty('--lyr-line-duration', `${Math.min(320, duration)}ms`)
          }
          const previous = segIdxRef.current
          if (segments[previous]?.kind === 'notes' && segments[previous].skipPool) collapsingNotesRef.current.add(previous)
          collapsingNotesRef.current.delete(found)
          segIdxRef.current = found
          setSegIdx(found)
        }
        const seg = found >= 0 ? segments[found] : null
        const lineProgress = seg?.kind === 'line' && seg.endTimeSec > seg.timeSec
          ? Math.max(0, Math.min(1, progress))
          : 0
        if (textFillMode === 'words') {
          const words = wordsRef.current
          const index = seg?.kind === 'line' ? wordIndexAtProgress(words.starts, lineProgress) : -1
          const stateIndex = lineProgress >= 1 ? words.elements.length : index
          if (stateIndex !== words.current) {
            words.current = stateIndex
            words.elements.forEach((element, word) => {
              element.classList.toggle('is-filled', word <= index)
              element.classList.toggle('is-current-word', word === index && lineProgress < 1)
            })
          }
        } else textRef.current?.style.setProperty('--lyr-fill', `${lineProgress * 100}%`)
        if (underlineRef.current) {
          const progress = fillEnabled ? underlineProgress : 0
          underlineRef.current.classList.toggle('has-progress', progress > 0)
          underlineRef.current.style.transform = `scaleX(${progress})`
        }
      }
    }
    update()
    return () => cancelAnimationFrame(frame)
  }, [timing, segments, lyricsRate, offsetMs, fillEnabled, playbackRate, motionStyle, textFillMode, getPosition])

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

  const skipLabel = t('Skip instrumental')
  const itemsNode = useMemo(
    () => segments.map((segment, index) => (
      <SyncedRow
        key={`${segment.kind}${index}`}
        segment={segment}
        index={index}
        active={index === segIdx}
        past={index < segIdx}
        near={index >= paintRange.start && index < paintRange.end}
        textFillMode={textFillMode}
        progressDirection={progressDirection}
        skipLabel={skipLabel}
        registerRow={registerRow}
        setTextRef={setTextRef}
        setUnderlineRef={setUnderlineRef}
        onSeek={seekToLyricTime}
        onPauseEnd={endPause}
        onMeasure={measureAll}
        onMeasureProgress={measureProgressGeometry}
      />
    )),
    [segments, segIdx, paintRange, textFillMode, progressDirection, skipLabel, registerRow, setTextRef, setUnderlineRef, seekToLyricTime, endPause, measureAll, measureProgressGeometry],
  )

  return (
    <div className={`lyr-synced${motionStyle === 'accelerated' ? ' is-accelerated' : ''}`} ref={stageRef} onWheel={onWheel} onTouchStart={onTouchStart} onTouchMove={onTouchMove}>
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
})

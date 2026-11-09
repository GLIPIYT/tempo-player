import { memo, useCallback } from 'react'
import { Music2 } from 'lucide-react'
import type { LyricSegment } from './timingResolver'
import type { LyricProgressDirection, LyricTextFillMode } from '../../state/settings'
import { lyricDisplayText, lyricDisplayTokens } from './lyricTokens'
import { capitalizeLyricLines } from './displayCase'

/** Keep unchanged rows out of the render work when the active cue advances. */
export const SyncedRow = memo(function SyncedRow({
  segment, index, active, past, near = true, textFillMode, progressDirection, skipLabel, capitalizeLines = true,
  registerRow, setTextRef, setUnderlineRef, onSeek, onPauseEnd, onMeasure, onMeasureProgress,
}: {
  segment: LyricSegment
  index: number
  active: boolean
  past: boolean
  near?: boolean
  textFillMode: LyricTextFillMode
  progressDirection: LyricProgressDirection
  skipLabel: string
  capitalizeLines?: boolean
  registerRow: (index: number, element: HTMLElement | null) => void
  setTextRef: (element: HTMLSpanElement | null) => void
  setUnderlineRef: (element: HTMLSpanElement | null) => void
  onSeek: (timeSec: number) => void
  onPauseEnd: () => void
  onMeasure: (instant: boolean) => void
  onMeasureProgress: () => void
}) {
  const rowRef = useCallback((element: HTMLElement | null) => registerRow(index, element), [index, registerRow])
  const displayText = capitalizeLines ? capitalizeLyricLines(segment.text) : segment.text
  const onClick = () => {
    onPauseEnd()
    onSeek(segment.seekToSec)
  }
  if (segment.kind === 'notes') {
    return (
      <button
        ref={rowRef}
        className={'lyr-notes' + (segment.skipPool ? ' is-skip-pool' : '') + (active ? ' is-active' : '') + (near ? ' is-near' : '')}
        tabIndex={active ? 0 : -1}
        onTransitionEnd={event => {
          if (event.target === event.currentTarget && event.propertyName === 'height') onMeasure(false)
        }}
        onClick={onClick}
        aria-label={skipLabel}
      >
        {near && <span className="lyr-notes-row" aria-hidden="true">
          <Music2 size={17} className="lyr-note" />
          <Music2 size={17} className="lyr-note" />
          <Music2 size={17} className="lyr-note" />
        </span>}
      </button>
    )
  }
  return (
    <div ref={rowRef} className={'lyr-line' + (active ? ' is-active' : past ? ' is-past' : '') + (near ? ' is-near' : '')} onClick={onClick}>
      <span
        className={`lyr-line-text${textFillMode === 'words' ? ' is-word-fill' : ''}`}
        style={{ whiteSpace: 'pre-line' }}
        ref={active ? setTextRef : null}
        onTransitionEnd={active ? event => {
          if (event.target === event.currentTarget && event.propertyName === 'transform') onMeasureProgress()
        } : undefined}
      >
        {textFillMode === 'words' && active ? lyricDisplayTokens(displayText).map((token, tokenIndex) => {
          const word = /\S/u.test(token)
          return <span key={tokenIndex} data-lyric-token={word ? 'word' : 'space'} className={word ? 'lyr-word' : 'lyr-word-space'}>{token}</span>
        }) : lyricDisplayText(displayText)}
      </span>
      <span
        className="lyr-underline"
        style={{ transformOrigin: progressDirection === 'center-out' ? 'center center' : progressDirection === 'right-to-left' ? 'right center' : 'left center' }}
        ref={active ? setUnderlineRef : null}
      />
    </div>
  )
})

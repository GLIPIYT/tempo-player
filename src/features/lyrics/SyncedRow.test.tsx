import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SyncedRow } from './SyncedRow'
import type { LyricSegment } from './timingResolver'

const noop = () => {}
const line: LyricSegment = {
  kind: 'line', timeSec: 0, endTimeSec: 4, seekToSec: 0, lineIndices: [0],
  text: 'На время завязал, теперь\nещё  одна строка',
}
const props = {
  index: 0, past: false, textFillMode: 'words' as const, progressDirection: 'center-out' as const,
  skipLabel: 'Skip instrumental', registerRow: noop, setTextRef: noop, setUnderlineRef: noop,
  onSeek: noop, onPauseEnd: noop, onMeasure: noop, onMeasureProgress: noop,
}

it('keeps actual separators, punctuation, repeated spaces and newlines between highlighted words', () => {
  const markup = renderToStaticMarkup(<SyncedRow {...props} segment={line} active />)
  const tokens = [...markup.matchAll(/data-lyric-token="(word|space)" class="([^"]+)">([^<]*)<\/span>/gu)]
  expect(tokens.map(match => match[3]).join('')).toBe(line.text)
  expect(tokens.filter(match => match[1] === 'space').map(match => match[3])).toEqual([' ', ' ', ' ', '\n', '  ', ' '])
  expect(tokens.filter(match => match[1] === 'space').every(match => match[2] === 'lyr-word-space')).toBe(true)
})

it('keeps inactive long lists as plain text instead of building word nodes for every row', () => {
  const markup = renderToStaticMarkup(<SyncedRow {...props} segment={line} active={false} />)
  expect(markup).not.toContain('data-lyric-token')
  expect(markup).toContain(line.text)
})

it('retains compact instrumental rows and their active state', () => {
  const segment: LyricSegment = { ...line, kind: 'notes', text: '', skipPool: true }
  const inactive = renderToStaticMarkup(<SyncedRow {...props} segment={segment} active={false} />)
  const active = renderToStaticMarkup(<SyncedRow {...props} segment={segment} active />)
  expect(inactive).toContain('class="lyr-notes is-skip-pool is-near" tabindex="-1"')
  expect(active).toContain('class="lyr-notes is-skip-pool is-active is-near" tabindex="0"')
})

it('does not create SVG decorations for distant pause rows', () => {
  const segment: LyricSegment = { ...line, kind: 'notes', text: '', skipPool: true }
  const markup = renderToStaticMarkup(<SyncedRow {...props} segment={segment} active={false} near={false} />)
  expect(markup).toContain('lyr-notes is-skip-pool')
  expect(markup).not.toContain('<svg')
})

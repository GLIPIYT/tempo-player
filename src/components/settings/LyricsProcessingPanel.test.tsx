import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import LyricsProcessingPanel from './LyricsProcessingPanel'
import type { ModelState } from '../../features/lyrics/analysis/contract'

const noop = () => {}
const model = (phase: ModelState['phase']): ModelState => ({
  enabled: true, phase, loadedBytes: 0, totalBytes: 100, error: null,
})
function render(phase: ModelState['phase'], analysis: { phase: 'idle' | 'loading' | 'analyzing' | 'waiting' | 'paused' | 'complete' | 'unavailable' | 'error'; error: string | null; unavailableReason: 'missing-file' | 'unreadable-file' | null }) {
  return renderToStaticMarkup(<LyricsProcessingPanel
    vocalEnabled={false}
    wordEnabled
    wordMode
    modelState={model(phase)}
    wordAnalysisState={analysis}
    vocalState={{ phase: 'idle', error: null }}
    onVocalChange={noop}
    onWordChange={noop}
    onRetryModel={noop}
    onRetryAnalysis={noop}
    onRetryVocal={noop}
  />)
}

it('keeps model readiness visible while the current track is paused', () => {
  const markup = render('ready', { phase: 'paused', error: null, unavailableReason: null })
  expect(markup).toContain('class="processing-state is-ready"')
  expect(markup).toContain('Paused — play to analyze')
  expect(markup).toContain('Model is available on this computer.')
})

it('reports missing or unreadable audio accurately and offers a retry', () => {
  const missing = render('ready', { phase: 'unavailable', error: null, unavailableReason: 'missing-file' })
  expect(missing).toContain('No local or cached audio file found')
  expect(missing).toContain('Retry analysis')
  expect(missing).not.toContain('Audio file required')

  const unreadable = render('ready', { phase: 'unavailable', error: null, unavailableReason: 'unreadable-file' })
  expect(unreadable).toContain('Audio file could not be read for analysis')
  expect(unreadable).toContain('Model is available on this computer.')
})

it('shows local model verification separately from a network download', () => {
  const markup = render('checking', { phase: 'idle', error: null, unavailableReason: null })
  expect(markup).toContain('Checking model files')
  expect(markup).not.toContain('role="progressbar"')
})

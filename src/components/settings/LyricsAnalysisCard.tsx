import { useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { useSettings } from '../../state/settings'
import { vocalAnalysisRunner } from '../../features/lyrics/analysis/vocalRunner'
import { lyricsAnalysisLifecycle } from '../integration/LyricsAnalysisBridge'

export default function LyricsAnalysisCard() {
  const t = useT()
  const { settings, update } = useSettings()
  const state = useSyncExternalStore(lyricsAnalysisLifecycle.subscribe, lyricsAnalysisLifecycle.getSnapshot)
  const vocalState = useSyncExternalStore(vocalAnalysisRunner.subscribe, vocalAnalysisRunner.getSnapshot)
  const vocalEnabled = settings.lyrics.vocalAnalysisEnabled
  const whisperEnabled = settings.lyrics.whisperWordTimingsEnabled
  const wordMode = settings.lyrics.textFillMode === 'words'
  const modelRequested = whisperEnabled && wordMode
  const title = t('Use speech recognition for word timing')
  const progress = state.totalBytes > 0 ? Math.min(100, Math.max(0, state.loadedBytes / state.totalBytes * 100)) : 0
  const status = state.phase === 'downloading'
    ? `${t('Downloading model')} · ${Math.floor(progress)}%`
    : state.phase === 'ready' ? t('Ready')
    : state.phase === 'error' ? t('Model download failed')
    : modelRequested ? t('Preparing model download')
    : whisperEnabled && !wordMode ? t('Only used in word-by-word mode') : t('Not downloaded')
  const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)
  return (
    <section className="set-card">
      <div className="set-row">
        <span className="set-row-label">{t('Use vocal timing analysis')}</span>
        <button className={vocalEnabled ? 'switch is-on' : 'switch'} role="switch" aria-checked={vocalEnabled}
          aria-label={t('Use vocal timing analysis')}
          onClick={() => update({ lyrics: { vocalAnalysisEnabled: !vocalEnabled } })} />
      </div>
      {vocalEnabled && vocalState.phase === 'error' && vocalState.error && <div className="set-note" role="alert">
        {t('Vocal timing analysis failed')}
      </div>}
      <div className="set-row">
        <span className="set-row-label">{title}</span>
        <button className={whisperEnabled ? 'switch is-on' : 'switch'} role="switch" aria-checked={whisperEnabled} aria-label={title}
          onClick={() => {
            const next = !whisperEnabled
            lyricsAnalysisLifecycle.setPreference(next && wordMode)
            update({ lyrics: { whisperWordTimingsEnabled: next } })
          }} />
      </div>
      <div className="set-note" role="status">{status}</div>
      {state.phase === 'downloading' && <>
        <div className="lyrics-analysis-progress" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(progress)}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="set-note lyrics-analysis-bytes">{megabytes(state.loadedBytes)} / {megabytes(state.totalBytes)} MB</div>
      </>}
      {state.phase === 'error' && <>
        {state.error && <div className="set-note lyrics-analysis-error" role="alert">{state.error}</div>}
        {modelRequested && <button className="btn-primary lyrics-analysis-retry" onClick={() => lyricsAnalysisLifecycle.retryDownload()}>{t('Retry download')}</button>}
      </>}
    </section>
  )
}

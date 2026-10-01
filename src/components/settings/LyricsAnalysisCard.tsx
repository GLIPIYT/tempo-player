import { useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { useSettings } from '../../state/settings'
import { lyricsAnalysisLifecycle } from '../integration/LyricsAnalysisBridge'

export default function LyricsAnalysisCard() {
  const t = useT()
  const { settings, update } = useSettings()
  const state = useSyncExternalStore(lyricsAnalysisLifecycle.subscribe, lyricsAnalysisLifecycle.getSnapshot)
  const enabled = settings.lyrics.deepAnalysisEnabled === true
  const title = t('Deep lyrics analysis')
  const progress = state.totalBytes > 0 ? Math.min(100, Math.max(0, state.loadedBytes / state.totalBytes * 100)) : 0
  const status = state.phase === 'downloading'
    ? `${t('Downloading model')} · ${Math.floor(progress)}%`
    : enabled && state.phase === 'absent' ? t('Preparing model download')
    : state.phase === 'ready' ? t('Ready') : state.phase === 'error' ? t('Model download failed') : t('Not downloaded')
  const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)
  return (
    <section className="set-card">
      <div className="set-row">
        <span className="set-row-label">{title}</span>
        <button className={enabled ? 'switch is-on' : 'switch'} role="switch" aria-checked={enabled} aria-label={title}
          onClick={() => {
            lyricsAnalysisLifecycle.setPreference(!enabled)
            update({ lyrics: { deepAnalysisEnabled: !enabled } })
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
        {enabled && <button className="btn-primary lyrics-analysis-retry" onClick={() => lyricsAnalysisLifecycle.retryDownload()}>{t('Retry download')}</button>}
      </>}
    </section>
  )
}

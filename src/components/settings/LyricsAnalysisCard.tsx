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
  const status = state.phase === 'downloading'
    ? `${Math.min(100, Math.max(0, Math.floor(state.loadedBytes / Math.max(1, state.totalBytes) * 100)))}%`
    : state.phase === 'ready' ? t('Ready') : state.phase === 'error' ? t('Model unavailable') : t('Not downloaded')
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
    </section>
  )
}

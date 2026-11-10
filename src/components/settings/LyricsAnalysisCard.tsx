import { useSyncExternalStore } from 'react'
import { useSettings } from '../../state/settings'
import { vocalAnalysisRunner } from '../../features/lyrics/analysis/vocalRunner'
import { lyricsAnalysisRunner } from '../../features/lyrics/analysis/runner'
import { lyricsAnalysisLifecycle } from '../integration/LyricsAnalysisBridge'
import LyricsProcessingPanel from './LyricsProcessingPanel'

export default function LyricsAnalysisCard() {
  const { settings, update } = useSettings()
  const modelState = useSyncExternalStore(
    lyricsAnalysisLifecycle.subscribe,
    lyricsAnalysisLifecycle.getSnapshot,
  )
  const vocalState = useSyncExternalStore(
    vocalAnalysisRunner.subscribe,
    vocalAnalysisRunner.getSnapshot,
  )
  const wordAnalysisState = useSyncExternalStore(
    lyricsAnalysisRunner.subscribe,
    lyricsAnalysisRunner.getSnapshot,
  )
  const wordMode = settings.lyrics.textFillMode === 'words'
  return (
    <LyricsProcessingPanel
      vocalEnabled={settings.lyrics.vocalAnalysisEnabled}
      wordEnabled={settings.lyrics.whisperWordTimingsEnabled}
      wordMode={wordMode}
      modelState={modelState}
      wordAnalysisState={wordAnalysisState}
      vocalState={vocalState}
      onVocalChange={(enabled) =>
        update({ lyrics: { vocalAnalysisEnabled: enabled } })
      }
      onWordChange={(enabled) => {
        lyricsAnalysisLifecycle.setPreference(enabled && wordMode)
        update({ lyrics: { whisperWordTimingsEnabled: enabled } })
      }}
      onRetryModel={() => lyricsAnalysisLifecycle.retryDownload()}
      onRetryAnalysis={() => lyricsAnalysisRunner.retry()}
      onRetryVocal={() => vocalAnalysisRunner.retry()}
    />
  )
}

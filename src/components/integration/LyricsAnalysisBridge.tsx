import { useEffect, useRef } from 'react'
import { onLyricsAnalysisModelState, onSoundcloudCacheReady } from '../../api/events'
import { lyricsAnalysisRunner } from '../../features/lyrics/analysis/runner'
import { vocalAnalysisRunner } from '../../features/lyrics/analysis/vocalRunner'
import { ensureAnalysisModel, getAnalysisModelState, setAnalysisModelEnabled } from '../../features/lyrics/analysis/nativeClient'
import { lyricsService } from '../../features/lyrics/lyricsService'
import { connectLyricsAnalysis } from './lyricsAnalysisConnection'
import { connectVocalAnalysis } from './vocalAnalysisConnection'
import { playerController } from '../../player/controller'
import { useSettings } from '../../state/settings'
import { createLyricsAnalysisLifecycle } from './lyricsAnalysisLifecycle'

export const lyricsAnalysisLifecycle = createLyricsAnalysisLifecycle({ runner: lyricsAnalysisRunner,
  status: getAnalysisModelState, setEnabled: setAnalysisModelEnabled, ensureModel: ensureAnalysisModel, listen: onLyricsAnalysisModelState })

/** Mounted only by App: the mini player and overlay never create an analysis writer. */
export default function LyricsAnalysisBridge() {
  const { settings } = useSettings()
  const cacheOnline = useRef(settings.lyrics.cacheOnline)
  cacheOnline.current = settings.lyrics.cacheOnline
  const wordTimingsEnabled = useRef(settings.lyrics.textFillMode === 'words')
  wordTimingsEnabled.current = settings.lyrics.textFillMode === 'words'
  const connection = useRef<ReturnType<typeof connectLyricsAnalysis> | null>(null)
  const vocalConnection = useRef<ReturnType<typeof connectVocalAnalysis> | null>(null)
  useEffect(() => {
    const stopLifecycle = lyricsAnalysisLifecycle.start()
    const disconnect = connectLyricsAnalysis({ player: playerController, runner: lyricsAnalysisRunner, lyrics: lyricsService,
      lifecycle: lyricsAnalysisLifecycle, cacheOnline: () => cacheOnline.current, listenCacheReady: onSoundcloudCacheReady,
      wordTimingsEnabled: () => wordTimingsEnabled.current })
    const disconnectVocal = connectVocalAnalysis({ player: playerController, runner: vocalAnalysisRunner, lyrics: lyricsService,
      cacheOnline: () => cacheOnline.current, listenCacheReady: onSoundcloudCacheReady,
      wordTimingsEnabled: () => wordTimingsEnabled.current })
    connection.current = disconnect
    vocalConnection.current = disconnectVocal
    return () => {
      connection.current = null
      vocalConnection.current = null
      disconnectVocal()
      disconnect()
      stopLifecycle()
    }
  }, [])
  useEffect(() => {
    vocalAnalysisRunner.setEnabled(settings.lyrics.vocalAnalysisEnabled)
  }, [settings.lyrics.vocalAnalysisEnabled])
  useEffect(() => {
    lyricsAnalysisLifecycle.setPreference(
      settings.lyrics.whisperWordTimingsEnabled && settings.lyrics.textFillMode === 'words',
    )
  }, [settings.lyrics.whisperWordTimingsEnabled, settings.lyrics.textFillMode])
  useEffect(() => {
    connection.current?.update()
    vocalConnection.current?.update()
  }, [settings.lyrics.textFillMode])
  return null
}

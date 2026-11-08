import { useEffect, useRef } from 'react'
import { onLyricsAnalysisModelState, onSoundcloudCacheReady } from '../../api/events'
import { lyricsAnalysisRunner } from '../../features/lyrics/analysis/runner'
import { ensureAnalysisModel, getAnalysisModelState, setAnalysisModelEnabled } from '../../features/lyrics/analysis/nativeClient'
import { lyricsService } from '../../features/lyrics/lyricsService'
import { connectLyricsAnalysis } from './lyricsAnalysisConnection'
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
  useEffect(() => {
    const stopLifecycle = lyricsAnalysisLifecycle.start()
    const disconnect = connectLyricsAnalysis({ player: playerController, runner: lyricsAnalysisRunner, lyrics: lyricsService,
      lifecycle: lyricsAnalysisLifecycle, cacheOnline: () => cacheOnline.current, listenCacheReady: onSoundcloudCacheReady,
      wordTimingsEnabled: () => wordTimingsEnabled.current })
    connection.current = disconnect
    return () => { connection.current = null; disconnect(); stopLifecycle() }
  }, [])
  useEffect(() => {
    lyricsAnalysisLifecycle.setPreference(settings.lyrics.deepAnalysisEnabled)
  }, [settings.lyrics.deepAnalysisEnabled])
  useEffect(() => {
    connection.current?.update()
  }, [settings.lyrics.textFillMode])
  return null
}

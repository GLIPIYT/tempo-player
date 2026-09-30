import { useEffect, useRef } from 'react'
import { onLyricsAnalysisModelState } from '../../api/events'
import { lyricsAnalysisRunner } from '../../features/lyrics/analysis/runner'
import { getAnalysisModelState, setAnalysisModelEnabled } from '../../features/lyrics/analysis/nativeClient'
import { lyricsService } from '../../features/lyrics/lyricsService'
import { connectLyricsAnalysis } from './lyricsAnalysisConnection'
import { playerController } from '../../player/controller'
import { useSettings } from '../../state/settings'
import { createLyricsAnalysisLifecycle } from './lyricsAnalysisLifecycle'

export const lyricsAnalysisLifecycle = createLyricsAnalysisLifecycle({ runner: lyricsAnalysisRunner,
  status: getAnalysisModelState, setEnabled: setAnalysisModelEnabled, listen: onLyricsAnalysisModelState })

/** Mounted only by App: the mini player and overlay never create an analysis writer. */
export default function LyricsAnalysisBridge() {
  const { settings } = useSettings()
  const cacheOnline = useRef(settings.lyrics.cacheOnline)
  cacheOnline.current = settings.lyrics.cacheOnline
  useEffect(() => {
    const stopLifecycle = lyricsAnalysisLifecycle.start()
    const disconnect = connectLyricsAnalysis({ player: playerController, runner: lyricsAnalysisRunner, lyrics: lyricsService,
      lifecycle: lyricsAnalysisLifecycle, cacheOnline: () => cacheOnline.current })
    return () => { disconnect(); stopLifecycle() }
  }, [])
  useEffect(() => {
    lyricsAnalysisLifecycle.setPreference(settings.lyrics.deepAnalysisEnabled)
  }, [settings.lyrics.deepAnalysisEnabled])
  return null
}

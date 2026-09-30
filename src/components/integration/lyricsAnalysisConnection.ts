import type { LyricsLine } from '../../features/lyrics/types'
import type { lyricsAnalysisRunner } from '../../features/lyrics/analysis/runner'
import type { lyricsService } from '../../features/lyrics/lyricsService'
import type { PlayerSnapshot } from '../../player/controller'

interface ConnectionDependencies {
  player: { getSnapshot(): Pick<PlayerSnapshot, 'currentTrack' | 'position' | 'isPlaying' | 'playbackRate'>; subscribe(listener: () => void): () => void }
  runner: typeof lyricsAnalysisRunner
  lyrics: typeof lyricsService
  lifecycle: { setSchedulingAllowed(allowed: boolean): void }
  cacheOnline(): boolean
}
/** Exact source/manual endings cannot benefit from ASR. Keep original indices. */
export function needsLyricsAnalysis(lines: readonly LyricsLine[]): boolean {
  return lines.some(line => {
    if (!line.text.trim()) return false
    const end = line.endTimeSec ?? line.words?.at(-1)?.endTimeSec
    return end == null || !Number.isFinite(end) || end <= line.timeSec
  })
}

export function connectLyricsAnalysis({ player, runner, lyrics, lifecycle, cacheOnline }: ConnectionDependencies): () => void {
  let generation = -1
  let publishing = false
  let active: ReturnType<typeof lyrics.getCurrent> = null
  const syncLyrics = () => {
    if (publishing) return
    const current = lyrics.getCurrent()
    const track = player.getSnapshot().currentTrack
    if (!current || !track || current.trackId !== track.sourceId || current.sourceResult?.kind !== 'synced') {
      if (active) { active = null; generation = -1; lifecycle.setSchedulingAllowed(false); runner.setTrack(null) }
      return
    }
    if (generation === current.generation) return
    active = current; generation = current.generation
    lifecycle.setSchedulingAllowed(false)
    runner.setTrack({ track, sourceLines: current.sourceResult.lines, durationSec: current.durationSec ?? 0,
      offsetMs: current.offsetMs, lyricKey: current.lyricKey, sourceLyricKey: current.sourceLyricKey })
    lifecycle.setSchedulingAllowed(needsLyricsAnalysis(current.sourceResult.lines))
  }
  const syncPlayer = () => {
    const snapshot = player.getSnapshot()
    lyrics.setPosition(snapshot.position)
    runner.setPosition(snapshot.position, snapshot.isPlaying)
    if (snapshot.currentTrack) lyrics.ensure(snapshot.currentTrack, cacheOnline())
    else lyrics.invalidate()
    syncLyrics()
  }
  const unsubscribeAnalysis = runner.subscribe(() => {
    const snapshot = runner.getSnapshot()
    if (!active || snapshot.lyricKey !== active.lyricKey) return
    publishing = true
    try { lyrics.publishAnalysis(active.trackId, active.lyricKey, active.generation, snapshot.analysis) }
    finally { publishing = false }
  })
  const unsubscribeLyrics = lyrics.subscribe(syncLyrics)
  const unsubscribePlayer = player.subscribe(syncPlayer)
  syncPlayer()
  return () => { unsubscribePlayer(); unsubscribeLyrics(); unsubscribeAnalysis(); runner.stop() }
}

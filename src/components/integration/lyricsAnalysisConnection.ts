import type { LyricsLine } from '../../features/lyrics/types'
import type { lyricsAnalysisRunner } from '../../features/lyrics/analysis/runner'
import type { lyricsService } from '../../features/lyrics/lyricsService'
import type { PlayerSnapshot } from '../../player/controller'

interface ConnectionDependencies {
  player: { getSnapshot(): Pick<PlayerSnapshot, 'currentTrack' | 'position' | 'isPlaying' | 'playbackRate' | 'duration' | 'preparing'>; subscribe(listener: () => void): () => void }
  runner: typeof lyricsAnalysisRunner
  lyrics: typeof lyricsService
  lifecycle: { setSchedulingAllowed(allowed: boolean): void }
  cacheOnline(): boolean
  listenCacheReady?(handler: (sourceId: string) => void): Promise<() => void>
}
/** Exact source/manual endings cannot benefit from ASR. Keep original indices. */
export function needsLyricsAnalysis(lines: readonly LyricsLine[]): boolean {
  return lines.some(line => {
    if (!line.text.trim()) return false
    const end = line.endTimeSec ?? line.words?.at(-1)?.endTimeSec
    return end == null || !Number.isFinite(end) || end <= line.timeSec
  })
}

export function connectLyricsAnalysis({ player, runner, lyrics, lifecycle, cacheOnline, listenCacheReady }: ConnectionDependencies): () => void {
  let generation = -1
  let publishing = false
  let disposed = false
  let unsubscribeCache: (() => void) | undefined
  let cacheRetryGeneration = -1
  let mediaRetryGeneration = -1
  let previousTrack = ''
  let wasPreparing = false
  let hadDuration = false
  let active: ReturnType<typeof lyrics.getCurrent> = null
  const syncLyrics = () => {
    if (publishing) return
    const snapshot = player.getSnapshot()
    const track = snapshot.currentTrack
    if (track) lyrics.setMediaDuration(track.sourceId, snapshot.duration)
    const current = lyrics.getCurrent()
    if (!current || !track || current.trackId !== track.sourceId || current.sourceResult?.kind !== 'synced') {
      if (active) { active = null; generation = -1; lifecycle.setSchedulingAllowed(false); runner.setTrack(null) }
      return
    }
    if (generation === current.generation && active?.durationSec === current.durationSec) return
    const changedCandidate = generation !== current.generation
    active = current; generation = current.generation
    if (changedCandidate) lifecycle.setSchedulingAllowed(false)
    runner.setTrack({ track, sourceLines: current.sourceResult.lines, durationSec: current.durationSec ?? 0,
      offsetMs: current.offsetMs, lyricKey: current.lyricKey, sourceLyricKey: current.sourceLyricKey })
    if (changedCandidate) lifecycle.setSchedulingAllowed(needsLyricsAnalysis(current.sourceResult.lines))
  }
  const syncPlayer = () => {
    const snapshot = player.getSnapshot()
    const trackKey = snapshot.currentTrack ? JSON.stringify([snapshot.currentTrack.source, snapshot.currentTrack.sourceId, snapshot.currentTrack.dbId]) : ''
    const hasDuration = Number.isFinite(snapshot.duration) && snapshot.duration > 0
    const becameReady = trackKey === previousTrack && ((wasPreparing && !snapshot.preparing) || (!hadDuration && hasDuration))
    previousTrack = trackKey; wasPreparing = snapshot.preparing; hadDuration = hasDuration
    lyrics.setPosition(snapshot.position)
    runner.setPosition(snapshot.position, snapshot.isPlaying)
    if (snapshot.currentTrack) lyrics.ensure(snapshot.currentTrack, cacheOnline())
    else lyrics.invalidate()
    syncLyrics()
    // At most one media-readiness retry per lyric generation. The exact cache
    // completion retains its separate opportunity after a streaming fallback.
    if (becameReady && active && mediaRetryGeneration !== active.generation) {
      mediaRetryGeneration = active.generation
      runner.refreshAudioIdentity()
    }
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
  void listenCacheReady?.(sourceId => {
    const track = player.getSnapshot().currentTrack
    if (disposed || !active || track?.source !== 'soundcloud' || track.sourceId !== sourceId
      || active.trackId !== sourceId || cacheRetryGeneration === active.generation) return
    cacheRetryGeneration = active.generation
    runner.refreshAudioIdentity()
  }).then(remove => { if (disposed) remove(); else unsubscribeCache = remove }).catch(() => {})
  syncPlayer()
  return () => { disposed = true; unsubscribeCache?.(); unsubscribePlayer(); unsubscribeLyrics(); unsubscribeAnalysis(); runner.stop() }
}

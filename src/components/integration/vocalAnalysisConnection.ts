import type { PlayerSnapshot } from '../../player/controller'
import type { lyricsService } from '../../features/lyrics/lyricsService'
import type { vocalAnalysisRunner } from '../../features/lyrics/analysis/vocalRunner'
import { mapLyricWordTimings } from '../../features/lyrics/wordTiming'

interface Dependencies {
  player: { getSnapshot(): Pick<PlayerSnapshot, 'currentTrack' | 'position' | 'isPlaying' | 'duration' | 'preparing'>; subscribe(listener: () => void): () => void }
  lyrics: typeof lyricsService
  runner: typeof vocalAnalysisRunner
  cacheOnline(): boolean
  wordTimingsEnabled(): boolean
  listenCacheReady?(handler: (sourceId: string) => void): Promise<() => void>
}
export function connectVocalAnalysis({ player, lyrics, runner, cacheOnline, wordTimingsEnabled, listenCacheReady }: Dependencies): (() => void) & { update(): void } {
  let disposed = false, publishing = false
  let generation = -1, previousWordMode = false, previousDuration: number | null = null
  let active: ReturnType<typeof lyrics.getCurrent> = null
  let removeCache: (() => void) | undefined
  let previousPreparing = false, previousTrack = '', retried = -1
  const sync = () => {
    if (disposed || publishing) return
    const snapshot = player.getSnapshot(), current = lyrics.getCurrent(), wordMode = wordTimingsEnabled()
    if (!snapshot.currentTrack || !current || current.trackId !== snapshot.currentTrack.sourceId || current.sourceResult?.kind !== 'synced') {
      if (active) { active = null; generation = -1; runner.setTrack(null) }
      return
    }
    if (generation === current.generation && previousDuration === current.durationSec && wordMode === previousWordMode) return
    generation = current.generation; previousDuration = current.durationSec; previousWordMode = wordMode
    const lines = current.sourceResult.lines
    const needs = lines.some(line => {
      if (!line.text.trim()) return false
      const end = line.endTimeSec ?? line.words?.at(-1)?.endTimeSec
      if (end == null || !Number.isFinite(end) || end <= line.timeSec) return true
      return wordMode && !mapLyricWordTimings(line.text, line.words, line.timeSec, end, 'source')
    })
    active = needs ? current : null
    runner.setTrack(needs ? { track: snapshot.currentTrack, sourceLines: lines, durationSec: current.durationSec ?? 0,
      offsetMs: current.offsetMs, lyricKey: current.lyricKey, sourceLyricKey: current.sourceLyricKey } : null)
    if (!needs) lyrics.publishVocalAnalysis(current.trackId, current.lyricKey, current.generation, null)
  }
  const onPlayer = () => {
    const snapshot = player.getSnapshot()
    const trackId = snapshot.currentTrack?.sourceId ?? ''
    const becameReady = trackId === previousTrack && previousPreparing && !snapshot.preparing
    previousTrack = trackId; previousPreparing = snapshot.preparing
    // ASR connection remains the source-selection owner. Calling ensure is
    // idempotent and also makes this connection independently testable.
    if (snapshot.currentTrack) lyrics.ensure(snapshot.currentTrack, cacheOnline())
    runner.setPosition(snapshot.position, snapshot.isPlaying)
    sync()
    if (becameReady && active && retried !== active.generation) { retried = active.generation; runner.refreshAudioIdentity() }
  }
  const onAnalysis = () => {
    const value = runner.getSnapshot()
    if (!active || value.lyricKey !== active.lyricKey) return
    publishing = true
    try { lyrics.publishVocalAnalysis(active.trackId, active.lyricKey, active.generation, value.analysis) }
    finally { publishing = false }
  }
  const removeAnalysis = runner.subscribe(onAnalysis)
  const removeLyrics = lyrics.subscribe(sync)
  const removePlayer = player.subscribe(onPlayer)
  void listenCacheReady?.(sourceId => {
    if (!disposed && active?.trackId === sourceId) runner.refreshAudioIdentity()
  }).then(remove => { if (disposed) remove(); else removeCache = remove }).catch(() => {})
  onPlayer()
  const disconnect = (() => { disposed = true; removeCache?.(); removeAnalysis(); removeLyrics(); removePlayer(); runner.stop() }) as (() => void) & { update(): void }
  disconnect.update = sync
  return disconnect
}

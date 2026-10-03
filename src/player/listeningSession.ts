import type { UnifiedTrack } from '../types/models'
import { recommendationTrack, type ListeningEvent, type ListeningStartReason, type ListeningEndReason, type PlaybackSample } from '../features/recommendations/types'

/** One accumulator belongs to one actual media session, independent of the queue. */
export class ListeningAccumulator {
  private event: ListeningEvent | null = null
  private anchor: PlaybackSample | null = null
  private intervals: Array<[number, number]> = []

  begin(track: UnifiedTrack, startReason: ListeningStartReason, generation = 0): ListeningEvent {
    const metadata = recommendationTrack(track)
    this.anchor = null
    this.intervals = []
    this.event = {
      id: crypto.randomUUID(), revision: 0, trackKey: metadata.trackKey, track: metadata,
      startReason, startedAt: Date.now(), elapsedSec: 0, coveredSec: 0,
      durationSec: track.durationSec, playbackRate: 1, finished: false, generation,
    }
    return { ...this.event }
  }

  sample(sample: PlaybackSample): void {
    const event = this.event
    if (!event || event.finished || sample.sessionId !== event.id || !Number.isFinite(sample.positionSec) || sample.positionSec < 0 || !Number.isFinite(sample.atMs)) return
    const rate = sample.playbackRate ?? event.playbackRate
    if (!Number.isFinite(rate) || rate <= 0) return
    if (sample.durationSec && Number.isFinite(sample.durationSec)) event.durationSec = sample.durationSec
    const previous = this.anchor
    if (previous?.state === 'playing' && sample.state !== 'seeking' && previous.epoch === sample.epoch) {
      const wall = (sample.atMs - previous.atMs) / 1000
      const advance = sample.positionSec - previous.positionSec
      const previousRate = previous.playbackRate ?? event.playbackRate
      // Reject jumps instead of manufacturing coverage across a seek/buffer gap.
      if (wall > 0 && advance > 0 && advance <= wall * previousRate + 0.35) {
        event.elapsedSec += Math.min(wall, advance / previousRate)
        this.addInterval(previous.positionSec, sample.positionSec)
        event.coveredSec = this.intervals.reduce((sum, [a, b]) => sum + b - a, 0)
      }
    }
    event.playbackRate = rate
    this.anchor = { ...sample, playbackRate: rate }
  }

  setGeneration(generation: number): void {
    if (this.event) this.event.generation = generation
  }
  hasActualListening(): boolean { return (this.event?.elapsedSec ?? 0) > 0 }

  private addInterval(start: number, end: number): void {
    const duration = this.event?.durationSec
    if (duration && duration > 0) end = Math.min(duration, end)
    if (end <= start) return
    const merged: Array<[number, number]> = []
    for (const [a, b] of this.intervals) {
      if (b < start) merged.push([a, b])
      else if (end < a) { merged.push([start, end]); start = a; end = b }
      else { start = Math.min(start, a); end = Math.max(end, b) }
    }
    merged.push([start, end])
    // Extremely fragmented playback stays conservative and bounded.
    if (merged.length <= 2048) this.intervals = merged
  }

  checkpoint(): ListeningEvent | null {
    if (!this.event || this.event.finished) return null
    this.event.revision += 1
    return { ...this.event, track: { ...this.event.track } }
  }

  finish(reason: ListeningEndReason): ListeningEvent | null {
    if (!this.event || this.event.finished) return null
    this.event.finished = true
    this.event.endReason = reason
    this.event.revision += 1
    this.anchor = null
    return { ...this.event, track: { ...this.event.track } }
  }
}

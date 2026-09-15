import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from '../api/client'
import { measureLoudness } from './loudness'

/**
 * Background loudness measurement.
 *
 * There is no "scan the library" action: levelling only matters for what is
 * about to be heard, so the queue prefetch measures the few tracks after the
 * current one while it plays. A track lasts minutes and a measurement takes a
 * fraction of that, so the next track is normally levelled before it starts,
 * and nothing is spent on tracks the user never reaches. Files carrying
 * ReplayGain tags never appear here - the scanner already read their gain.
 */

/** Small gap between measurements so decoding never competes with playback. */
const PAUSE_MS = 150

/** Ids already measured or in flight, so repeated calls cannot duplicate work. */
const handled = new Set<number>()

export async function analyzeTracks(tracks: { id: number; path: string }[]): Promise<void> {
  for (const track of tracks) {
    if (handled.has(track.id)) continue
    handled.add(track.id)
    const result = await measureLoudness(convertFileSrc(track.path))
    // a null result still marks the file as attempted, so one the decoder
    // cannot handle is not retried on every pass
    await api
      .setTrackLoudness(track.id, result?.gainDb ?? null, result?.peakDb ?? null)
      .catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
  }
}

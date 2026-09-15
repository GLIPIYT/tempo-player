import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from '../api/client'
import { measureLoudness } from './loudness'

/**
 * Background loudness analysis for the local library.
 *
 * Files that carry ReplayGain tags never appear here - the scanner already read
 * their gain - so this only covers the rest. Work is done in small batches with
 * a pause between them so decoding does not compete with playback, and each
 * result is written straight back so an interrupted run resumes where it left
 * off rather than starting over.
 */

const BATCH = 3
const PAUSE_MS = 350

let running = false
let remaining = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribeLoudnessAnalysis(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function loudnessAnalysisState(): { running: boolean; remaining: number } {
  return { running, remaining }
}

export async function refreshLoudnessRemaining(): Promise<void> {
  try {
    remaining = await api.countTracksNeedingLoudness()
  } catch {
    remaining = 0
  }
  notify()
}

/** Ids already measured or in flight, so the queue prefetch cannot duplicate work. */
const handled = new Set<number>()

/**
 * Measures a specific set of tracks.
 *
 * This is how levelling normally happens: when a track starts, the few queued
 * after it are measured while it plays. A track lasts minutes, which is ample
 * time for a handful of measurements, so the next track is already levelled by
 * the time it begins - no up-front pass over the whole library, and the effect
 * shows up on what is actually being listened to.
 */
export async function analyzeTracks(tracks: { id: number; path: string }[]): Promise<void> {
  for (const track of tracks) {
    if (handled.has(track.id)) continue
    handled.add(track.id)
    const result = await measureLoudness(convertFileSrc(track.path))
    // a null result still marks the file as attempted, so one the decoder
    // cannot handle is not retried
    await api
      .setTrackLoudness(track.id, result?.gainDb ?? null, result?.peakDb ?? null)
      .catch(() => {})
    // small gap so decoding never competes with playback
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  await refreshLoudnessRemaining()
}

/** Measures tracks until nothing is left. Safe to call repeatedly. */
export async function analyzeLibraryLoudness(): Promise<void> {
  if (running) return
  running = true
  notify()
  try {
    for (;;) {
      const jobs = await api.listTracksNeedingLoudness(BATCH)
      if (jobs.length === 0) break
      for (const job of jobs) {
        handled.add(job.id)
        const result = await measureLoudness(convertFileSrc(job.path))
        // a null result still marks the file as attempted, so one the decoder
        // cannot handle is not retried on every run
        await api
          .setTrackLoudness(job.id, result?.gainDb ?? null, result?.peakDb ?? null)
          .catch(() => {})
      }
      remaining = Math.max(0, remaining - jobs.length)
      notify()
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
    }
  } finally {
    running = false
    await refreshLoudnessRemaining()
  }
}

/**
 * Loudness measurement for local files.
 *
 * Runs in its own AudioContext, deliberately separate from playback: the
 * playback element is routed through a GainNode and is subject to
 * cross-origin restrictions there, while this only ever decodes same-origin
 * local files. Nothing here touches the audio that is currently playing.
 */

import type { AudioIdentity } from '../features/lyrics/analysis/contract'
import { withDecodedAudio, yieldToUi } from './decodeForAnalysis'

/** Reference level the tracks are pulled towards. */
export const TARGET_RMS_DB = -18
const MAX_BOOST_DB = 12
const MAX_CUT_DB = -24
/** Kept clear of full scale so the limiter has somewhere to work. */
const CLIP_HEADROOM_DB = 1
/** Sampling stride for the RMS pass; the peak is still tracked on every sample. */
const STRIDE = 4

export interface LoudnessResult {
  gainDb: number
  peakDb: number
}

/**
 * Measures one decoded buffer. Exported so the gain rules can be exercised
 * without an AudioContext - `measureLoudness` is only the I/O wrapped around it.
 */
export function analyse(buffer: AudioBuffer): LoudnessResult | null {
  const channels = buffer.numberOfChannels
  if (channels === 0 || buffer.length === 0) return null

  let sumSquares = 0
  let samples = 0
  let peak = 0

  for (let ch = 0; ch < channels; ch += 1) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i += STRIDE) {
      const value = data[i]
      const magnitude = value < 0 ? -value : value
      if (magnitude > peak) peak = magnitude
      sumSquares += value * value
      samples += 1
    }
  }

  return resultFromEnergy(sumSquares, samples, peak)
}

function resultFromEnergy(sumSquares: number, samples: number, peak: number): LoudnessResult | null {
  if (samples === 0 || peak <= 0) return null

  const rms = Math.sqrt(sumSquares / samples)
  if (!Number.isFinite(rms) || rms <= 0) return null

  const rmsDb = 20 * Math.log10(rms)
  const peakDb = 20 * Math.log10(peak)

  // pull the track towards the reference, then never let the boost push the
  // peak past full scale
  let gainDb = TARGET_RMS_DB - rmsDb
  gainDb = Math.min(gainDb, -peakDb - CLIP_HEADROOM_DB)
  gainDb = Math.max(MAX_CUT_DB, Math.min(MAX_BOOST_DB, gainDb))

  return { gainDb, peakDb }
}

/** Decodes and measures one file. Returns null when it cannot be measured. */
export function measureLoudness(identity: AudioIdentity, signal = new AbortController().signal): Promise<LoudnessResult | null> {
  return withDecodedAudio(identity, signal, buffer => analyseCooperatively(buffer, signal))
}

/** dB to the linear multiplier the engine expects. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

export async function analyseCooperatively(buffer: AudioBuffer, signal: AbortSignal): Promise<LoudnessResult | null> {
  let sumSquares = 0, samples = 0, peak = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let base = 0; base < data.length; base += 32768) {
      signal.throwIfAborted()
      for (let i = base; i < Math.min(base + 32768, data.length); i += STRIDE) {
        peak = Math.max(peak, Math.abs(data[i])); sumSquares += data[i] * data[i]; samples++
      }
      await yieldToUi()
    }
  }
  return resultFromEnergy(sumSquares, samples, peak)
}

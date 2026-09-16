/**
 * Loudness measurement for local files.
 *
 * Runs in its own AudioContext, deliberately separate from playback: the
 * playback element is routed through a GainNode and is subject to
 * cross-origin restrictions there, while this only ever decodes same-origin
 * local files. Nothing here touches the audio that is currently playing.
 */

/** Reference level the tracks are pulled towards. */
export const TARGET_RMS_DB = -18
const MAX_BOOST_DB = 12
const MAX_CUT_DB = -24
/** Kept clear of full scale so the limiter has somewhere to work. */
const CLIP_HEADROOM_DB = 1
/** Sampling stride for the RMS pass; the peak is still tracked on every sample. */
const STRIDE = 4
/** decodeAudioData allocates the whole track as float32 - skip very long files. */
const MAX_DURATION_SEC = 30 * 60

export interface LoudnessResult {
  gainDb: number
  peakDb: number
}

function audioContextCtor(): typeof AudioContext | null {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  )
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
export async function measureLoudness(url: string): Promise<LoudnessResult | null> {
  const Ctor = audioContextCtor()
  if (!Ctor) return null
  let ctx: AudioContext | null = null
  try {
    ctx = new Ctor()
    const response = await fetch(url)
    if (!response.ok) return null
    const bytes = await response.arrayBuffer()
    const buffer = await ctx.decodeAudioData(bytes)
    if (buffer.duration > MAX_DURATION_SEC) return null
    return analyse(buffer)
  } catch {
    // an undecodable file is a normal outcome, not an error worth surfacing
    return null
  } finally {
    if (ctx) void ctx.close().catch(() => {})
  }
}

/** dB to the linear multiplier the engine expects. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

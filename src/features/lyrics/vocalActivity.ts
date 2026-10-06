export interface VocalActivitySample {
  positionMs: number
  score: number
}

export interface VocalActivitySegment {
  startMs: number
  endMs: number
}

const MIN_FREQUENCY_HZ = 50
const VOICE_LOW_HZ = 180
const VOICE_HIGH_HZ = 3600
const FORMANT_LOW_HZ = 350
const FORMANT_HIGH_HZ = 2800
const VOICE_ON_THRESHOLD = 0.56
const VOICE_HOLD_THRESHOLD = 0.43
const RELEASE_MS = 180
const MIN_SEGMENT_MS = 140

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function binAtFrequency(frequency: number, sampleRate: number, binCount: number): number {
  const nyquist = Math.max(MIN_FREQUENCY_HZ + 1, sampleRate / 2)
  const range = Math.log(nyquist / MIN_FREQUENCY_HZ)
  const position = Math.log(Math.max(MIN_FREQUENCY_HZ, frequency) / MIN_FREQUENCY_HZ) / range
  return Math.max(0, Math.min(binCount - 1, Math.floor(position * binCount)))
}

/**
 * A small spectral heuristic for voiced singing. It favors sustained energy in
 * the vocal/formant range with several distinct peaks; it deliberately returns
 * low confidence for broadband or quiet frames rather than moving a lyric line
 * on weak evidence.
 */
export function estimateVocalActivity(bins: Float32Array, sampleRate = 48_000): number {
  if (bins.length < 16) return 0
  const voiceStart = binAtFrequency(VOICE_LOW_HZ, sampleRate, bins.length)
  const voiceEnd = binAtFrequency(VOICE_HIGH_HZ, sampleRate, bins.length)
  const formantStart = binAtFrequency(FORMANT_LOW_HZ, sampleRate, bins.length)
  const formantEnd = binAtFrequency(FORMANT_HIGH_HZ, sampleRate, bins.length)
  let totalPower = 0
  let voicePower = 0
  let formantPower = 0
  let voiceBins = 0
  let peaks = 0

  for (let index = 0; index < bins.length; index += 1) {
    const value = clamp01(bins[index])
    const power = value * value
    totalPower += power
    if (index >= voiceStart && index <= voiceEnd) {
      voicePower += power
      voiceBins += 1
      if (
        index > voiceStart && index < voiceEnd && value >= 0.075
        && value > bins[index - 1] * 1.16 && value >= bins[index + 1] * 1.16
      ) peaks += 1
    }
    if (index >= formantStart && index <= formantEnd) formantPower += power
  }

  if (totalPower < 0.012 || voiceBins === 0) return 0
  const bandShare = voicePower / totalPower
  const formantShare = voicePower > 0 ? formantPower / voicePower : 0
  const averageLevel = Math.sqrt(voicePower / voiceBins)
  const bandScore = clamp01((bandShare - 0.28) / 0.42)
  const formantScore = clamp01((formantShare - 0.38) / 0.48)
  const peakScore = clamp01(peaks / 6)
  const levelScore = clamp01((averageLevel - 0.035) / 0.16)
  return clamp01((bandScore * 0.48 + formantScore * 0.32 + peakScore * 0.2) * levelScore)
}

/** Groups confident spectral frames into short vocal phrases. */
export function findVocalActivitySegments(samples: readonly VocalActivitySample[]): VocalActivitySegment[] {
  const segments: VocalActivitySegment[] = []
  let startMs: number | null = null
  let lastVoiceMs: number | null = null

  const finish = (): void => {
    if (startMs === null || lastVoiceMs === null) return
    const endMs = lastVoiceMs + 50
    if (endMs - startMs >= MIN_SEGMENT_MS) {
      const previous = segments.at(-1)
      if (previous && startMs - previous.endMs <= 120) previous.endMs = endMs
      else segments.push({ startMs, endMs })
    }
    startMs = null
    lastVoiceMs = null
  }

  for (const sample of samples) {
    if (startMs === null) {
      if (sample.score >= VOICE_ON_THRESHOLD) {
        startMs = sample.positionMs
        lastVoiceMs = sample.positionMs
      }
      continue
    }

    if (sample.score >= VOICE_HOLD_THRESHOLD) {
      lastVoiceMs = sample.positionMs
      continue
    }

    if (lastVoiceMs !== null && sample.positionMs - lastVoiceMs > RELEASE_MS) finish()
  }

  finish()
  return segments
}

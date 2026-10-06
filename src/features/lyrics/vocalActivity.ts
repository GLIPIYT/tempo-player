export interface VocalActivitySample {
  positionMs: number
  score: number
}

export interface VocalActivitySegment {
  startMs: number
  endMs: number
}

const VOICE_LOW_HZ = 180
const VOICE_HIGH_HZ = 3600
const FORMANT_LOW_HZ = 350
const FORMANT_HIGH_HZ = 2800
// getByteFrequencyData() stores the analyser's -85..-15 dB range in bytes.
// A typical singing voice has per-bin levels around -70..-55 dB, so normalizing
// against 0.012 (about -38 dB) made the score nearly always zero.
const VOICE_ON_THRESHOLD = 0.12
const VOICE_HOLD_THRESHOLD = 0.075
const RELEASE_MS = 260
const MIN_SEGMENT_MS = 100

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function binAtFrequency(frequency: number, sampleRate: number, binCount: number): number {
  const binWidth = sampleRate / (binCount * 2)
  return Math.max(0, Math.min(binCount - 1, Math.floor(frequency / binWidth)))
}

/**
 * A small spectral heuristic for voiced singing. It reads the analyser's raw
 * linear-frequency byte spectrum, converts dB bins to power, and favors sustained
 * energy in the vocal/formant range with several distinct peaks.
 */
export function estimateVocalActivity(
  bins: Uint8Array,
  sampleRate = 48_000,
  minDecibels = -85,
  maxDecibels = -15,
): number {
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
  let maxVoiceBin = 0
  const decibelRange = Math.max(1, maxDecibels - minDecibels)

  for (let index = 0; index < bins.length; index += 1) {
    const value = bins[index]
    const decibels = minDecibels + (value / 255) * decibelRange
    const power = 10 ** (decibels / 10)
    totalPower += power
    if (index >= voiceStart && index <= voiceEnd) {
      voicePower += power
      voiceBins += 1
      maxVoiceBin = Math.max(maxVoiceBin, value)
    }
    if (index >= formantStart && index <= formantEnd) formantPower += power
  }

  if (maxVoiceBin < 5 || voiceBins === 0) return 0
  for (let index = Math.max(voiceStart + 1, 1); index < Math.min(voiceEnd, bins.length - 1); index += 1) {
    const value = bins[index]
    if (value >= Math.max(5, maxVoiceBin * 0.08)
      && value > bins[index - 1] && value >= bins[index + 1]) peaks += 1
  }
  const bandShare = voicePower / totalPower
  const formantShare = voicePower > 0 ? formantPower / voicePower : 0
  const averageLevel = Math.sqrt(voicePower / voiceBins)
  const bandScore = clamp01((bandShare - 0.14) / 0.36)
  const formantScore = clamp01((formantShare - 0.18) / 0.42)
  const peakScore = clamp01(peaks / 3.25)
  const levelScore = clamp01((averageLevel - 0.00005) / 0.0007)
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

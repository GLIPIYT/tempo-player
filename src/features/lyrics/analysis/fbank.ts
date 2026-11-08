export interface FireRedCmvn {
  means: readonly number[]
  inverseStd: readonly number[]
}

export interface FireRedFeatures {
  data: Float32Array
  frames: number
  energy: Float32Array
  flux: Float32Array
}

const SAMPLE_RATE = 16000
const FRAME_LENGTH = 400
const FRAME_SHIFT = 160
const FFT_SIZE = 512
const FFT_BINS = FFT_SIZE / 2
const MEL_BINS = 80
const PREEMPHASIS = Math.fround(0.97)
const LOG_FLOOR = Math.fround(1.1920928955078125e-7)
const MAX_SAMPLES = SAMPLE_RATE * 32

interface MelFilter {
  firstBin: number
  weights: Float32Array
}

function f32(value: number): number {
  return Math.fround(value)
}

function melScale(frequency: number): number {
  const ratio = f32(f32(frequency) / 700)
  const argument = f32(1 + ratio)
  return f32(1127 * f32(Math.log(argument)))
}

function makeMelFilters(): MelFilter[] {
  const lowMel = melScale(20)
  const highMel = melScale(SAMPLE_RATE / 2)
  const melStep = f32(f32(highMel - lowMel) / (MEL_BINS + 1))
  const binWidth = f32(SAMPLE_RATE / FFT_SIZE)

  return Array.from({ length: MEL_BINS }, (_, bin) => {
    const left = f32(lowMel + f32(bin * melStep))
    const center = f32(lowMel + f32((bin + 1) * melStep))
    const right = f32(lowMel + f32((bin + 2) * melStep))
    let firstBin = -1
    let lastBin = -1
    const allWeights = new Float32Array(FFT_BINS)

    for (let fftBin = 0; fftBin < FFT_BINS; fftBin += 1) {
      const frequency = f32(binWidth * fftBin)
      const mel = melScale(frequency)
      if (mel <= left || mel >= right) continue

      const weight = mel <= center
        ? f32(f32(mel - left) / f32(center - left))
        : f32(f32(right - mel) / f32(right - center))
      allWeights[fftBin] = weight
      if (firstBin === -1) firstBin = fftBin
      lastBin = fftBin
    }

    if (firstBin === -1 || lastBin < firstBin) throw new Error('Invalid FireRed mel filter')
    return { firstBin, weights: allWeights.slice(firstBin, lastBin + 1) }
  })
}

function makeBitReversal(): Uint16Array {
  const reversal = new Uint16Array(FFT_SIZE)
  let reversed = 0
  for (let index = 0; index < FFT_SIZE; index += 1) {
    reversal[index] = reversed
    let mask = FFT_SIZE >> 1
    while (mask <= reversed && mask > 0) {
      reversed -= mask
      mask >>= 1
    }
    reversed += mask
  }
  return reversal
}

const window = Float32Array.from({ length: FRAME_LENGTH }, (_, index) => {
  const cosine = Math.cos((2 * Math.PI * index) / (FRAME_LENGTH - 1))
  return Math.fround(Math.pow(0.5 - 0.5 * cosine, 0.85))
})
const bitReversal = makeBitReversal()
const melFilters = makeMelFilters()

function fft(real: Float32Array, imaginary: Float32Array): void {
  for (let index = 0; index < FFT_SIZE; index += 1) {
    const reversed = bitReversal[index]
    if (index >= reversed) continue
    const realValue = real[index]
    const imaginaryValue = imaginary[index]
    real[index] = real[reversed]
    imaginary[index] = imaginary[reversed]
    real[reversed] = realValue
    imaginary[reversed] = imaginaryValue
  }

  for (let length = 2; length <= FFT_SIZE; length <<= 1) {
    const half = length >> 1
    for (let offset = 0; offset < half; offset += 1) {
      const angle = (-2 * Math.PI * offset) / length
      const twiddleReal = f32(Math.cos(angle))
      const twiddleImaginary = f32(Math.sin(angle))
      for (let index = offset; index < FFT_SIZE; index += length) {
        const paired = index + half
        const tempReal = f32(f32(twiddleReal * real[paired]) - f32(twiddleImaginary * imaginary[paired]))
        const tempImaginary = f32(f32(twiddleReal * imaginary[paired]) + f32(twiddleImaginary * real[paired]))
        const currentReal = real[index]
        const currentImaginary = imaginary[index]
        real[paired] = f32(currentReal - tempReal)
        imaginary[paired] = f32(currentImaginary - tempImaginary)
        real[index] = f32(currentReal + tempReal)
        imaginary[index] = f32(currentImaginary + tempImaginary)
      }
    }
  }
}

function validateCmvn(cmvn: FireRedCmvn): void {
  if (!cmvn || cmvn.means?.length !== MEL_BINS || cmvn.inverseStd?.length !== MEL_BINS) {
    throw new TypeError('FireRed CMVN must contain 80 means and inverse standard deviations')
  }
  for (let index = 0; index < MEL_BINS; index += 1) {
    if (!Number.isFinite(cmvn.means[index]) || !Number.isFinite(cmvn.inverseStd[index]) || cmvn.inverseStd[index] <= 0) {
      throw new TypeError('FireRed CMVN values must be finite and inverse standard deviations must be positive')
    }
  }
}

/**
 * Extracts the upstream FireRedVAD 80-bin log-fbank input and per-frame
 * waveform summaries from normalized mono PCM at 16 kHz.
 */
export function extractFireRedFeatures(pcm: Float32Array, cmvn: FireRedCmvn): FireRedFeatures {
  if (!(pcm instanceof Float32Array)) throw new TypeError('FireRed audio must be a Float32Array')
  if (pcm.length > MAX_SAMPLES) throw new RangeError('FireRed audio cannot exceed 32 seconds')
  validateCmvn(cmvn)
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = pcm[index]
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
      throw new RangeError(`FireRed audio sample ${index} must be finite and within [-1, 1]`)
    }
  }

  const frames = pcm.length < FRAME_LENGTH ? 0 : 1 + Math.floor((pcm.length - FRAME_LENGTH) / FRAME_SHIFT)
  const data = new Float32Array(frames * MEL_BINS)
  const energy = new Float32Array(frames)
  const flux = new Float32Array(frames)
  const frame = new Float32Array(FRAME_LENGTH)
  const real = new Float32Array(FFT_SIZE)
  const imaginary = new Float32Array(FFT_SIZE)
  const power = new Float32Array(FFT_BINS)
  const logMel = new Float32Array(MEL_BINS)
  let previousLogMel: Float32Array | null = null

  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    const start = frameIndex * FRAME_SHIFT
    let sum = 0
    for (let index = 0; index < FRAME_LENGTH; index += 1) {
      const sample = f32(pcm[start + index] * 32768)
      frame[index] = sample
      sum = f32(sum + sample)
    }
    const mean = f32(sum / FRAME_LENGTH)
    let squareSum = 0
    for (let index = 0; index < FRAME_LENGTH; index += 1) {
      const centered = f32(frame[index] - mean)
      frame[index] = centered
      squareSum = f32(squareSum + f32(centered * centered))
    }
    energy[frameIndex] = f32(Math.sqrt(squareSum / FRAME_LENGTH) / 32768)

    // Kaldi's pre-emphasis loop runs backward so each difference uses the
    // original preceding sample; the first sample is scaled by (1 - 0.97).
    for (let index = FRAME_LENGTH - 1; index > 0; index -= 1) {
      frame[index] = f32(frame[index] - f32(PREEMPHASIS * frame[index - 1]))
    }
    frame[0] = f32(frame[0] - f32(PREEMPHASIS * frame[0]))

    real.fill(0)
    imaginary.fill(0)
    for (let index = 0; index < FRAME_LENGTH; index += 1) real[index] = f32(frame[index] * window[index])
    fft(real, imaginary)

    for (let index = 0; index < FFT_BINS; index += 1) {
      power[index] = f32(f32(real[index] * real[index]) + f32(imaginary[index] * imaginary[index]))
    }

    let fluxSum = 0
    for (let melIndex = 0; melIndex < MEL_BINS; melIndex += 1) {
      const filter = melFilters[melIndex]
      let melEnergy = 0
      for (let index = 0; index < filter.weights.length; index += 1) {
        melEnergy = f32(melEnergy + f32(filter.weights[index] * power[filter.firstBin + index]))
      }
      const rawLogMel = f32(Math.log(Math.max(melEnergy, LOG_FLOOR)))
      logMel[melIndex] = rawLogMel
      const outputIndex = frameIndex * MEL_BINS + melIndex
      data[outputIndex] = (rawLogMel - cmvn.means[melIndex]) * cmvn.inverseStd[melIndex]
      if (previousLogMel) fluxSum = f32(fluxSum + Math.max(0, f32(rawLogMel - previousLogMel[melIndex])))
    }
    if (previousLogMel) flux[frameIndex] = f32(fluxSum / MEL_BINS)
    previousLogMel = logMel.slice()
  }

  return { data, frames, energy, flux }
}

import { describe, expect, it } from 'vitest'
import { TARGET_RMS_DB, analyse, dbToLinear } from './loudness'

/**
 * `analyse` only ever reads these three members, so a plain object stands in
 * for an AudioBuffer and keeps the test out of the Web Audio API entirely.
 */
function buffer(channels: number[][]): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (index: number) => Float32Array.from(channels[index]),
  } as unknown as AudioBuffer
}

/** A flat signal at the given amplitude. */
function flat(amplitude: number, length = 4000): AudioBuffer {
  return buffer([new Array<number>(length).fill(amplitude)])
}

describe('analyse', () => {
  it('refuses to measure nothing', () => {
    expect(analyse(buffer([]))).toBeNull()
    expect(analyse(buffer([[]]))).toBeNull()
    expect(analyse(flat(0))).toBeNull()
  })

  it('reports the peak alongside the gain', () => {
    const result = analyse(flat(0.5))
    expect(result?.peakDb).toBeCloseTo(-6.0206, 3)
  })

  it('lifts a quiet track towards the reference level', () => {
    // rms -20 dB against a -18 dB target, so two dB of boost - and the peak is
    // nowhere near full scale, so nothing stops it
    expect(analyse(flat(0.1))?.gainDb).toBeCloseTo(2, 5)
  })

  it('pulls a loud track down', () => {
    expect(analyse(flat(0.5))?.gainDb).toBeCloseTo(TARGET_RMS_DB + 6.0206, 3)
  })

  it('stops the boost at the headroom, so the peak cannot be pushed past full scale', () => {
    // Mostly silence with one full-scale spike: the RMS asks for roughly +6 dB,
    // but the peak is already at 0 dBFS and may only go to -1
    const spiky = new Array<number>(1000).fill(0)
    spiky[0] = 1
    const result = analyse(buffer([spiky]))
    expect(result?.peakDb).toBeCloseTo(0, 5)
    expect(result?.gainDb).toBeCloseTo(-1, 5)
  })

  it('caps the boost at 12 dB however quiet the track is', () => {
    expect(analyse(flat(0.0005))?.gainDb).toBe(12)
  })

  it('caps the cut at 24 dB', () => {
    // only reachable for material decoded above full scale, which is exactly
    // what the floor is there for
    expect(analyse(flat(2))?.gainDb).toBe(-24)
  })

  it('mixes the channels together rather than trusting the first one', () => {
    // rms of 0.1 and 0.3 together is sqrt(0.05), which is quieter than the
    // 0.3 channel on its own - so this must not read as a single channel
    const stereo = analyse(buffer([new Array<number>(4000).fill(0.1), new Array<number>(4000).fill(0.3)]))
    expect(stereo?.gainDb).toBeCloseTo(-4.99, 2)
    expect(stereo?.peakDb).toBeCloseTo(-10.4576, 3)
  })
})

describe('dbToLinear', () => {
  it('is unity at zero', () => {
    expect(dbToLinear(0)).toBe(1)
  })

  it('doubles and halves six dB either side', () => {
    expect(dbToLinear(6.0206)).toBeCloseTo(2, 3)
    expect(dbToLinear(-6.0206)).toBeCloseTo(0.5, 3)
  })
})

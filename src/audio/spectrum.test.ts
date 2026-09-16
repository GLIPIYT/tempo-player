import { describe, expect, it } from 'vitest'
import { SPECTRUM_BINS, blendSpectrum, foldSpectrum } from './spectrum'

/** A 1024-sample analyser window, which is 512 linearly spaced bins. */
const BINS = 512
const RATE = 44100

function analyserFrame(values: Record<number, number> = {}): Uint8Array {
  const frame = new Uint8Array(BINS)
  for (const [index, value] of Object.entries(values)) frame[Number(index)] = value
  return frame
}

function folded(values: Record<number, number> = {}): Float32Array {
  const out = new Float32Array(SPECTRUM_BINS)
  foldSpectrum(analyserFrame(values), RATE, out)
  return out
}

describe('foldSpectrum', () => {
  it('sends a low tone left and a high tone right', () => {
    // ~86 Hz and ~20.7 kHz at 44.1 kHz
    expect(folded({ 2: 200 }).indexOf(200)).toBe(5)
    expect(folded({ 480: 200 }).indexOf(200)).toBe(63)
  })

  it('keeps the loudest value when several analyser bins fold into one slot', () => {
    expect(folded({ 470: 90, 480: 210 })[63]).toBe(210)
  })

  it('drops the low cut from the picture but still counts it as energy', () => {
    // bins 0 and 1 sit below 50 Hz, which is rumble and DC
    const out = folded({ 0: 200, 1: 200 })
    expect(out.every((value) => value === 0)).toBe(true)
    expect(foldSpectrum(analyserFrame({ 0: 200 }), RATE, new Float32Array(SPECTRUM_BINS))).toBe(200)
  })

  it('reports the loudest analyser bin as the peak', () => {
    const peak = foldSpectrum(analyserFrame({ 2: 90, 300: 240, 400: 30 }), RATE, new Float32Array(SPECTRUM_BINS))
    expect(peak).toBe(240)
  })

  it('overwrites the whole frame, so a quiet pass cannot inherit the last one', () => {
    const out = new Float32Array(SPECTRUM_BINS).fill(255)
    expect(foldSpectrum(analyserFrame(), RATE, out)).toBe(0)
    expect(out.every((value) => value === 0)).toBe(true)
  })

  it('follows the sample rate, because the bins are spaced by it', () => {
    // the same analyser bin is a different frequency at half the rate, and the
    // log scale has to land it in a different slot
    const atFullRate = new Float32Array(SPECTRUM_BINS)
    const atHalfRate = new Float32Array(SPECTRUM_BINS)
    foldSpectrum(analyserFrame({ 100: 200 }), 44100, atFullRate)
    foldSpectrum(analyserFrame({ 100: 200 }), 22050, atHalfRate)
    expect(atFullRate.indexOf(200)).toBe(46)
    expect(atHalfRate.indexOf(200)).toBe(44)
  })
})

describe('blendSpectrum', () => {
  it('log-compresses, so a quiet frame still shows up', () => {
    // a tenth of full scale compresses to roughly 0.279 before the blend
    const out = new Float32Array(SPECTRUM_BINS)
    const frame = new Float32Array(SPECTRUM_BINS)
    frame[0] = 25.5
    blendSpectrum(frame, out)
    expect(out[0]).toBeCloseTo(0.1254, 4)
  })

  it('carries inertia, so one silent frame does not empty the bar', () => {
    const out = new Float32Array(SPECTRUM_BINS)
    const loud = new Float32Array(SPECTRUM_BINS).fill(255)
    blendSpectrum(loud, out)
    expect(out[0]).toBeCloseTo(0.45, 4)
    blendSpectrum(new Float32Array(SPECTRUM_BINS), out)
    expect(out[0]).toBeCloseTo(0.2475, 4)
  })

  it('clamps anything at or above full scale', () => {
    const out = new Float32Array(SPECTRUM_BINS)
    const frame = new Float32Array(SPECTRUM_BINS)
    frame[0] = 300
    blendSpectrum(frame, out)
    expect(out[0]).toBeCloseTo(0.45, 4)
  })

  it('leaves the slots nobody played alone', () => {
    const out = new Float32Array(SPECTRUM_BINS)
    const frame = new Float32Array(SPECTRUM_BINS)
    frame[0] = 255
    blendSpectrum(frame, out)
    expect(out.slice(1).every((value) => value === 0)).toBe(true)
  })
})

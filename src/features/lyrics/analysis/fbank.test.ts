import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractFireRedFeatures, type FireRedCmvn } from './fbank'

const identityCmvn: FireRedCmvn = { means: Array(80).fill(0), inverseStd: Array(80).fill(1) }
const parityEnabled = process.env.FIRERED_FBANK_PARITY === '1'

describe('FireRed fbank', () => {
  it('uses 25 ms windows, 10 ms hops, and snips incomplete edge frames', () => {
    const pcm = new Float32Array(400 + 3 * 160 + 50)
    const result = extractFireRedFeatures(pcm, identityCmvn)

    expect(result.frames).toBe(4)
    expect(result.data).toHaveLength(4 * 80)
    expect(result.energy).toHaveLength(4)
    expect(result.flux).toHaveLength(4)
  })

  it('returns no frames for inputs shorter than one window', () => {
    const result = extractFireRedFeatures(new Float32Array(399), identityCmvn)
    expect(result).toEqual({ data: new Float32Array(), frames: 0, energy: new Float32Array(), flux: new Float32Array() })
  })

  it('floors silent mel energy and reports zero RMS and spectral flux', () => {
    const result = extractFireRedFeatures(new Float32Array(400), identityCmvn)
    expect(result.frames).toBe(1)
    expect(result.energy[0]).toBe(0)
    expect(result.flux[0]).toBe(0)
    expect([...result.data].every(Number.isFinite)).toBe(true)
    expect(result.data[0]).toBeCloseTo(Math.log(1.1920928955078125e-7), 4)
  })

  it('reports normalized RMS after DC removal and nonnegative log-mel flux', () => {
    const pcm = Float32Array.from({ length: 560 }, (_, index) => {
      const amplitude = index < 400 ? 0.2 : 0.4
      return 0.5 + amplitude * Math.sin((2 * Math.PI * 440 * index) / 16000)
    })
    const result = extractFireRedFeatures(pcm, identityCmvn)

    expect(result.frames).toBe(2)
    expect(result.energy[0]).toBeGreaterThan(0.1)
    expect(result.energy[0]).toBeLessThan(0.2)
    expect([...result.flux].every(value => Number.isFinite(value) && value >= 0)).toBe(true)
  })

  it('rejects non-finite, out-of-range, and overlong PCM', () => {
    const nonFinite = new Float32Array(400)
    nonFinite[23] = Number.NaN
    const outOfRange = new Float32Array(400)
    outOfRange[12] = 1.01

    expect(() => extractFireRedFeatures(nonFinite, identityCmvn)).toThrow(/finite/)
    expect(() => extractFireRedFeatures(outOfRange, identityCmvn)).toThrow(/\[-1, 1\]/)
    expect(() => extractFireRedFeatures(new Float32Array(512001), identityCmvn)).toThrow(/32 seconds/)
    expect(() => extractFireRedFeatures(new Float32Array(400), { means: [], inverseStd: [] })).toThrow(/80 means/)
  })

  it.skipIf(!parityEnabled)('matches the pinned Kaldi native fbank on repository audio references', async () => {
    const directory = resolve(process.cwd(), '.task-plans/firered-integration')
    const cmvn = JSON.parse(await readFile(resolve(directory, 'fbank-cmvn.json'), 'utf8')) as FireRedCmvn
    const references = JSON.parse(await readFile(resolve(directory, 'fbank-reference.json'), 'utf8')) as {
      label: string
      samples: number
      frames: number
      bins: number
      pcmFile: string
      featureFile: string
    }[]
    const summaries: { label: string; frames: number; maxAbs: number; meanAbs: number }[] = []

    for (const reference of references) {
      const pcmBuffer = await readFile(resolve(directory, reference.pcmFile))
      const expectedBuffer = await readFile(resolve(directory, reference.featureFile))
      const pcm = new Float32Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
      const expected = new Float32Array(expectedBuffer.buffer, expectedBuffer.byteOffset,
        expectedBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
      const actual = extractFireRedFeatures(pcm, cmvn)

      expect(actual.frames).toBe(reference.frames)
      expect(actual.data).toHaveLength(reference.frames * reference.bins)
      expect(expected).toHaveLength(actual.data.length)

      let maxAbs = 0
      let totalAbs = 0
      for (let index = 0; index < expected.length; index += 1) {
        const difference = Math.abs(actual.data[index] - expected[index])
        if (difference > maxAbs) maxAbs = difference
        totalAbs += difference
      }
      summaries.push({ label: reference.label, frames: actual.frames, maxAbs, meanAbs: totalAbs / expected.length })
      expect(maxAbs).toBeLessThan(0.001)
      expect(totalAbs / expected.length).toBeLessThan(0.000001)

      if (reference.label === 'local-opus-first-30s') {
        const chunkStartSample = 1 * 16000
        const chunkEndSample = 29 * 16000
        const coreStartFrame = 5 * 100
        const coreEndFrame = 25 * 100
        const chunkStartFrame = chunkStartSample / 160
        const chunked = extractFireRedFeatures(pcm.slice(chunkStartSample, chunkEndSample), cmvn)
        const fullStart = coreStartFrame * reference.bins
        const fullEnd = coreEndFrame * reference.bins
        const chunkStart = (coreStartFrame - chunkStartFrame) * reference.bins
        const chunkEnd = chunkStart + (coreEndFrame - coreStartFrame) * reference.bins

        expect(chunked.data.slice(chunkStart, chunkEnd)).toEqual(actual.data.slice(fullStart, fullEnd))
        expect(chunked.energy.slice(coreStartFrame - chunkStartFrame, coreEndFrame - chunkStartFrame))
          .toEqual(actual.energy.slice(coreStartFrame, coreEndFrame))
        expect(chunked.flux.slice(coreStartFrame - chunkStartFrame, coreEndFrame - chunkStartFrame))
          .toEqual(actual.flux.slice(coreStartFrame, coreEndFrame))
      }
    }

    console.info('FireRed fbank parity:', JSON.stringify(summaries))
  })
})

import { describe, expect, it } from 'vitest'
import {
  cachedWaveformRequest,
  fallbackWaveformHeights,
  resampleWaveform,
  soundCloudWaveformHeights,
} from './waveform'

describe('resampleWaveform', () => {
  it('preserves the strongest real peak in each display bucket', () => {
    expect(resampleWaveform([0, 0.25, 0.5, 0.75, 1], 3)).toEqual([0.25, 0.75, 1])
  })

  it('interpolates a smaller waveform across the full display width', () => {
    expect(resampleWaveform([0, 1], 3)).toEqual([0, 0.5, 1])
  })

  it('clamps malformed amplitudes and rejects empty data', () => {
    expect(resampleWaveform([-1, 1.5, Number.NaN], 3)).toEqual([0, 1, 0])
    expect(resampleWaveform([], 10)).toBeNull()
  })
})

describe('fallbackWaveformHeights', () => {
  it('keeps a stable fallback shape for non-SoundCloud and unavailable tracks', () => {
    const first = fallbackWaveformHeights('track-42', 40)

    expect(fallbackWaveformHeights('track-42', 40)).toEqual(first)
    expect(first).toHaveLength(40)
    expect(first.every((height) => height >= 18 && height <= 100)).toBe(true)
    expect(new Set(first).size).toBeGreaterThan(1)
  })
})

describe('soundCloudWaveformHeights', () => {
  it('shows a neutral flat shape until SoundCloud peaks are available', () => {
    expect(soundCloudWaveformHeights(null, 4)).toEqual([14, 14, 14, 14])
  })

  it('renders the returned SoundCloud peaks as bar heights', () => {
    expect(soundCloudWaveformHeights([0, 0.5, 1], 3)).toEqual([0, 50, 100])
  })
})

describe('cachedWaveformRequest', () => {
  it('removes a rejected request so a later attempt can retry', async () => {
    const cache = new Map<string, Promise<number[]>>()
    let attempts = 0
    const first = cachedWaveformRequest(cache, '42', () => {
      attempts++
      return Promise.reject(new Error('offline'))
    })

    await expect(first).rejects.toThrow('offline')
    expect(cache.has('42')).toBe(false)
    await expect(cachedWaveformRequest(cache, '42', () => {
      attempts++
      return Promise.resolve([0.25, 1])
    })).resolves.toEqual([0.25, 1])
    expect(attempts).toBe(2)
  })

  it('does not evict a newer request when an older retry fails', async () => {
    const cache = new Map<string, Promise<number[]>>()
    let rejectFirst!: (reason: Error) => void
    const first = cachedWaveformRequest(cache, '42', () => new Promise<number[]>((_, reject) => {
      rejectFirst = reject
    }))
    const newer = Promise.resolve([1])
    cache.set('42', newer)

    rejectFirst(new Error('offline'))
    await expect(first).rejects.toThrow('offline')

    expect(cache.get('42')).toBe(newer)
  })
})

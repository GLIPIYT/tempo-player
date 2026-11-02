import { describe, expect, it } from 'vitest'
import {
  cachedWaveformRequest,
  fallbackWaveformHeights,
  resampleWaveform,
  soundCloudWaveformHeights,
  waveformBarCountForWidth,
} from './waveform'

describe('waveformBarCountForWidth', () => {
  it('fits the 2px bars and 2px gaps without imposing an overflowing minimum', () => {
    expect(waveformBarCountForWidth(0)).toBe(0)
    expect(waveformBarCountForWidth(1)).toBe(0)
    expect(waveformBarCountForWidth(2)).toBe(1)
    expect(waveformBarCountForWidth(5)).toBe(1)
    expect(waveformBarCountForWidth(6)).toBe(2)
    expect(waveformBarCountForWidth(93)).toBe(23)
    expect(waveformBarCountForWidth(94)).toBe(24)
  })

  it('adds about 20 bars at the reference width and keeps growing in wide windows', () => {
    expect(waveformBarCountForWidth(358)).toBe(90)
    expect(waveformBarCountForWidth(438)).toBe(100)
    expect(waveformBarCountForWidth(800)).toBe(110)
    expect(waveformBarCountForWidth(1200)).toBe(120)
    expect(waveformBarCountForWidth(1600)).toBe(130)
    expect(waveformBarCountForWidth(3200)).toBe(170)
  })

  it('accounts for interface zoom when fitting bars to the visible width', () => {
    expect(waveformBarCountForWidth(400, 1)).toBe(100)
    expect(waveformBarCountForWidth(400, 2)).toBe(50)
    expect(waveformBarCountForWidth(800, 2)).toBe(100)
    expect(waveformBarCountForWidth(800, 1)).toBe(110)
    expect(waveformBarCountForWidth(1600, 2)).toBe(130)
    expect(waveformBarCountForWidth(400, Number.NaN)).toBe(100)
  })

  it.each([
    [0, 1],
    [93, 1],
    [400, 1],
    [800, 2],
    [1600, 2],
    [3200, 2],
  ])('never exceeds the available width for %ipx at %ix scale', (width, scale) => {
    const count = waveformBarCountForWidth(width, scale)
    const layoutWidth = width / scale
    const occupiedWidth = count * 2 + Math.max(0, count - 1) * 2

    expect(occupiedWidth).toBeLessThanOrEqual(layoutWidth)
  })
})

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
    const first = fallbackWaveformHeights('track-42', 110)

    expect(fallbackWaveformHeights('track-42', 110)).toEqual(first)
    expect(first).toHaveLength(110)
    expect(first.every((height) => height >= 18 && height <= 100)).toBe(true)
    expect(new Set(first).size).toBeGreaterThan(1)
  })
})

describe('soundCloudWaveformHeights', () => {
  it('shows a neutral flat shape until SoundCloud peaks are available', () => {
    expect(soundCloudWaveformHeights(null, 4)).toEqual([14, 14, 14, 14])
  })

  it('renders the returned SoundCloud peaks as bar heights', () => {
    expect(soundCloudWaveformHeights([0, 0.25, 0.5, 0.75, 1], 5)).toEqual([0, 21, 42, 63, 84])
  })

  it('keeps amplitude differences while leaving headroom above the strongest peak', () => {
    const heights = soundCloudWaveformHeights([0.6, 0.8, 1], 3)

    expect(heights).toEqual([50.4, 67.2, 84])
    expect(heights[0]).toBeLessThan(heights[1])
    expect(heights[1]).toBeLessThan(heights[2])
    expect(Math.max(...heights)).toBeLessThan(100)
  })
})

describe('cachedWaveformRequest', () => {
  it('reuses the same in-flight request for repeated observations of one track', async () => {
    const cache = new Map<string, Promise<number[]>>()
    let attempts = 0
    let resolveRequest!: (samples: number[]) => void
    const load = () => {
      attempts++
      return new Promise<number[]>((resolve) => {
        resolveRequest = resolve
      })
    }

    const first = cachedWaveformRequest(cache, '42', load)
    const repeated = cachedWaveformRequest(cache, '42', load)
    resolveRequest([0.25, 0.75])

    await expect(first).resolves.toEqual([0.25, 0.75])
    await expect(repeated).resolves.toEqual([0.25, 0.75])
    expect(attempts).toBe(1)
  })

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

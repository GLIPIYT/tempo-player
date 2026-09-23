import { describe, expect, it } from 'vitest'
import { EQUALIZER_PRESETS, normalizeEqualizer } from './equalizer'

describe('normalizeEqualizer', () => {
  it('preserves five-band settings and saved curves in the ten-band graph', () => {
    const result = normalizeEqualizer({
      enabled: true,
      preset: 'custom',
      bands: [-12, -6, 0, 6, 12],
      userPresets: [{ id: 'old', name: 'Old curve', bands: [6, 4, 2, 0, -3] }],
      selectedUserPresetId: 'old',
    })

    expect(result.enabled).toBe(true)
    expect(result.bands).toEqual([0, -12, 0, -6, 0, 0, 0, 6, 0, 12])
    expect(result.userPresets[0]?.bands).toEqual([0, 6, 0, 4, 0, 2, 0, 0, 0, -3])
    expect(result.selectedUserPresetId).toBe('old')
  })

  it('uses ten-band built-in presets and clamps custom gain to ±18 dB', () => {
    expect(normalizeEqualizer({ preset: 'bass' }).bands).toEqual(EQUALIZER_PRESETS.bass)
    expect(normalizeEqualizer({
      preset: 'custom',
      bands: [24, -24, 3, 0, 0, 0, 0, 0, 0, 0],
    }).bands).toEqual([18, -18, 3, 0, 0, 0, 0, 0, 0, 0])
  })
})

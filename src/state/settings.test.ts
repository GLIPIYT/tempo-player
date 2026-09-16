import { describe, expect, it } from 'vitest'
import { clampMiniShowMs, clampVisualizer, defaultSettings } from './settings'

describe('clampVisualizer', () => {
  it('falls back to the defaults for an empty block', () => {
    expect(clampVisualizer({})).toEqual(defaultSettings.visualizer)
  })

  it('rejects an unknown style rather than letting it reach the renderer', () => {
    expect(clampVisualizer({ style: 'squiggle' as never }).style).toBe(defaultSettings.visualizer.style)
    expect(clampVisualizer({ style: 'wave' }).style).toBe('wave')
    expect(clampVisualizer({ style: 'off' }).style).toBe('off')
  })

  it('holds every slider inside its range', () => {
    expect(clampVisualizer({ bars: 9999 }).bars).toBe(192)
    expect(clampVisualizer({ bars: 1 }).bars).toBe(8)
    expect(clampVisualizer({ heightPx: 9999 }).heightPx).toBe(160)
    expect(clampVisualizer({ heightPx: 0 }).heightPx).toBe(24)
    expect(clampVisualizer({ opacityPct: 999 }).opacityPct).toBe(100)
    expect(clampVisualizer({ opacityPct: 0 }).opacityPct).toBe(10)
    expect(clampVisualizer({ smoothing: 999 }).smoothing).toBe(100)
    expect(clampVisualizer({ smoothing: -5 }).smoothing).toBe(0)
  })

  it('rounds, and falls back for values that are not numbers at all', () => {
    expect(clampVisualizer({ bars: 55.6 }).bars).toBe(56)
    expect(clampVisualizer({ bars: Number.NaN }).bars).toBe(defaultSettings.visualizer.bars)
    expect(clampVisualizer({ bars: 'lots' as never }).bars).toBe(defaultSettings.visualizer.bars)
  })

  it('treats mirror as opt-in and the theme colour as opt-out', () => {
    expect(clampVisualizer({}).mirror).toBe(false)
    expect(clampVisualizer({ mirror: true }).mirror).toBe(true)
    expect(clampVisualizer({ mirror: 'yes' as never }).mirror).toBe(false)
    expect(clampVisualizer({}).useThemeColor).toBe(true)
    expect(clampVisualizer({ useThemeColor: false }).useThemeColor).toBe(false)
  })
})

describe('clampMiniShowMs', () => {
  it('holds the mini player peek between one and fifteen seconds', () => {
    expect(clampMiniShowMs(1)).toBe(1000)
    expect(clampMiniShowMs(999_999)).toBe(15000)
  })

  it('falls back for anything unusable', () => {
    expect(clampMiniShowMs(Number.NaN)).toBe(defaultSettings.miniPlayer.autoShowDurationMs)
  })
})

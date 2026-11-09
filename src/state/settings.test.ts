import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampMiniShowMs, clampVisualizer, defaultSettings, loadSettings } from './settings'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('persisted lyrics analysis preferences', () => {
  function loadLyrics(value: unknown) {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(value) })
    return loadSettings().lyrics
  }

  it('keeps cached-text search opt-in and preserves the capitalization choice', () => {
    expect(loadLyrics({ lyrics: {} }).searchCached).toBe(false)
    expect(loadLyrics({ lyrics: {} }).capitalizeLines).toBe(true)
    expect(loadLyrics({ lyrics: { searchCached: true, capitalizeLines: false } }).searchCached).toBe(true)
    expect(loadLyrics({ lyrics: { searchCached: true, capitalizeLines: false } }).capitalizeLines).toBe(false)
  })

  it('defaults to vocal timing and keeps Whisper opt-in for new and existing settings', () => {
    expect(defaultSettings.lyrics.vocalAnalysisEnabled).toBe(true)
    expect(defaultSettings.lyrics.whisperWordTimingsEnabled).toBe(false)
    expect(loadLyrics({ lyrics: { cacheOnline: false } }).vocalAnalysisEnabled).toBe(true)
    expect(loadLyrics({ lyrics: { cacheOnline: false } }).whisperWordTimingsEnabled).toBe(false)
    vi.stubGlobal('localStorage', { getItem: () => null })
    expect(loadSettings().lyrics.vocalAnalysisEnabled).toBe(true)
    expect(loadSettings().lyrics.whisperWordTimingsEnabled).toBe(false)
  })

  it.each([true, false])('preserves an explicit vocal timing preference of %s', value => {
    expect(loadLyrics({ lyrics: { vocalAnalysisEnabled: value } }).vocalAnalysisEnabled).toBe(value)
  })

  it.each([true, false])('preserves an explicit Whisper preference of %s', value => {
    expect(loadLyrics({ lyrics: { whisperWordTimingsEnabled: value } }).whisperWordTimingsEnabled).toBe(value)
  })

  it.each([null, 'true', 'false', 0, 1, {}, []])('uses defaults for invalid saved preferences %j', value => {
    const lyrics = loadLyrics({ lyrics: { vocalAnalysisEnabled: value, whisperWordTimingsEnabled: value } })
    expect(lyrics.vocalAnalysisEnabled).toBe(true)
    expect(lyrics.whisperWordTimingsEnabled).toBe(false)
  })

  it('ignores the legacy hardware-selected model setting without opting into Whisper', () => {
    const lyrics = loadLyrics({ lyrics: { deepAnalysisEnabled: true } })
    expect(lyrics.whisperWordTimingsEnabled).toBe(false)
    expect('deepAnalysisEnabled' in lyrics).toBe(false)
  })

  it('keeps an explicit Whisper opt-out when loading a legacy enabled preference', () => {
    expect(loadLyrics({ lyrics: { deepAnalysisEnabled: true, whisperWordTimingsEnabled: false } })
      .whisperWordTimingsEnabled).toBe(false)
  })
})

describe('player companion setting', () => {
  function loadPlayer(value: unknown) {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(value) })
    return loadSettings().player
  }

  it('defaults to off for existing settings without the preference', () => {
    expect(defaultSettings.player.companionEnabled).toBe(false)
    expect(loadPlayer({ player: { waveform: true } }).companionEnabled).toBe(false)
  })

  it.each([true, false])('preserves an explicit saved %s', value => {
    expect(loadPlayer({ player: { companionEnabled: value } }).companionEnabled).toBe(value)
  })

  it.each(['true', 1, null])('treats invalid saved %j as disabled', value => {
    expect(loadPlayer({ player: { companionEnabled: value } }).companionEnabled).toBe(false)
  })
})

describe('persisted waveform cache preference', () => {
  function loadPlayer(value: unknown) {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(value) })
    return loadSettings().player
  }

  it('keeps the disk cache opt-in for new and legacy settings', () => {
    expect(defaultSettings.player.cacheWaveforms).toBe(false)
    expect(loadPlayer({ player: { waveform: true } }).cacheWaveforms).toBe(false)
  })

  it('preserves only an explicit saved opt-in', () => {
    expect(loadPlayer({ player: { cacheWaveforms: true } }).cacheWaveforms).toBe(true)
    expect(loadPlayer({ player: { cacheWaveforms: 'true' } }).cacheWaveforms).toBe(false)
  })
})

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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampMiniShowMs, clampVisualizer, defaultSettings, loadSettings, resolveDeepAnalysisDefault } from './settings'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

afterEach(() => {
  vi.unstubAllGlobals()
  native.invoke.mockReset()
})

describe('persisted lyrics analysis choice', () => {
  function loadStored(value: unknown) {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(value) })
    return loadSettings().lyrics.deepAnalysisEnabled
  }

  it('leaves legacy settings and missing storage unresolved', () => {
    expect(loadStored({ lyrics: { cacheOnline: false } })).toBeNull()
    vi.stubGlobal('localStorage', { getItem: () => null })
    expect(loadSettings().lyrics.deepAnalysisEnabled).toBeNull()
  })

  it.each([true, false])('preserves an explicit saved %s', value => {
    expect(loadStored({ lyrics: { deepAnalysisEnabled: value } })).toBe(value)
  })

  it.each([null, 'true', 'false', 0, 1, {}, []])('leaves invalid saved %j unresolved', value => {
    expect(loadStored({ lyrics: { deepAnalysisEnabled: value } })).toBeNull()
  })

  it('keeps initially persisted null unresolved for the pending hardware probe', () => {
    expect(loadStored(defaultSettings)).toBeNull()
  })
})

describe('settings hardware default update', () => {
  async function pendingDefault(recommended: boolean) {
    vi.resetModules()
    let finish!: (value: unknown) => void
    const response = new Promise(resolve => { finish = resolve })
    native.invoke.mockReturnValue(response)
    const { initializeDeepAnalysisDefault } = await import('../features/lyrics/analysis/hardwareDefault')
    let current = defaultSettings
    const pending = initializeDeepAnalysisDefault(resolve => {
      current = resolveDeepAnalysisDefault(current, resolve)
    })
    return {
      get: () => current,
      set: (choice: boolean | null) => {
        current = { ...current, lang: 'en', lyrics: { ...current.lyrics, deepAnalysisEnabled: choice } }
      },
      complete: async () => {
        finish({ installedRamBytes: 17_179_869_184, physicalCores: 6, maxDedicatedVramBytes: 2_147_483_648, recommendedEnabled: recommended })
        await pending
      },
    }
  }

  it('resolves the actual settings updater after an asynchronous recommendation', async () => {
    const state = await pendingDefault(true)
    state.set(null)
    await state.complete()
    expect(state.get().lyrics.deepAnalysisEnabled).toBe(true)
    expect(state.get().lang).toBe('en')
    expect(defaultSettings.lyrics.deepAnalysisEnabled).toBeNull()
  })

  it.each([true, false])('preserves a manual %s through the actual updater after a late response', async manual => {
    const state = await pendingDefault(!manual)
    state.set(manual)
    const selected = state.get()
    await state.complete()
    expect(state.get().lyrics.deepAnalysisEnabled).toBe(manual)
    expect(state.get()).toBe(selected)
    expect(state.get().lang).toBe('en')
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

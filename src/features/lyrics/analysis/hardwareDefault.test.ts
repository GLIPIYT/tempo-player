import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

const capableProfile = {
  installedRamBytes: 17_179_869_184,
  physicalCores: 6,
  maxDedicatedVramBytes: 2_147_483_648,
  recommendedEnabled: true,
}

async function freshModule() {
  vi.resetModules()
  return await import('./hardwareDefault')
}

afterEach(() => native.invoke.mockReset())

describe('initial lyrics analysis choice', () => {
  it('uses the recommendation only for an unresolved choice', async () => {
    const { initializeDeepAnalysis } = await freshModule()
    expect(initializeDeepAnalysis(null, true)).toBe(true)
    expect(initializeDeepAnalysis(null, false)).toBe(false)
    expect(initializeDeepAnalysis(true, false)).toBe(true)
    expect(initializeDeepAnalysis(false, true)).toBe(false)
  })

  it('shares a single native probe across concurrent initializations', async () => {
    native.invoke.mockResolvedValue(capableProfile)
    const { initializeDeepAnalysisDefault } = await freshModule()
    let first: boolean | null = null
    let second: boolean | null = null
    await Promise.all([
      initializeDeepAnalysisDefault(resolve => { first = resolve(first) }),
      initializeDeepAnalysisDefault(resolve => { second = resolve(second) }),
    ])
    expect([first, second]).toEqual([true, true])
    expect(native.invoke.mock.calls).toEqual([['get_lyrics_analysis_hardware']])
  })

  it.each([true, false])('preserves a manual %s selected before a late probe response', async manual => {
    let finish!: (profile: typeof capableProfile) => void
    const response = new Promise(resolve => { finish = resolve })
    native.invoke.mockReturnValue(response)
    const { initializeDeepAnalysisDefault } = await freshModule()
    let current: boolean | null = null
    const pending = initializeDeepAnalysisDefault(resolve => { current = resolve(current) })
    current = manual
    finish({ ...capableProfile, recommendedEnabled: !manual })
    await pending
    expect(current).toBe(manual)
  })

  it('resolves unknown measurements to disabled', async () => {
    native.invoke.mockResolvedValue({
      installedRamBytes: null, physicalCores: null, maxDedicatedVramBytes: null, recommendedEnabled: false,
    })
    const { initializeDeepAnalysisDefault } = await freshModule()
    let current: boolean | null = null
    await initializeDeepAnalysisDefault(resolve => { current = resolve(current) })
    expect(current).toBe(false)
  })

  it('resolves a failed native probe to disabled and caches the failure', async () => {
    native.invoke.mockRejectedValue(new Error('native probe unavailable'))
    const { initializeDeepAnalysisDefault } = await freshModule()
    let current: boolean | null = null
    await initializeDeepAnalysisDefault(resolve => { current = resolve(current) })
    await initializeDeepAnalysisDefault(resolve => { current = resolve(current) })
    expect(current).toBe(false)
    expect(native.invoke).toHaveBeenCalledTimes(1)
  })
})

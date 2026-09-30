import { describe, expect, it } from 'vitest'
import { createLyricsAnalysisLifecycle } from './lyricsAnalysisLifecycle'
import type { ModelState } from '../../features/lyrics/analysis/contract'

const state = (enabled: boolean, phase: ModelState['phase'] = 'absent'): ModelState => ({ enabled, phase, loadedBytes: 0, totalBytes: 100, error: null })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve() }
function fixture() {
  const initial = deferred<ModelState>()
  const requests: { enabled: boolean; result: ReturnType<typeof deferred<ModelState>> }[] = []
  let running = false
  let event: (value: ModelState) => void = () => {}
  const lifecycle = createLyricsAnalysisLifecycle({
    runner: { setEnabled(enabled) { running = enabled } }, status: () => initial.promise,
    setEnabled: enabled => { const result = deferred<ModelState>(); requests.push({ enabled, result }); return result.promise },
    listen: async handler => { event = handler; return () => { event = () => {} } },
  })
  return { lifecycle, initial, requests, running: () => running, event: (value: ModelState) => event(value) }
}
describe('main analysis lifecycle', () => {
  it('requires native enable success, ignores late status and stops before deletion finishes', async () => {
    const f = fixture(); const stop = f.lifecycle.start()
    f.lifecycle.setSchedulingAllowed(true); f.lifecycle.setPreference(true); await flush()
    expect(f.running()).toBe(false)
    expect(f.requests).toHaveLength(1); f.requests[0].result.resolve(state(true, 'ready')); await flush()
    expect(f.running()).toBe(true)
    f.initial.resolve(state(false)); await flush()
    expect(f.lifecycle.getSnapshot().phase).toBe('ready')
    f.lifecycle.setPreference(false)
    expect(f.running()).toBe(false)
    await flush(); expect(f.requests.at(-1)?.enabled).toBe(false)
    stop()
  })
  it('never enables from a stale on response or enabled event after switching off', async () => {
    const f = fixture(); const stop = f.lifecycle.start()
    f.lifecycle.setSchedulingAllowed(true); f.lifecycle.setPreference(true); await flush()
    f.lifecycle.setPreference(false)
    expect(f.requests).toHaveLength(1); f.event(state(true, 'ready')); f.requests[0].result.resolve(state(true)); await flush()
    expect(f.running()).toBe(false)
    expect(f.requests.at(-1)?.enabled).toBe(false)
    stop()
  })
  it('does not overwrite a newer progress event with the initial GET', async () => {
    const f = fixture(); const stop = f.lifecycle.start(); await flush()
    f.event({ ...state(true, 'downloading'), loadedBytes: 50 })
    f.initial.resolve(state(false)); await flush()
    expect(f.lifecycle.getSnapshot().loadedBytes).toBe(50)
    expect(f.running()).toBe(false)
    stop()
  })
  it('keeps null disabled and all-explicit lyrics out of the inference scheduler', async () => {
    const f = fixture(); const stop = f.lifecycle.start()
    f.lifecycle.setPreference(null); await flush()
    expect(f.requests.every(request => !request.enabled)).toBe(true)
    if (f.requests[0]) { f.requests[0].result.resolve(state(false)); await flush() }
    f.lifecycle.setPreference(true); await flush()
    expect(f.requests.at(-1)?.enabled).toBe(true); f.requests.at(-1)!.result.resolve(state(true)); await flush()
    expect(f.running()).toBe(false)
    f.lifecycle.setSchedulingAllowed(true); expect(f.running()).toBe(true)
    f.lifecycle.setSchedulingAllowed(false); expect(f.running()).toBe(false)
    stop()
  })
})

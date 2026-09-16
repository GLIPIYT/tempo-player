import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'tempo.hiddenSections.v1'

let storage: Map<string, string>

function installStorage(): void {
  storage = new Map()
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  }
}

/**
 * A fresh module per test: the store parses storage once and keeps the result
 * at module scope, so otherwise state would leak from one test into the next.
 */
async function load(): Promise<typeof import('./hiddenSections')> {
  vi.resetModules()
  return await import('./hiddenSections')
}

beforeEach(() => {
  installStorage()
  // Only Date is faked. Comparing calendar days is the whole job here, and
  // faking the rest of the timer API would interfere with the dynamic imports.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('hidden sections', () => {
  it('hides a section for the rest of the day', async () => {
    vi.setSystemTime(new Date('2026-09-16T12:00:00'))
    const hidden = await load()
    hidden.hideSectionUntilTomorrow('recent')
    expect(hidden.isSectionHidden('recent')).toBe(true)
    expect(hidden.anySectionHidden()).toBe(true)
  })

  it('brings it back on its own the next day, with no timer involved', async () => {
    vi.setSystemTime(new Date('2026-09-16T23:59:00'))
    const hidden = await load()
    hidden.hideSectionUntilTomorrow('recent')
    expect(hidden.isSectionHidden('recent')).toBe(true)

    // same module, same stored entry - only the day moved on
    vi.setSystemTime(new Date('2026-09-17T00:01:00'))
    expect(hidden.isSectionHidden('recent')).toBe(false)
    expect(hidden.anySectionHidden()).toBe(false)
  })

  it('unhides one section without touching the others', async () => {
    vi.setSystemTime(new Date('2026-09-16T12:00:00'))
    const hidden = await load()
    hidden.hideSectionUntilTomorrow('recent')
    hidden.hideSectionUntilTomorrow('top')
    hidden.unhideSection('recent')
    expect(hidden.isSectionHidden('recent')).toBe(false)
    expect(hidden.isSectionHidden('top')).toBe(true)
  })

  it('clears only today when asked to unhide everything', async () => {
    vi.setSystemTime(new Date('2026-09-16T12:00:00'))
    storage.set(KEY, JSON.stringify({ recent: '2026-09-16', stale: '2026-09-15' }))
    const hidden = await load()
    hidden.unhideAllSections()
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ stale: '2026-09-15' })
  })

  it('survives storage that is missing or corrupt', async () => {
    storage.set(KEY, 'not json at all')
    const hidden = await load()
    expect(hidden.isSectionHidden('recent')).toBe(false)
    hidden.hideSectionUntilTomorrow('recent')
    expect(hidden.isSectionHidden('recent')).toBe(true)
  })

  it('tells subscribers about every change, and stops once they leave', async () => {
    vi.setSystemTime(new Date('2026-09-16T12:00:00'))
    const hidden = await load()
    let calls = 0
    const off = hidden.subscribeHiddenSections(() => {
      calls += 1
    })
    hidden.hideSectionUntilTomorrow('recent')
    expect(calls).toBe(1)
    hidden.unhideSection('recent')
    expect(calls).toBe(2)
    off()
    hidden.hideSectionUntilTomorrow('top')
    expect(calls).toBe(2)
  })
})

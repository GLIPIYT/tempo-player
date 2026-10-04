import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioEngine } from './engine'

function seekElement(engine: AudioEngine, element: HTMLAudioElement, target: number): Promise<boolean> {
  return (engine as unknown as { seekElement(el: HTMLAudioElement, time: number): Promise<boolean> })
    .seekElement(element, target)
}

function fakeAudioElement(initialTime: number, appliedTime: (target: number) => number): HTMLAudioElement {
  let currentTime = initialTime
  const listeners = new Map<string, EventListener>()
  return {
    get currentTime() { return currentTime },
    set currentTime(value: number) {
      currentTime = appliedTime(value)
      queueMicrotask(() => listeners.get('seeked')?.(new Event('seeked')))
    },
    addEventListener: ((name: string, listener: EventListener) => { listeners.set(name, listener) }) as HTMLAudioElement['addEventListener'],
    removeEventListener: ((name: string) => { listeners.delete(name) }) as HTMLAudioElement['removeEventListener'],
  } as unknown as HTMLAudioElement
}

describe('cached-file seek handoff', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects a seek event when the decoder stayed at the old position', async () => {
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    const engine = new AudioEngine()
    const element = fakeAudioElement(12.5, () => 12.5)

    await expect(seekElement(engine, element, 13)).resolves.toBe(false)
  })

  it('accepts a seek only when the decoder reached the requested position', async () => {
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    const engine = new AudioEngine()
    const element = fakeAudioElement(12.5, target => target)

    await expect(seekElement(engine, element, 13)).resolves.toBe(true)
  })
})

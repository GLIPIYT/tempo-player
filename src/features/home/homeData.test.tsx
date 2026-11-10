import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createHomeDataCache, homeDataCache, useHomeData } from './homeData'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

describe('Home data cache', () => {
  it('starts empty and stores results only after a successful load', async () => {
    const cache = createHomeDataCache()
    expect(cache.peek<string[]>('recent')).toBeUndefined()

    await expect(cache.load('recent', 2, async () => ['track'])).resolves.toEqual(['track'])
    expect(cache.peek<string[]>('recent')).toMatchObject({ version: 2, data: ['track'] })
  })

  it('deduplicates requests for the same key and library version', async () => {
    const cache = createHomeDataCache()
    const response = deferred<string[]>()
    const loader = vi.fn(() => response.promise)
    const first = cache.load('top', 3, loader)
    const second = cache.load('top', 3, loader)

    await Promise.resolve()
    expect(loader).toHaveBeenCalledOnce()
    response.resolve(['favorite'])
    await expect(Promise.all([first, second])).resolves.toEqual([['favorite'], ['favorite']])
  })

  it('keeps the newest version when an older request resolves later', async () => {
    const cache = createHomeDataCache()
    const oldResponse = deferred<string[]>()
    const newResponse = deferred<string[]>()
    const oldRequest = cache.load('hour-picks:2026-11-11-00', 4, () => oldResponse.promise)
    const newRequest = cache.load('hour-picks:2026-11-11-00', 5, () => newResponse.promise)

    newResponse.resolve(['current library'])
    await newRequest
    oldResponse.resolve(['outdated library'])
    await oldRequest

    expect(cache.peek<string[]>('hour-picks:2026-11-11-00')).toMatchObject({
      version: 5,
      data: ['current library'],
    })
  })

  it('bounds old query keys while retaining the most recent Home results', async () => {
    const cache = createHomeDataCache()
    for (let index = 0; index < 65; index += 1) {
      await cache.load(`hour-picks:2026-11-${index}`, 1, async () => [index])
    }

    expect(cache.peek<number[]>('hour-picks:2026-11-0')).toBeUndefined()
    expect(cache.peek<number[]>('hour-picks:2026-11-64')?.data).toEqual([64])
  })

  it('retains warm data when a refresh fails', async () => {
    const cache = createHomeDataCache()
    await cache.load('dormant', 6, async () => ['warm'])

    await expect(cache.load('dormant', 7, async () => { throw new Error('refresh failed') }))
      .rejects.toThrow('refresh failed')
    expect(cache.peek<string[]>('dormant')).toMatchObject({ version: 6, data: ['warm'] })
  })

  it('renders warm values immediately while the current version revalidates', async () => {
    const key = 'first-render-test'
    await homeDataCache.load(key, 10, async () => ['warm mix'])

    function Probe() {
      const result = useHomeData(key, () => new Promise<string[]>(() => undefined), 11)
      return createElement('output', null, `${result.loading}:${result.data?.[0] ?? ''}`)
    }

    expect(renderToStaticMarkup(createElement(Probe))).toBe('<output>true:warm mix</output>')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createTrackCacheProgressStore } from './trackCacheProgressStore'

describe('track cache progress store', () => {
  it('notifies only subscribers for the track whose progress changed', () => {
    const store = createTrackCacheProgressStore()
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const stopFirst = store.subscribe('101', firstListener)
    store.subscribe('202', secondListener)

    const firstProgress = {
      trackId: '101',
      downloadedBytes: 10,
      totalBytes: 100,
      progress: 0.1,
      state: 'running' as const,
      exiting: false,
    }
    store.set(firstProgress)

    expect(firstListener).toHaveBeenCalledOnce()
    expect(secondListener).not.toHaveBeenCalled()
    expect(store.get('101')).toBe(firstProgress)
    expect(store.getAll()).toEqual([firstProgress])

    stopFirst()
    store.set({ ...firstProgress, downloadedBytes: 30, progress: 0.3 })
    expect(firstListener).toHaveBeenCalledOnce()
  })

  it('notifies the track when its progress exits and is removed', () => {
    const store = createTrackCacheProgressStore()
    const listener = vi.fn()
    store.subscribe('303', listener)
    store.set({ trackId: '303', downloadedBytes: 0, totalBytes: 0, state: 'done', exiting: false })
    listener.mockClear()

    store.update('303', progress => ({ ...progress, exiting: true }))
    expect(listener).toHaveBeenCalledOnce()
    expect(store.get('303')?.exiting).toBe(true)

    store.remove('303')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.get('303')).toBeNull()
    expect(store.getAll()).toEqual([])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installUpdateWithPendingMarker,
  markPendingUpdate,
  takePendingUpdate,
} from './service'

const values = new Map<string, string>()

beforeEach(() => {
  values.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => { values.delete(key) },
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('installUpdateWithPendingMarker', () => {
  it('clears the rejected install marker without deleting a marker for another version', async () => {
    await expect(installUpdateWithPendingMarker('1.1.0', async () => {
      markPendingUpdate('1.1.1')
      throw new Error('installer launch failed')
    })).rejects.toThrow('installer launch failed')

    expect(takePendingUpdate()).toBe('1.1.1')
  })

  it('clears its marker when the install attempt rejects', async () => {
    await expect(installUpdateWithPendingMarker('1.1.0', async () => {
      throw new Error('installer launch failed')
    })).rejects.toThrow('installer launch failed')

    expect(takePendingUpdate()).toBeNull()
  })

  it('keeps the marker when the install command succeeds', async () => {
    await expect(installUpdateWithPendingMarker('1.1.0', async () => {})).resolves.toBeUndefined()

    expect(takePendingUpdate()).toBe('1.1.0')
  })
})

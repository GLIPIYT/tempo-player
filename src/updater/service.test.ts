import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  installUpdateWithPendingMarker,
  latestRelease,
  markPendingUpdate,
  takePendingUpdate,
} from './service'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

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

describe('latestRelease', () => {
  it('requests the latest-only command and returns its minimal version response', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ version: '1.3.3' } as never)

    await expect(latestRelease()).resolves.toEqual({ version: '1.3.3' })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('updater_latest')
  })
})

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

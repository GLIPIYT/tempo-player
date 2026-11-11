import { describe, expect, it, vi } from 'vitest'
import { disposeTensors } from './disposeTensors'

describe('disposeTensors', () => {
  it('disposes unique tensor-like values and ignores non-tensors', () => {
    const dispose = vi.fn()
    const tensor = { dispose }
    disposeTensors([tensor, tensor, null, 1, { data: [] }])
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('continues releasing outputs if one dispose call fails', () => {
    const first = { dispose: vi.fn(() => { throw new Error('already released') }) }
    const second = { dispose: vi.fn() }
    disposeTensors([first, second])
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
  })
})

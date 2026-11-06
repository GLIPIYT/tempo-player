import { describe, expect, it } from 'vitest'
import { shouldAutoPeekForTrackChange } from './autoShow'

describe('mini-player automatic peek', () => {
  it('peeks after natural completion when both existing settings allow it', () => {
    expect(shouldAutoPeekForTrackChange('natural-end', true, true)).toBe(true)
  })

  it.each(['manual', 'queue', 'repeat', 'restore'])('does not peek for %s track changes', reason => {
    expect(shouldAutoPeekForTrackChange(reason, true, true)).toBe(false)
  })

  it('honors the mini-player and auto-show settings', () => {
    expect(shouldAutoPeekForTrackChange('natural-end', false, true)).toBe(false)
    expect(shouldAutoPeekForTrackChange('natural-end', true, false)).toBe(false)
  })
})

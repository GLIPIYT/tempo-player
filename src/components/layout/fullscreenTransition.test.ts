import { describe, expect, it, vi } from 'vitest'
import { createFullscreenTransition } from './fullscreenTransition'

function windowMock(maximized: boolean) {
  return {
    isMaximized: vi.fn(async () => maximized),
    unmaximize: vi.fn(async () => {}),
    maximize: vi.fn(async () => {}),
    setFullscreen: vi.fn(async (_value: boolean) => {}),
  }
}

describe('fullscreen transition', () => {
  it('restores a maximized Windows window after fullscreen', async () => {
    const win = windowMock(true)
    const transition = createFullscreenTransition(win, true)
    await transition(true)
    await transition(false)
    expect(win.unmaximize).toHaveBeenCalledOnce()
    expect(win.setFullscreen.mock.calls).toEqual([[true], [false]])
    expect(win.unmaximize.mock.invocationCallOrder[0]).toBeLessThan(win.setFullscreen.mock.invocationCallOrder[0])
    expect(win.maximize.mock.invocationCallOrder[0]).toBeGreaterThan(win.setFullscreen.mock.invocationCallOrder[1])
  })

  it('leaves a normal window and non-Windows maximize state to the native fullscreen implementation', async () => {
    for (const [maximized, windows] of [[false, true], [true, false]]) {
      const win = windowMock(maximized)
      const transition = createFullscreenTransition(win, windows)
      await transition(true)
      await transition(false)
      expect(win.unmaximize).not.toHaveBeenCalled()
      expect(win.maximize).not.toHaveBeenCalled()
    }
  })

  it('restores maximize if entering fullscreen fails', async () => {
    const win = windowMock(true)
    win.setFullscreen.mockRejectedValueOnce(new Error('failed'))
    await expect(createFullscreenTransition(win, true)(true)).rejects.toThrow('failed')
    expect(win.maximize).toHaveBeenCalledOnce()
  })

  it('keeps the restoration pending if leaving fullscreen fails', async () => {
    const win = windowMock(true)
    const transition = createFullscreenTransition(win, true)
    await transition(true)
    win.setFullscreen.mockRejectedValueOnce(new Error('failed'))
    await expect(transition(false)).rejects.toThrow('failed')
    expect(win.maximize).not.toHaveBeenCalled()
    await transition(false)
    expect(win.maximize).toHaveBeenCalledOnce()
  })
})

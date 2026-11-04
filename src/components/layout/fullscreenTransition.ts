interface FullscreenWindow {
  isMaximized(): Promise<boolean>
  unmaximize(): Promise<void>
  maximize(): Promise<void>
  setFullscreen(fullscreen: boolean): Promise<void>
}

/** Work around Tao's Windows client-area clipping for maximized frameless windows. */
export function createFullscreenTransition(win: FullscreenWindow, windows: boolean) {
  let restoreMaximized = false
  return async (enter: boolean): Promise<void> => {
    if (enter) {
      const wasMaximized = windows && await win.isMaximized()
      if (wasMaximized) await win.unmaximize()
      try {
        await win.setFullscreen(true)
        restoreMaximized = wasMaximized
      } catch (error) {
        if (wasMaximized) await win.maximize()
        throw error
      }
    } else {
      await win.setFullscreen(false)
      if (restoreMaximized) {
        await win.maximize()
        restoreMaximized = false
      }
    }
  }
}

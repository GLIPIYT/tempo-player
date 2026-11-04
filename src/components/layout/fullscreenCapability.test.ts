import { describe, expect, it } from 'vitest'
import capability from '../../../src-tauri/capabilities/default.json'

describe('main window fullscreen capability', () => {
  it('allows the title bar to enter and exit fullscreen', () => {
    expect(capability.windows).toContain('main')
    expect(capability.permissions).toContain('core:window:allow-set-fullscreen')
    expect(capability.permissions).toContain('core:window:allow-unmaximize')
    expect(capability.permissions).toContain('core:window:allow-maximize')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, parseHex, toHex } from './engine'
import { CUSTOM_DEFAULT_BASE } from './presets'

describe('parseHex', () => {
  it('reads the six-digit form', () => {
    expect(parseHex('#6c8cff')).toEqual({ r: 108, g: 140, b: 255 })
  })

  it('expands the three-digit shorthand', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('#f0a')).toEqual({ r: 255, g: 0, b: 170 })
  })

  it('ignores case and surrounding whitespace', () => {
    expect(parseHex('  #6C8CFF ')).toEqual({ r: 108, g: 140, b: 255 })
  })

  it('rejects anything that is not a hex colour', () => {
    expect(parseHex('')).toBeNull()
    expect(parseHex('6c8cff')).toBeNull()
    expect(parseHex('#6c8cf')).toBeNull()
    expect(parseHex('#6c8cfff')).toBeNull()
    expect(parseHex('#gggggg')).toBeNull()
    expect(parseHex('rgb(1,2,3)')).toBeNull()
  })
})

describe('toHex', () => {
  it('pads every channel to two digits', () => {
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe('#000000')
    expect(toHex({ r: 1, g: 2, b: 3 })).toBe('#010203')
  })

  it('rounds and clamps, so a stray value cannot produce a broken colour', () => {
    expect(toHex({ r: 255.4, g: -10, b: 300 })).toBe('#ff00ff')
  })

  it('round-trips through parseHex', () => {
    expect(toHex(parseHex('#6c8cff')!)).toBe('#6c8cff')
  })
})

function mockThemeDocument() {
  const properties = new Map<string, string>()
  const classes = new Set<string>()
  const attributes = new Set<string>()
  const root = {
    dataset: {} as DOMStringMap,
    style: {
      colorScheme: '',
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
    classList: {
      contains: (name: string) => classes.has(name),
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
    },
    toggleAttribute: (name: string, enabled: boolean) => enabled ? attributes.add(name) : attributes.delete(name),
    removeAttribute: (name: string) => attributes.delete(name),
  }
  vi.stubGlobal('document', { documentElement: root })
  return { root, properties }
}

describe('applyTheme mode', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the Tempo palette for missing presets', () => {
    const { root, properties } = mockThemeDocument()

    applyTheme({ kind: 'preset', presetId: 'old-preset' })

    expect(root.dataset.themeMode).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')
    expect(properties.get('--bg')).toBe(CUSTOM_DEFAULT_BASE.background)
  })

  it.each([
    ['neon', 'dark'],
    ['aurora-gradient', 'dark'],
    ['tempo-light', 'light'],
    ['linen-light', 'light'],
    ['sage-light', 'light'],
    ['lilac-light', 'light'],
  ])('uses the background for preset %s', (presetId, mode) => {
    const { root } = mockThemeDocument()

    applyTheme({ kind: 'preset', presetId })

    expect(root.dataset.themeMode).toBe(mode)
  })

  it('uses the effective solid backdrop and keeps the saved palette intact', () => {
    const { root, properties } = mockThemeDocument()
    const base = { ...CUSTOM_DEFAULT_BASE, accent: '#fff' }

    applyTheme({ kind: 'custom', custom: { base, overrides: {} } })
    expect(root.dataset.themeMode).toBe('dark')

    applyTheme({ kind: 'custom', custom: { base, overrides: { bg: '#fcf8ee' } } })
    expect(root.dataset.themeMode).toBe('light')
    expect(root.style.colorScheme).toBe('light')
    expect(properties.get('--bg')).toBe('#fcf8ee')
    expect(properties.get('--t-base-bg')).toBe(base.background)
    expect(properties.get('--t-text')).toBe('#182231')

    applyTheme(undefined)
    expect(root.dataset.themeMode).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')
    expect(properties.has('--t-text')).toBe(false)
  })

  it.each([
    ['#fef2df', '#ffdbec', 'light'],
    ['#141b26', '#30213c', 'dark'],
    ['#000', '#bbb', 'dark'],
  ])('uses both custom gradient stops for %s / %s', (first, second, expectedMode) => {
    const { root } = mockThemeDocument()

    applyTheme({
      kind: 'custom',
      custom: {
        base: { ...CUSTOM_DEFAULT_BASE },
        overrides: {},
        gradientAnchors: { first, second },
      },
    })

    expect(root.dataset.themeMode).toBe(expectedMode)
    expect(root.style.colorScheme).toBe(expectedMode)
  })
})

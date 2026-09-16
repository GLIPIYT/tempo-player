import { describe, expect, it } from 'vitest'
import { parseHex, toHex } from './engine'

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

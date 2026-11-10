import { describe, expect, it } from 'vitest'
import { contrastBackgroundColor } from './backgroundContrast'

describe('background spectrum contrast', () => {
  it('darkens white without introducing a blue tint', () => {
    const color = contrastBackgroundColor({ r: 255, g: 255, b: 255 })
    expect(color.r).toBe(color.g)
    expect(color.g).toBe(color.b)
    expect(color.r).toBeLessThan(255)
  })
  it('lightens neutral dark backgrounds without changing hue', () => {
    const color = contrastBackgroundColor({ r: 15, g: 15, b: 15 })
    expect(color.r).toBeGreaterThan(15)
    expect(color.r).toBe(color.g)
    expect(color.g).toBe(color.b)
  })
  it('retains the dominant channel for a colored backdrop', () => {
    const color = contrastBackgroundColor({ r: 90, g: 18, b: 28 })
    expect(color.r).toBeGreaterThan(color.b)
    expect(color.b).toBeGreaterThan(color.g)
  })
})

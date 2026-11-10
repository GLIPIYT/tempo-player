import { describe, expect, it } from 'vitest'
import { sidebarMarkerLayout } from './sidebarMarker'

describe('sidebarMarkerLayout', () => {
  it('places the marker within a main navigation row', () => {
    expect(sidebarMarkerLayout({ left: 10, top: 14, height: 34 })).toEqual({
      x: 10,
      y: 20,
      height: 22,
    })
  })

  it.each([
    { row: 'profile', scalePct: 100, top: 568 },
    { row: 'profile', scalePct: 125, top: 568 },
    { row: 'settings', scalePct: 100, top: 606 },
    { row: 'settings', scalePct: 125, top: 606 },
  ])('keeps the $row footer marker in local layout coordinates at $scalePct% scale', ({ top }) => {
    expect(sidebarMarkerLayout({ left: 10, top, height: 34 })).toEqual({
      x: 10,
      y: top + 6,
      height: 22,
    })
  })

  it.each([
    { state: 'expanded at full height', top: 606 },
    { state: 'collapsed after a shorter resize', top: 446 },
  ])('tracks the settings row after the sidebar is $state', ({ top }) => {
    expect(sidebarMarkerLayout({ left: 10, top, height: 34 })).toEqual({
      x: 10,
      y: top + 6,
      height: 22,
    })
  })

  it('keeps a short row inside its bounds', () => {
    expect(sidebarMarkerLayout({ left: 10, top: 40, height: 10 })).toEqual({
      x: 10,
      y: 46,
      height: 0,
    })
  })
})

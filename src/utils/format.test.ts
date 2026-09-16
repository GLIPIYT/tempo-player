import { describe, expect, it } from 'vitest'
import { fmtTime } from './format'

describe('fmtTime', () => {
  it('pads the seconds and drops the hour below an hour', () => {
    expect(fmtTime(0)).toBe('0:00')
    expect(fmtTime(5)).toBe('0:05')
    expect(fmtTime(59)).toBe('0:59')
    expect(fmtTime(60)).toBe('1:00')
    expect(fmtTime(3599)).toBe('59:59')
  })

  it('adds an hours field once there is one', () => {
    expect(fmtTime(3600)).toBe('1:00:00')
    expect(fmtTime(3725)).toBe('1:02:05')
    expect(fmtTime(7322)).toBe('2:02:02')
  })

  it('truncates rather than rounds, so the clock never runs ahead of the track', () => {
    expect(fmtTime(59.9)).toBe('0:59')
    expect(fmtTime(3599.99)).toBe('59:59')
  })

  it('falls back for anything that is not a usable duration', () => {
    expect(fmtTime(null)).toBe('--:--')
    expect(fmtTime(undefined)).toBe('--:--')
    expect(fmtTime(Number.NaN)).toBe('--:--')
    expect(fmtTime(Number.POSITIVE_INFINITY)).toBe('--:--')
    expect(fmtTime(-1)).toBe('--:--')
  })
})

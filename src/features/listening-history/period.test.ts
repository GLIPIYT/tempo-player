import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareMetric, historyDateLabel, hourlyLine, interpolateAnimatedValue, listeningPeriod, previousListeningSelection, smoothHourlyLine } from './period'

afterEach(() => vi.unstubAllEnvs())
describe('listening calendar periods', () => {
  it('includes every local day of a leap month with an exclusive next-month edge', () => {
    vi.stubEnv('TZ', 'Asia/Yekaterinburg')
    const result = listeningPeriod({ kind: 'month', date: '2024-02-16' })
    expect(result.boundaries).toHaveLength(30)
    expect(new Date(result.to * 1000).getMonth()).toBe(2)
    expect(new Date(result.to * 1000).getDate()).toBe(1)
    expect(() => listeningPeriod({ kind: 'day', date: '2026-02-30' })).toThrow('Invalid listening date')
  })
  it('retains real hourly boundaries on both daylight-saving transitions', () => {
    vi.stubEnv('TZ', 'America/New_York')
    expect(listeningPeriod({ kind: 'day', date: '2026-03-08' }).boundaries).toHaveLength(24)
    expect(listeningPeriod({ kind: 'day', date: '2026-11-01' }).boundaries).toHaveLength(26)
  })
  it('creates twelve five-minute buckets for a specific hour, including repeated DST hours', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const repeatedHour = Math.floor(new Date('2026-11-01T01:00:00-05:00').getTime() / 1000)
    const selection = { kind: 'hour' as const, date: '2026-11-01', hourFrom: repeatedHour }
    const period = listeningPeriod(selection)
    expect(period.boundaries).toHaveLength(13)
    expect(period.boundaries.slice(1).map((edge, index) => edge - period.boundaries[index])).toEqual(Array(12).fill(300))
    expect(previousListeningSelection(selection)).toEqual({ kind: 'hour', date: '2026-11-01', hourFrom: repeatedHour - 3600 })
    expect(() => listeningPeriod({ ...selection, hourFrom: repeatedHour + 60 })).toThrow('Invalid listening hour')
  })
  it('selects the preceding local calendar period without overflowing month ends', () => {
    vi.stubEnv('TZ', 'Asia/Yekaterinburg')
    expect(previousListeningSelection({ kind: 'month', date: '2026-01-31' })).toEqual({ kind: 'month', date: '2025-12-01' })
    expect(previousListeningSelection({ kind: 'day', date: '2026-01-01' })).toEqual({ kind: 'day', date: '2025-12-31' })
  })
  it('formats weekday labels and preserves silent hours in the line chart', () => {
    vi.stubEnv('TZ', 'Asia/Yekaterinburg')
    const time = new Date('2026-11-08T00:00:00').getTime() / 1000
    expect(historyDateLabel(time, 'ru', 'day')).toContain('вс.')
    const line = hourlyLine([0, 3600, 0])
    expect(line.points).toHaveLength(3)
    expect(line.points[0].y).toBe(160)
    expect(line.points[1].y).toBe(16)
    expect(line.path.split('L')).toHaveLength(3)
    expect(hourlyLine([]).path).toBe('')
    expect(smoothHourlyLine([0, 3600, 0]).path).toContain('C')
    expect(smoothHourlyLine([]).area).toBe('')
  })
  it('reports a delta without inventing a percentage for a zero baseline', () => {
    expect(compareMetric(12, 0)).toEqual({ current: 12, previous: 0, delta: 12, percentChange: null, isNew: true })
    expect(compareMetric(0, 0)).toEqual({ current: 0, previous: 0, delta: 0, percentChange: null, isNew: false })
    expect(compareMetric(75, 100)).toEqual({ current: 75, previous: 100, delta: -25, percentChange: -25, isNew: false })
  })
  it('clamps smooth numeric animation progress to the target range', () => {
    expect(interpolateAnimatedValue(0, 100, 0)).toBe(0)
    expect(interpolateAnimatedValue(0, 100, 1)).toBe(100)
    expect(interpolateAnimatedValue(0, 100, -1)).toBe(0)
    expect(interpolateAnimatedValue(0, 100, 2)).toBe(100)
  })
})

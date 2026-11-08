import { afterEach, describe, expect, it, vi } from 'vitest'
import { historyDateLabel, hourlyLine, listeningPeriod } from './period'

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
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareMetric, historyDateLabel, hourlyLine, interpolateAnimatedValue, listeningComparisonPeriod, listeningPeriod, previousListeningSelection, smoothHourlyLine } from './period'

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
  it('maps the last active timestamp to the requested calendar granularity', () => {
    vi.stubEnv('TZ', 'Asia/Yekaterinburg')
    const activity = new Date('2026-10-14T18:42:00').getTime() / 1000
    const month = listeningComparisonPeriod(activity, 'month')
    const day = listeningComparisonPeriod(activity, 'day')
    const hour = listeningComparisonPeriod(activity, 'hour')
    const fiveMinutes = listeningComparisonPeriod(activity, 'fiveMinutes')
    expect(month.from).toBe(new Date('2026-10-01T00:00:00').getTime() / 1000)
    expect(day.from).toBe(new Date('2026-10-14T00:00:00').getTime() / 1000)
    expect(hour.from).toBe(new Date('2026-10-14T18:00:00').getTime() / 1000)
    expect(fiveMinutes.from).toBe(new Date('2026-10-14T18:40:00').getTime() / 1000)
    expect(fiveMinutes.boundaries).toEqual([fiveMinutes.from, fiveMinutes.from + 300])
    expect(() => listeningComparisonPeriod(-1, 'day')).toThrow('Invalid listening timestamp')
  })
  it('skips empty calendar months and anchors a zero month to the last active month', () => {
    vi.stubEnv('TZ', 'Asia/Yekaterinburg')
    const emptySelectedMonth = listeningPeriod({ kind: 'month', date: '2026-03-01' })
    const lastActivity = new Date('2026-01-14T18:42:00').getTime() / 1000
    const baseline = listeningComparisonPeriod(lastActivity, 'month')
    expect(emptySelectedMonth.from).toBe(new Date('2026-03-01T00:00:00').getTime() / 1000)
    expect(baseline.from).toBe(new Date('2026-01-01T00:00:00').getTime() / 1000)
    expect(baseline.from).not.toBe(new Date('2026-02-01T00:00:00').getTime() / 1000)
  })
  it('uses the actual hovered day or hour for drilldown comparisons', () => {
    vi.stubEnv('TZ', 'Asia/Yekaterinburg')
    const activeDayBefore = new Date('2026-11-04T20:42:00').getTime() / 1000
    const selectedDate = '2026-11-05'
    const selectedDay = listeningPeriod({ kind: 'day', date: selectedDate })
    const month = listeningPeriod({ kind: 'month', date: selectedDate })
    const hoveredDay = month.boundaries.find(edge => new Date(edge * 1000).getDate() === 5)!
    expect(hoveredDay).toBe(selectedDay.from)
    const hoveredDayBaseline = listeningComparisonPeriod(activeDayBefore, 'day')
    const openedDayBaseline = listeningComparisonPeriod(activeDayBefore, 'day')
    expect(hoveredDayBaseline.boundaries).toEqual(openedDayBaseline.boundaries)

    const selectedHour = selectedDay.boundaries[18]
    const activeHourBefore = new Date('2026-11-05T16:28:00').getTime() / 1000
    const hoveredHourBaseline = listeningComparisonPeriod(activeHourBefore, 'hour')
    const openedHourBaseline = listeningComparisonPeriod(activeHourBefore, 'hour')
    expect(selectedHour).toBe(new Date('2026-11-05T18:00:00').getTime() / 1000)
    expect(hoveredHourBaseline.boundaries).toEqual(openedHourBaseline.boundaries)
    expect(hoveredHourBaseline.from).toBe(new Date('2026-11-05T16:00:00').getTime() / 1000)
  })
  it('keeps a repeated daylight-saving hour and its five-minute buckets distinct', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const firstHourActivity = new Date('2026-11-01T01:22:00-04:00').getTime() / 1000
    const secondHourActivity = new Date('2026-11-01T01:22:00-05:00').getTime() / 1000
    const firstHour = listeningComparisonPeriod(firstHourActivity, 'hour')
    const secondHour = listeningComparisonPeriod(secondHourActivity, 'hour')
    expect(secondHour.from - firstHour.from).toBe(3600)
    expect(listeningComparisonPeriod(firstHourActivity, 'fiveMinutes').from).toBe(firstHour.from + 1200)
    expect(listeningComparisonPeriod(secondHourActivity, 'fiveMinutes').from).toBe(secondHour.from + 1200)
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
    expect(compareMetric(12, 0)).toEqual({ current: 12, previous: 0, delta: 12, percentChange: null })
    expect(compareMetric(0, 0)).toEqual({ current: 0, previous: 0, delta: 0, percentChange: 0 })
    expect(compareMetric(75, 100)).toEqual({ current: 75, previous: 100, delta: -25, percentChange: -25 })
  })
  it('clamps smooth numeric animation progress to the target range', () => {
    expect(interpolateAnimatedValue(0, 100, 0)).toBe(0)
    expect(interpolateAnimatedValue(0, 100, 1)).toBe(100)
    expect(interpolateAnimatedValue(0, 100, -1)).toBe(0)
    expect(interpolateAnimatedValue(0, 100, 2)).toBe(100)
  })
})

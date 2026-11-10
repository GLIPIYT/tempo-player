export type ListeningSelection =
  | { kind: 'month' | 'day'; date: string }
  | { kind: 'hour'; date: string; hourFrom: number }

export interface MetricComparison {
  current: number
  previous: number
  delta: number
  /** Null when the previous value is zero, so a percentage is not fabricated. */
  percentChange: number | null
  /** True only when a positive current value has no previous-period baseline. */
  isNew: boolean
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseLocalDate(dateKey: string): Date {
  const date = new Date(`${dateKey}T00:00:00`)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateKey) || !Number.isFinite(date.getTime()) || localDateKey(date) !== dateKey) {
    throw new Error('Invalid listening date')
  }
  return date
}

/** Local calendar boundaries, not fixed 24-hour approximations across DST. */
export function listeningPeriod(selection: ListeningSelection) {
  const date = parseLocalDate(selection.date)
  const boundaries: number[] = []
  if (selection.kind === 'hour') {
    if (!Number.isSafeInteger(selection.hourFrom)) throw new Error('Invalid listening hour')
    const hourStart = new Date(selection.hourFrom * 1000)
    if (localDateKey(hourStart) !== selection.date || hourStart.getMinutes() !== 0 || hourStart.getSeconds() !== 0 || hourStart.getMilliseconds() !== 0) {
      throw new Error('Invalid listening hour')
    }
    for (let index = 0; index <= 12; index++) boundaries.push(selection.hourFrom + index * 300)
  } else if (selection.kind === 'month') {
    const month = date.getMonth()
    const cursor = new Date(date.getFullYear(), month, 1)
    while (cursor.getMonth() === month) {
      boundaries.push(cursor.getTime() / 1000)
      cursor.setDate(cursor.getDate() + 1)
    }
    boundaries.push(cursor.getTime() / 1000)
  } else {
    const end = new Date(date)
    end.setDate(end.getDate() + 1)
    for (let time = date.getTime(); time < end.getTime(); time += 3600_000) boundaries.push(time / 1000)
    boundaries.push(end.getTime() / 1000)
  }
  return { boundaries, from: boundaries[0], to: boundaries[boundaries.length - 1] }
}

/** Returns the equivalent preceding calendar period, or the previous chronological hour. */
export function previousListeningSelection(selection: ListeningSelection): ListeningSelection {
  listeningPeriod(selection) // Validate the selection before deriving a comparison range.
  if (selection.kind === 'hour') {
    const previousHour = new Date((selection.hourFrom - 3600) * 1000)
    return { kind: 'hour', date: localDateKey(previousHour), hourFrom: selection.hourFrom - 3600 }
  }

  const date = parseLocalDate(selection.date)
  if (selection.kind === 'month') {
    date.setDate(1)
    date.setMonth(date.getMonth() - 1)
    return { kind: 'month', date: localDateKey(date) }
  }
  date.setDate(date.getDate() - 1)
  return { kind: 'day', date: localDateKey(date) }
}

export function compareMetric(current: number, previous: number): MetricComparison {
  const delta = current - previous
  return {
    current,
    previous,
    delta,
    percentChange: previous === 0 ? null : delta / Math.abs(previous) * 100,
    isNew: previous === 0 && current > 0,
  }
}

export function historyDateLabel(time: number, lang: 'ru' | 'en', kind: 'month' | 'day'): string {
  const date = new Date(time * 1000)
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US'
  if (kind === 'month') return date.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
  const weekday = date.toLocaleDateString(locale, { weekday: 'short' })
  return `${date.toLocaleDateString(locale, { day: 'numeric', month: 'long' })}, ${lang === 'ru' && !weekday.endsWith('.') ? `${weekday}.` : weekday}`
}

export function historyHours(seconds: number, lang: 'ru' | 'en'): string {
  return (Math.max(0, seconds) / 3600).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 2 })
}

/** Ease-out interpolation shared by the count-up display and comparison values. */
export function interpolateAnimatedValue(from: number, to: number, progress: number): number {
  const normalized = Math.max(0, Math.min(1, progress))
  const eased = 1 - (1 - normalized) ** 3
  return from + (to - from) * eased
}

/** A linear hourly series; empty buckets stay on zero instead of disappearing. */
export function hourlyLine(values: readonly number[], width = 680, height = 160) {
  const max = Math.max(60, ...values)
  const points = values.map((value, index) => ({
    x: ((index + 0.5) / Math.max(1, values.length)) * width,
    y: height - Math.max(0, value) / max * (height - 16),
  }))
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
  return { points, path, area: points.length ? `${path} L${points[points.length - 1].x.toFixed(2)},${height} L${points[0].x.toFixed(2)},${height} Z` : '', max }
}

/** A Catmull–Rom smoothed hourly series; data points remain available for markers. */
export function smoothHourlyLine(values: readonly number[], width = 680, height = 160) {
  const line = hourlyLine(values, width, height)
  if (line.points.length < 3) return line
  const { points } = line
  const segments: string[] = [`M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`]
  for (let index = 0; index < points.length - 1; index++) {
    const previous = points[Math.max(0, index - 1)]
    const start = points[index]
    const end = points[index + 1]
    const next = points[Math.min(points.length - 1, index + 2)]
    const c1x = start.x + (end.x - previous.x) / 6
    const c1y = start.y + (end.y - previous.y) / 6
    const c2x = end.x - (next.x - start.x) / 6
    const c2y = end.y - (next.y - start.y) / 6
    segments.push(`C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${end.x.toFixed(2)},${end.y.toFixed(2)}`)
  }
  const path = segments.join(' ')
  return { ...line, path, area: `${path} L${points[points.length - 1].x.toFixed(2)},${height} L${points[0].x.toFixed(2)},${height} Z` }
}

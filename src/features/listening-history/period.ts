export interface ListeningSelection { kind: 'month' | 'day'; date: string }

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Local calendar boundaries, not fixed 24-hour approximations across DST. */
export function listeningPeriod(selection: ListeningSelection) {
  const date = new Date(`${selection.date}T00:00:00`)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(selection.date) || !Number.isFinite(date.getTime()) || localDateKey(date) !== selection.date) {
    throw new Error('Invalid listening date')
  }
  const boundaries: number[] = []
  if (selection.kind === 'month') {
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

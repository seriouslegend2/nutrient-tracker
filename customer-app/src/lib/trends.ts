import { localDateISO } from '@/lib/date'

export type TrendRange = '7d' | '4w' | '3m' | '1y'
export type ReportGrouping = 'day' | 'week' | 'month'

export const TREND_RANGES: { value: TrendRange; label: string; days: number; grouping: ReportGrouping }[] = [
  { value: '7d', label: '7 days', days: 7, grouping: 'day' },
  { value: '4w', label: '4 weeks', days: 28, grouping: 'day' },
  { value: '3m', label: '3 months', days: 90, grouping: 'week' },
  { value: '1y', label: '1 year', days: 365, grouping: 'month' },
]

export function reportWindow(range: TrendRange, now = new Date()) {
  const config = TREND_RANGES.find((item) => item.value === range)!
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  start.setDate(start.getDate() - config.days + 1)
  const previousEnd = new Date(start)
  previousEnd.setDate(previousEnd.getDate() - 1)
  const previousStart = new Date(previousEnd)
  previousStart.setDate(previousStart.getDate() - config.days + 1)
  return {
    dateFrom: localDateISO(start), dateTo: localDateISO(now),
    previousDateFrom: localDateISO(previousStart), previousDateTo: localDateISO(previousEnd),
    ...config,
  }
}

export function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

export function periodChange(values: number[]): number | null {
  if (values.length < 6) return null
  const midpoint = Math.floor(values.length / 2)
  const earlier = average(values.slice(0, midpoint))
  const recent = average(values.slice(midpoint))
  if (earlier == null || recent == null || earlier === 0) return null
  return ((recent - earlier) / earlier) * 100
}

export function bucketForDate(value: string, grouping: ReportGrouping): string {
  const date = new Date(`${value}T12:00:00`)
  if (grouping === 'week') {
    const mondayOffset = (date.getDay() + 6) % 7
    date.setDate(date.getDate() - mondayOffset)
  } else if (grouping === 'month') {
    date.setDate(1)
  }
  return localDateISO(date)
}

export function aggregateDatedValues(
  items: { date: string; value: number }[],
  grouping: ReportGrouping
): { bucket: string; value: number }[] {
  const totals = new Map<string, number>()
  for (const item of items) {
    const bucket = bucketForDate(item.date, grouping)
    totals.set(bucket, (totals.get(bucket) ?? 0) + item.value)
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, value]) => ({ bucket, value }))
}

export function expectedBuckets(dateFrom: string, dateTo: string, grouping: ReportGrouping): string[] {
  const start = new Date(`${dateFrom}T12:00:00`)
  const end = new Date(`${dateTo}T12:00:00`)
  const buckets = new Set<string>()
  for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
    buckets.add(bucketForDate(localDateISO(date), grouping))
  }
  return [...buckets]
}

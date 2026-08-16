import { localDateISO } from '@/lib/date'
import type { GoalProgressSummaryItem } from '@/lib/api-client'

export type TrendRange = '7d' | '4w' | '3m' | '1y'
export type ReportGrouping = 'day' | 'week' | 'month'

export const TREND_RANGES: { value: TrendRange; label: string; days: number; grouping: ReportGrouping }[] = [
  { value: '7d', label: '7 days', days: 7, grouping: 'day' },
  { value: '4w', label: '4 weeks', days: 28, grouping: 'week' },
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

function addMonths(value: Date, months: number): Date {
  const target = new Date(value.getFullYear(), value.getMonth() + months, 1, 12)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate()
  target.setDate(Math.min(value.getDate(), lastDay))
  return target
}

function dayNumber(value: Date): number {
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000
}

export function bucketForDate(value: string, grouping: ReportGrouping, dateFrom = value): string {
  const date = new Date(`${value}T12:00:00`)
  const start = new Date(`${dateFrom}T12:00:00`)
  if (grouping === 'week') {
    const elapsedDays = dayNumber(date) - dayNumber(start)
    date.setDate(date.getDate() - (elapsedDays % 7))
  } else if (grouping === 'month') {
    let months = (date.getFullYear() - start.getFullYear()) * 12 + date.getMonth() - start.getMonth()
    if (date < addMonths(start, months)) months -= 1
    return localDateISO(addMonths(start, months))
  }
  return localDateISO(date)
}

export function aggregateDatedValues(
  items: { date: string; value: number }[],
  grouping: ReportGrouping,
  dateFrom = items[0]?.date ?? localDateISO(new Date())
): { bucket: string; value: number }[] {
  const totals = new Map<string, number>()
  for (const item of items) {
    const bucket = bucketForDate(item.date, grouping, dateFrom)
    totals.set(bucket, (totals.get(bucket) ?? 0) + item.value)
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, value]) => ({ bucket, value }))
}

export function expectedBuckets(dateFrom: string, dateTo: string, grouping: ReportGrouping): string[] {
  const start = new Date(`${dateFrom}T12:00:00`)
  const end = new Date(`${dateTo}T12:00:00`)
  const buckets: string[] = []
  for (let index = 0; ; index += 1) {
    const date = grouping === 'month' ? addMonths(start, index) : new Date(start)
    if (grouping === 'day') date.setDate(start.getDate() + index)
    if (grouping === 'week') date.setDate(start.getDate() + index * 7)
    if (date > end) break
    buckets.push(localDateISO(date))
  }
  return buckets
}

export function selectGoal(
  goals: GoalProgressSummaryItem[], selectedGoalId: string
): GoalProgressSummaryItem | undefined {
  return goals.find((goal) => goal.goal_id === selectedGoalId)
    ?? goals.find((goal) => goal.is_primary)
    ?? goals[0]
}

export function goalCalendarInRange(
  goal: GoalProgressSummaryItem | undefined, dateFrom: string, dateTo: string
) {
  return goal?.calendar.filter((point) => point.date >= dateFrom && point.date <= dateTo) ?? []
}

export function goalProgressionSeries(
  goal: GoalProgressSummaryItem | undefined, dateFrom: string, dateTo: string
) {
  if (!goal) return []
  const bodyWeight = goal.kind === 'body_weight'
  const dailyPlanned = goal.period.total_days > 0
    ? goal.period.target / goal.period.total_days
    : 0
  let cumulativeActual = 0
  let hasActual = false

  return goal.calendar.map((point, index) => {
    if (point.actual != null) {
      cumulativeActual += point.actual
      hasActual = true
    }
    return {
      date: point.date,
      actual: bodyWeight ? point.actual : hasActual ? cumulativeActual : null,
      planned: bodyWeight ? point.target : dailyPlanned * (index + 1),
      status: point.status,
    }
  }).filter((point) => point.date >= dateFrom && point.date <= dateTo)
}

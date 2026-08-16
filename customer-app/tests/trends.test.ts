import { describe, expect, it } from 'vitest'

import type { GoalProgressSummaryItem } from '../src/lib/api-client'
import { aggregateDatedValues, average, expectedBuckets, goalCalendarInRange, goalProgressionSeries, periodChange, reportWindow, selectGoal } from '../src/lib/trends'

describe('trend utilities', () => {
  it('builds inclusive local report windows', () => {
    expect(reportWindow('7d', new Date(2026, 7, 16))).toMatchObject({
      dateFrom: '2026-08-10', dateTo: '2026-08-16',
      previousDateFrom: '2026-08-03', previousDateTo: '2026-08-09', grouping: 'day',
    })
    expect(reportWindow('4w', new Date(2026, 7, 17))).toMatchObject({
      dateFrom: '2026-07-21', dateTo: '2026-08-17', grouping: 'week',
    })
  })

  it('groups recorded values without inventing missing zeroes', () => {
    expect(aggregateDatedValues([
      { date: '2026-08-10', value: 250 },
      { date: '2026-08-10', value: 500 },
      { date: '2026-08-12', value: 300 },
    ], 'day')).toEqual([
      { bucket: '2026-08-10', value: 750 },
      { bucket: '2026-08-12', value: 300 },
    ])
  })

  it('does not call a direction from fewer than six points', () => {
    expect(periodChange([100, 110, 120])).toBeNull()
    expect(periodChange([100, 100, 100, 120, 120, 120])).toBeCloseTo(20)
  })

  it('calculates expected weekly buckets and safe empty averages', () => {
    expect(expectedBuckets('2026-07-21', '2026-08-17', 'week')).toEqual([
      '2026-07-21', '2026-07-28', '2026-08-04', '2026-08-11',
    ])
    expect(average([])).toBeNull()
  })

  it('anchors weekly aggregation to the rolling range instead of Monday', () => {
    expect(aggregateDatedValues([
      { date: '2026-07-21', value: 100 },
      { date: '2026-07-27', value: 200 },
      { date: '2026-07-28', value: 300 },
      { date: '2026-08-17', value: 400 },
    ], 'week', '2026-07-21')).toEqual([
      { bucket: '2026-07-21', value: 300 },
      { bucket: '2026-07-28', value: 300 },
      { bucket: '2026-08-11', value: 400 },
    ])
  })

  it('anchors yearly month buckets to the rolling start date', () => {
    const buckets = expectedBuckets('2025-08-18', '2026-08-17', 'month')
    expect(buckets).toHaveLength(12)
    expect(buckets[0]).toBe('2025-08-18')
    expect(buckets.at(-1)).toBe('2026-07-18')
  })

  it('selects goals by identity rather than array position and clips their chart range', () => {
    const goals = [
      {
        goal_id: 'calories', is_primary: true,
        calendar: [{ date: '2026-08-09', actual: 1800, target: 2000, status: 'met' }, { date: '2026-08-10', actual: 1900, target: 2000, status: 'met' }],
      },
      {
        goal_id: 'protein', is_primary: false,
        calendar: [{ date: '2026-08-10', actual: 90, target: 100, status: 'below' }, { date: '2026-08-11', actual: 110, target: 100, status: 'met' }],
      },
    ] as GoalProgressSummaryItem[]

    expect(selectGoal(goals, 'protein')?.goal_id).toBe('protein')
    expect(selectGoal(goals, '')?.goal_id).toBe('calories')
    expect(goalCalendarInRange(selectGoal(goals, 'protein'), '2026-08-11', '2026-08-16')).toEqual([
      { date: '2026-08-11', actual: 110, target: 100, status: 'met' },
    ])
  })

  it('builds planned cumulative progression separately from recorded actuals', () => {
    const goal = {
      goal_id: 'protein', kind: 'nutrient',
      period: { target: 300, total_days: 3 },
      calendar: [
        { date: '2026-08-10', actual: 80, target: 100, status: 'below' },
        { date: '2026-08-11', actual: null, target: 100, status: 'no_data' },
        { date: '2026-08-12', actual: 110, target: 100, status: 'met' },
      ],
    } as GoalProgressSummaryItem

    expect(goalProgressionSeries(goal, '2026-08-10', '2026-08-12')).toEqual([
      { date: '2026-08-10', actual: 80, planned: 100, status: 'below' },
      { date: '2026-08-11', actual: 80, planned: 200, status: 'no_data' },
      { date: '2026-08-12', actual: 190, planned: 300, status: 'met' },
    ])
  })
})

import { describe, expect, it } from 'vitest'

import { aggregateDatedValues, average, expectedBuckets, periodChange, reportWindow } from '../src/lib/trends'

describe('trend utilities', () => {
  it('builds inclusive local report windows', () => {
    expect(reportWindow('7d', new Date(2026, 7, 16))).toMatchObject({
      dateFrom: '2026-08-10', dateTo: '2026-08-16',
      previousDateFrom: '2026-08-03', previousDateTo: '2026-08-09', grouping: 'day',
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
    expect(expectedBuckets('2026-08-10', '2026-08-23', 'week')).toEqual(['2026-08-10', '2026-08-17'])
    expect(average([])).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'

import { inclusiveDateRange, rollingDateWindow, shiftISODate, startOfWeekISO } from '../src/lib/date'

describe('meal date ranges', () => {
  it('builds every date in an inclusive custom range', () => {
    expect(inclusiveDateRange('2026-08-12', '2026-08-16')).toEqual([
      '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16',
    ])
  })

  it('finds the Monday-to-Sunday week containing a date', () => {
    const start = startOfWeekISO('2026-08-16')
    expect(start).toBe('2026-08-10')
    expect(shiftISODate(start, 6)).toBe('2026-08-16')
  })

  it('rejects a reversed range', () => {
    expect(inclusiveDateRange('2026-08-16', '2026-08-12')).toEqual([])
  })

  it.each([
    [5, '2026-08-13'],
    [7, '2026-08-11'],
    [14, '2026-08-04'],
  ])('builds a %i-day rolling meal window ending today', (days, dateFrom) => {
    const window = rollingDateWindow(days, '2026-08-17')

    expect(window).toEqual({ dateFrom, dateTo: '2026-08-17' })
    expect(inclusiveDateRange(window.dateFrom, window.dateTo)).toHaveLength(days)
  })
})

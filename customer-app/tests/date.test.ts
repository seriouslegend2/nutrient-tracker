import { describe, expect, it } from 'vitest'

import { inclusiveDateRange, shiftISODate, startOfWeekISO } from '../src/lib/date'

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
})

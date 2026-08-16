import { describe, expect, it } from 'vitest'

import { buildGoalPayload } from '../src/components/goal-setup'
import { calendarAchievement, goalStatusText } from '../src/components/home-client'

describe('goal builder payloads', () => {
  const end = '2026-12-31'
  const start = '2026-08-16'

  it('builds each supported cadence and backend spec', () => {
    expect(buildGoalPayload('weight', 4, end, 'gain', true, start)).toEqual({
      kind: 'body_weight',
      spec: { direction: 'gain', amount_kg: 4 },
      starts_on: start,
      ends_on: end,
      cadence: 'period',
      make_primary: true,
    })
    expect(buildGoalPayload('protein', 70, end, 'lose', false, start)).toMatchObject({
      kind: 'nutrient', cadence: 'daily',
      spec: { nutrients: { protein_g: 70 }, direction: 'at_least', label: 'Daily protein' },
    })
    expect(buildGoalPayload('hydration', 2200, end, 'lose', false, start)).toMatchObject({
      kind: 'hydration', cadence: 'daily', spec: { target_ml: 2200, label: 'Daily hydration' },
    })
    expect(buildGoalPayload('training', 3, end, 'lose', false, start)).toMatchObject({
      kind: 'behaviour', cadence: 'weekly',
      spec: { metric: 'training_days', target: 3, label: 'Training days' },
    })
    expect(buildGoalPayload('training', 12, end, 'lose', false, start, 'monthly')).toMatchObject({
      kind: 'behaviour', cadence: 'monthly',
      spec: { metric: 'training_days', target: 12 },
    })
  })
})

describe('goal status language', () => {
  it('never describes an exceeded at-most target as reached', () => {
    expect(goalStatusText('above', 'at_most')).toBe('Over target')
    expect(goalStatusText('met', 'at_most')).toBe('Within target')
  })

  it('keeps missing observations distinct from success', () => {
    expect(goalStatusText('no_data', 'at_least')).toBe('No data')
    expect(goalStatusText('met', 'at_least')).toBe('Goal met')
  })

  it('counts reached hydration days only from completed calendar statuses', () => {
    const calendar = [
      { date: '2026-08-12', status: 'met' as const, actual: 2200, target: 2000 },
      { date: '2026-08-13', status: 'below' as const, actual: 1500, target: 2000 },
      { date: '2026-08-14', status: 'no_data' as const, actual: null, target: 2000 },
      { date: '2026-08-15', status: 'in_progress' as const, actual: 500, target: 2000 },
      { date: '2026-08-16', status: 'future' as const, actual: null, target: 2000 },
    ]

    expect(calendarAchievement(calendar, '2026-08-15')).toEqual({ reached: 1, elapsed: 4 })
  })
})

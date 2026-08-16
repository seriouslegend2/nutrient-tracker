import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, ApiRequestError } from '../src/lib/api-client'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('customer API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('serializes pagination, arrays, and non-empty filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await api.meals({
      page: 3,
      page_size: 20,
      meal_type: ['breakfast', 'dinner'],
      query: '',
      cursor: null,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/meals?page=3&page_size=20&meal_type=breakfast&meal_type=dinner',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })

  it('encodes search input and includes the requested page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await api.searchDishes('rice & dal', 4)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dishes/search?q=rice+%26+dal&page=4',
      expect.any(Object)
    )
  })

  it('does not set a JSON content type for FormData', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)
    const form = new FormData()
    form.set('message', 'lunch')

    await api.sendMessage(form)

    expect(fetchMock).toHaveBeenCalledWith('/api/messages', {
      method: 'POST',
      body: form,
      headers: {},
    })
  })

  it('confirms a typed media meal draft and returns created meals', async () => {
    const response = { created: 1, meals: [{ id: 'meal-1', dish_name: 'dal' }] }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.confirmMessage('message-1', {
      meal_date: '2026-08-16',
      meal_type: 'lunch',
      items: [{ dish_name: 'dal', grams: null, portions: 1.5, portion_unit: 'katori' }],
    })

    expect(result).toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith('/api/messages/message-1/confirm', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        meal_date: '2026-08-16',
        meal_type: 'lunch',
        items: [{ dish_name: 'dal', grams: null, portions: 1.5, portion_unit: 'katori' }],
      }),
    }))
  })

  it('permanently discards a media meal draft', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await api.discardMessage('message-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/messages/message-1/discard', expect.objectContaining({
      method: 'POST',
    }))
  })

  it('returns undefined for a successful no-content response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))

    await expect(api.deleteMeal('meal-1')).resolves.toBeUndefined()
  })

  it('preserves backend error status and details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'Meal not found', code: 'NOT_FOUND' }, 404))
    )

    const error = await api.deleteMeal('missing').catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({
      message: 'Meal not found',
      status: 404,
      body: { detail: 'Meal not found', code: 'NOT_FOUND' },
    })
  })

  it('uses the multi-goal summary, activity, and primary BFF routes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ goals: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await api.goalProgressSummary('2026-08-16')
    await api.checkInGoalActivity('2026-08-16')
    await api.makeGoalPrimary('goal-1')

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/goals/progress/summary?as_of=2026-08-16', expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/goals/activity/check-in', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ date: '2026-08-16', activity_type: 'training' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/goals/goal-1/primary', expect.objectContaining({ method: 'POST' }))
  })

  it('updates only the usual category serving count', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ portion_count: 1.5 }))
    vi.stubGlobal('fetch', fetchMock)

    await api.setPortion('dal_gravy', 1.5)

    expect(fetchMock).toHaveBeenCalledWith('/api/me/portions/dal_gravy', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ portion_count: 1.5 }),
    }))
  })

  it('uses report BFF routes and repeats requested nutrients', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ series: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await api.mealPatterns({ date_from: '2026-08-01', date_to: '2026-08-16' })
    await api.nutrientSeries({
      date_from: '2026-08-01', date_to: '2026-08-16', group_by: 'day',
      nutrient: ['fiber_g', 'sodium_mg'],
    })
    await api.hydrationReport({ date_from: '2026-08-01', date_to: '2026-08-16', group_by: 'week' })

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/reports/meal-patterns?date_from=2026-08-01&date_to=2026-08-16', expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/reports/nutrient-series?date_from=2026-08-01&date_to=2026-08-16&group_by=day&nutrient=fiber_g&nutrient=sodium_mg', expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/reports/hydration?date_from=2026-08-01&date_to=2026-08-16&group_by=week', expect.any(Object))
  })
})

/**
 * The browser's ONLY way to reach data: same-origin /api/*.
 *
 * There is no backend URL here and no Supabase client. If you find yourself
 * wanting either in a component, the answer is a new route handler.
 */

export type Page<T> = {
  items: T[]
  total: number
  page: number
  page_size: number
  total_pages: number
  has_more: boolean
  next_cursor: string | null
}

export type ApiError = {
  detail: string
  code: string
  suggested_action: string | null
  context: Record<string, unknown>
  request_id: string
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Partial<ApiError>
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })

  if (res.status === 401) {
    // Global 401: the session went away. Send them back to login with a return path.
    if (typeof window !== 'undefined') {
      const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`)
      window.location.href = `/auth/login?next=${next}`
    }
    throw new ApiRequestError('Not authenticated', 401, {})
  }

  if (res.status === 204) return undefined as T

  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiRequestError(
      body.detail ?? 'Request failed',
      res.status,
      body as Partial<ApiError>
    )
  }
  return body as T
}

const qs = (params: Record<string, unknown>) => {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return
    Array.isArray(v) ? v.forEach((x) => search.append(k, String(x))) : search.set(k, String(v))
  })
  const s = search.toString()
  return s ? `?${s}` : ''
}

export const api = {
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<Me>('/me'),
  updateProfile: (patch: Record<string, unknown>) =>
    request('/me/profile', { method: 'PATCH', body: JSON.stringify(patch) }),
  submitOnboarding: (body: Record<string, unknown>) =>
    request('/me/onboarding', { method: 'POST', body: JSON.stringify(body) }),

  logWeight: (weight_kg: number, waist_cm?: number) =>
    request('/me/body-metrics', {
      method: 'POST',
      body: JSON.stringify({ weight_kg, waist_cm }),
    }),
  weightHistory: (page = 1) =>
    request<Page<BodyMetric>>(`/me/body-metrics${qs({ page })}`),

  portions: () => request<Page<CategoryPortion>>('/me/portions'),
  setPortion: (category: string, body: Record<string, unknown>) =>
    request(`/me/portions/${category}`, { method: 'PUT', body: JSON.stringify(body) }),

  preferences: () => request<Page<Preference>>('/me/preferences'),
  setPreference: (topic: string, body: Record<string, unknown>) =>
    request(`/me/preferences/${encodeURIComponent(topic)}`, {
      method: 'PUT', body: JSON.stringify(body),
    }),

  meals: (params: Record<string, unknown> = {}) =>
    request<Page<Meal>>(`/meals${qs(params)}`),
  day: (date: string, version?: number) =>
    request<Day>(`/meals/day/${date}${qs({ version })}`),
  dayVersions: (date: string) =>
    request<Page<DayVersion>>(`/meals/day/${date}/versions`),
  logMeal: (body: Record<string, unknown>) =>
    request<Meal>('/meals', { method: 'POST', body: JSON.stringify(body) }),
  adjustMeal: (id: string, body: Record<string, unknown>) =>
    request<Meal>(`/meals/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteMeal: (id: string) => request<void>(`/meals/${id}`, { method: 'DELETE' }),

  searchDishes: (q: string, page = 1) =>
    request<Page<Dish>>(`/dishes/search${qs({ q, page })}`),
  dishPortion: (id: string) => request<DishPortion>(`/dishes/${id}/portion`),
  setDishPortion: (id: string, body: Record<string, unknown>) =>
    request(`/me/dishes/${id}/portion`, { method: 'PUT', body: JSON.stringify(body) }),
  categories: () => request<Page<CategoryPortion>>('/categories'),

  activeGoal: () => request<Goal | null>('/goals/active'),
  goals: (page = 1) => request<Page<Goal>>(`/goals${qs({ page })}`),
  previewGoal: (body: Record<string, unknown>) =>
    request<GoalPreview>('/goals/preview', { method: 'POST', body: JSON.stringify(body) }),
  createGoal: (body: Record<string, unknown>) =>
    request<Goal>('/goals', { method: 'POST', body: JSON.stringify(body) }),
  activateGoal: (id: string) => request<Goal>(`/goals/${id}/activate`, { method: 'POST' }),
  deactivateGoal: (id: string) => request<Goal>(`/goals/${id}/deactivate`, { method: 'POST' }),
  goalProgress: (id: string, params: Record<string, unknown> = {}) =>
    request<GoalProgress>(`/goals/${id}/progress${qs(params)}`),

  trend: (params: Record<string, unknown> = {}) => request<Trend>(`/reports/trend${qs(params)}`),
  macros: (params: Record<string, unknown> = {}) => request<Macros>(`/reports/macros${qs(params)}`),
  micros: (params: Record<string, unknown> = {}) => request<Micros>(`/reports/micros${qs(params)}`),
  goalVsActual: (params: Record<string, unknown> = {}) =>
    request<GoalVsActual>(`/reports/goal-vs-actual${qs(params)}`),

  logWater: (volume_ml: number) =>
    request('/water', { method: 'POST', body: JSON.stringify({ volume_ml }) }),
  water: (page = 1) => request<Page<WaterLog>>(`/water${qs({ page })}`),

  sendMessage: (form: FormData) =>
    request<Message[]>('/messages', { method: 'POST', body: form }),
  messages: (params: Record<string, unknown> = {}) =>
    request<Page<Message>>(`/messages${qs(params)}`),
  confirmMessage: (id: string, body: Record<string, unknown>) =>
    request(`/messages/${id}/confirm`, { method: 'POST', body: JSON.stringify(body) }),
}

// --- types (mirrors the backend response models) ---------------------------

export type Me = {
  id: string
  email: string | null
  roles: string[]
  profile: Profile | null
  onboarding_complete: boolean
}

export type Profile = {
  sex: string | null
  date_of_birth: string | null
  height_cm: number | null
  activity: string
  diet: string | null
  allergies: string[]
  breakfast_time?: string | null
  lunch_time?: string | null
  dinner_time?: string | null
  is_pregnant_or_nursing?: boolean
  has_medical_condition?: boolean
  bmi: number | null
  bmr_kcal: number | null
  tdee_kcal: number | null
}

export type BodyMetric = { measured_on: string; weight_kg: number; waist_cm: number | null }

export type CategoryPortion = {
  category: string
  portion_unit: string
  portion_grams: number
  portion_count: number
  is_custom: boolean
  global_portion_grams: number
  global_portion_count: number
  source: string | null
}

export type Preference = {
  pref_id: string
  topic_title: string
  content: string
  type: string
  status: string
}

export type Meal = {
  id: string
  meal_date: string
  meal_type: string
  dish_name: string
  food_id: string | null
  category?: string | null
  portions: number
  portion_unit: string
  grams: number | null
  nutrients: Record<string, number>
  resolved_from: string
  confidence: string | null
  source: string
}

export type Day = {
  meal_date: string
  version: number | null
  slots: Record<string, Meal[]>
  totals: Record<string, number>
  unaccounted_items: number
}

export type DayVersion = { version: number; is_active: boolean; created_at: string; item_count: number }

export type Dish = {
  dish_id: string
  name: string
  category: string
  portion_unit: string
  portion_grams: number
  per_100g: Record<string, number>
}

export type DishPortion = {
  portion_unit: string
  portion_grams: number | null
  per_100g: Record<string, number>
  resolved_from: string
}

export type GoalTarget = {
  metric: string
  scope: string
  direction: string
  value: number
  unit: string
  label?: string
}

export type Goal = {
  goal_id: string
  kind: string
  spec: Record<string, unknown>
  starts_on: string
  ends_on: string
  daily_targets: { targets: GoalTarget[] }
  derivation: Record<string, unknown>
  status: string
  version: number
  is_active: boolean
}

export type GoalPreview = {
  daily_targets: { targets: GoalTarget[] }
  derivation: Record<string, unknown>
  clamp_fired: boolean
}

export type GoalProgress = {
  days_elapsed: number
  days_logged: number
  adherence: number
  unaccounted_items: number
  targets: {
    metric: string
    direction: string
    target_per_day: number
    target_to_date: number
    actual_to_date: number
    unit: string
  }[]
}

export type Trend = {
  group_by: string
  series: { bucket: string; calories_kcal: number; rolling_mean: number }[]
  unaccounted_items: number
}

export type Macros = {
  series: Record<string, number | Record<string, number> | string>[]
  amdr_reference: Record<string, number[]>
}

export type Micros = {
  basis: string
  watchlist: MicroRow[]
  panel: MicroRow[]
}

export type MicroRow = {
  nutrient: string
  actual_per_day: number
  rda_per_day: number
  pct_of_rda: number
  direction: string
  on_track: boolean
}

export type GoalVsActual = {
  has_goal: boolean
  clamp_fired?: boolean
  targets: GoalTarget[]
  series: Record<string, unknown>[]
  summary?: GoalProgress
}

export type WaterLog = { logged_on: string; volume_ml: number }

export type Message = {
  id: string
  thread_id: string
  direction: string
  msg_type: string
  msg_text: string | null
  payload: Record<string, unknown>
  status: string
  created_at: string
}

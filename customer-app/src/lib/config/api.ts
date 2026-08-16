import { createHmac } from 'node:crypto'

/**
 * The single source of truth for every backend path, timeout and header.
 *
 * A URL built by hand anywhere else is a bug. KookarCore's equivalent is
 * ~1,070 lines and exists for exactly this reason.
 *
 * SERVER-ONLY. Nothing here may be imported into a client component: there is
 * no NEXT_PUBLIC_ prefix on any of it, so the values never reach the bundle.
 */

/** Read at RUNTIME via a getter, never at module init - a module-init read
 *  bakes in the build-time value and silently breaks on redeploy. */
function env(name: string): string {
  return process.env[name] ?? ''
}

export const API = {
  get baseUrl() {
    return env('BACKEND_API_URL') || 'http://localhost:8000'
  },
  get jwtSecret() {
    return env('BACKEND_JWT_SECRET')
  },

  /** Timeout tiers. A 30s metadata call and a 10m stream should not share one. */
  timeouts: {
    metadata: 30_000,
    default: 120_000,
    long: 300_000,
    stream: 600_000,
  },

  paths: {
    me: '/api/v1/me',
    profile: '/api/v1/me/profile',
    onboarding: '/api/v1/me/onboarding',
    bodyMetrics: '/api/v1/me/body-metrics',
    preferences: '/api/v1/me/preferences',
    portions: '/api/v1/me/portions',
    meals: '/api/v1/meals',
    mealDay: (d: string) => `/api/v1/meals/day/${d}`,
    mealDayVersions: (d: string) => `/api/v1/meals/day/${d}/versions`,
    dishSearch: '/api/v1/dishes/search',
    dish: (id: string) => `/api/v1/dishes/${id}`,
    dishPortion: (id: string) => `/api/v1/dishes/${id}/portion`,
    myDishPortion: (id: string) => `/api/v1/me/dishes/${id}/portion`,
    categories: '/api/v1/categories',
    goals: '/api/v1/goals',
    goalActive: '/api/v1/goals/active',
    goalPreview: '/api/v1/goals/preview',
    goalProgressSummary: '/api/v1/goals/progress/summary',
    goalActivity: '/api/v1/goals/activity',
    goalActivityCheckIn: '/api/v1/goals/activity/check-in',
    goalProgress: (id: string) => `/api/v1/goals/${id}/progress`,
    goalActivate: (id: string) => `/api/v1/goals/${id}/activate`,
    goalDeactivate: (id: string) => `/api/v1/goals/${id}/deactivate`,
    goalPrimary: (id: string) => `/api/v1/goals/${id}/primary`,
    reportTrend: '/api/v1/reports/trend',
    reportMacros: '/api/v1/reports/macros',
    reportMicros: '/api/v1/reports/micros',
    reportGoalVsActual: '/api/v1/reports/goal-vs-actual',
    water: '/api/v1/water',
    messages: '/api/v1/messages',
  },
} as const

export function createBackendToken(userId: string): string {
  if (!API.jwtSecret) throw new Error('BACKEND_JWT_SECRET is not configured')
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    user_id: userId,
    house_id: 0,
    roles: ['user'],
  })}`
  const signature = createHmac('sha256', API.jwtSecret)
    .update(unsigned)
    .digest('base64url')
  return `${unsigned}.${signature}`
}

export function buildUrl(path: string, search?: string): string {
  const url = `${API.baseUrl}${path}`
  return search ? `${url}${search.startsWith('?') ? search : `?${search}`}` : url
}

/** Never let the shared backend bearer reach a log line. */
export function redactHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      k.toLowerCase() === 'authorization' ? 'Bearer <redacted>' : v,
    ])
  )
}

import { createHmac } from 'node:crypto'

/**
 * Backend endpoint map. SERVER-ONLY - no NEXT_PUBLIC_ prefix on any of it.
 *
 * The admin surface is a separate set of routes. The signed bearer identifies
 * the operator and FastAPI loads that user's role from the database.
 */

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

  timeouts: {
    metadata: 30_000,
    default: 120_000,
    long: 300_000,
    stream: 600_000,
  },

  paths: {
    me: '/api/v1/me',
    users: '/api/v1/admin/users',
    user: (id: string) => `/api/v1/admin/users/${id}`,
    userPanel: (id: string, panel: string) => `/api/v1/admin/users/${id}/${panel}`,
    metrics: '/api/v1/admin/metrics',
    resolutionMix: '/api/v1/admin/resolution-mix',
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

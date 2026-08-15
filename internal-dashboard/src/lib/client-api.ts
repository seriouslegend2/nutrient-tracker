import { safeNext } from '@/lib/auth'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, { cache: 'no-store' })
  if (response.ok) return response.json() as Promise<T>

  const body = (await response.json().catch(() => ({}))) as {
    detail?: string
    code?: string
  }

  if (response.status === 401 && typeof window !== 'undefined') {
    const next = safeNext(`${window.location.pathname}${window.location.search}`)
    window.location.replace(
      `/auth/login?error=session_expired&next=${encodeURIComponent(next)}`
    )
  }

  throw new ApiError(body.detail ?? 'Request failed', response.status, body.code)
}

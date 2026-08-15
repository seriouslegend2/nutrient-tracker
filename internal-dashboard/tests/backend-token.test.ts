import { createHmac } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { API, buildUrl, createBackendToken } from '../src/lib/config/api'

const decodePart = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

describe('dashboard backend configuration', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('creates the expected backend claims and a valid HS256 signature', () => {
    const secret = 'dashboard-unit-test-secret'
    vi.stubEnv('BACKEND_JWT_SECRET', secret)

    const token = createBackendToken('admin-123')
    const parts = token.split('.')

    expect(parts).toHaveLength(3)
    expect(decodePart(parts[0])).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(decodePart(parts[1])).toEqual({
      user_id: 'admin-123',
      house_id: 0,
      roles: ['user'],
    })
    expect(parts[2]).toBe(
      createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url')
    )
  })

  it('binds each payload and signature to its operator', () => {
    vi.stubEnv('BACKEND_JWT_SECRET', 'dashboard-unit-test-secret')

    const first = createBackendToken('admin-one')
    const second = createBackendToken('admin-two')

    expect(decodePart(first.split('.')[1]).user_id).toBe('admin-one')
    expect(decodePart(second.split('.')[1]).user_id).toBe('admin-two')
    expect(first).not.toBe(second)
  })

  it('fails closed when the backend secret is missing', () => {
    vi.stubEnv('BACKEND_JWT_SECRET', '')

    expect(() => createBackendToken('admin-123')).toThrow(
      'BACKEND_JWT_SECRET is not configured'
    )
  })

  it('builds paginated user-panel URLs from the central endpoint map', () => {
    vi.stubEnv('BACKEND_API_URL', 'https://backend.example')

    expect(buildUrl(API.paths.userPanel('user/id', 'agent-runs'), 'page=2&page_size=20')).toBe(
      'https://backend.example/api/v1/admin/users/user/id/agent-runs?page=2&page_size=20'
    )
  })
})

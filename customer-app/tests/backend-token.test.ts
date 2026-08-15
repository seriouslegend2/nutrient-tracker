import { createHmac } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBackendToken } from '../src/lib/config/api'

const decodePart = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

describe('createBackendToken', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('creates the expected backend claims and a valid HS256 signature', () => {
    const secret = 'unit-test-secret'
    vi.stubEnv('BACKEND_JWT_SECRET', secret)

    const token = createBackendToken('user-123')
    const parts = token.split('.')

    expect(parts).toHaveLength(3)
    expect(decodePart(parts[0])).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(decodePart(parts[1])).toEqual({
      user_id: 'user-123',
      house_id: 0,
      roles: ['user'],
    })
    expect(parts[2]).toBe(
      createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url')
    )
  })

  it('binds the payload and signature to the requested user', () => {
    vi.stubEnv('BACKEND_JWT_SECRET', 'unit-test-secret')

    const first = createBackendToken('user-one')
    const second = createBackendToken('user-two')

    expect(decodePart(first.split('.')[1]).user_id).toBe('user-one')
    expect(decodePart(second.split('.')[1]).user_id).toBe('user-two')
    expect(first).not.toBe(second)
  })

  it('fails closed when the backend secret is missing', () => {
    vi.stubEnv('BACKEND_JWT_SECRET', '')

    expect(() => createBackendToken('user-123')).toThrow(
      'BACKEND_JWT_SECRET is not configured'
    )
  })
})

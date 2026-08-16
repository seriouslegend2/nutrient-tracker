import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ createServerClient: vi.fn() }))

vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }))

import { proxy } from '../proxy'

describe('customer auth proxy', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key'
    mocks.createServerClient.mockReset()
  })

  it('redirects a signed-out protected request and preserves cookie updates', async () => {
    mockUser(null, true)

    const response = await proxy(new NextRequest('https://app.example/meals?day=today'))

    expect(response.headers.get('location')).toBe(
      'https://app.example/auth/login?next=%2Fmeals%3Fday%3Dtoday'
    )
    expect(response.cookies.get('sb-session')?.value).toBe('refreshed')
  })

  it('redirects a signed-in user away from login to the requested page', async () => {
    mockUser({ id: 'user-1' })

    const response = await proxy(new NextRequest(
      'https://app.example/auth/login?next=%2Fanalytics%3Frange%3Dweek'
    ))

    expect(response.headers.get('location')).toBe('https://app.example/analytics?range=week')
  })

  it('uses home when a signed-in login request has an unsafe destination', async () => {
    mockUser({ id: 'user-1' })

    const response = await proxy(new NextRequest(
      'https://app.example/auth/login?next=%2F%2Fattacker.example'
    ))

    expect(response.headers.get('location')).toBe('https://app.example/home')
  })
})

function mockUser(user: { id: string } | null, refreshCookie = false) {
  mocks.createServerClient.mockImplementation((_url, _key, options) => ({
    auth: {
      getUser: async () => {
        if (refreshCookie) {
          options.cookies.setAll([{
            name: 'sb-session',
            value: 'refreshed',
            options: { httpOnly: true, path: '/' },
          }])
        }
        return { data: { user } }
      },
    },
  }))
}

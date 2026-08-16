import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))

import { GET as google } from '../app/api/auth/google/route'
import { GET as callback } from '../app/auth/callback/route'

describe('Google OAuth routes', () => {
  beforeEach(() => mocks.createClient.mockReset())

  it('opens Google with an account chooser and a safe callback', async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test' },
      error: null,
    })
    mocks.createClient.mockResolvedValue({ auth: { signInWithOAuth } })

    const response = await google(new NextRequest(
      'https://app.example/api/auth/google?next=%2Fmeals%3Fday%3Dtoday'
    ))

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'https://app.example/auth/callback?next=%2Fmeals%3Fday%3Dtoday',
        queryParams: { prompt: 'select_account' },
      },
    })
    expect(response.headers.get('location')).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=test'
    )
  })

  it('does not put an unsafe continuation into the OAuth callback', async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth' },
      error: null,
    })
    mocks.createClient.mockResolvedValue({ auth: { signInWithOAuth } })

    await google(new NextRequest(
      'https://app.example/api/auth/google?next=%2F%2Fattacker.example'
    ))

    expect(signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        redirectTo: 'https://app.example/auth/callback?next=%2Fhome',
      }),
    }))
  })

  it('returns to login when Google authorization cannot start', async () => {
    mocks.createClient.mockResolvedValue({
      auth: {
        signInWithOAuth: vi.fn().mockResolvedValue({
          data: { url: null },
          error: new Error('provider disabled'),
        }),
      },
    })

    const response = await google(new NextRequest(
      'https://app.example/api/auth/google?next=%2Fanalytics'
    ))

    expect(response.headers.get('location')).toBe(
      'https://app.example/auth/login?error=google_auth_failed&next=%2Fanalytics'
    )
  })

  it('exchanges the Google callback code and rejects an unsafe destination', async () => {
    const exchangeCodeForSession = vi.fn().mockResolvedValue({ error: null })
    mocks.createClient.mockResolvedValue({ auth: { exchangeCodeForSession } })

    const response = await callback(new NextRequest(
      'https://app.example/auth/callback?code=google-code&next=%2F%2Fattacker.example'
    ))

    expect(exchangeCodeForSession).toHaveBeenCalledWith('google-code')
    expect(response.headers.get('location')).toBe('https://app.example/home')
  })
})

import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GET as callback } from '../app/auth/callback/route'
import { GET as google } from '../app/api/auth/google/route'
import { createClient } from '../src/lib/supabase/server'

vi.mock('../src/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

const signInWithOAuth = vi.fn()
const exchangeCodeForSession = vi.fn()
const mockedCreateClient = vi.mocked(createClient)

describe('Google OAuth routes', () => {
  beforeEach(() => {
    signInWithOAuth.mockReset()
    exchangeCodeForSession.mockReset()
    mockedCreateClient.mockReset()
    mockedCreateClient.mockResolvedValue({
      auth: { signInWithOAuth, exchangeCodeForSession },
    } as unknown as Awaited<ReturnType<typeof createClient>>)
  })

  it('opens the account chooser with a safe dashboard callback', async () => {
    signInWithOAuth.mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth' },
      error: null,
    })

    const response = await google(new NextRequest(
      'https://dashboard.example/api/auth/google?next=%2Fusers%3Fpage%3D2'
    ))

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'https://dashboard.example/auth/callback?next=%2Fusers%3Fpage%3D2',
        queryParams: { prompt: 'select_account' },
      },
    })
    expect(response.headers.get('location')).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth'
    )
  })

  it('does not include an unsafe continuation in the callback', async () => {
    signInWithOAuth.mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth' },
      error: null,
    })

    await google(new NextRequest(
      'https://dashboard.example/api/auth/google?next=%2F%2Fattacker.example'
    ))

    expect(signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        redirectTo: 'https://dashboard.example/auth/callback?next=%2Fusers',
      }),
    }))
  })

  it('returns to login when Google authorization cannot start', async () => {
    signInWithOAuth.mockResolvedValue({
      data: { url: null },
      error: new Error('provider unavailable'),
    })

    const response = await google(new NextRequest(
      'https://dashboard.example/api/auth/google?next=%2Fusers'
    ))

    expect(response.headers.get('location')).toBe(
      'https://dashboard.example/auth/login?error=google_auth_failed&next=%2Fusers'
    )
  })

  it('exchanges the callback code and redirects to a safe destination', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })

    const response = await callback(new NextRequest(
      'https://dashboard.example/auth/callback?code=google-code&next=%2Fusers%3Fpage%3D3'
    ))

    expect(exchangeCodeForSession).toHaveBeenCalledWith('google-code')
    expect(response.headers.get('location')).toBe('https://dashboard.example/users?page=3')
  })

  it('returns to login when the callback exchange fails', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: new Error('invalid code') })

    const response = await callback(new NextRequest(
      'https://dashboard.example/auth/callback?code=bad-code&next=%2Fusers'
    ))

    expect(response.headers.get('location')).toBe(
      'https://dashboard.example/auth/login?error=google_auth_failed&next=%2Fusers'
    )
  })
})

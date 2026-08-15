import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { POST } from '../app/api/auth/login/route'
import { createClient } from '../src/lib/supabase/server'

vi.mock('../src/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

const signInWithPassword = vi.fn()
const mockedCreateClient = vi.mocked(createClient)

function loginRequest(values: Record<string, string>) {
  return new NextRequest('https://dashboard.example/api/auth/login', {
    method: 'POST',
    body: new URLSearchParams(values),
  })
}

describe('password login route', () => {
  beforeEach(() => {
    signInWithPassword.mockReset()
    mockedCreateClient.mockReset()
    mockedCreateClient.mockResolvedValue({
      auth: { signInWithPassword },
    } as unknown as Awaited<ReturnType<typeof createClient>>)
  })

  it('signs in server-side and redirects to a safe destination', async () => {
    signInWithPassword.mockResolvedValue({ error: null })

    const response = await POST(loginRequest({
      email: ' admin@example.com ',
      password: 'correct horse battery staple',
      next: '/users?page=2',
    }))

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'correct horse battery staple',
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://dashboard.example/users?page=2')
  })

  it('uses the default destination when next is unsafe', async () => {
    signInWithPassword.mockResolvedValue({ error: null })

    const response = await POST(loginRequest({
      email: 'admin@example.com',
      password: 'secret',
      next: '//attacker.example/steal',
    }))

    expect(response.headers.get('location')).toBe('https://dashboard.example/users')
  })

  it('returns a clear login error without exposing provider details', async () => {
    signInWithPassword.mockResolvedValue({ error: new Error('provider detail') })

    const response = await POST(loginRequest({
      email: 'admin@example.com',
      password: 'wrong',
      next: '/users',
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      'https://dashboard.example/auth/login?error=invalid_credentials&next=%2Fusers'
    )
  })

  it('rejects missing credentials before creating a Supabase client', async () => {
    const response = await POST(loginRequest({ email: '', password: '', next: '/users' }))

    expect(mockedCreateClient).not.toHaveBeenCalled()
    expect(response.headers.get('location')).toBe(
      'https://dashboard.example/auth/login?error=missing_credentials&next=%2Fusers'
    )
  })
})

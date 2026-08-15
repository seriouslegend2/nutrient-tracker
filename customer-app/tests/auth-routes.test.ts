import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))

import { POST as login } from '../app/api/auth/login/route'
import { POST as signup } from '../app/api/auth/signup/route'
import { GET as callback } from '../app/auth/callback/route'

const request = (path: string, body: unknown) =>
  new NextRequest(`https://app.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('credential auth routes', () => {
  beforeEach(() => mocks.createClient.mockReset())

  it('logs in through the server client and returns a safe destination', async () => {
    const signInWithPassword = vi.fn().mockResolvedValue({ error: null })
    mocks.createClient.mockResolvedValue({ auth: { signInWithPassword } })

    const response = await login(request('/api/auth/login', {
      email: 'person@example.com',
      password: 'secret',
      next: '/meals?day=today',
    }))

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'person@example.com',
      password: 'secret',
    })
    await expect(response.json()).resolves.toEqual({
      status: 'authenticated',
      next: '/meals?day=today',
    })
  })

  it('rejects invalid login input before creating a server client', async () => {
    const response = await login(request('/api/auth/login', {
      email: 'invalid',
      password: 'secret',
    }))

    expect(response.status).toBe(400)
    expect(mocks.createClient).not.toHaveBeenCalled()
  })

  it('does not return an external login destination', async () => {
    mocks.createClient.mockResolvedValue({
      auth: { signInWithPassword: vi.fn().mockResolvedValue({ error: null }) },
    })

    const response = await login(request('/api/auth/login', {
      email: 'person@example.com',
      password: 'secret',
      next: '//attacker.example',
    }))

    await expect(response.json()).resolves.toMatchObject({ next: '/home' })
  })

  it('creates an account with a safe email-confirmation callback', async () => {
    const signUp = vi.fn().mockResolvedValue({ data: { session: null }, error: null })
    mocks.createClient.mockResolvedValue({ auth: { signUp } })

    const response = await signup(request('/api/auth/signup', {
      email: 'person@example.com',
      password: 'secret',
      next: '/onboarding?source=signup',
    }))

    expect(signUp).toHaveBeenCalledWith({
      email: 'person@example.com',
      password: 'secret',
      options: {
        emailRedirectTo: 'https://app.example/auth/callback?next=%2Fonboarding%3Fsource%3Dsignup',
      },
    })
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ status: 'confirmation_required' })
  })

  it('distinguishes signup with an immediate session', async () => {
    mocks.createClient.mockResolvedValue({
      auth: { signUp: vi.fn().mockResolvedValue({ data: { session: {} }, error: null }) },
    })

    const response = await signup(request('/api/auth/signup', {
      email: 'person@example.com',
      password: 'secret',
      next: '/home',
    }))

    await expect(response.json()).resolves.toEqual({ status: 'authenticated', next: '/home' })
  })

  it('exchanges confirmation codes and rejects an unsafe callback destination', async () => {
    const exchangeCodeForSession = vi.fn().mockResolvedValue({ error: null })
    mocks.createClient.mockResolvedValue({ auth: { exchangeCodeForSession } })

    const response = await callback(new NextRequest(
      'https://app.example/auth/callback?code=confirmation-code&next=%2F%2Fattacker.example'
    ))

    expect(exchangeCodeForSession).toHaveBeenCalledWith('confirmation-code')
    expect(response.headers.get('location')).toBe('https://app.example/home')
  })
})

'use client'

import { useSearchParams } from 'next/navigation'
import { FormEvent, useState } from 'react'

import { MIN_PASSWORD_LENGTH, safeRedirectPath } from '@/lib/auth'

type Mode = 'login' | 'signup'

type AuthResponse = {
  status?: 'authenticated' | 'confirmation_required'
  next?: string
  detail?: string
  message?: string
}

export function LoginClient() {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const params = useSearchParams()
  const next = safeRedirectPath(params.get('next'))
  const callbackFailed = params.has('error')

  const changeMode = (nextMode: Mode) => {
    setMode(nextMode)
    setError(null)
    setSuccess(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSuccess(null)

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, next }),
      })
      const body = (await response.json().catch(() => ({}))) as AuthResponse

      if (!response.ok) {
        setError(body.detail ?? 'Authentication could not be completed. Please try again.')
        return
      }

      if (body.status === 'confirmation_required') {
        setSuccess(body.message ?? 'Check your email to confirm your account.')
        setPassword('')
        return
      }

      if (body.status === 'authenticated') {
        setSuccess(mode === 'signup' ? 'Account created. Redirecting...' : 'Signed in. Redirecting...')
        window.location.assign(safeRedirectPath(body.next ?? null, next))
        return
      }

      setError('Authentication could not be completed. Please try again.')
    } catch {
      setError('Unable to reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-[420px] flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Nutrient Tracker</h1>
      <p className="mb-6 mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>
        Log meals, set goals, see where you actually are.
      </p>

      <div className="mb-6 grid grid-cols-2 rounded-xl border p-1" style={{ borderColor: 'var(--color-line)' }} aria-label="Authentication mode">
        {(['login', 'signup'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            disabled={busy}
            onClick={() => changeMode(value)}
            className="rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50"
            style={mode === value ? { background: 'var(--color-surface)' } : { color: 'var(--color-tx2)' }}
          >
            {value === 'login' ? 'Log in' : 'Sign up'}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={busy}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="input disabled:opacity-50"
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1.5 block text-sm font-medium">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={MIN_PASSWORD_LENGTH}
            required
            disabled={busy}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="input disabled:opacity-50"
            aria-describedby={mode === 'signup' ? 'password-help' : undefined}
          />
          {mode === 'signup' && (
            <p id="password-help" className="mt-1.5 text-xs" style={{ color: 'var(--color-tx2)' }}>
              Use at least {MIN_PASSWORD_LENGTH} characters.
            </p>
          )}
        </div>
        <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-50">
          {busy ? (mode === 'login' ? 'Logging in...' : 'Creating account...') : (mode === 'login' ? 'Log in' : 'Create account')}
        </button>
      </form>

      {(error || callbackFailed) && !success && (
        <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>
          {error ?? 'Your email confirmation could not be completed. Please try again.'}
        </p>
      )}
      {success && (
        <p className="mt-3 text-sm" role="status" aria-live="polite" style={{ color: 'var(--color-tx2)' }}>
          {success}
        </p>
      )}
    </main>
  )
}

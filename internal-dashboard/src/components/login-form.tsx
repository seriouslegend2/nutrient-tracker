const ERRORS: Record<string, string> = {
  auth_unavailable: 'Sign-in is temporarily unavailable. Please try again.',
  invalid_credentials: 'The email or password is incorrect.',
  missing_credentials: 'Enter both your email and password.',
  session_expired: 'Your session expired. Sign in again to continue.',
}

export function LoginForm({ next, error }: { next: string; error?: string }) {
  const message = error ? ERRORS[error] ?? 'Sign-in failed. Please try again.' : undefined

  return (
    <main className="mx-auto flex min-h-screen max-w-[420px] flex-col justify-center px-6 py-12">
      <p
        className="text-xs font-medium uppercase tracking-[0.18em]"
        style={{ color: 'var(--color-accent)' }}
      >
        Administration
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm leading-6" style={{ color: 'var(--color-tx2)' }}>
        Use your Nutrient Tracker account to access the internal dashboard.
      </p>

      {message && (
        <p
          id="login-error"
          role="alert"
          className="mt-6 rounded-lg border p-3 text-sm"
          style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
        >
          {message}
        </p>
      )}

      <form action="/api/auth/login" method="post" className="mt-7 space-y-5">
        <input type="hidden" name="next" value={next} />

        <div>
          <label htmlFor="email" className="mb-2 block text-sm font-medium">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            aria-describedby={message ? 'login-error' : undefined}
            className="w-full rounded-xl border bg-transparent px-3.5 py-3 outline-none focus:ring-2"
            style={{ borderColor: 'var(--color-line)', '--tw-ring-color': 'var(--color-accent)' } as React.CSSProperties}
          />
        </div>

        <div>
          <label htmlFor="password" className="mb-2 block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-describedby={message ? 'login-error' : undefined}
            className="w-full rounded-xl border bg-transparent px-3.5 py-3 outline-none focus:ring-2"
            style={{ borderColor: 'var(--color-line)', '--tw-ring-color': 'var(--color-accent)' } as React.CSSProperties}
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-xl px-4 py-3 font-medium"
          style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        >
          Sign in
        </button>
      </form>

      <p className="mt-6 text-center text-xs leading-5" style={{ color: 'var(--color-tx2)' }}>
        New accounts are created in the customer application.
      </p>
    </main>
  )
}

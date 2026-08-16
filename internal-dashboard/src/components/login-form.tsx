const ERRORS: Record<string, string> = {
  auth_unavailable: 'Sign-in is temporarily unavailable. Please try again.',
  google_auth_failed: 'Google sign-in could not be completed. Please try again.',
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
        Continue with an authorized Google account to access the internal dashboard.
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

      <a
        href={`/api/auth/google?next=${encodeURIComponent(next)}`}
        className="mt-7 flex w-full items-center justify-center gap-3 rounded-xl px-4 py-3 font-medium"
        style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
      >
        <span
          className="grid h-7 w-7 place-items-center rounded-full bg-white text-base font-bold text-neutral-700"
          aria-hidden="true"
        >
          G
        </span>
        Continue with Google
      </a>

      <p className="mt-6 text-center text-xs leading-5" style={{ color: 'var(--color-tx2)' }}>
        Google can create the account, but only accounts granted the backend admin role can enter.
      </p>
    </main>
  )
}

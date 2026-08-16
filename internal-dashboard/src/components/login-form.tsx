const ERRORS: Record<string, string> = {
  auth_unavailable: 'Sign-in is temporarily unavailable. Please try again.',
  google_auth_failed: 'Google sign-in could not be completed. Please try again.',
  session_expired: 'Your session expired. Sign in again to continue.',
}

export function LoginForm({ next, error }: { next: string; error?: string }) {
  const message = error ? ERRORS[error] ?? 'Sign-in failed. Please try again.' : undefined

  return (
    <main className="mx-auto flex min-h-screen max-w-[460px] flex-col justify-center px-5 py-12 sm:px-6">
      <section className="card p-6 shadow-[0_24px_80px_color-mix(in_oklch,var(--color-tx)_8%,transparent)] sm:p-8">
      <p
        className="text-xs font-medium uppercase tracking-[0.18em]"
        style={{ color: 'var(--color-accent)' }}
      >
        Administration
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Operations access</h1>
      <p className="mt-2 text-sm leading-6" style={{ color: 'var(--color-tx2)' }}>
        Review customer accounts, nutrition records, and system activity with an authorized Google account.
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
        className="mt-7 flex min-h-12 w-full items-center justify-center gap-3 rounded-xl px-4 py-3 font-semibold"
        style={{ background: 'var(--color-accent)', color: 'var(--color-accent-on)' }}
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
      </section>
    </main>
  )
}

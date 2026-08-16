'use client'

import { useSearchParams } from 'next/navigation'

import { safeRedirectPath } from '@/lib/auth'

export function LoginClient() {
  const params = useSearchParams()
  const next = safeRedirectPath(params.get('next'))
  const callbackFailed = params.has('error')

  return (
    <main className="mx-auto flex min-h-screen max-w-[420px] flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Nutrient Tracker</h1>
      <p className="mb-6 mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>
        Log meals, set goals, see where you actually are.
      </p>

      <a
        href={`/api/auth/google?next=${encodeURIComponent(next)}`}
        className="btn-primary flex w-full items-center justify-center gap-3"
      >
        <span
          className="grid h-7 w-7 place-items-center rounded-full bg-white text-base font-bold text-neutral-700"
          aria-hidden="true"
        >
          G
        </span>
        Continue with Google
      </a>
      <p className="mt-4 text-center text-xs leading-5" style={{ color: 'var(--color-tx2)' }}>
        Choose a Google account. New users are registered automatically and existing users are signed in.
      </p>

      {callbackFailed && (
        <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>
          Google sign-in could not be completed. Please try again.
        </p>
      )}
    </main>
  )
}

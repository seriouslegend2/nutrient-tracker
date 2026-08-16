'use client'

import { useSearchParams } from 'next/navigation'

import { safeRedirectPath } from '@/lib/auth'

export function LoginClient() {
  const params = useSearchParams()
  const next = safeRedirectPath(params.get('next'))
  const callbackFailed = params.has('error')

  return (
    <main className="auth-shell">
      <section className="auth-card">
       <div className="brand-mark mb-6" aria-hidden="true">
         <MacroMark />
       </div>
       <p className="mb-2 font-semibold" style={{ color: 'var(--color-accent-strong)' }}>Your daily nutrition</p>
      <h1 className="display-title text-[42px] leading-none">Nourish</h1>
      <p className="mb-6 mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>
         Log meals, correct portions, and see what is left today.
      </p>

      <a
        href={`/api/auth/google?next=${encodeURIComponent(next)}`}
        className="btn-primary flex w-full items-center justify-center gap-3"
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-white text-base font-bold text-neutral-700" aria-hidden="true">
          G
        </span>
        Continue with Google
      </a>
      <p className="mt-4 text-center text-sm leading-6" style={{ color: 'var(--color-tx2)' }}>
        New here? Your account will be created when you continue.
      </p>

      {callbackFailed && (
        <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>
          Google sign-in could not be completed. Please try again.
        </p>
      )}
      </section>
    </main>
  )
}

function MacroMark() {
  return (
    <span className="flex h-6 items-end gap-1">
      <span className="h-4 w-1.5 rounded-full bg-white" />
      <span className="h-6 w-1.5 rounded-full bg-white" />
      <span className="h-3 w-1.5 rounded-full bg-white" />
    </span>
  )
}

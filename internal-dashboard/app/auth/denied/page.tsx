import { LogoutButton } from '@/components/logout-button'

export default function AccessDeniedPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
      <p className="text-xs font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--color-danger)' }}>
        Access denied
      </p>
      <h1 className="mt-3 text-2xl font-semibold">Administrator account required</h1>
      <p className="mt-3 text-sm leading-6" style={{ color: 'var(--color-tx2)' }}>
        You are signed in, but this account does not have the backend admin role.
        Sign out to use a different account.
      </p>
      <div className="mx-auto mt-6">
        <LogoutButton />
      </div>
    </main>
  )
}

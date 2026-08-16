'use client'

import { useState } from 'react'

export function LogoutButton({ className = '' }: { className?: string }) {
  const [busy, setBusy] = useState(false)

  const logout = async () => {
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      window.location.assign('/auth/login')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={logout}
      className={`rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50 ${className}`}
      style={{ borderColor: 'var(--color-line)', color: 'var(--color-tx2)' }}
    >
      {busy ? 'Signing out...' : 'Sign out'}
    </button>
  )
}

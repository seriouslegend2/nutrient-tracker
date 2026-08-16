'use client'

import { useState } from 'react'

import { clearDashboardStorage } from '@/lib/dashboard-storage'

export function LogoutButton({ className = '' }: { className?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const logout = async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      if (!response.ok) throw new Error('Sign out failed')
      clearDashboardStorage()
      window.location.assign('/auth/login')
    } catch {
      setError('Could not sign out. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="text-right">
    <button
      type="button"
      disabled={busy}
      onClick={logout}
      className={`control-button whitespace-nowrap disabled:opacity-50 ${className}`}
      style={{ color: 'var(--color-tx2)' }}
    >
      {busy ? 'Signing out...' : 'Sign out'}
    </button>
    {error && <p role="alert" className="mt-1 max-w-40 text-xs" style={{ color: 'var(--color-danger)' }}>{error}</p>}
  </div>
}

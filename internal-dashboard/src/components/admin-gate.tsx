'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'

import { getJson, ApiError } from '@/lib/client-api'

type Me = {
  id: string
  email: string | null
  roles: string[]
}

export function AdminGate({ children }: { children: React.ReactNode }) {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => getJson<Me>('/me'),
    retry: false,
  })

  const isAdmin = me.data?.roles.includes('admin') ?? false

  useEffect(() => {
    if (me.data && !isAdmin) window.location.replace('/auth/denied')
    if (me.error instanceof ApiError && me.error.status === 403) {
      window.location.replace('/auth/denied')
    }
  }, [isAdmin, me.data, me.error])

  if (me.isPending || (me.data && !isAdmin)) {
    return (
      <main className="grid min-h-screen place-items-center text-sm" style={{ color: 'var(--color-tx2)' }}>
        Verifying administrator access...
      </main>
    )
  }

  if (me.error) {
    if (me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403)) {
      return null
    }
    return (
      <main className="mx-auto max-w-md px-6 py-24 text-center">
        <h1 className="text-xl font-semibold">Unable to verify access</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>
          {me.error instanceof Error ? me.error.message : 'The backend did not respond.'}
        </p>
        <button
          onClick={() => void me.refetch()}
          className="mt-5 rounded-lg px-4 py-2 text-sm"
          style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        >
          Try again
        </button>
      </main>
    )
  }

  return children
}

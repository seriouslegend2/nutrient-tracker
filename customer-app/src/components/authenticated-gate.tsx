'use client'

import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect } from 'react'

import { api } from '@/lib/api-client'

export function AuthenticatedGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const isPublic = pathname.startsWith('/auth')
  const isOnboarding = pathname === '/onboarding'
  const { data, error, isPending } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    enabled: !isPublic,
    retry: false,
  })

  useEffect(() => {
    if (!isPublic && !isOnboarding && data && !data.onboarding_complete) {
      router.replace('/onboarding')
    }
  }, [data, isOnboarding, isPublic, router])

  if (isPublic || isOnboarding) return children
  if (isPending || (data && !data.onboarding_complete)) {
    return (
      <main className="grid min-h-screen place-items-center px-6 text-sm" style={{ color: 'var(--color-tx2)' }}>
        Loading your profile…
      </main>
    )
  }
  if (error) {
    return (
      <main className="grid min-h-screen place-items-center px-6 text-center text-sm" role="alert">
        We could not load your profile. Refresh to try again.
      </main>
    )
  }
  return children
}

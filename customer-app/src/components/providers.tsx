'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

import { ApiRequestError } from '@/lib/api-client'
import { AuthenticatedGate } from '@/components/authenticated-gate'

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (count, error) => {
              // Never retry an auth failure - it will never succeed, and the
              // redirect has already been triggered by the client.
              if (error instanceof ApiRequestError && error.status === 401) return false
              return count < 2
            },
          },
          mutations: { retry: 0 },
        },
      })
  )
  return (
    <QueryClientProvider client={client}>
      <AuthenticatedGate>{children}</AuthenticatedGate>
    </QueryClientProvider>
  )
}

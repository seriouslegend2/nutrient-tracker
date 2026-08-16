'use client'

import { dehydrate, hydrate, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { DASHBOARD_QUERY_CACHE_KEY } from '@/lib/dashboard-storage'

const CACHE_MAX_AGE_MS = 10 * 60_000

function createDashboardClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => {
          if (error instanceof Error && 'status' in error && error.status === 401) return false
          return count < 2
        },
      },
      mutations: { retry: 0 },
    },
  })

  if (typeof window !== 'undefined') {
    try {
      const persisted = JSON.parse(window.sessionStorage.getItem(DASHBOARD_QUERY_CACHE_KEY) ?? 'null') as {
        savedAt?: number
        state?: Parameters<typeof hydrate>[1]
      } | null
      if (persisted?.savedAt && persisted.state && Date.now() - persisted.savedAt < CACHE_MAX_AGE_MS) {
        hydrate(client, persisted.state)
      } else {
        window.sessionStorage.removeItem(DASHBOARD_QUERY_CACHE_KEY)
      }
    } catch {
      window.sessionStorage.removeItem(DASHBOARD_QUERY_CACHE_KEY)
    }
  }

  return client
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(createDashboardClient)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = client.getQueryCache().subscribe(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const state = dehydrate(client, {
          shouldDehydrateQuery: (query) => query.state.status === 'success' && query.queryKey[0] === 'admin',
        })
        try {
          window.sessionStorage.setItem(
            DASHBOARD_QUERY_CACHE_KEY,
            JSON.stringify({ savedAt: Date.now(), state }),
          )
        } catch {
          window.sessionStorage.removeItem(DASHBOARD_QUERY_CACHE_KEY)
        }
      }, 100)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [client])

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

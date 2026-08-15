/**
 * Supabase server client. SERVER-ONLY.
 *
 * The browser never gets a Supabase client. Auth tokens are carried only in
 * secure, httpOnly cookies and data calls go through same-origin /api routes.
 * Middleware is responsible for refreshing those cookies before they expire.
 */

import { createServerClient, type SetAllCookies } from '@supabase/ssr'
import { cookies } from 'next/headers'

import { authCookieOptions } from '@/lib/auth'

export async function createClient() {
  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Fail CLOSED. Missing config must not silently skip the auth check -
  // fail-open middleware is an outage that looks like everything working.
  if (!url || !anonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required'
    )
  }

  return createServerClient(url, anonKey, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list: Parameters<SetAllCookies>[0]) => {
        try {
          list.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, { ...options, ...authCookieOptions })
          )
        } catch {
          // Called from a Server Component: middleware refreshes the session.
        }
      },
    },
  })
}

export async function getUser() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return data.user
}

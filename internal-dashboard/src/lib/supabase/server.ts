/**
 * Supabase server client. SERVER-ONLY.
 *
 * The browser never creates a Supabase client. Session cookies are httpOnly,
 * and browser data calls go through same-origin /api/* route handlers.
 */

import { createServerClient, type SetAllCookies } from '@supabase/ssr'
import { cookies } from 'next/headers'

import { getSupabaseConfig, SUPABASE_COOKIE_OPTIONS } from '@/lib/supabase/config'

export async function createClient() {
  const cookieStore = await cookies()
  const { url, anonKey } = getSupabaseConfig()

  return createServerClient(url, anonKey, {
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list: Parameters<SetAllCookies>[0]) => {
        try {
          list.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        } catch {
          // Server Components cannot write cookies. Middleware persists refreshes;
          // auth route handlers use this same client in a writable cookie context.
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

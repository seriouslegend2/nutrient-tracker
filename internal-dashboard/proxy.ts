import { createServerClient, type SetAllCookies } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

import { safeNext } from '@/lib/auth'
import { getSupabaseConfig, SUPABASE_COOKIE_OPTIONS } from '@/lib/supabase/config'

/**
 * Auth gate + security headers.
 *
 * Fails CLOSED: missing config throws rather than skipping the check.
 */
export async function proxy(request: NextRequest) {
  const { url, anonKey } = getSupabaseConfig()

  let response = NextResponse.next({ request })

  const supabase = createServerClient(url, anonKey, {
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list: Parameters<SetAllCookies>[0]) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        list.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        )
      },
    },
  })

  const { data: { user } } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  const isPublic =
    path.startsWith('/auth') || path.startsWith('/_next') || path === '/favicon.ico'
  const isApi = path.startsWith('/api')

  // Redirect page requests. API routes return their own JSON 401s.
  if (!user && !isPublic && !isApi) {
    const redirect = request.nextUrl.clone()
    redirect.pathname = '/auth/login'
    redirect.searchParams.set('next', safeNext(`${path}${request.nextUrl.search}`))
    return NextResponse.redirect(redirect)
  }

  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}

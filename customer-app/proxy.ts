import { createServerClient, type SetAllCookies } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

import { authCookieOptions, safeRedirectPath } from '@/lib/auth'

/**
 * Auth gate + security headers.
 *
 * Fails CLOSED: missing config throws rather than skipping the check.
 */
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error('Supabase configuration is required')
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(url, anonKey, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list: Parameters<SetAllCookies>[0]) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        list.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, { ...options, ...authCookieOptions })
        )
      },
    },
  })

  const { data: { user } } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  const isPublic =
    path === '/auth/login' || path === '/auth/callback' ||
    path.startsWith('/_next') || path === '/favicon.ico' || path === '/manifest.webmanifest'
  const isApi = path.startsWith('/api')

  if (user && path === '/auth/login') {
    return redirectWithCookies(
      response,
      new URL(safeRedirectPath(request.nextUrl.searchParams.get('next')), request.url)
    )
  }

  // Redirect page requests. API routes return their own JSON 401s.
  if (!user && !isPublic && !isApi) {
    const redirect = request.nextUrl.clone()
    redirect.pathname = '/auth/login'
    redirect.search = ''
    redirect.searchParams.set('next', `${path}${request.nextUrl.search}`)
    return redirectWithCookies(response, redirect)
  }

  setSecurityHeaders(response)
  return response
}

function redirectWithCookies(response: NextResponse, destination: URL) {
  const redirect = NextResponse.redirect(destination)
  response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie))
  setSecurityHeaders(redirect)
  return redirect
}

function setSecurityHeaders(response: NextResponse) {
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}

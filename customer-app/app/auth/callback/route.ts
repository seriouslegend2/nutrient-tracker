import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { safeRedirectPath } from '@/lib/auth'

/** Exchanges a PKCE confirmation code server-side and sets httpOnly cookies. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const next = safeRedirectPath(request.nextUrl.searchParams.get('next'))

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(next, request.url))
  }
  const login = new URL('/auth/login', request.url)
  login.searchParams.set('error', 'auth_failed')
  login.searchParams.set('next', next)
  return NextResponse.redirect(login)
}

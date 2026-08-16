import { NextRequest, NextResponse } from 'next/server'

import { safeNext } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const next = safeNext(request.nextUrl.searchParams.get('next'))

  if (code) {
    try {
      const supabase = await createClient()
      const { error } = await supabase.auth.exchangeCodeForSession(code)
      if (!error) return NextResponse.redirect(new URL(next, request.nextUrl.origin))
    } catch (error) {
      console.error('[auth] Google callback failed', { error: String(error) })
    }
  }

  const login = new URL('/auth/login', request.url)
  login.searchParams.set('error', 'google_auth_failed')
  login.searchParams.set('next', next)
  return NextResponse.redirect(login)
}

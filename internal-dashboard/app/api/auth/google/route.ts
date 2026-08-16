import { NextRequest, NextResponse } from 'next/server'

import { safeNext } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

function loginRedirect(request: NextRequest, next: string, error: string) {
  const login = new URL('/auth/login', request.url)
  login.searchParams.set('error', error)
  login.searchParams.set('next', next)
  return NextResponse.redirect(login)
}

export async function GET(request: NextRequest) {
  const next = safeNext(request.nextUrl.searchParams.get('next'))
  const callback = new URL('/auth/callback', request.nextUrl.origin)
  callback.searchParams.set('next', next)

  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callback.toString(),
        queryParams: { prompt: 'select_account' },
      },
    })

    if (error || !data.url) return loginRedirect(request, next, 'google_auth_failed')
    return NextResponse.redirect(data.url)
  } catch (error) {
    console.error('[auth] Google sign-in failed', { error: String(error) })
    return loginRedirect(request, next, 'auth_unavailable')
  }
}

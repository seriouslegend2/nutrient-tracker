import { NextRequest, NextResponse } from 'next/server'

import { publicOrigin, safeRedirectPath } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const next = safeRedirectPath(request.nextUrl.searchParams.get('next'))
  const callback = new URL('/auth/callback', publicOrigin(request))
  callback.searchParams.set('next', next)

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: callback.toString(),
      queryParams: { prompt: 'select_account' },
    },
  })

  if (error || !data.url) {
    const login = new URL('/auth/login', publicOrigin(request))
    login.searchParams.set('error', 'google_auth_failed')
    login.searchParams.set('next', next)
    return NextResponse.redirect(login)
  }

  return NextResponse.redirect(data.url)
}

import { NextRequest, NextResponse } from 'next/server'

import { safeNext } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

function loginRedirect(request: NextRequest, next: string, error: string) {
  const login = new URL('/auth/login', request.url)
  login.searchParams.set('error', error)
  login.searchParams.set('next', next)
  return NextResponse.redirect(login, { status: 303 })
}

export async function POST(request: NextRequest) {
  const form = await request.formData()
  const emailValue = form.get('email')
  const passwordValue = form.get('password')
  const nextValue = form.get('next')
  const email = typeof emailValue === 'string' ? emailValue.trim() : ''
  const password = typeof passwordValue === 'string' ? passwordValue : ''
  const next = safeNext(typeof nextValue === 'string' ? nextValue : undefined)

  if (!email || !password) {
    return loginRedirect(request, next, 'missing_credentials')
  }

  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) return loginRedirect(request, next, 'invalid_credentials')
    return NextResponse.redirect(new URL(next, request.nextUrl.origin), { status: 303 })
  } catch (error) {
    console.error('[auth] password sign-in failed', { error: String(error) })
    return loginRedirect(request, next, 'auth_unavailable')
  }
}

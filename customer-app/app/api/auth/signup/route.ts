import { NextRequest, NextResponse } from 'next/server'

import { safeRedirectPath, validateAuthCredentials } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null)
  const validated = validateAuthCredentials(body)

  if ('error' in validated) {
    return NextResponse.json({ detail: validated.error }, { status: 400 })
  }

  const next = safeRedirectPath(
    typeof (body as Record<string, unknown>).next === 'string'
      ? (body as Record<string, string>).next
      : null
  )
  const callback = new URL('/auth/callback', request.nextUrl.origin)
  callback.searchParams.set('next', next)

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    ...validated.credentials,
    options: { emailRedirectTo: callback.toString() },
  })

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 400 })
  }

  if (data.session) {
    return NextResponse.json({ status: 'authenticated', next }, { status: 201 })
  }

  return NextResponse.json(
    {
      status: 'confirmation_required',
      message: 'Check your email for a confirmation link, then return here to sign in.',
    },
    { status: 201 }
  )
}

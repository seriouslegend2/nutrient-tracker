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
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword(validated.credentials)

  if (error) {
    return NextResponse.json(
      { detail: 'Email or password is incorrect.' },
      { status: 401 }
    )
  }

  return NextResponse.json({ status: 'authenticated', next })
}

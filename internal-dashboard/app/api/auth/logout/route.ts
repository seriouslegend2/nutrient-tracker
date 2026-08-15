import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    await supabase.auth.signOut({ scope: 'local' })
  } catch (error) {
    console.error('[auth] sign out failed', { error: String(error) })
  }

  return NextResponse.redirect(new URL('/auth/login', request.url), { status: 303 })
}

import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'

export async function POST() {
  try {
    const supabase = await createClient()
    await supabase.auth.signOut({ scope: 'local' })
  } catch (error) {
    console.error('[auth] sign out failed', { error: String(error) })
  }

  return new NextResponse(null, { status: 204 })
}

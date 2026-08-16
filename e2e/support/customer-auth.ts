import type { BrowserContext } from '@playwright/test'

import { CUSTOMER_URL, projectRef, required } from './environment'

const COOKIE_CHUNK_SIZE = 3180

export async function installCustomerSession(
  context: BrowserContext,
  email: string,
  password: string,
): Promise<void> {
  const supabaseUrl = required('SUPABASE_URL').replace(/\/$/, '')
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: required('SUPABASE_ANON_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    throw new Error(`Supabase fixture sign-in failed with HTTP ${response.status}.`)
  }

  const session = await response.json()
  const encoded = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
  const baseName = `sb-${projectRef(supabaseUrl)}-auth-token`
  const values = Array.from(
    { length: Math.ceil(encoded.length / COOKIE_CHUNK_SIZE) },
    (_, index) => encoded.slice(index * COOKIE_CHUNK_SIZE, (index + 1) * COOKIE_CHUNK_SIZE),
  )
  await context.addCookies(values.map((value, index) => ({
    name: values.length === 1 ? baseName : `${baseName}.${index}`,
    value,
    url: CUSTOMER_URL,
    httpOnly: false,
    sameSite: 'Lax' as const,
    secure: CUSTOMER_URL.startsWith('https://'),
  })))
}

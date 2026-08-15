import type { Metadata } from 'next'

import { LoginForm } from '@/components/login-form'
import { safeNext } from '@/lib/auth'

export const metadata: Metadata = { title: 'Sign in · Nutrient Tracker' }

type Props = {
  searchParams: Promise<{ next?: string; error?: string }>
}

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams
  return <LoginForm next={safeNext(params.next)} error={params.error} />
}

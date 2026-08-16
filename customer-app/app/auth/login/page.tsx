import type { Metadata } from 'next'
import { Suspense } from 'react'

import { LoginClient } from '@/components/login-client'

export const metadata: Metadata = { title: 'Continue with Google · Nutrient Tracker' }

export default function LoginPage() {
  return <Suspense><LoginClient /></Suspense>
}

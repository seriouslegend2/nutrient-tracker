import type { Metadata } from 'next'
import { Suspense } from 'react'

import { LoginClient } from '@/components/login-client'

export const metadata: Metadata = { title: 'Log in or sign up · Nutrient Tracker' }

export default function LoginPage() {
  return <Suspense><LoginClient /></Suspense>
}

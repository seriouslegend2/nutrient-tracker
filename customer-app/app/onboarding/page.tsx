import type { Metadata } from 'next'
import { Suspense } from 'react'

import { OnboardingClient } from '@/components/onboarding-client'

export const metadata: Metadata = { title: 'Welcome · Nutrient Tracker' }
export const dynamic = 'force-dynamic'

export default function OnboardingPage() {
  return (
    <Suspense>
      <OnboardingClient />
    </Suspense>
  )
}

import type { Metadata } from 'next'

import { HomeClient } from '@/components/home-client'

export const metadata: Metadata = { title: 'Home · Nutrient Tracker' }
// Protected pages must never be statically cached.
export const dynamic = 'force-dynamic'

export default function HomePage() {
  return <HomeClient />
}

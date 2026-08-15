import type { Metadata } from 'next'

import { AboutClient } from '@/components/about-client'

export const metadata: Metadata = { title: 'About · Nutrient Tracker' }
export const dynamic = 'force-dynamic'

export default function AboutPage() {
  return <AboutClient />
}

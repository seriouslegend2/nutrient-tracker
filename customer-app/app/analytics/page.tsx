import type { Metadata } from 'next'

import { AnalyticsClient } from '@/components/analytics-client'

export const metadata: Metadata = { title: 'Analytics · Nutrient Tracker' }
export const dynamic = 'force-dynamic'

export default function AnalyticsPage() {
  return <AnalyticsClient />
}

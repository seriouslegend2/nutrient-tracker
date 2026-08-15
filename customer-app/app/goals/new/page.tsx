import type { Metadata } from 'next'

import { GoalPageClient } from '@/components/goal-page-client'

export const metadata: Metadata = { title: 'Set a goal · Nutrient Tracker' }
export const dynamic = 'force-dynamic'

export default function GoalPage() {
  return <GoalPageClient />
}

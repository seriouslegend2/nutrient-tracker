import type { Metadata } from 'next'

import { MealsClient } from '@/components/meals-client'

export const metadata: Metadata = { title: 'Meals · Nutrient Tracker' }
export const dynamic = 'force-dynamic'

export default function MealsPage() {
  return <MealsClient />
}

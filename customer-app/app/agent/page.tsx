import type { Metadata } from 'next'

import { AgentClient } from '@/components/agent-client'

export const metadata: Metadata = { title: 'Agent · Nutrient Tracker' }
export const dynamic = 'force-dynamic'

export default function AgentPage() {
  return <AgentClient />
}

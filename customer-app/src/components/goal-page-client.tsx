'use client'

import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'

import { GoalSetup } from '@/components/goal-setup'
import { api } from '@/lib/api-client'

export function GoalPageClient() {
  const router = useRouter()
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me })
  return (
    <main className="app-shell min-h-screen px-5 pt-8">
      <button onClick={() => router.back()} className="mb-6 text-sm" style={{ color: 'var(--color-accent)' }}>Back</button>
      <GoalSetup isPregnantOrNursing={me?.profile?.is_pregnant_or_nursing}
                 hasMedicalCondition={me?.profile?.has_medical_condition}
                 onCreated={() => router.replace('/home')} />
    </main>
  )
}

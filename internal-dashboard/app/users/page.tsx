import type { Metadata } from 'next'

import { AdminGate } from '@/components/admin-gate'
import { UsersClient } from '@/components/users-client'

export const metadata: Metadata = { title: 'Users · Admin' }
export const dynamic = 'force-dynamic'

export default function UsersPage() {
  return (
    <AdminGate>
      <UsersClient />
    </AdminGate>
  )
}

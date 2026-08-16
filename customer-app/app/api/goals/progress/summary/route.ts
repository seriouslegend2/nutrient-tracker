import { API } from '@/lib/config/api'
import { proxyRoute } from '@/lib/proxy'

export const { GET } = proxyRoute(API.paths.goalProgressSummary)

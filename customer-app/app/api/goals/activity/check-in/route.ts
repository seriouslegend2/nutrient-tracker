import { API } from '@/lib/config/api'
import { proxyRoute } from '@/lib/proxy'

export const { POST } = proxyRoute(API.paths.goalActivityCheckIn)

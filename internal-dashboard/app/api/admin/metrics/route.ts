// Auto-generated BFF proxy. Admin-gated on the BACKEND via READ_ANY_USER;
// this layer only proves the caller has a session.
import { API } from '@/lib/config/api'
import { proxyRoute } from '@/lib/proxy'

export const { GET, POST, PUT, PATCH, DELETE } = proxyRoute(API.paths.metrics)

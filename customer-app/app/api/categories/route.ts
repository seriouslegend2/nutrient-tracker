// Auto-generated BFF proxy. Auth-checked, forwards method + body + query,
// no transforms. The browser calls THIS, never the backend directly.
import { API } from '@/lib/config/api'
import { proxyRoute } from '@/lib/proxy'

export const { GET, POST, PUT, PATCH, DELETE } = proxyRoute(API.paths.categories)

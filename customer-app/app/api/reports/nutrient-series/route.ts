// Auth-checked BFF proxy. The browser never calls the backend directly.
import { API } from '@/lib/config/api'
import { proxyRoute } from '@/lib/proxy'

export const { GET, POST, PUT, PATCH, DELETE } = proxyRoute(API.paths.reportNutrientSeries)

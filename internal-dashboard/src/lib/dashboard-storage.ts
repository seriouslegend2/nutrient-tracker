export const DASHBOARD_QUERY_CACHE_KEY = 'nutrient-admin-query-cache-v1'
export const DASHBOARD_STATE_KEY = 'nutrient-admin-navigation-v1'

export function clearDashboardStorage() {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(DASHBOARD_QUERY_CACHE_KEY)
  window.localStorage.removeItem(DASHBOARD_STATE_KEY)
}

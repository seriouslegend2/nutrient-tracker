export const CUSTOMER_URL = process.env.E2E_CUSTOMER_URL ?? 'http://localhost:3000'
export const DASHBOARD_URL = process.env.E2E_DASHBOARD_URL ?? 'http://localhost:3001'
export const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8000'

export function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`[E2E configuration] ${name} is required and must not be committed.`)
  return value
}

export function nonAdminEmail(email: string): string {
  const separator = email.lastIndexOf('@')
  if (separator < 1) throw new Error('[E2E configuration] E2E_EMAIL must be a valid email address.')
  const local = email.slice(0, separator).replace(/\+.*$/, '')
  return `${local}+nutrient-e2e-non-admin${email.slice(separator)}`
}

export function projectRef(urlValue: string | undefined): string {
  if (!urlValue) return 'not provided'
  try {
    const hostname = new URL(urlValue).hostname
    return hostname.endsWith('.supabase.co') ? hostname.split('.')[0] : hostname
  } catch {
    return 'invalid SUPABASE_URL'
  }
}

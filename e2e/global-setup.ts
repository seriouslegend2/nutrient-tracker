import fs from 'node:fs/promises'
import path from 'node:path'

import type { FullConfig } from '@playwright/test'

import {
  BACKEND_URL,
  CUSTOMER_URL,
  DASHBOARD_URL,
  nonAdminEmail,
  projectRef,
  required,
} from './support/environment'

type AuthUser = { id: string; email?: string }

const root = path.resolve(__dirname, '..')
const metadataFile = path.join(root, 'artifacts/e2e/runtime/run-metadata.json')
const screenshotsDir = path.join(root, 'artifacts/e2e/screenshots')

const TABLE_MIGRATIONS: Record<string, string> = {
  app_users: '20260815100100_users_and_profiles.sql',
  user_roles: '20260815100100_users_and_profiles.sql',
  user_profiles: '20260815100100_users_and_profiles.sql',
  body_metrics: '20260815100100_users_and_profiles.sql',
  dish_global: '20260815100200_dishes_and_portions.sql',
  dish_household: '20260815100200_dishes_and_portions.sql',
  category_global: '20260815100200_dishes_and_portions.sql',
  category_household: '20260815100200_dishes_and_portions.sql',
  meals: '20260815100300_meals.sql',
  goals: '20260815100400_goals_and_logs.sql',
  user_preferences: '20260815100400_goals_and_logs.sql',
  water_logs: '20260815100400_goals_and_logs.sql',
  activity_logs: '20260816130000_multi_goal_cadence.sql',
  communication_master: '20260815100400_goals_and_logs.sql',
  agent_runs: '20260815100400_goals_and_logs.sql',
  agent_actions: '20260816220000_agent_actions.sql',
  audit_log: '20260815100400_goals_and_logs.sql',
}

const REQUIRED_RPCS: Record<string, string> = {
  is_admin: '20260815100800_rls_policies.sql',
  fn_refresh_user_profile: '20260816110000_backend_database_remediation.sql',
  fn_resolve_goal_targets: '20260816110000_backend_database_remediation.sql',
  fn_resolve_portion: '20260815100700_lookup_chain_and_triggers.sql',
  fn_goal_progress: '20260815100700_lookup_chain_and_triggers.sql',
  fn_create_goal: '20260816110000_backend_database_remediation.sql',
  fn_set_goal_active: '20260816110000_backend_database_remediation.sql',
  fn_resolve_goal_targets_v2: '20260816130000_multi_goal_cadence.sql',
  fn_create_goal_v2: '20260816130000_multi_goal_cadence.sql',
  fn_set_goal_active_v2: '20260816130000_multi_goal_cadence.sql',
  fn_set_goal_primary: '20260816130000_multi_goal_cadence.sql',
  fn_replace_meal_day: '20260816110000_backend_database_remediation.sql',
  fn_version_meal_item: '20260816110000_backend_database_remediation.sql',
  fn_upsert_preference: '20260816110000_backend_database_remediation.sql',
  fn_set_dish_household: '20260816110000_backend_database_remediation.sql',
  fn_set_category_household: '20260816110000_backend_database_remediation.sql',
  fn_create_agent_action: '20260816220000_agent_actions.sql',
  fn_confirm_agent_action: '20260816220000_agent_actions.sql',
  fn_execute_meal_agent_action: '20260817100000_atomic_meal_agent_actions.sql',
  fn_append_meal_item: '20260817100000_atomic_meal_agent_actions.sql',
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const startedAt = new Date().toISOString()
  await clearPreviousScreenshots()
  await writeMetadata({ startedAt, status: 'setting-up' })

  let serviceKey = ''
  let password = ''
  try {
    const supabaseUrl = required('SUPABASE_URL').replace(/\/$/, '')
    serviceKey = required('SUPABASE_SERVICE_ROLE_KEY')
    const email = required('E2E_EMAIL').toLowerCase()
    password = required('E2E_PASSWORD')
    if (password.length < 6) throw new Error('[E2E configuration] E2E_PASSWORD must contain at least 6 characters.')

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    }

    // Validate the hosted contract before changing any auth user or product row.
    await assertSchema(supabaseUrl, headers)
    await assertServices()
    const primary = await ensureAuthUser(supabaseUrl, headers, email, password)
    const denialEmail = nonAdminEmail(email)
    const nonAdmin = await ensureAuthUser(supabaseUrl, headers, denialEmail, password)

    await ensureBootstrap(supabaseUrl, headers, primary, true)
    await ensureBootstrap(supabaseUrl, headers, nonAdmin, false)
    await resetOnboarding(supabaseUrl, headers, primary.id)
    await resetE2EGoals(supabaseUrl, headers, primary.id)
    await removeStaleE2EMeals(supabaseUrl, headers, primary.id)

    await writeMetadata({
      startedAt,
      setupFinishedAt: new Date().toISOString(),
      status: 'ready',
      projectRef: projectRef(supabaseUrl),
      environment: { customer: CUSTOMER_URL, dashboard: DASHBOARD_URL, backend: BACKEND_URL },
    })
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), [serviceKey, password])
    await writeMetadata({
      startedAt,
      setupFinishedAt: new Date().toISOString(),
      status: 'failed',
      projectRef: projectRef(process.env.SUPABASE_URL),
      environment: { customer: CUSTOMER_URL, dashboard: DASHBOARD_URL, backend: BACKEND_URL },
      blocker: message,
    })
    throw new Error(message)
  }
}

async function ensureAuthUser(
  base: string,
  headers: Record<string, string>,
  email: string,
  password: string,
): Promise<AuthUser> {
  let page = 1
  let found: AuthUser | undefined
  while (!found) {
    const response = await fetch(`${base}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers })
    const body = await responseJson(response)
    if (!response.ok) throw requestFailure('Supabase Auth Admin user lookup', response, body)
    const users = Array.isArray(body) ? body : asRecord(body).users
    if (!Array.isArray(users)) throw new Error('[E2E setup] Supabase Auth Admin returned an unexpected users response.')
    found = users.find((user) => asRecord(user).email?.toString().toLowerCase() === email) as AuthUser | undefined
    if (found || users.length < 1000) break
    page += 1
  }

  const payload = JSON.stringify({ email, password, email_confirm: true })
  if (!found) {
    const response = await fetch(`${base}/auth/v1/admin/users`, { method: 'POST', headers, body: payload })
    const body = await responseJson(response)
    if (!response.ok) {
      throw requestFailure(
        'Supabase Auth Admin user creation (a database error here can mean the auth bootstrap migration is partially applied)',
        response,
        body,
      )
    }
    found = body as AuthUser
  } else {
    const response = await fetch(`${base}/auth/v1/admin/users/${found.id}`, { method: 'PUT', headers, body: payload })
    const body = await responseJson(response)
    if (!response.ok) throw requestFailure('Supabase Auth Admin user confirmation/password update', response, body)
    found = body as AuthUser
  }
  if (!found?.id) throw new Error('[E2E setup] Supabase Auth Admin did not return a user id.')
  return found
}

async function assertSchema(base: string, headers: Record<string, string>): Promise<void> {
  const missing: string[] = []
  for (const [table, migration] of Object.entries(TABLE_MIGRATIONS)) {
    const response = await fetch(`${base}/rest/v1/${table}?select=*&limit=0`, { headers })
    if (response.ok) continue
    const body = await responseJson(response)
    if (response.status === 404 || ['42P01', 'PGRST205'].includes(String(asRecord(body).code))) {
      missing.push(`${table} (${migration})`)
      continue
    }
    throw requestFailure(`PostgREST schema probe for ${table}`, response, body)
  }

  const openApiResponse = await fetch(`${base}/rest/v1/`, { headers: { ...headers, Accept: 'application/openapi+json' } })
  const openApi = await responseJson(openApiResponse)
  if (!openApiResponse.ok) throw requestFailure('PostgREST OpenAPI schema probe', openApiResponse, openApi)
  const paths = asRecord(openApi).paths
  const missingRpcs = Object.entries(REQUIRED_RPCS)
    .filter(([rpc]) => !asRecord(paths)[`/rpc/${rpc}`])
    .map(([rpc, migration]) => `${rpc} (${migration})`)

  if (missing.length || missingRpcs.length) {
    const details = [...missing.map((item) => `table ${item}`), ...missingRpcs.map((item) => `RPC ${item}`)]
    throw new Error(`[E2E hosted schema blocker] Required migrations are not applied or not visible to PostgREST: ${details.join(', ')}. Run "supabase db push" against the hosted project before executing real E2E.`)
  }
}

async function ensureBootstrap(
  base: string,
  headers: Record<string, string>,
  user: AuthUser,
  admin: boolean,
): Promise<void> {
  await restWrite(base, headers, 'app_users?on_conflict=id', 'POST', { id: user.id, email: user.email }, 'resolution=merge-duplicates')
  await restWrite(base, headers, 'user_roles?on_conflict=user_id,role', 'POST', { user_id: user.id, role: 'customer' }, 'resolution=ignore-duplicates')
  if (admin) {
    await restWrite(base, headers, 'user_roles?on_conflict=user_id,role', 'POST', { user_id: user.id, role: 'admin' }, 'resolution=ignore-duplicates')
  } else {
    await restWrite(base, headers, `user_roles?user_id=eq.${user.id}&role=eq.admin`, 'DELETE', undefined)
  }
}

async function resetOnboarding(base: string, headers: Record<string, string>, userId: string): Promise<void> {
  await restWrite(base, headers, `user_profiles?user_id=eq.${userId}`, 'PATCH', { onboarding_completed_at: null })
}

async function resetE2EGoals(base: string, headers: Record<string, string>, userId: string): Promise<void> {
  await restWrite(base, headers, `goals?user_id=eq.${userId}&is_active=eq.true`, 'PATCH', {
    is_active: false,
    is_primary: false,
    status: 'abandoned',
  })
  await restWrite(base, headers, `activity_logs?user_id=eq.${userId}`, 'DELETE')
}

async function removeStaleE2EMeals(base: string, headers: Record<string, string>, userId: string): Promise<void> {
  const prefix = encodeURIComponent('E2E free text%')
  await restWrite(base, headers, `meals?user_id=eq.${userId}&dish_name=like.${prefix}`, 'DELETE')
}

async function restWrite(
  base: string,
  headers: Record<string, string>,
  pathName: string,
  method: string,
  value?: unknown,
  prefer?: string,
): Promise<void> {
  const response = await fetch(`${base}/rest/v1/${pathName}`, {
    method,
    headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
    body: value === undefined ? undefined : JSON.stringify(value),
  })
  const body = await responseJson(response)
  if (!response.ok) throw requestFailure(`PostgREST ${method} ${pathName.split('?')[0]}`, response, body)
}

async function assertServices(): Promise<void> {
  const checks = [
    ['customer app', `${CUSTOMER_URL}/auth/login`],
    ['dashboard', `${DASHBOARD_URL}/auth/login`],
    ['FastAPI', `${BACKEND_URL}/docs`],
  ] as const
  for (const [name, url] of checks) {
    const deadline = Date.now() + 60_000
    let lastError = 'not ready'
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5_000) })
        if (response.ok) {
          lastError = ''
          break
        }
        lastError = `HTTP ${response.status}`
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    if (lastError) {
      throw new Error(`[E2E service blocker] ${name} is not reachable at ${url}: ${lastError}. Start all three real services before the hosted run.`)
    }
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { message: text.slice(0, 500) } }
}

function requestFailure(operation: string, response: Response, body: unknown): Error {
  const record = asRecord(body)
  const detail = record.message ?? record.msg ?? record.error_description ?? record.error ?? JSON.stringify(body)
  return new Error(`[E2E setup] ${operation} failed with HTTP ${response.status}: ${String(detail)}`)
}

function asRecord(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function redact(message: string, values: string[]): string {
  return values.filter(Boolean).reduce((result, value) => result.replaceAll(value, '[REDACTED]'), message)
}

async function writeMetadata(value: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(metadataFile), { recursive: true })
  await fs.writeFile(metadataFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function clearPreviousScreenshots(): Promise<void> {
  await fs.mkdir(screenshotsDir, { recursive: true })
  const entries = await fs.readdir(screenshotsDir, { withFileTypes: true })
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => fs.unlink(path.join(screenshotsDir, entry.name))))
}

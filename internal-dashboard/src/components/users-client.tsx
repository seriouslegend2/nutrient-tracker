'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { LogoutButton } from '@/components/logout-button'
import { ApiError, getJson } from '@/lib/client-api'
import { DASHBOARD_STATE_KEY } from '@/lib/dashboard-storage'
import { PANELS, type PanelId } from '@/lib/panels'

type Page<T> = {
  items: T[]
  total: number
  page: number
  page_size: number
  total_pages: number
  has_more: boolean
}

const USER_PAGE_SIZES = [20, 50, 100]
const PANEL_PAGE_SIZE = 20
const RESOLUTION_COLOURS = [
  'var(--color-accent)',
  'var(--color-protein)',
  'var(--color-carbs)',
  'var(--color-fat)',
  'var(--color-danger)',
]

type DashboardState = {
  page: number
  pageSize: number
  selected: string | null
  panel: PanelId
  panelPage: number
}

const DEFAULT_STATE: DashboardState = {
  page: 1,
  pageSize: 20,
  selected: null,
  panel: 'overview',
  panelPage: 1,
}

function positiveInteger(value: string | null | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isPanel(value: unknown): value is PanelId {
  return typeof value === 'string' && PANELS.some((item) => item.id === value)
}

function restoreDashboardState(): DashboardState {
  let saved: Partial<DashboardState> = {}
  try {
    saved = JSON.parse(window.localStorage.getItem(DASHBOARD_STATE_KEY) ?? '{}') as Partial<DashboardState>
  } catch {
    window.localStorage.removeItem(DASHBOARD_STATE_KEY)
  }
  const params = new URLSearchParams(window.location.search)
  const requestedPageSize = positiveInteger(params.get('page_size'), saved.pageSize ?? 20)
  const panel = params.get('panel') ?? saved.panel
  return {
    page: positiveInteger(params.get('page'), saved.page ?? 1),
    pageSize: USER_PAGE_SIZES.includes(requestedPageSize) ? requestedPageSize : 20,
    selected: params.get('user') ?? saved.selected ?? null,
    panel: isPanel(panel) ? panel : 'overview',
    panelPage: positiveInteger(params.get('panel_page'), saved.panelPage ?? 1),
  }
}

function persistDashboardState(state: DashboardState) {
  window.localStorage.setItem(DASHBOARD_STATE_KEY, JSON.stringify(state))
  const params = new URLSearchParams()
  if (state.page > 1) params.set('page', String(state.page))
  if (state.pageSize !== 20) params.set('page_size', String(state.pageSize))
  if (state.selected) params.set('user', state.selected)
  if (state.panel !== 'overview') params.set('panel', state.panel)
  if (state.panelPage > 1) params.set('panel_page', String(state.panelPage))
  const query = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}`,
  )
}

export function UsersClient() {
  const [ready, setReady] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [selected, setSelected] = useState<string | null>(null)
  const [panel, setPanel] = useState<PanelId>('overview')
  const [panelPage, setPanelPage] = useState(1)

  useEffect(() => {
    const restored = restoreDashboardState()
    setPage(restored.page)
    setPageSize(restored.pageSize)
    setSelected(restored.selected)
    setPanel(restored.panel)
    setPanelPage(restored.panelPage)
    setReady(true)
  }, [])

  useEffect(() => {
    if (!ready) return
    persistDashboardState({ page, pageSize, selected, panel, panelPage })
  }, [ready, page, pageSize, selected, panel, panelPage])

  const users = useQuery({
    queryKey: ['admin', 'users', page, pageSize],
    queryFn: () => getJson<Page<AdminUser>>(`/admin/users?page=${page}&page_size=${pageSize}`),
    retry: false,
    placeholderData: (previous) => previous,
    enabled: ready,
  })

  const metrics = useQuery({
    queryKey: ['admin', 'metrics'],
    queryFn: () => getJson<Metrics>('/admin/metrics'),
    retry: false,
    enabled: ready,
  })

  const mix = useQuery({
    queryKey: ['admin', 'mix'],
    queryFn: () => getJson<ResolutionMix>('/admin/resolution-mix'),
    retry: false,
    enabled: ready,
  })

  if (!ready || users.isPending || !users.data) return <PageStatus>Restoring user operations...</PageStatus>

  if (users.error) {
    const denied = users.error instanceof ApiError && users.error.status === 403
    return (
      <main className="mx-auto max-w-md px-6 py-24 text-center">
        <h1 className="text-xl font-semibold">
          {denied ? 'Admin access required' : 'Users could not be loaded'}
        </h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>
          {denied
            ? 'The backend denied the read:any_user permission for this account.'
            : users.error.message}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          {!denied && (
            <button
              onClick={() => void users.refetch()}
              className="rounded-lg px-3 py-1.5 text-xs"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
            >
              Try again
            </button>
          )}
          <LogoutButton />
        </div>
      </main>
    )
  }

  const userPage = users.data

  return (
    <div className="dashboard-shell mx-auto max-w-[1540px] px-4 py-5 sm:px-6 lg:py-7">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.16em]" style={{ color: 'var(--color-accent)' }}>
            Internal dashboard
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Account operations</h1>
          <p className="mt-1 text-base" style={{ color: 'var(--color-tx2)' }}>Inspect customer records and system activity.</p>
        </div>
        <LogoutButton />
      </header>

      <MetricsSummary data={metrics.data} error={metrics.error} loading={metrics.isPending} />
      <ResolutionSummary data={mix.data} error={mix.error} loading={mix.isPending} />

      <div className="grid items-start gap-5 lg:grid-cols-[400px_minmax(0,1fr)] xl:grid-cols-[440px_minmax(0,1fr)]">
        <section className={`card min-w-0 overflow-hidden lg:sticky lg:top-5 lg:flex lg:max-h-[calc(100vh-2.5rem)] lg:flex-col ${selected ? 'hidden lg:flex' : ''}`}>
          <div className="flex items-end justify-between gap-3 border-b p-4 sm:p-5" style={{ borderColor: 'var(--color-line)' }}>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">Accounts</h2>
                {users.isFetching && <span role="status" className="text-sm" style={{ color: 'var(--color-tx2)' }}>Refreshing...</span>}
              </div>
              <p className="mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>
                Newest first. Select an account to inspect.
              </p>
            </div>
            <label className="text-xs" style={{ color: 'var(--color-tx2)' }}>
              <span className="sr-only">Accounts per page</span>
              <select
                aria-label="Accounts per page"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value))
                  setPage(1)
                  setSelected(null)
                  setPanel('overview')
                  setPanelPage(1)
                }}
                className="min-h-10 rounded-lg border bg-transparent px-2.5 text-sm"
                style={{ borderColor: 'var(--color-line)' }}
              >
                {USER_PAGE_SIZES.map((size) => <option key={size}>{size}</option>)}
              </select>
            </label>
          </div>

          {userPage.items.length ? (
            <div className="scroll-region min-h-0 flex-1 divide-y divide-[var(--color-line)] overflow-y-auto">
              {userPage.items.map((user) => {
                const profile = firstProfile(user.user_profiles)
                const title = user.display_name ?? user.email ?? 'Unnamed user'
                return (
                  <button
                    key={user.id}
                    type="button"
                    aria-pressed={selected === user.id}
                    onClick={() => {
                      setSelected(user.id)
                      setPanel('overview')
                      setPanelPage(1)
                    }}
                    className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3.5 text-left sm:px-5"
                    style={{ background: selected === user.id ? 'var(--color-accent-soft)' : undefined }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base font-semibold">{title}</span>
                      {user.email && user.email !== title && <span className="mt-0.5 block truncate text-sm" style={{ color: 'var(--color-tx2)' }}>{user.email}</span>}
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Status>{profile?.onboarding_completed_at ? 'Onboarded' : profile ? 'Incomplete' : 'No profile'}</Status>
                        {profile && <span className="truncate text-sm" style={{ color: 'var(--color-tx2)' }}>{[profile.activity, profile.diet].filter(Boolean).join(' / ') || 'No profile details'}</span>}
                      </span>
                      <span className="mt-1.5 block truncate font-mono text-xs" style={{ color: 'var(--color-tx2)' }}>{user.id}</span>
                    </span>
                    <span className="pt-0.5 text-right text-sm tabular-nums" style={{ color: 'var(--color-tx2)' }}>
                      <span className="block">Joined</span>
                      <span className="mt-0.5 block">{formatDate(user.created_at)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <EmptyState>No user accounts have been created.</EmptyState>
          )}

          <Pagination
            page={userPage.page}
            totalPages={userPage.total_pages}
            total={userPage.total}
            noun="users"
            disabled={users.isFetching}
            onPage={(nextPage) => {
              setPage(nextPage)
              setSelected(null)
              setPanel('overview')
              setPanelPage(1)
            }}
          />
        </section>

        {selected ? (
          <div className="min-w-0 lg:sticky lg:top-5">
            <button type="button" className="control-button mb-3 lg:hidden" onClick={() => setSelected(null)}>← Back to accounts</button>
            <UserWorkspace userId={selected} panel={panel} panelPage={panelPage}
              onPanel={(nextPanel) => { setPanel(nextPanel); setPanelPage(1) }} onPanelPage={setPanelPage} />
          </div>
        ) : (
          <section className="card hidden min-h-72 place-items-center p-10 text-center text-sm lg:grid" style={{ color: 'var(--color-tx2)' }}>
            Select a user to inspect their supported admin data.
          </section>
        )}
      </div>
    </div>
  )
}

function MetricsSummary({ data, error, loading }: { data?: Metrics; error: Error | null; loading: boolean }) {
  if (error) {
    return <section className="card mb-5 p-4 text-base" style={{ color: 'var(--color-tx2)' }}>Operational metrics are unavailable.</section>
  }
  if (loading || !data) return <section aria-label="Loading operational metrics" className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((item) => <div key={item} className="card h-20 animate-pulse" />)}</section>

  return (
    <section aria-label="Operational metrics" className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Metric label="Total users" value={String(data.total_users)} />
      <Metric label="Meals in last 7 days" value={String(data.meals_last_7d)} />
      <Metric label="Agent runs" value={String(data.agent_runs)} detail={data.agent_success_rate == null ? undefined : `${data.agent_success_rate}% successful`} />
      <Metric label="Agent p95 latency" value={data.p95_latency_ms == null ? '—' : `${data.p95_latency_ms} ms`} detail={data.total_cost_usd ? `$${data.total_cost_usd} total cost` : undefined} />
    </section>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="card p-4"><p className="text-2xl font-semibold tabular-nums">{value}</p><p className="mt-1 text-sm font-medium" style={{ color: 'var(--color-tx2)' }}>{label}</p>{detail && <p className="mt-1 text-xs" style={{ color: 'var(--color-tx2)' }}>{detail}</p>}</div>
}

function ResolutionSummary({ data, error, loading }: { data?: ResolutionMix; error: Error | null; loading: boolean }) {
  if (error) {
    return (
      <section className="card mb-5 p-4 text-sm" style={{ color: 'var(--color-tx2)' }}>
        Portion resolution metrics are unavailable for this account.
      </section>
    )
  }
  if (loading || !data) return <section aria-label="Loading portion resolution metrics" className="card mb-5 h-28 animate-pulse" />

  const samples = data.levels.reduce((total, level) => total + level.count, 0)
  return (
    <section className="card mb-5 p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">
          Portion resolution <span className="font-normal" style={{ color: 'var(--color-tx2)' }}>/ last {data.window_days} days</span>
        </h2>
        <span className="text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>
          {samples} active meal {samples === 1 ? 'item' : 'items'}
        </span>
      </div>
      {samples ? (
        <>
          <div className="mt-4 flex h-3 overflow-hidden rounded-full" role="img" aria-label={`Portion resolution across ${samples} active meal items`} style={{ background: 'var(--color-line)' }}>
            {data.levels.map((level, index) => (
              <div
                key={level.level}
                title={`${level.level}: ${level.count} (${level.pct}%)`}
                style={{ width: `${level.pct}%`, background: RESOLUTION_COLOURS[index % RESOLUTION_COLOURS.length] }}
              />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm" style={{ color: 'var(--color-tx2)' }}>
            {data.levels.map((level, index) => <span key={level.level} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: RESOLUTION_COLOURS[index % RESOLUTION_COLOURS.length] }} />{humanize(level.level)} {level.pct}% ({level.count})</span>)}
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm" style={{ color: 'var(--color-tx2)' }}>
          No active meal items were recorded in this window.
        </p>
      )}
    </section>
  )
}

function UserWorkspace({ userId, panel, panelPage, onPanel, onPanelPage }: {
  userId: string
  panel: PanelId
  panelPage: number
  onPanel: (panel: PanelId) => void
  onPanelPage: (page: number) => void
}) {
  const definition = PANELS.find((item) => item.id === panel)!

  const detail = useQuery({
    queryKey: ['admin', 'user', userId],
    queryFn: () => getJson<UserDetail>(`/admin/users/${userId}`),
    retry: false,
  })

  const panelData = useQuery({
    queryKey: ['admin', 'user', userId, panel, panelPage],
    queryFn: () => getJson<Page<Record<string, unknown>>>(
      `/admin/users/${userId}/${definition.endpoint}?page=${panelPage}&page_size=${PANEL_PAGE_SIZE}`
    ),
    enabled: definition.endpoint !== null,
    retry: false,
  })

  return (
    <section className="card min-w-0 overflow-hidden lg:flex lg:h-[calc(100vh-2.5rem)] lg:flex-col">
      <div className="border-b px-4 py-4 sm:px-5" style={{ borderColor: 'var(--color-line)' }}>
        <p className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--color-accent)' }}>Selected account</p>
        <h2 className="mt-1 truncate text-xl font-semibold">{detail.data?.user.display_name ?? detail.data?.user.email ?? (detail.isPending ? 'Loading account...' : 'Account')}</h2>
        <p className="mt-1 truncate font-mono text-xs" style={{ color: 'var(--color-tx2)' }}>{userId}</p>
      </div>
      <nav role="tablist" aria-label="Account data" className="scroll-region flex flex-none gap-1 overflow-x-auto border-b p-2" style={{ borderColor: 'var(--color-line)' }}>
        {PANELS.map((item) => (
          <button
            key={item.id}
            id={`panel-tab-${item.id}`}
            role="tab"
            aria-selected={panel === item.id}
            aria-controls={`panel-${item.id}`}
            onClick={() => onPanel(item.id)}
            className="min-h-11 whitespace-nowrap rounded-lg px-3.5 text-sm font-semibold"
            style={{
              background: panel === item.id ? 'var(--color-accent)' : 'transparent',
              color: panel === item.id ? 'var(--color-accent-on)' : 'var(--color-tx2)',
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div id={`panel-${panel}`} role="tabpanel" aria-labelledby={`panel-tab-${panel}`} className="scroll-region max-h-[65dvh] min-h-64 overflow-y-auto p-4 pr-2 sm:p-5 sm:pr-3 lg:max-h-none lg:min-h-0 lg:flex-1">
        {panel === 'overview' ? (
          <Overview detail={detail.data} loading={detail.isPending} error={detail.error} onRetry={() => void detail.refetch()} />
        ) : panelData.isPending ? (
          <p role="status" className="text-sm" style={{ color: 'var(--color-tx2)' }}>Loading {definition.label.toLowerCase()}...</p>
        ) : panelData.error ? (
          <PanelError error={panelData.error} onRetry={() => void panelData.refetch()} />
        ) : panelData.data ? (
          <>
            <PanelContent panel={panel} rows={panelData.data.items} />
            <Pagination
              page={panelData.data.page}
              totalPages={panelData.data.total_pages}
              total={panelData.data.total}
              noun={definition.label.toLowerCase()}
              disabled={panelData.isFetching}
              onPage={onPanelPage}
            />
          </>
        ) : null}
      </div>

      <div className="flex-none border-t px-5 py-3 text-xs leading-5" style={{ borderColor: 'var(--color-line)', color: 'var(--color-tx2)' }}>
        Profile data is summarized in Overview. Body history, goal progress, and audit panels are unavailable because the admin API does not expose those user-scoped endpoints.
      </div>
    </section>
  )
}

function Overview({ detail, loading, error, onRetry }: { detail?: UserDetail; loading: boolean; error: Error | null; onRetry: () => void }) {
  if (loading) return <p role="status" className="text-sm" style={{ color: 'var(--color-tx2)' }}>Loading overview...</p>
  if (error) return <PanelError error={error} onRetry={onRetry} />
  if (!detail) return null

  const profile = detail.profile
  const goal = detail.active_goal

  return (
    <div className="space-y-5 text-base">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Meal rows" value={String(detail.meal_count)} />
        <Stat label="BMI" value={formatNumber(profile?.bmi, 1)} />
        <Stat label="BMR kcal" value={formatNumber(profile?.bmr_kcal, 0)} />
        <Stat label="TDEE kcal" value={formatNumber(profile?.tdee_kcal, 0)} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-tx2)' }}>Profile</h3>
        {profile ? (
          <dl className="grid gap-x-5 gap-y-3 rounded-lg border p-4 sm:grid-cols-3" style={{ borderColor: 'var(--color-line)' }}>
            <Definition label="Activity" value={profile.activity} />
            <Definition label="Diet" value={profile.diet} />
            <Definition label="Height" value={profile.height_cm != null ? `${profile.height_cm} cm` : null} />
            <Definition label="Waist" value={profile.waist_cm != null ? `${profile.waist_cm} cm` : null} />
            <Definition label="Allergies" value={profile.allergies?.length ? profile.allergies.join(', ') : 'None recorded'} />
            <Definition label="Onboarding" value={profile.onboarding_completed_at ? formatDateTime(profile.onboarding_completed_at) : 'Incomplete'} />
          </dl>
        ) : <EmptyState>No profile has been created for this user.</EmptyState>}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-tx2)' }}>Active goal</h3>
        {goal ? <GoalCard goal={goal} /> : <EmptyState>No active goal is recorded.</EmptyState>}
      </div>
    </div>
  )
}

function PanelContent({ panel, rows }: { panel: PanelId; rows: Record<string, unknown>[] }) {
  if (!rows.length) {
    const messages: Record<Exclude<PanelId, 'overview'>, string> = {
      meals: 'No meal rows are recorded for this user.',
      goals: 'No goal versions are recorded for this user.',
      preferences: 'No preference versions are recorded for this user.',
      messages: 'No conversation messages are recorded for this user.',
      'agent-runs': 'No agent runs are recorded for this user.',
    }
    return <EmptyState>{messages[panel as Exclude<PanelId, 'overview'>]}</EmptyState>
  }

  if (panel === 'meals') return <MealsPanel rows={rows} />
  if (panel === 'goals') return <GoalsPanel rows={rows} />
  if (panel === 'preferences') return <PreferencesPanel rows={rows} />
  if (panel === 'messages') return <MessagesPanel rows={rows} />
  if (panel === 'agent-runs') return <AgentRunsPanel rows={rows} />
  return null
}

function MealsPanel({ rows }: { rows: Record<string, unknown>[] }) {
  return (
    <div className="space-y-3">
      {rows.map((meal, index) => (
        <article key={stringValue(meal.id) ?? index} className="rounded-lg border p-4" style={{ borderColor: 'var(--color-line)' }}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-medium">{stringValue(meal.dish_name) ?? 'Unnamed dish'}</h3>
              <p className="mt-1 text-xs" style={{ color: 'var(--color-tx2)' }}>
                {[humanize(stringValue(meal.meal_type)), formatDate(stringValue(meal.meal_date))].filter(Boolean).join(' / ')}
              </p>
            </div>
            <Status>{meal.is_active === false ? 'Superseded' : 'Active'}</Status>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
            <Definition label="Portion" value={[valueText(meal.portions), stringValue(meal.portion_unit)].filter(Boolean).join(' ')} />
            <Definition label="Calories" value={unitValue(meal.calories_kcal, 'kcal')} />
            <Definition label="Protein" value={unitValue(meal.protein_g, 'g')} />
            <Definition label="Carbs" value={unitValue(meal.carbs_g, 'g')} />
            <Definition label="Fat" value={unitValue(meal.fat_g, 'g')} />
          </div>
          <p className="mt-3 break-words text-[11px]" style={{ color: 'var(--color-tx2)' }}>
            Source: {humanize(stringValue(meal.source)) || 'Unknown'} / Resolution: {humanize(stringValue(meal.resolved_from)) || 'Unknown'} / Version {valueText(meal.version) || 'n/a'}
          </p>
          {stringValue(meal.note) && <p className="mt-2 break-words text-xs">Note: {stringValue(meal.note)}</p>}
        </article>
      ))}
    </div>
  )
}

function GoalsPanel({ rows }: { rows: Record<string, unknown>[] }) {
  return <div className="space-y-3">{rows.map((goal, index) => <GoalCard key={stringValue(goal.id) ?? index} goal={goal} />)}</div>
}

function GoalCard({ goal }: { goal: Record<string, unknown> }) {
  const derivation = recordValue(goal.derivation)
  const targets = targetList(goal.daily_targets)
  const clamped = derivation?.clamp_fired === true || derivation?.floor_applied === true

  return (
    <article className="rounded-lg border p-4" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">{humanize(stringValue(goal.kind)) || 'Goal'}</h3>
          <p className="mt-1 text-xs" style={{ color: 'var(--color-tx2)' }}>
            {formatDate(stringValue(goal.starts_on))} to {formatDate(stringValue(goal.ends_on))} / Version {valueText(goal.version) || 'n/a'}
          </p>
        </div>
        <Status>{goal.is_active === false ? 'Historical' : humanize(stringValue(goal.status)) || 'Active'}</Status>
      </div>
      {targets.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {targets.map((target, index) => (
            <span key={`${target.label}-${index}`} className="rounded-md border px-2 py-1 text-xs" style={{ borderColor: 'var(--color-line)' }}>
              {target.label}: {target.value}
            </span>
          ))}
        </div>
      ) : <p className="mt-3 text-xs" style={{ color: 'var(--color-tx2)' }}>No daily targets are present.</p>}
      {clamped && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-warn)' }}>
          Safety adjustment applied. Requested {valueText(derivation?.requested_intake_kcal) || 'n/a'} kcal; applied {valueText(derivation?.applied_intake_kcal) || 'n/a'} kcal.
        </p>
      )}
    </article>
  )
}

function PreferencesPanel({ rows }: { rows: Record<string, unknown>[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {rows.map((preference, index) => (
        <article key={stringValue(preference.id) ?? index} className="rounded-lg border p-4" style={{ borderColor: 'var(--color-line)' }}>
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium">{stringValue(preference.topic_title) ?? 'Untitled preference'}</h3>
            <Status>{preference.is_active === false ? 'Historical' : stringValue(preference.status) ?? 'Active'}</Status>
          </div>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{stringValue(preference.content) ?? 'No content recorded.'}</p>
          <p className="mt-3 text-[11px]" style={{ color: 'var(--color-tx2)' }}>
            {stringValue(preference.type) ?? 'Unknown type'} / Source: {humanize(stringValue(preference.source)) || 'Unknown'} / Version {valueText(preference.version) || 'n/a'}
            {stringValue(preference.expires_on) ? ` / Expires ${formatDate(stringValue(preference.expires_on))}` : ''}
          </p>
        </article>
      ))}
    </div>
  )
}

function MessagesPanel({ rows }: { rows: Record<string, unknown>[] }) {
  return (
    <div className="space-y-3">
      {rows.map((message, index) => {
        const inbound = message.direction === 'inbound'
        return (
          <article
            key={stringValue(message.id) ?? index}
            className={`max-w-full rounded-xl border p-4 sm:max-w-[88%] ${inbound ? '' : 'ml-auto'}`}
            style={{ borderColor: 'var(--color-line)', background: inbound ? undefined : 'var(--color-line)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--color-tx2)' }}>
              <span>{inbound ? 'User' : 'System'} / {humanize(stringValue(message.msg_type)) || 'Message'}</span>
              <span>{formatDateTime(stringValue(message.created_at))}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{stringValue(message.msg_text) ?? 'No text content.'}</p>
            <div className="mt-2 flex gap-3 text-[11px]" style={{ color: 'var(--color-tx2)' }}>
              <span>Status: {humanize(stringValue(message.status)) || 'Unknown'}</span>
              {stringValue(message.media_url) && <span>Media attached</span>}
            </div>
          </article>
        )
      })}
    </div>
  )
}

function AgentRunsPanel({ rows }: { rows: Record<string, unknown>[] }) {
  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h3 className="text-lg font-semibold">Agent run history</h3>
        <span className="text-sm tabular-nums" style={{ color: 'var(--color-tx2)' }}>{rows.length} loaded</span>
      </div>
      <div className="space-y-3">
      {rows.map((run, index) => (
        <article key={stringValue(run.id) ?? index} className="rounded-xl border p-4" style={{ borderColor: 'var(--color-line)' }}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-medium">{stringValue(run.agent_name) ?? 'Unnamed agent'}</h3>
              <p className="mt-1 text-xs" style={{ color: 'var(--color-tx2)' }}>
                {[stringValue(run.model), formatDateTime(stringValue(run.created_at))].filter(Boolean).join(' / ')}
              </p>
            </div>
            <Status>{humanize(stringValue(run.status)) || 'Unknown'}</Status>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <Definition label="Duration" value={unitValue(run.duration_ms, 'ms')} />
            <Definition label="Input tokens" value={valueText(run.input_tokens)} />
            <Definition label="Output tokens" value={valueText(run.output_tokens)} />
            <Definition label="Cost" value={run.cost_usd != null ? `$${valueText(run.cost_usd)}` : null} />
          </dl>
          {stringValue(run.error_message) && <p className="mt-3 break-words text-xs" style={{ color: 'var(--color-danger)' }}>{stringValue(run.error_message)}</p>}
        </article>
      ))}
      </div>
    </div>
  )
}

function Pagination({ page, totalPages, total, noun, disabled, onPage }: {
  page: number
  totalPages: number
  total: number
  noun: string
  disabled: boolean
  onPage: (page: number) => void
}) {
  if (total === 0) return null
  const pages = Math.max(1, totalPages)
  const displayNoun = total === 1 ? noun.replace(/s$/, '') : noun
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm" style={{ borderColor: 'var(--color-line)', color: 'var(--color-tx2)' }}>
      <span>{total} {displayNoun} / Page {page} of {pages}</span>
      <div className="flex gap-2">
        <button
          disabled={disabled || page <= 1}
          onClick={() => onPage(page - 1)}
          className="control-button disabled:opacity-40"
        >
          Previous
        </button>
        <button
          disabled={disabled || page >= pages}
          onClick={() => onPage(page + 1)}
          className="control-button disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  )
}

function PanelError({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const denied = error instanceof ApiError && error.status === 403
  return (
    <div className="rounded-lg border p-4 text-sm" style={{ borderColor: denied ? 'var(--color-danger)' : 'var(--color-line)' }}>
      <p className="font-medium">{denied ? 'Permission denied' : 'Panel unavailable'}</p>
      <p className="mt-1 break-words" style={{ color: 'var(--color-tx2)' }}>{error.message}</p>
      {onRetry && !denied && <button onClick={onRetry} className="control-button mt-3">Try again</button>}
    </div>
  )
}

function PageStatus({ children }: { children: React.ReactNode }) {
  return <main role="status" className="grid min-h-screen place-items-center text-base" style={{ color: 'var(--color-tx2)' }}>{children}</main>
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed p-5 text-center text-base" style={{ borderColor: 'var(--color-line)', color: 'var(--color-tx2)' }}>{children}</p>
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)' }}>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs" style={{ color: 'var(--color-tx2)' }}>{label}</div>
    </div>
  )
}

function Definition({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--color-tx2)' }}>{label}</dt>
      <dd className="mt-0.5 break-words tabular-nums">{value || 'Not recorded'}</dd>
    </div>
  )
}

function Status({ children }: { children: React.ReactNode }) {
  const text = String(children)
  const positive = /^(active|onboarded|completed|success|successful|ok)$/i.test(text)
  const negative = /failed|error|denied/i.test(text)
  return <span className="rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide" style={{ borderColor: negative ? 'var(--color-danger)' : positive ? 'var(--color-accent)' : 'var(--color-line)', background: negative ? 'var(--color-danger-soft)' : positive ? 'var(--color-accent-soft)' : undefined, color: negative ? 'var(--color-danger)' : positive ? 'var(--color-accent)' : 'var(--color-tx2)' }}>{children}</span>
}

function firstProfile(value: AdminUser['user_profiles']): UserProfile | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function valueText(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  return null
}

function unitValue(value: unknown, unit: string): string | null {
  const text = valueText(value)
  return text === null ? null : `${text} ${unit}`
}

function humanize(value: string | null | undefined): string {
  if (!value) return ''
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not recorded'
  const date = new Date(`${value.slice(0, 10)}T00:00:00`)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date)
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatNumber(value: number | null | undefined, digits: number): string {
  return value == null ? 'Not recorded' : Number(value).toFixed(digits)
}

function targetList(value: unknown): { label: string; value: string }[] {
  const record = recordValue(value)
  const rawTargets = Array.isArray(record?.targets) ? record.targets : []
  return rawTargets.flatMap((target) => {
    const item = recordValue(target)
    if (!item) return []
    const label = stringValue(item.nutrient) ?? stringValue(item.name) ?? stringValue(item.metric)
    const amount = valueText(item.target) ?? valueText(item.value) ?? valueText(item.amount)
    if (!label || !amount) return []
    return [{ label: humanize(label), value: `${amount}${stringValue(item.unit) ? ` ${stringValue(item.unit)}` : ''}` }]
  })
}

type UserProfile = {
  activity?: string | null
  diet?: string | null
  height_cm?: number | null
  waist_cm?: number | null
  allergies?: string[]
  bmi?: number | null
  bmr_kcal?: number | null
  tdee_kcal?: number | null
  onboarding_completed_at?: string | null
}

type AdminUser = {
  id: string
  email: string | null
  display_name: string | null
  created_at: string
  updated_at?: string
  user_profiles?: UserProfile | UserProfile[] | null
}

type UserDetail = {
  user: AdminUser
  profile: UserProfile | null
  active_goal: Record<string, unknown> | null
  meal_count: number
}

type Metrics = {
  total_users: number
  meals_last_7d: number
  agent_runs: number
  agent_success_rate: number | null
  p50_latency_ms: number | null
  p95_latency_ms: number | null
  total_cost_usd: number
}

type ResolutionMix = {
  window_days: number
  total: number
  levels: { level: string; count: number; pct: number }[]
}

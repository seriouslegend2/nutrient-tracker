'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { LogoutButton } from '@/components/logout-button'
import { ApiError, getJson } from '@/lib/client-api'
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

export function UsersClient() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [selected, setSelected] = useState<string | null>(null)
  const [panel, setPanel] = useState<PanelId>('overview')

  const users = useQuery({
    queryKey: ['admin', 'users', page, pageSize],
    queryFn: () => getJson<Page<AdminUser>>(`/admin/users?page=${page}&page_size=${pageSize}`),
    retry: false,
  })

  const metrics = useQuery({
    queryKey: ['admin', 'metrics'],
    queryFn: () => getJson<Metrics>('/admin/metrics'),
    retry: false,
  })

  const mix = useQuery({
    queryKey: ['admin', 'mix'],
    queryFn: () => getJson<ResolutionMix>('/admin/resolution-mix'),
    retry: false,
  })

  if (users.isPending) return <PageStatus>Loading users...</PageStatus>

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
    <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: 'var(--color-accent)' }}>
            Internal dashboard
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Users</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-4">
          <MetricsSummary data={metrics.data} error={metrics.error} />
          <LogoutButton />
        </div>
      </header>

      <ResolutionSummary data={mix.data} error={mix.error} />

      <div className="grid gap-5 xl:grid-cols-[500px_minmax(0,1fr)]">
        <section className="card overflow-hidden">
          <div className="flex items-end justify-between gap-3 border-b p-4" style={{ borderColor: 'var(--color-line)' }}>
            <div>
              <h2 className="text-sm font-semibold">Accounts</h2>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--color-tx2)' }}>
                Newest first. The admin API does not expose search or filters.
              </p>
            </div>
            <label className="text-[11px]" style={{ color: 'var(--color-tx2)' }}>
              Per page
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value))
                  setPage(1)
                  setSelected(null)
                }}
                className="ml-2 rounded-md border bg-transparent px-2 py-1"
                style={{ borderColor: 'var(--color-line)' }}
              >
                {USER_PAGE_SIZES.map((size) => <option key={size}>{size}</option>)}
              </select>
            </label>
          </div>

          {userPage.items.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[470px] text-sm">
                <thead>
                  <tr style={{ color: 'var(--color-tx2)' }}>
                    <th className="p-3 text-left text-xs font-medium">User</th>
                    <th className="p-3 text-left text-xs font-medium">Profile</th>
                    <th className="p-3 text-right text-xs font-medium">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {userPage.items.map((user) => {
                    const profile = firstProfile(user.user_profiles)
                    return (
                      <tr
                        key={user.id}
                        onClick={() => {
                          setSelected(user.id)
                          setPanel('overview')
                        }}
                        className="cursor-pointer border-t"
                        style={{
                          borderColor: 'var(--color-line)',
                          background: selected === user.id ? 'var(--color-line)' : undefined,
                        }}
                      >
                        <td className="p-3">
                          <div className="font-medium">{user.display_name ?? user.email ?? 'Unnamed user'}</div>
                          <div className="mt-0.5 text-xs" style={{ color: 'var(--color-tx2)' }}>{user.email ?? 'No email'}</div>
                          <div className="mt-0.5 font-mono text-[10px]" style={{ color: 'var(--color-tx2)' }}>{user.id}</div>
                        </td>
                        <td className="p-3 text-xs">
                          {profile ? (
                            <>
                              <div>{profile.onboarding_completed_at ? 'Onboarded' : 'Incomplete'}</div>
                              <div className="mt-0.5" style={{ color: 'var(--color-tx2)' }}>
                                {[profile.activity, profile.diet].filter(Boolean).join(' / ') || 'No activity or diet'}
                              </div>
                            </>
                          ) : <span style={{ color: 'var(--color-tx2)' }}>No profile</span>}
                        </td>
                        <td className="p-3 text-right text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>
                          {formatDate(user.created_at)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
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
            }}
          />
        </section>

        {selected ? (
          <UserWorkspace key={selected} userId={selected} panel={panel} onPanel={setPanel} />
        ) : (
          <section className="card grid min-h-72 place-items-center p-10 text-center text-sm" style={{ color: 'var(--color-tx2)' }}>
            Select a user to inspect their supported admin data.
          </section>
        )}
      </div>
    </div>
  )
}

function MetricsSummary({ data, error }: { data?: Metrics; error: Error | null }) {
  if (error) {
    return <span className="text-xs" style={{ color: 'var(--color-tx2)' }}>Operational metrics unavailable</span>
  }
  if (!data) return <span className="text-xs" style={{ color: 'var(--color-tx2)' }}>Loading metrics...</span>

  return (
    <div className="flex flex-wrap justify-end gap-x-5 gap-y-1 text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>
      <span>{data.total_users} users</span>
      <span>{data.meals_last_7d} active meals / 7d</span>
      {data.agent_runs > 0 ? (
        <>
          <span>{data.agent_runs} agent runs</span>
          {data.agent_success_rate != null && <span>{data.agent_success_rate}% successful</span>}
          {data.p95_latency_ms != null && <span>p95 {data.p95_latency_ms} ms</span>}
        </>
      ) : <span>No agent runs recorded</span>}
    </div>
  )
}

function ResolutionSummary({ data, error }: { data?: ResolutionMix; error: Error | null }) {
  if (error) {
    return (
      <section className="card mb-5 p-4 text-xs" style={{ color: 'var(--color-tx2)' }}>
        Portion resolution metrics are unavailable for this account.
      </section>
    )
  }
  if (!data) return null

  const samples = data.levels.reduce((total, level) => total + level.count, 0)
  return (
    <section className="card mb-5 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium" style={{ color: 'var(--color-tx2)' }}>
          Portion resolution mix / last {data.window_days} days
        </h2>
        <span className="text-[11px] tabular-nums" style={{ color: 'var(--color-tx2)' }}>
          {samples} active meal {samples === 1 ? 'item' : 'items'}
        </span>
      </div>
      {samples ? (
        <>
          <div className="mt-3 flex h-3 overflow-hidden rounded-full" style={{ background: 'var(--color-line)' }}>
            {data.levels.map((level, index) => (
              <div
                key={level.level}
                title={`${level.level}: ${level.count} (${level.pct}%)`}
                style={{ width: `${level.pct}%`, background: `oklch(${0.72 - index * 0.07} 0.13 ${155 + index * 28})` }}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px]" style={{ color: 'var(--color-tx2)' }}>
            {data.levels.map((level) => <span key={level.level}>{humanize(level.level)} {level.pct}% ({level.count})</span>)}
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

function UserWorkspace({ userId, panel, onPanel }: {
  userId: string
  panel: PanelId
  onPanel: (panel: PanelId) => void
}) {
  const [panelPage, setPanelPage] = useState(1)
  const definition = PANELS.find((item) => item.id === panel)!

  useEffect(() => setPanelPage(1), [panel, userId])

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
    <section className="card min-w-0 overflow-hidden">
      <nav className="flex gap-1 overflow-x-auto border-b p-2" style={{ borderColor: 'var(--color-line)' }}>
        {PANELS.map((item) => (
          <button
            key={item.id}
            onClick={() => onPanel(item.id)}
            className="whitespace-nowrap rounded-lg px-3 py-1.5 text-xs"
            style={{
              background: panel === item.id ? 'var(--color-accent)' : 'transparent',
              color: panel === item.id ? 'var(--color-bg)' : 'var(--color-tx2)',
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="p-4 sm:p-5">
        {panel === 'overview' ? (
          <Overview detail={detail.data} loading={detail.isPending} error={detail.error} />
        ) : panelData.isPending ? (
          <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>Loading {definition.label.toLowerCase()}...</p>
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
              onPage={setPanelPage}
            />
          </>
        ) : null}
      </div>

      <div className="border-t px-5 py-3 text-[11px] leading-5" style={{ borderColor: 'var(--color-line)', color: 'var(--color-tx2)' }}>
        Profile data is summarized in Overview. Body history, goal progress, and audit panels are unavailable because the admin API does not expose those user-scoped endpoints.
      </div>
    </section>
  )
}

function Overview({ detail, loading, error }: { detail?: UserDetail; loading: boolean; error: Error | null }) {
  if (loading) return <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>Loading overview...</p>
  if (error) return <PanelError error={error} />
  if (!detail) return null

  const profile = detail.profile
  const goal = detail.active_goal

  return (
    <div className="space-y-5 text-sm">
      <div>
        <h2 className="text-lg font-semibold">{detail.user.display_name ?? detail.user.email ?? 'Unnamed user'}</h2>
        <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--color-tx2)' }}>{detail.user.id}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Meal rows" value={String(detail.meal_count)} />
        <Stat label="BMI" value={formatNumber(profile?.bmi, 1)} />
        <Stat label="BMR kcal" value={formatNumber(profile?.bmr_kcal, 0)} />
        <Stat label="TDEE kcal" value={formatNumber(profile?.tdee_kcal, 0)} />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-tx2)' }}>Profile</h3>
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
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-tx2)' }}>Active goal</h3>
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
          <p className="mt-3 text-[11px]" style={{ color: 'var(--color-tx2)' }}>
            Source: {humanize(stringValue(meal.source)) || 'Unknown'} / Resolution: {humanize(stringValue(meal.resolved_from)) || 'Unknown'} / Version {valueText(meal.version) || 'n/a'}
          </p>
          {stringValue(meal.note) && <p className="mt-2 text-xs">Note: {stringValue(meal.note)}</p>}
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
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{stringValue(preference.content) ?? 'No content recorded.'}</p>
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
            className={`max-w-[88%] rounded-xl border p-4 ${inbound ? '' : 'ml-auto'}`}
            style={{ borderColor: 'var(--color-line)', background: inbound ? undefined : 'var(--color-line)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--color-tx2)' }}>
              <span>{inbound ? 'User' : 'System'} / {humanize(stringValue(message.msg_type)) || 'Message'}</span>
              <span>{formatDateTime(stringValue(message.created_at))}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{stringValue(message.msg_text) ?? 'No text content.'}</p>
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
    <div className="space-y-3">
      {rows.map((run, index) => (
        <article key={stringValue(run.id) ?? index} className="rounded-lg border p-4" style={{ borderColor: 'var(--color-line)' }}>
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
          {stringValue(run.error_message) && <p className="mt-3 text-xs" style={{ color: 'var(--color-danger)' }}>{stringValue(run.error_message)}</p>}
        </article>
      ))}
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
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-tx2)' }}>
      <span>{total} {noun} / Page {page} of {totalPages}</span>
      <div className="flex gap-2">
        <button
          disabled={disabled || page <= 1}
          onClick={() => onPage(page - 1)}
          className="rounded-md border px-3 py-1.5 disabled:opacity-40"
          style={{ borderColor: 'var(--color-line)' }}
        >
          Previous
        </button>
        <button
          disabled={disabled || page >= totalPages}
          onClick={() => onPage(page + 1)}
          className="rounded-md border px-3 py-1.5 disabled:opacity-40"
          style={{ borderColor: 'var(--color-line)' }}
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
      <p className="mt-1" style={{ color: 'var(--color-tx2)' }}>{error.message}</p>
      {onRetry && !denied && <button onClick={onRetry} className="mt-3 text-xs underline">Try again</button>}
    </div>
  )
}

function PageStatus({ children }: { children: React.ReactNode }) {
  return <main className="grid min-h-screen place-items-center text-sm" style={{ color: 'var(--color-tx2)' }}>{children}</main>
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed p-5 text-center text-sm" style={{ borderColor: 'var(--color-line)', color: 'var(--color-tx2)' }}>{children}</p>
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)' }}>
      <div className="text-lg tabular-nums">{value}</div>
      <div className="text-[11px]" style={{ color: 'var(--color-tx2)' }}>{label}</div>
    </div>
  )
}

function Definition({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-tx2)' }}>{label}</dt>
      <dd className="mt-0.5 tabular-nums">{value || 'Not recorded'}</dd>
    </div>
  )
}

function Status({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide" style={{ borderColor: 'var(--color-line)', color: 'var(--color-tx2)' }}>{children}</span>
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

'use client'

import { useQuery } from '@tanstack/react-query'

import { BottomNav } from '@/components/nav'
import { api, type Day, type Goal, type GoalProgress } from '@/lib/api-client'

const today = () => new Date().toISOString().slice(0, 10)

const MACRO_COLOURS: Record<string, string> = {
  protein_g: 'var(--color-protein)',
  carbs_g: 'var(--color-carbs)',
  fat_g: 'var(--color-fat)',
}

export function HomeClient() {
  const { data: goal } = useQuery({ queryKey: ['goal', 'active'], queryFn: api.activeGoal })
  const { data: day } = useQuery({ queryKey: ['day', today()], queryFn: () => api.day(today()) })
  const { data: progress } = useQuery({
    queryKey: ['goal', 'progress', goal?.goal_id],
    queryFn: () => api.goalProgress(goal!.goal_id),
    enabled: Boolean(goal?.goal_id),
  })

  const targets = goal?.daily_targets?.targets ?? []
  const calorieTarget = targets.find((t) => t.metric === 'calories_kcal')?.value
  const consumed = day?.totals?.calories_kcal ?? 0
  const remaining = calorieTarget ? Math.round(calorieTarget - consumed) : null

  return (
    <div className="app-shell px-4 pt-6">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>
          {new Date().toLocaleDateString(undefined, {
            weekday: 'long', day: 'numeric', month: 'long',
          })}
        </p>
      </header>

      {/* Primary ring: the remaining number is the largest element on screen. */}
      <section className="card mb-4 p-6 text-center">
        {calorieTarget ? (
          <>
            <div className="text-5xl font-semibold tabular-nums">
              {remaining! >= 0 ? remaining : 0}
            </div>
            <div className="mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>
              kcal left of {Math.round(calorieTarget)}
            </div>
            <Bar value={consumed} target={calorieTarget} colour="var(--color-accent)" />
            {remaining !== null && remaining < 0 && (
              <p className="mt-3 text-sm" style={{ color: 'var(--color-warn)' }}>
                {Math.abs(remaining)} kcal over. One day does not decide a week.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="text-3xl font-semibold tabular-nums">
              {Math.round(consumed)} kcal
            </div>
            <p className="mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>
              No goal set yet - logging still works.
            </p>
            <a
               href="/goals/new"
              className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-medium"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
            >
              Set a goal
            </a>
          </>
        )}
      </section>

      {/* Protein first: it is the macro people actively chase. */}
      <section className="card mb-4 p-5">
        <h2 className="mb-3 text-sm font-medium" style={{ color: 'var(--color-tx2)' }}>
          Macros
        </h2>
        {(['protein_g', 'carbs_g', 'fat_g'] as const).map((macro) => {
          const target = targets.find((t) => t.metric === macro)?.value
          const actual = day?.totals?.[macro] ?? 0
          return (
            <div key={macro} className="mb-3 last:mb-0">
              <div className="mb-1 flex items-baseline justify-between text-sm">
                <span>{macro.replace('_g', '')}</span>
                <span className="tabular-nums" style={{ color: 'var(--color-tx2)' }}>
                  {Math.round(actual)}
                  {target ? ` / ${Math.round(target)}` : ''} g
                </span>
              </div>
              <Bar value={actual} target={(target ?? actual) || 1} colour={MACRO_COLOURS[macro]} />
            </div>
          )
        })}
      </section>

      {goal && <GoalCard goal={goal} progress={progress} />}
      {day && <DayGaps day={day} />}
      <HydrationCard target={targets.find((target) => target.metric === 'water_ml')?.value} />

      <BottomNav />
    </div>
  )
}

function Bar({ value, target, colour }: { value: number; target: number; colour: string }) {
  const pct = Math.min(100, Math.round((value / (target || 1)) * 100))
  return (
    <div
      className="mt-2 h-2 w-full overflow-hidden rounded-full"
      style={{ background: 'var(--color-line)' }}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: colour }} />
    </div>
  )
}

function GoalCard({ goal, progress }: { goal: Goal; progress?: GoalProgress }) {
  const derivation = goal.derivation as Record<string, unknown>
  const clamped = Boolean(derivation.clamp_fired || derivation.floor_applied)

  return (
    <section className="card mb-4 p-5">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-medium" style={{ color: 'var(--color-tx2)' }}>
          Your goal
        </h2>
        <span className="text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>
          {goal.starts_on} → {goal.ends_on}
        </span>
      </div>
      <p className="text-base">{describeGoal(goal)}</p>

      {progress && (
        <p className="mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>
          Logged {progress.days_logged} of {progress.days_elapsed} days
          {' · '}
          {Math.round(progress.adherence * 100)}% adherence
        </p>
      )}

      {/* If a safety clamp fired, this is where it gets explained - not hidden. */}
      {clamped && (
        <div
          className="mt-3 rounded-lg border p-3 text-sm"
          style={{ borderColor: 'var(--color-warn)', color: 'var(--color-tx2)' }}
        >
          <strong style={{ color: 'var(--color-warn)' }}>Adjusted for safety.</strong>{' '}
          You asked for {String(derivation.requested_rate_kg_per_week ?? '')} kg/week, which
          needs {String(derivation.requested_intake_kcal ?? '')} kcal/day. We set{' '}
          {String(derivation.applied_intake_kcal ?? '')} kcal/day instead - the minimum safe
          intake is {String(derivation.calorie_floor_kcal ?? '')} kcal.
          {derivation.achievable_end_date ? (
            <> At this rate you reach your target around {String(derivation.achievable_end_date)}.</>
          ) : null}
        </div>
      )}
    </section>
  )
}

/** Unknown-nutrition rows are a stated gap, never silently counted as zero. */
function DayGaps({ day }: { day: Day }) {
  if (!day.unaccounted_items) return null
  return (
    <section
      className="card mb-4 border-dashed p-4 text-sm"
      style={{ color: 'var(--color-tx2)' }}
    >
      {day.unaccounted_items} item{day.unaccounted_items > 1 ? 's' : ''} today
      {' '}without nutrition info - your totals do not include them.{' '}
      <a href="/meals" style={{ color: 'var(--color-accent)' }}>
        Identify them
      </a>
    </section>
  )
}

function HydrationCard({ target }: { target?: number }) {
  const { data, refetch } = useQuery({ queryKey: ['water'], queryFn: () => api.water() })
  const todayMl = (data?.items ?? [])
    .filter((w) => w.logged_on === today())
    .reduce((sum, w) => sum + w.volume_ml, 0)

  const byDay = (data?.items ?? []).reduce<Record<string, number>>((days, log) => {
    days[log.logged_on] = (days[log.logged_on] ?? 0) + log.volume_ml
    return days
  }, {})

  return (
    <section aria-labelledby="hydration-heading" className="card mb-4 p-5">
      <div className="flex items-center justify-between">
        <div>
        <h2 id="hydration-heading" className="text-sm font-medium" style={{ color: 'var(--color-tx2)' }}>
          Water
        </h2>
        <p className="text-lg tabular-nums">{(todayMl / 1000).toFixed(1)} L{target ? ` / ${(target / 1000).toFixed(1)} L` : ''}</p>
        </div>
        <button
        onClick={async () => {
          await api.logWater(250)
          refetch()
        }}
        className="rounded-lg px-4 py-2 text-sm font-medium"
        style={{ background: 'var(--color-line)' }}
      >
        +250 ml
        </button>
      </div>
      {target && <Bar value={todayMl} target={target} colour="var(--color-protein)" />}
      {Object.keys(byDay).length > 0 && <details className="mt-3 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
        <summary className="cursor-pointer text-xs" style={{ color: 'var(--color-accent)' }}>Recent history</summary>
        <div className="mt-2 space-y-1 text-xs">{Object.entries(byDay).slice(0, 7).map(([date, volume]) =>
          <div key={date} className="flex justify-between"><span>{date}</span><span className="tabular-nums">{(volume / 1000).toFixed(1)} L</span></div>)}</div>
      </details>}
    </section>
  )
}

function describeGoal(goal: Goal): string {
  const spec = goal.spec as Record<string, unknown>
  switch (goal.kind) {
    case 'body_weight':
      return `${spec.direction === 'gain' ? 'Gain' : 'Lose'} ${spec.amount_kg} kg`
    case 'item':
      return `${spec.amount} ${spec.unit ?? 'g'} of ${spec.label} daily`
    case 'hydration':
      return 'Stay hydrated'
    case 'behaviour':
      return 'Log every day'
    default:
      return goal.daily_targets.targets
        .map((t) => `${t.value} ${t.unit} ${t.metric.replace('_g', '').replace('_kcal', '')}`)
        .join(' · ')
  }
}

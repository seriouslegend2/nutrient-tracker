'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'

import { BottomNav } from '@/components/nav'
import { NutrientSpine } from '@/components/nutrient-spine'
import { api, type Day, type Goal, type GoalProgressSummaryItem, type Meal } from '@/lib/api-client'
import { localDateISO } from '@/lib/date'

const MACROS = [
  { key: 'protein_g', label: 'Protein', short: 'P', colour: 'var(--color-protein)' },
  { key: 'carbs_g', label: 'Carbs', short: 'C', colour: 'var(--color-carbs)' },
  { key: 'fat_g', label: 'Fat', short: 'F', colour: 'var(--color-fat)' },
] as const

const MEAL_SLOTS = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'snacks', label: 'Snacks' },
  { key: 'dinner', label: 'Dinner' },
] as const

export function HomeClient() {
  const date = localDateISO()
  const goalQuery = useQuery({ queryKey: ['goal', 'active'], queryFn: api.activeGoal })
  const dayQuery = useQuery({ queryKey: ['day', date], queryFn: () => api.day(date) })
  const summaryQuery = useQuery({
    queryKey: ['goals', 'summary', date],
    queryFn: () => api.goalProgressSummary(date),
  })
  const goalSummaries = summaryQuery.data?.goals ?? []

  if (dayQuery.isPending) {
    return <PageFrame><StatusCard title="Loading today’s meals…" /></PageFrame>
  }

  if (dayQuery.isError) {
    return (
      <PageFrame>
        <StatusCard title="Today’s meals could not be loaded." detail="Check your connection and try again.">
          <button className="action-button" onClick={() => dayQuery.refetch()}>Try again</button>
        </StatusCard>
      </PageFrame>
    )
  }

  return (
    <PageFrame>
      <main>
        <div className="grid gap-4 md:grid-cols-[3fr_2fr] md:items-start">
          <EnergyCard day={dayQuery.data} goal={goalQuery.data} goals={goalSummaries}
                      goalUnavailable={goalQuery.isError} date={date} />
          <HydrationCard target={goalSummaries.find((goal) => goal.kind === 'hydration')?.today.target ??
            goalQuery.data?.daily_targets.targets.find((target) => target.metric === 'water_ml')?.value} date={date} />
        </div>
        <GoalsSection date={date} goals={summaryQuery.data?.goals ?? []} pending={summaryQuery.isPending}
                      failed={summaryQuery.isError} onRetry={() => summaryQuery.refetch()} />
        <div className="grid gap-4 md:grid-cols-[3fr_2fr] md:items-start">
          <MealRhythm day={dayQuery.data} date={date} />
          <DayGaps day={dayQuery.data} />
        </div>
      </main>
    </PageFrame>
  )
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell home-shell px-5 pt-6 sm:px-6">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-base font-semibold" style={{ color: 'var(--color-accent-strong)' }}>Nourish</p>
          <h1 className="display-title text-[38px] leading-none">Today</h1>
        </div>
        <p className="max-w-40 text-right text-sm font-medium leading-relaxed" style={{ color: 'var(--color-tx2)' }}>
          {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </header>
      {children}
      <BottomNav />
    </div>
  )
}

function EnergyCard({ day, goal, goals, goalUnavailable, date }: {
  day: Day
  goal?: Goal | null
  goals: GoalProgressSummaryItem[]
  goalUnavailable: boolean
  date: string
}) {
  const targets = goal?.daily_targets.targets ?? []
  const calorieTarget = targets.find((target) => target.metric === 'calories_kcal')?.value
  const consumed = day.totals.calories_kcal ?? 0
  const remaining = calorieTarget == null ? null : Math.round(calorieTarget - consumed)
  const pct = calorieTarget ? Math.round((consumed / calorieTarget) * 100) : null
  const slot = suggestedSlot()

  return (
    <section aria-labelledby="energy-heading" className="card mb-4 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Today’s energy</p>
          <h2 id="energy-heading" className="display-title mt-1 text-[42px] leading-none tabular-nums">
            {remaining == null ? Math.round(consumed) : Math.abs(remaining)}
            <span className="ml-2 text-xl font-semibold tracking-normal">kcal</span>
          </h2>
          <p className="mt-2 font-semibold" style={{ color: remaining != null && remaining < 0 ? 'var(--color-danger)' : 'var(--color-tx2)' }}>
            {remaining == null ? 'eaten today' : remaining < 0 ? 'over your target' : 'left today'}
          </p>
        </div>
        {goal ? <Link href="/about#goals" className="edit-badge">Manage goals</Link> : null}
      </div>

      {calorieTarget ? (
        <>
          <Bar value={consumed} target={calorieTarget} colour={remaining != null && remaining < 0 ? 'var(--color-danger)' : 'var(--color-accent-strong)'} />
          <div className="mt-2 flex justify-between text-sm font-medium tabular-nums" style={{ color: 'var(--color-tx2)' }}>
            <span>{Math.round(consumed)} eaten</span><span>{Math.round(calorieTarget)} target</span>
          </div>
        </>
      ) : (
        <p className="mt-4 text-sm" style={{ color: goalUnavailable ? 'var(--color-danger)' : 'var(--color-tx2)' }}>
          {goalUnavailable ? 'Your target is temporarily unavailable.' : 'Set a goal to see what is left each day.'}
        </p>
      )}

      <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--color-line)' }}>
        <h3 className="mb-3 font-bold">Macros</h3>
        <div className="grid grid-cols-3 gap-2">
          {MACROS.map((macro) => {
            const actual = day.totals[macro.key] ?? 0
            const explicitProtein = macro.key === 'protein_g'
              ? goals.find((item) => item.kind === 'nutrient' && item.metric === 'protein_g')?.today.target
              : undefined
            const target = explicitProtein ?? targets.find((item) => item.metric === macro.key)?.value
            return (
              <div key={macro.key}>
                <div className="flex items-center gap-2 text-sm font-semibold"><span className="h-2.5 w-2.5 rounded-full" style={{ background: macro.colour }} />{macro.label}</div>
                <p className="mt-1 text-lg font-bold tabular-nums">{Math.round(actual)}<span className="text-sm font-medium" style={{ color: 'var(--color-tx2)' }}> / {target ? `${Math.round(target)}g` : '—'}</span></p>
              </div>
            )
          })}
        </div>
      </div>

      <Link href={`/meals?date=${date}&slot=${slot}`} className="btn-primary mt-5 flex w-full items-center justify-center">
        + Log {slot === 'snacks' ? 'a snack' : slot}
      </Link>
      {pct != null && <span className="sr-only">{pct}% of daily calorie target</span>}
    </section>
  )
}

function MealRhythm({ day, date }: { day: Day; date: string }) {
  return (
    <section aria-labelledby="meals-today-heading" className="card mb-4 p-5 sm:p-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div><p className="eyebrow">Your meal rhythm</p><h2 id="meals-today-heading" className="display-title text-2xl">Meals today</h2></div>
        <Link href={`/meals?date=${date}&slot=misc`} className="action-button">+ Add</Link>
      </div>
      <div>
        {MEAL_SLOTS.map((slot) => {
          const items = day.slots[slot.key] ?? []
          const calories = items.reduce((sum, item) => sum + (item.nutrients?.calories_kcal ?? 0), 0)
          const nutrients = sumNutrients(items)
          return (
            <div key={slot.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t py-3.5" style={{ borderColor: 'var(--color-line)' }}>
              <NutrientSpine nutrients={items.length ? nutrients : null} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2"><h3 className="font-bold">{slot.label}</h3>{items.length > 0 && <span className="text-sm tabular-nums" style={{ color: 'var(--color-tx2)' }}>{Math.round(calories)} kcal</span>}</div>
                <p className="mt-0.5 truncate text-sm" style={{ color: 'var(--color-tx2)' }}>
                  {items.length ? items.map((item) => item.dish_name).join(', ') : 'Nothing logged'}
                </p>
              </div>
              <Link href={`/meals?date=${date}&slot=${slot.key}`} className={items.length ? 'action-button-secondary' : 'action-button'}>
                {items.length ? 'View / edit' : 'Add'}
              </Link>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function HydrationCard({ target, date }: { target?: number; date: string }) {
  const queryClient = useQueryClient()
  const [added, setAdded] = useState(false)
  const waterQuery = useQuery({ queryKey: ['water'], queryFn: () => api.water() })
  const addWater = useMutation({
    mutationFn: () => api.logWater(250, date),
    onSuccess: async () => {
      setAdded(true)
      await waterQuery.refetch()
      await queryClient.invalidateQueries({ queryKey: ['goals', 'summary'] })
    },
  })
  const todayMl = (waterQuery.data?.items ?? [])
    .filter((log) => log.logged_on === date)
    .reduce((sum, log) => sum + log.volume_ml, 0)

  return (
    <section aria-label="Water" className="card mb-4 p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="eyebrow">Water</p>
          <h2 id="hydration-heading" className="display-title mt-1 text-3xl tabular-nums">
            {(todayMl / 1000).toFixed(1)} <span className="text-lg font-semibold">L</span>
          </h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>{target ? `${(target / 1000).toFixed(1)} L daily target` : 'Logged today'}</p>
        </div>
        <button aria-label="+250 ml" disabled={addWater.isPending || waterQuery.isPending} onClick={() => { setAdded(false); addWater.mutate() }} className="action-button">
          {addWater.isPending ? 'Adding…' : '+ 250 ml'}
        </button>
      </div>
      {target && <Bar value={todayMl} target={target} colour="var(--color-protein)" />}
      {added && <p className="mt-3 text-sm font-semibold" role="status" style={{ color: 'var(--color-accent-strong)' }}>250 ml added.</p>}
      {addWater.isError && <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>Water was not added. Try again.</p>}
    </section>
  )
}

function GoalsSection({ date, goals, pending, failed, onRetry }: {
  date: string
  goals: GoalProgressSummaryItem[]
  pending: boolean
  failed: boolean
  onRetry: () => void
}) {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = goals.find((goal) => goal.goal_id === selectedId) ?? goals[0]
  const checkIn = useMutation({
    mutationFn: () => api.checkInGoalActivity(date),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['goals', 'summary'] })
      queryClient.invalidateQueries({ queryKey: ['goal', 'activity'] })
    },
  })

  return (
    <section aria-labelledby="goals-heading" className="card mb-4 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div><p className="eyebrow">Your progress</p><h2 id="goals-heading" className="display-title text-3xl">Goals</h2></div>
        <Link href="/about#goals" className="edit-badge">Manage</Link>
      </div>
      {pending && <p className="mt-4 text-sm" style={{ color: 'var(--color-tx2)' }}>Loading goal progress...</p>}
      {failed && <div className="mt-4"><p className="text-sm" style={{ color: 'var(--color-danger)' }}>Goal progress could not be loaded.</p><button className="action-button mt-3" onClick={onRetry}>Try again</button></div>}
      {!pending && !failed && !goals.length && (
        <div className="mt-4 rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}>
          <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>No active goals yet. Add daily, weekly, or fixed-period goals to track them here.</p>
          <Link href="/goals/new" className="action-button mt-3">Add a goal</Link>
        </div>
      )}
      {selected && <>
        <div role="tablist" aria-label="Active goals" className="-mx-1 mt-4 flex gap-2 overflow-x-auto px-1 pb-2">
          {goals.map((goal) => (
            <button key={goal.goal_id} type="button" role="tab" aria-selected={goal.goal_id === selected.goal_id}
                    id={`goal-tab-${goal.goal_id}`} aria-controls={`goal-panel-${goal.goal_id}`}
                    tabIndex={goal.goal_id === selected.goal_id ? 0 : -1}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                      event.preventDefault()
                      const current = goals.findIndex((item) => item.goal_id === goal.goal_id)
                      const next = event.key === 'Home' ? 0 : event.key === 'End' ? goals.length - 1
                        : (current + (event.key === 'ArrowRight' ? 1 : -1) + goals.length) % goals.length
                      setSelectedId(goals[next].goal_id)
                      requestAnimationFrame(() => document.getElementById(`goal-tab-${goals[next].goal_id}`)?.focus())
                    }}
                    onClick={() => setSelectedId(goal.goal_id)} className="choice shrink-0 whitespace-nowrap"
                    data-selected={goal.goal_id === selected.goal_id}>
              {goal.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`goal-panel-${selected.goal_id}`} aria-labelledby={`goal-tab-${selected.goal_id}`}>
          <GoalSummaryCard goal={selected} date={date} checkingIn={checkIn.isPending}
                           checkInError={checkIn.isError} onCheckIn={() => checkIn.mutate()} />
        </div>
      </>}
    </section>
  )
}

function GoalSummaryCard({ goal, date, checkingIn, checkInError, onCheckIn }: {
  goal: GoalProgressSummaryItem
  date: string
  checkingIn: boolean
  checkInError: boolean
  onCheckIn: () => void
}) {
  const checkedIn = goal.kind === 'behaviour' && goal.today.actual != null && goal.today.actual >= 1
  const activeToday = date >= goal.starts_on && date <= goal.ends_on
  const isBodyWeight = goal.kind === 'body_weight'
  const days = visibleCalendar(goal.calendar, date)
  return (
    <div className="mt-3 border-t pt-5" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="display-title text-2xl">{goal.label}</h3>
          <p className="mt-1 text-sm capitalize" style={{ color: 'var(--color-tx2)' }}>
            {goal.cadence} cadence: {cadenceDescription(goal.cadence)}
          </p>
          <p className="text-sm tabular-nums" style={{ color: 'var(--color-tx2)' }}>{formatDate(goal.starts_on)} to {formatDate(goal.ends_on)}</p>
        </div>
        <span className="rounded-full px-3 py-1 text-sm font-semibold" style={{ background: statusBackground(goal.today.status), color: statusColour(goal.today.status) }}>
          {isBodyWeight ? bodyWeightStatusText(goal.today.status, goal.today.direction) : goalStatusText(goal.today.status, goal.today.direction)}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}>
          <p className="eyebrow">{isBodyWeight ? 'Latest weight' : 'Today'}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{formatGoalValue(goal.today.actual, goal.today.unit, 'Not logged')}</p>
          <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>
            {isBodyWeight ? `Goal weight ${formatGoalValue(goal.today.target, goal.today.unit, '')}` : targetPhrase(goal.today.target, goal.today.unit, goal.today.direction)}
          </p>
        </div>
        <div className="rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}>
          <p className="eyebrow">Overall period</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{formatGoalValue(goal.period.actual, goal.period.unit, 'No data')}</p>
          <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>
            {isBodyWeight ? `Goal weight ${formatGoalValue(goal.period.target, goal.period.unit, '')}` : `of ${formatGoalValue(goal.period.target, goal.period.unit, '')} target`}
          </p>
          <p className="mt-2 text-sm font-semibold">{isBodyWeight ? bodyWeightStatusText(goal.period.status, goal.today.direction) : goalStatusText(goal.period.status, goal.today.direction)}</p>
          {isBodyWeight
            ? <p className="mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>Progress percentage needs a starting weigh-in, so only your latest measurement is shown.</p>
            : goal.period.progress_pct != null
            ? <><Bar value={goal.period.progress_pct} target={100} colour="var(--color-accent-strong)" /><p className="mt-2 text-sm tabular-nums" style={{ color: 'var(--color-tx2)' }}>{Math.round(goal.period.progress_pct)}% progress</p></>
            : <p className="mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>No data for progress yet.</p>}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {!isBodyWeight && <p><strong>{goal.period.completed_buckets ?? 0}</strong> of <strong>{goal.period.total_buckets ?? 0}</strong> {bucketName(goal.cadence)} completed</p>}
        {goal.kind === 'behaviour' && <p><strong>{goal.streak.current}</strong> {goal.streak.unit} current streak <span style={{ color: 'var(--color-tx2)' }}>({goal.streak.longest} longest)</span></p>}
      </div>

      {goal.kind === 'behaviour' && activeToday && (
        <div className="mt-4">
          <button type="button" className="btn-primary w-full sm:w-auto" disabled={checkingIn || checkedIn} onClick={onCheckIn}>
            {checkingIn ? 'Checking in...' : checkedIn ? 'Training checked in today' : 'I trained today'}
          </button>
          {checkInError && <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--color-danger)' }}>Your training check-in was not saved. Try again.</p>}
        </div>
      )}
      {goal.kind === 'behaviour' && !activeToday && (
        <p className="mt-4 text-sm" style={{ color: 'var(--color-tx2)' }}>{date < goal.starts_on ? 'This goal has not started yet.' : 'This goal period has ended.'}</p>
      )}

      <CalendarGrid days={days} unit={goal.today.unit} />
    </div>
  )
}

function CalendarGrid({ days, unit }: { days: GoalProgressSummaryItem['calendar']; unit: string }) {
  if (!days.length) return <p className="mt-5 text-sm" style={{ color: 'var(--color-tx2)' }}>No calendar dates in this goal period.</p>
  const firstWeekday = new Date(`${days[0].date}T00:00:00`).getDay()
  const monthLabel = new Date(`${days[0].date}T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  return (
    <div className="mt-6">
      <div className="flex items-end justify-between gap-3"><h4 className="font-bold">Calendar</h4><span className="text-xs" style={{ color: 'var(--color-tx2)' }}>{monthLabel}</span></div>
      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-xs" aria-hidden="true">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => <span key={`${day}-${index}`} style={{ color: 'var(--color-tx2)' }}>{day}</span>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {days.map((day, index) => {
          const status = calendarStatusText(day.status)
          const description = `${formatDate(day.date)}: ${status}. ${day.actual == null ? 'Not logged' : `${formatGoalValue(day.actual, unit, '')} logged`}; target ${formatGoalValue(day.target, unit, '')}.`
          return <div key={day.date} title={description} role="img" aria-label={description}
                      className="relative grid aspect-square min-h-9 place-items-center rounded-xl text-sm font-semibold tabular-nums"
                      style={{ gridColumnStart: index === 0 ? firstWeekday + 1 : undefined, background: statusBackground(day.status), color: statusColour(day.status), opacity: day.status === 'future' ? 0.55 : 1 }}>
            {Number(day.date.slice(-2))}
            <span aria-hidden="true" className="absolute bottom-0 right-1 text-[10px] leading-none">{calendarStatusMark(day.status)}</span>
          </div>
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--color-tx2)' }}>
        {['met', 'below', 'above', 'no_data', 'in_progress', 'future'].map((status) => <span key={status} className="inline-flex items-center gap-1"><span aria-hidden="true" className="grid h-4 w-4 place-items-center rounded text-[9px]" style={{ background: statusBackground(status), color: statusColour(status) }}>{calendarStatusMark(status)}</span>{calendarStatusText(status)}</span>)}
      </div>
    </div>
  )
}

function DayGaps({ day }: { day: Day }) {
  if (!day.unaccounted_items) return null
  return (
    <section className="card mb-4 p-5 text-sm">
      <strong>{day.unaccounted_items} item{day.unaccounted_items > 1 ? 's are' : ' is'} missing nutrition.</strong>
      <p className="mt-1" style={{ color: 'var(--color-tx2)' }}>Today’s totals do not include {day.unaccounted_items > 1 ? 'them' : 'it'}.</p>
      <Link href="/meals" className="action-button mt-3">Review meals</Link>
    </section>
  )
}

function StatusCard({ title, detail, children }: { title: string; detail?: string; children?: React.ReactNode }) {
  return <section className="card p-6"><h2 className="display-title text-2xl">{title}</h2>{detail && <p className="mt-2" style={{ color: 'var(--color-tx2)' }}>{detail}</p>}{children && <div className="mt-4">{children}</div>}</section>
}

function Bar({ value, target, colour }: { value: number; target: number; colour: string }) {
  const pct = Math.min(100, Math.round((value / (target || 1)) * 100))
  return <div className="progress-track mt-4 w-full" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="progress-fill" style={{ width: `${pct}%`, background: colour }} /></div>
}

function sumNutrients(items: Meal[]) {
  return items.reduce<Record<string, number>>((totals, item) => {
    for (const [key, value] of Object.entries(item.nutrients ?? {})) totals[key] = (totals[key] ?? 0) + value
    return totals
  }, {})
}

function suggestedSlot() {
  const hour = new Date().getHours()
  if (hour < 11) return 'breakfast'
  if (hour < 15) return 'lunch'
  if (hour < 18) return 'snacks'
  return 'dinner'
}

export function goalStatusText(status: string, direction: string | null): string {
  if (status === 'no_data') return 'No data'
  if (status === 'future') return 'Not started'
  if (status === 'in_progress') return 'In progress'
  if (status === 'below') return 'Below target'
  if (status === 'above') return direction === 'at_most' ? 'Over target' : 'Above target'
  if (status === 'met') return direction === 'at_most' ? 'Within target' : 'Goal met'
  return status.replaceAll('_', ' ')
}

function bodyWeightStatusText(status: string, direction: string | null): string {
  if (status === 'above') return direction === 'at_most' ? 'Above goal weight' : 'Above goal weight'
  if (status === 'below') return 'Below goal weight'
  if (status === 'met') return 'At goal weight'
  return goalStatusText(status, direction)
}

function calendarStatusText(status: string): string {
  if (status === 'no_data') return 'No data'
  if (status === 'in_progress') return 'In progress'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function calendarStatusMark(status: string): string {
  if (status === 'met') return '✓'
  if (status === 'above') return '↑'
  if (status === 'below') return '↓'
  if (status === 'no_data') return '—'
  if (status === 'in_progress') return '…'
  return ''
}

function visibleCalendar(calendar: GoalProgressSummaryItem['calendar'], asOf: string) {
  const currentMonth = asOf.slice(0, 7)
  const month = calendar.filter((day) => day.date.startsWith(currentMonth))
  if (month.length) return month.slice(0, 42)
  const recent = calendar.filter((day) => day.date <= asOf).slice(-42)
  const anchor = recent.at(-1) ?? calendar[0]
  return anchor ? calendar.filter((day) => day.date.startsWith(anchor.date.slice(0, 7))).slice(0, 42) : []
}

function cadenceDescription(cadence: GoalProgressSummaryItem['cadence']): string {
  if (cadence === 'weekly') return 'resets each week'
  if (cadence === 'monthly') return 'resets each month'
  if (cadence === 'period') return 'one target across the fixed period'
  return 'resets each day'
}

function bucketName(cadence: GoalProgressSummaryItem['cadence']): string {
  if (cadence === 'weekly') return 'weeks'
  if (cadence === 'monthly') return 'months'
  if (cadence === 'period') return 'periods'
  return 'days'
}

function targetPhrase(target: number, unit: string, direction: string | null): string {
  const value = formatGoalValue(target, unit, '')
  if (direction === 'at_most') return `${value} maximum target`
  if (direction === 'around') return `${value} target range`
  return `${value} minimum target`
}

function formatGoalValue(value: number | null, unit: string, missing: string): string {
  if (value == null) return missing
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return unit ? `${formatted} ${unit}` : formatted
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function statusBackground(status: string): string {
  if (status === 'met') return 'color-mix(in oklch, var(--color-accent) 18%, var(--color-surface))'
  if (status === 'above') return 'color-mix(in oklch, var(--color-danger) 14%, var(--color-surface))'
  if (status === 'below') return 'color-mix(in oklch, var(--color-warn) 18%, var(--color-surface))'
  return 'var(--color-surface-soft)'
}

function statusColour(status: string): string {
  if (status === 'above') return 'var(--color-danger)'
  if (status === 'below') return 'var(--color-warn)'
  if (status === 'met') return 'var(--color-accent-strong)'
  return 'var(--color-tx2)'
}

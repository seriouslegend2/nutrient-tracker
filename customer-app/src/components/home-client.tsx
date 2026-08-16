'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { MealDraftReview } from '@/components/meal-draft-review'
import { BottomNav } from '@/components/nav'
import { NutrientSpine } from '@/components/nutrient-spine'
import { api, type Day, type GoalProgressSummaryItem, type Meal, type Message } from '@/lib/api-client'
import { localDateISO } from '@/lib/date'
import { parseMediaMealDraft } from '@/lib/meal-draft'
import { suggestedMealSlot } from '@/lib/meal-slots'

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
  const dayQuery = useQuery({ queryKey: ['day', date], queryFn: () => api.day(date) })
  const summaryQuery = useQuery({
    queryKey: ['goals', 'summary', date],
    queryFn: () => api.goalProgressSummary(date),
  })
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
        <QuickCapture date={date} />
        <div className="grid gap-4 md:grid-cols-[3fr_2fr] md:items-start">
          <EnergyCard day={dayQuery.data} date={date} />
          <HydrationCard date={date} />
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

function EnergyCard({ day, date }: { day: Day; date: string }) {
  const consumed = day.totals.calories_kcal ?? 0
  const slot = suggestedMealSlot()

  return (
    <section aria-label="Today's nutrition" className="card mb-4 p-5 sm:p-6">
      <div>
        <p className="eyebrow">Today’s energy</p>
        <h2 id="energy-heading" className="display-title mt-1 text-[42px] leading-none tabular-nums">
          {Math.round(consumed)}
          <span className="ml-2 text-xl font-semibold tracking-normal">kcal</span>
        </h2>
        <p className="mt-2 font-semibold" style={{ color: 'var(--color-tx2)' }}>consumed today</p>
      </div>

      <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--color-line)' }}>
        <h3 className="mb-3 font-bold">Macros</h3>
        <div className="grid grid-cols-3 gap-2">
          {MACROS.map((macro) => {
            const actual = day.totals[macro.key] ?? 0
            return (
              <div key={macro.key}>
                <div className="flex items-center gap-2 text-sm font-semibold"><span className="h-2.5 w-2.5 rounded-full" style={{ background: macro.colour }} />{macro.label}</div>
                <p className="mt-1 text-lg font-bold tabular-nums">{Math.round(actual)}<span className="ml-1 text-sm font-medium" style={{ color: 'var(--color-tx2)' }}>g</span></p>
              </div>
            )
          })}
        </div>
      </div>

      <Link href={`/meals?date=${date}&slot=${slot}`} className="btn-primary mt-5 flex w-full items-center justify-center">
        + Log {slot === 'snacks' ? 'a snack' : slot}
      </Link>
    </section>
  )
}

function QuickCapture({ date }: { date: string }) {
  const cameraRef = useRef<HTMLInputElement>(null)
  const pdfRef = useRef<HTMLInputElement>(null)
  const [selection, setSelection] = useState<{ kind: 'image' | 'pdf'; name: string } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [draftMessage, setDraftMessage] = useState<Message | null>(null)
  const [captureError, setCaptureError] = useState('')
  const [loggedCount, setLoggedCount] = useState<number | null>(null)
  const [stage, setStage] = useState(0)

  const capture = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.set('file', file)
      return api.sendMessage(form)
    },
    onSuccess: (created) => {
      const draft = created.find((message) =>
        message.status === 'needs_confirmation' && parseMediaMealDraft(message.payload)
      )
      if (draft) {
        setDraftMessage(draft)
        return
      }
      const failed = created.find((message) => message.status === 'failed')
      const reply = [...created].reverse().find((message) => message.msg_text)
      setCaptureError(failed?.msg_text || reply?.msg_text || 'No reviewable meal items were detected. Try another file.')
    },
    onError: (error) => setCaptureError(error.message),
    onSettled: () => {
      if (cameraRef.current) cameraRef.current.value = ''
      if (pdfRef.current) pdfRef.current.value = ''
    },
  })

  useEffect(() => {
    if (!capture.isPending) return
    setStage(0)
    const timer = window.setInterval(() => setStage((current) => Math.min(current + 1, 2)), 1800)
    return () => window.clearInterval(timer)
  }, [capture.isPending])

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const processFile = (file: File, kind: 'image' | 'pdf') => {
    setCaptureError('')
    setLoggedCount(null)
    setDraftMessage(null)
    setSelection({ kind, name: file.name })
    setPreviewUrl(kind === 'image' ? URL.createObjectURL(file) : null)
    capture.mutate(file)
  }

  const clearCapture = () => {
    setDraftMessage(null)
    setSelection(null)
    setPreviewUrl(null)
  }

  const completeCapture = (count: number) => {
    clearCapture()
    setLoggedCount(count)
  }

  const imageStages = ['Securing your photo', 'Detecting meal items', 'Preparing editable portions']
  const pdfStages = ['Securing your PDF', 'Reading diary rows', 'Preparing editable portions']
  const stages = selection?.kind === 'pdf' ? pdfStages : imageStages

  return (
    <section aria-labelledby="quick-capture-heading" className="card mb-4 p-5 sm:p-6"
      style={{ background: 'linear-gradient(135deg, var(--color-accent-strong), color-mix(in oklch, var(--color-accent-strong) 78%, var(--color-tx)))', borderColor: 'transparent', color: 'var(--color-on-accent)' }}>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(event) => { const file = event.target.files?.[0]; if (file) processFile(file, 'image') }} />
      <input ref={pdfRef} type="file" accept="application/pdf" hidden
        onChange={(event) => { const file = event.target.files?.[0]; if (file) processFile(file, 'pdf') }} />

      <div className="grid gap-5 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <p className="text-sm font-semibold" style={{ color: 'color-mix(in oklch, var(--color-on-accent) 78%, transparent)' }}>Quick capture</p>
          <h2 id="quick-capture-heading" className="display-title mt-1 text-3xl">Turn a plate into a draft</h2>
          <p className="mt-2 max-w-xl text-sm" style={{ color: 'color-mix(in oklch, var(--color-on-accent) 82%, transparent)' }}>
            Take a clear rear-camera photo, then review every portion before anything is logged.
          </p>
        </div>
        <div className="relative mx-auto grid h-24 w-24 place-items-center rounded-full border sm:mx-0" style={{ borderColor: 'color-mix(in oklch, var(--color-on-accent) 35%, transparent)' }} aria-hidden="true">
          <span className="absolute h-16 w-16 rounded-full border" style={{ borderColor: 'color-mix(in oklch, var(--color-on-accent) 25%, transparent)' }} />
          <span className="h-8 w-8 rounded-full" style={{ background: 'var(--color-on-accent)' }} />
        </div>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-[2fr_1fr]">
        <button type="button" className="btn-secondary flex items-center justify-center gap-2 border-0" disabled={capture.isPending}
          style={{ color: 'var(--color-accent-strong)' }} onClick={() => cameraRef.current?.click()}>
          <CameraIcon /> Take meal photo
        </button>
        <button type="button" className="rounded-[15px] border px-4 font-bold" disabled={capture.isPending}
          style={{ borderColor: 'color-mix(in oklch, var(--color-on-accent) 42%, transparent)', color: 'var(--color-on-accent)' }} onClick={() => pdfRef.current?.click()}>
          Upload PDF
        </button>
      </div>

      {selection && (
        <div className="mt-4 overflow-hidden rounded-2xl border" style={{ borderColor: 'color-mix(in oklch, var(--color-on-accent) 25%, transparent)', background: 'color-mix(in oklch, var(--color-tx) 20%, transparent)' }}>
          {previewUrl ? <img src={previewUrl} alt="Meal selected for review" className="max-h-52 w-full object-cover" /> : (
            <p className="p-4 text-sm font-semibold">PDF: {selection.name}</p>
          )}
          {capture.isPending && (
            <div className="p-4" role="status" aria-live="polite">
              <p className="font-semibold">{stages[stage]}</p>
              <p className="mt-1 text-sm" style={{ color: 'color-mix(in oklch, var(--color-on-accent) 76%, transparent)' }}>This can take a moment. Nothing is logged until you confirm.</p>
              <div className="mt-3 flex gap-1.5" aria-hidden="true">{stages.map((_, index) => <span key={index} className="h-1.5 flex-1 rounded-full" style={{ background: index <= stage ? 'var(--color-on-accent)' : 'color-mix(in oklch, var(--color-on-accent) 25%, transparent)' }} />)}</div>
            </div>
          )}
        </div>
      )}
      {captureError && <p className="mt-4 rounded-xl p-3 text-sm font-semibold" role="alert" style={{ background: 'var(--color-surface)', color: 'var(--color-danger)' }}>{captureError}</p>}
      {loggedCount != null && <p className="mt-4 rounded-xl p-3 text-sm font-semibold" role="status" style={{ background: 'var(--color-surface)', color: 'var(--color-accent-strong)' }}>{loggedCount} {loggedCount === 1 ? 'item' : 'items'} added to your meal log.</p>}

      {draftMessage && (
        <div className="mt-4" style={{ color: 'var(--color-tx)' }}>
          <MealDraftReview messageId={draftMessage.id} payload={draftMessage.payload} initialDate={date}
            onConfirmed={(result) => completeCapture(result.created)} onDiscard={clearCapture} />
        </div>
      )}
    </section>
  )
}

function CameraIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.5 5.5 10 3.5h4l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2h3.5Z" stroke="currentColor" strokeWidth="1.8"/><circle cx="12" cy="12.5" r="3.5" stroke="currentColor" strokeWidth="1.8"/></svg>
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

function HydrationCard({ date }: { date: string }) {
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
          <p className="mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>logged today</p>
        </div>
        <button aria-label="+250 ml" disabled={addWater.isPending || waterQuery.isPending} onClick={() => { setAdded(false); addWater.mutate() }} className="action-button">
          {addWater.isPending ? 'Adding…' : '+ 250 ml'}
        </button>
      </div>
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
          {goals.map((goal, index) => (
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
              <span className="block text-left"><span className="block text-xs opacity-75">Goal {index + 1}</span>{goal.label}</span>
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
  const days = visibleCalendar(goal.calendar, date)
  const achievement = calendarAchievement(goal.calendar, date)
  return (
    <div className="mt-3 border-t pt-5" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="display-title text-2xl">{goal.label}</h3>
          <p className="mt-1 text-sm tabular-nums" style={{ color: 'var(--color-tx2)' }}>
            {formatDate(goal.starts_on)}–{formatDate(goal.ends_on)} · {goal.period.total_days} days
          </p>
        </div>
        {goal.kind === 'behaviour' && <span className="rounded-full px-3 py-1 text-sm font-semibold" style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent-strong)' }}>{goal.streak.current} {goal.streak.unit} streak</span>}
      </div>

      <div className="mt-4 divide-y" style={{ borderColor: 'var(--color-line)' }}>
        {goal.metrics.map((metric) => (
          <section key={metric.metric} className="py-4 first:pt-0 last:pb-0">
            <h4 className="font-bold">{metric.label}</h4>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <MetricBar title="Today" actual={metric.today.actual} target={metric.today.target}
                         unit={metric.unit} pct={metric.today.progress_pct} direction={metric.direction} />
              <MetricBar title="Period" actual={metric.period.actual} target={metric.period.target}
                         unit={metric.unit} pct={metric.period.progress_pct} direction={metric.direction} />
            </div>
          </section>
        ))}
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

      {goal.kind !== 'body_weight' && <CalendarGrid days={days} unit={goal.today.unit}
        summary={goal.kind === 'behaviour'
          ? `${achievement.reached} training ${achievement.reached === 1 ? 'day' : 'days'} logged`
          : `${achievement.reached} of ${achievement.elapsed} elapsed days reached`} />}
    </div>
  )
}

function MetricBar({ title, actual, target, unit, pct, direction }: {
  title: string
  actual: number | null
  target: number
  unit: string
  pct: number | null
  direction: string
}) {
  const over = actual != null && actual > target
  const colour = direction === 'at_most' && over ? 'var(--color-danger)' : 'var(--color-accent-strong)'
  return <div className="rounded-xl p-3" style={{ background: 'var(--color-surface-soft)' }}>
    <div className="flex items-baseline justify-between gap-2"><span className="text-sm font-semibold">{title}</span><strong className="tabular-nums">{formatGoalValue(actual, unit, '—')} / {formatGoalValue(target, unit, '')}</strong></div>
    <Bar value={pct ?? 0} target={100} colour={colour} />
    <p className="mt-1 text-right text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>{pct == null ? 'No data yet' : `${Math.round(pct)}%`}</p>
  </div>
}

function CalendarGrid({ days, unit, summary }: {
  days: GoalProgressSummaryItem['calendar']
  unit: string
  summary: string
}) {
  if (!days.length) return <p className="mt-5 text-sm" style={{ color: 'var(--color-tx2)' }}>No calendar dates in this goal period.</p>
  const firstWeekday = new Date(`${days[0].date}T00:00:00`).getDay()
  const monthLabel = new Date(`${days[0].date}T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const legend = ['met', 'below', 'above', 'no_data', 'in_progress', 'future']
    .filter((status) => days.some((day) => day.status === status))
  return (
    <div className="mt-5 max-w-sm">
      <div className="flex items-end justify-between gap-3"><div><h4 className="font-bold">Daily goal calendar</h4><p className="mt-0.5 text-xs font-medium" style={{ color: 'var(--color-tx2)' }}>{summary}</p></div><span className="text-xs" style={{ color: 'var(--color-tx2)' }}>{monthLabel}</span></div>
      <div className="mt-2 grid grid-cols-7 gap-1 text-center text-xs" aria-hidden="true">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => <span key={`${day}-${index}`} style={{ color: 'var(--color-tx2)' }}>{day}</span>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {days.map((day, index) => {
          const status = calendarStatusText(day.status)
          const description = `${formatDate(day.date)}: ${status}. ${day.actual == null ? 'Not logged' : `${formatGoalValue(day.actual, unit, '')} logged`}; target ${formatGoalValue(day.target, unit, '')}.`
          return <div key={day.date} title={description} role="img" aria-label={description}
                      className="relative grid h-8 place-items-center rounded-lg text-xs font-semibold tabular-nums"
                      style={{ gridColumnStart: index === 0 ? firstWeekday + 1 : undefined, background: statusBackground(day.status), color: statusColour(day.status), opacity: day.status === 'future' ? 0.55 : 1 }}>
            {Number(day.date.slice(-2))}
            <span aria-hidden="true" className="absolute bottom-0 right-1 text-[10px] leading-none">{calendarStatusMark(day.status)}</span>
          </div>
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--color-tx2)' }}>
        {legend.map((status) => <span key={status} className="inline-flex items-center gap-1"><span aria-hidden="true" className="grid h-4 w-4 place-items-center rounded text-[9px]" style={{ background: statusBackground(status), color: statusColour(status) }}>{calendarStatusMark(status)}</span>{calendarStatusText(status)}</span>)}
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

export function goalStatusText(status: string, direction: string | null): string {
  if (status === 'no_data') return 'No data'
  if (status === 'future') return 'Not started'
  if (status === 'in_progress') return 'In progress'
  if (status === 'below') return 'Below target'
  if (status === 'above') return direction === 'at_most' ? 'Over target' : 'Above target'
  if (status === 'met') return direction === 'at_most' ? 'Within target' : 'Goal met'
  return status.replaceAll('_', ' ')
}

function calendarStatusText(status: string): string {
  if (status === 'met') return 'Reached'
  if (status === 'no_data') return 'No data'
  if (status === 'in_progress') return 'In progress'
  if (status === 'future') return 'Upcoming'
  if (status === 'below') return 'Below target'
  if (status === 'above') return 'Above target'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function calendarStatusMark(status: string): string {
  if (status === 'met') return '✓'
  if (status === 'above') return '↑'
  if (status === 'below') return '↓'
  if (status === 'no_data') return '—'
  if (status === 'in_progress') return '…'
  if (status === 'future') return '○'
  return ''
}

function visibleCalendar(calendar: GoalProgressSummaryItem['calendar'], asOf: string) {
  const anchor = calendar.find((day) => day.date === asOf)
    ?? calendar.filter((day) => day.date <= asOf).at(-1)
    ?? calendar[0]
  return anchor ? calendar.filter((day) => day.date.startsWith(anchor.date.slice(0, 7))) : []
}

export function calendarAchievement(calendar: GoalProgressSummaryItem['calendar'], asOf: string) {
  const elapsed = calendar.filter((day) => day.date <= asOf && day.status !== 'future')
  return {
    reached: elapsed.filter((day) => day.status === 'met').length,
    elapsed: elapsed.length,
  }
}

function formatGoalValue(value: number | null, unit: string, missing: string): string {
  if (value == null) return missing
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1)
  const displayUnit = unit === 'days' && value === 1 ? 'day' : unit
  return displayUnit ? `${formatted} ${displayUnit}` : formatted
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

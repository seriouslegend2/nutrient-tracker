'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api, ApiRequestError, type GoalPreview, type GoalRequest } from '@/lib/api-client'
import { localDateISO } from '@/lib/date'

export type GoalBuilderType = 'weight' | 'calories' | 'protein' | 'carbs' | 'fat' | 'hydration' | 'training'
type NutrientBuilderType = 'calories' | 'protein' | 'carbs' | 'fat'
type TrainingCadence = 'weekly' | 'monthly' | 'period'
type PreviewSnapshot = { type: GoalBuilderType; payload: GoalRequest; result: GoalPreview }

const GOAL_TYPES: { type: GoalBuilderType; name: string; detail: string; cadence: string }[] = [
  { type: 'weight', name: 'Weight', detail: 'Lose or gain kilograms', cadence: 'Fixed period' },
  { type: 'calories', name: 'Calories', detail: 'Target daily energy', cadence: 'Daily' },
  { type: 'protein', name: 'Protein', detail: 'Reach grams each day', cadence: 'Daily' },
  { type: 'carbs', name: 'Carbs', detail: 'Target grams each day', cadence: 'Daily' },
  { type: 'fat', name: 'Fat', detail: 'Target grams each day', cadence: 'Daily' },
  { type: 'hydration', name: 'Hydration', detail: 'Reach millilitres each day', cadence: 'Daily' },
  { type: 'training', name: 'Training', detail: 'Track self-reported training days', cadence: 'Flexible' },
]

const NUTRIENT_GOALS: Record<NutrientBuilderType, {
  metric: 'calories_kcal' | 'protein_g' | 'carbs_g' | 'fat_g'
  direction: 'at_least' | 'around'
  label: string
  inputLabel: string
  defaultValue: string
  max: string
}> = {
  calories: { metric: 'calories_kcal', direction: 'around', label: 'Daily calories', inputLabel: 'Calories (kcal per day)', defaultValue: '2000', max: '9999' },
  protein: { metric: 'protein_g', direction: 'at_least', label: 'Daily protein', inputLabel: 'Protein (grams per day)', defaultValue: '60', max: '1000' },
  carbs: { metric: 'carbs_g', direction: 'around', label: 'Daily carbs', inputLabel: 'Carbs (grams per day)', defaultValue: '250', max: '2000' },
  fat: { metric: 'fat_g', direction: 'around', label: 'Daily fat', inputLabel: 'Fat (grams per day)', defaultValue: '65', max: '1000' },
}

function isNutrientType(type: GoalBuilderType): type is NutrientBuilderType {
  return type in NUTRIENT_GOALS
}

const defaultEnd = () => {
  const date = new Date()
  date.setDate(date.getDate() + 84)
  return localDateISO(date)
}

export function buildGoalPayload(
  type: GoalBuilderType,
  value: number,
  endsOn: string,
  direction: 'lose' | 'gain' = 'lose',
  makePrimary = false,
  startsOn = localDateISO(),
  trainingCadence: TrainingCadence = 'weekly'
): GoalRequest {
  const common = { starts_on: startsOn, ends_on: endsOn, make_primary: type === 'weight' && makePrimary }
  if (type === 'weight') {
    return { ...common, kind: 'body_weight', cadence: 'period', spec: { direction, amount_kg: value } }
  }
  if (isNutrientType(type)) {
    const nutrient = NUTRIENT_GOALS[type]
    return {
      ...common,
      kind: 'nutrient',
      cadence: 'daily',
      spec: {
        nutrients: { [nutrient.metric]: value },
        direction: nutrient.direction,
        label: nutrient.label,
      },
    }
  }
  if (type === 'hydration') {
    return { ...common, kind: 'hydration', cadence: 'daily', spec: { target_ml: value, label: 'Daily hydration' } }
  }
  return {
    ...common,
    kind: 'behaviour',
    cadence: trainingCadence,
    spec: { metric: 'training_days', target: value, label: 'Training days' },
  }
}

export function GoalSetup({ isPregnantOrNursing = false, hasMedicalCondition = false, onCreated, title = 'Add a goal' }: {
  isPregnantOrNursing?: boolean
  hasMedicalCondition?: boolean
  onCreated?: () => void
  title?: string
}) {
  const queryClient = useQueryClient()
  const [type, setType] = useState<GoalBuilderType>('weight')
  const [direction, setDirection] = useState<'lose' | 'gain'>('lose')
  const [values, setValues] = useState<Record<GoalBuilderType, string>>({
    weight: '5',
    calories: NUTRIENT_GOALS.calories.defaultValue,
    protein: NUTRIENT_GOALS.protein.defaultValue,
    carbs: NUTRIENT_GOALS.carbs.defaultValue,
    fat: NUTRIENT_GOALS.fat.defaultValue,
    hydration: '2000',
    training: '3',
  })
  const [endsOn, setEndsOn] = useState(defaultEnd)
  const [makePrimary, setMakePrimary] = useState(false)
  const [trainingCadence, setTrainingCadence] = useState<TrainingCadence>('weekly')
  const [preview, setPreview] = useState<PreviewSnapshot | null>(null)
  const [error, setError] = useState('')

  const value = Number(values[type])
  const body = () => buildGoalPayload(
    type, value, endsOn, direction, makePrimary, localDateISO(), trainingCadence
  )
  const previewGoal = useMutation({
    mutationFn: (payload: GoalRequest) => api.previewGoal(payload),
    onSuccess: (result, payload) => { setPreview({ type, payload, result }); setError('') },
    onError: (err) => setError(formatApiError(err)),
  })
  const create = useMutation({
    mutationFn: (payload: GoalRequest) => api.createGoal(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['goals'] })
      queryClient.invalidateQueries({ queryKey: ['goal'] })
      queryClient.invalidateQueries({ queryKey: ['goals', 'summary'] })
      onCreated?.()
    },
    onError: (err) => setError(formatApiError(err)),
  })

  const today = localDateISO()
  const tomorrow = new Date(`${today}T12:00:00`)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const latestEnd = new Date(`${today}T12:00:00`)
  latestEnd.setDate(latestEnd.getDate() + 1829)
  const selectedEnd = new Date(`${endsOn}T12:00:00`)
  const periodDays = Number.isNaN(selectedEnd.getTime()) ? 0 : Math.round((selectedEnd.getTime() - tomorrow.getTime()) / 86_400_000) + 2
  const trainingMax = trainingCadence === 'weekly' ? 7 : trainingCadence === 'monthly' ? 31 : Math.max(1, periodDays)
  const invalid = !Number.isFinite(value) || value <= 0 || (type === 'weight' && value > 100) ||
    (isNutrientType(type) && value > Number(NUTRIENT_GOALS[type].max)) ||
    (type === 'hydration' && value >= 10_000) ||
    (type === 'training' && (!Number.isInteger(value) || value > trainingMax)) ||
    !endsOn || endsOn <= today || endsOn > localDateISO(latestEnd)
  const blocked = type === 'weight' && (isPregnantOrNursing || hasMedicalCondition)
  const selected = GOAL_TYPES.find((goal) => goal.type === type)!
  const busy = previewGoal.isPending || create.isPending
  const changeValue = (next: string) => {
    setValues((current) => ({ ...current, [type]: next }))
    setPreview(null)
  }

  return (
    <section className="card p-5 sm:p-7">
      <p className="eyebrow mb-1">Goals</p>
      <h1 className="display-title text-3xl">{title}</h1>
      <p className="mb-5 mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>
        Choose a daily target or period goal, then preview how it will be evaluated before adding it.
      </p>

      <fieldset disabled={busy} className="m-0 border-0 p-0">
      <div role="radiogroup" aria-label="Goal type" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {GOAL_TYPES.map((goal) => (
          <button key={goal.type} type="button" role="radio" aria-checked={type === goal.type}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
                    event.preventDefault()
                    const current = GOAL_TYPES.findIndex((item) => item.type === goal.type)
                    const next = (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + GOAL_TYPES.length) % GOAL_TYPES.length
                    const nextType = GOAL_TYPES[next].type
                    setType(nextType); setPreview(null); setError('')
                    requestAnimationFrame(() => document.getElementById(`goal-type-${nextType}`)?.focus())
                  }}
                  id={`goal-type-${goal.type}`} tabIndex={type === goal.type ? 0 : -1}
                  onClick={() => { setType(goal.type); setPreview(null); setError('') }}
                  className="choice min-h-20 text-left" data-selected={type === goal.type}>
            <strong className="block">{goal.name}</strong>
            <span className="mt-0.5 block text-xs" style={{ color: type === goal.type ? 'inherit' : 'var(--color-tx2)' }}>{goal.detail}</span>
          </button>
        ))}
      </div>

      <div className="my-5 flex items-center justify-between rounded-2xl px-4 py-3 text-sm" style={{ background: 'var(--color-surface-soft)' }}>
        <span><strong>{type === 'training' ? cadenceLabel(trainingCadence) : selected.cadence}</strong> cadence</span>
        <span className="text-right text-xs" style={{ color: 'var(--color-tx2)' }}>{cadenceExplanation(type, trainingCadence)}</span>
      </div>

      {blocked && (
        <div className="mb-4 rounded-lg border p-3 text-sm" role="alert" style={{ borderColor: 'var(--color-warn)' }}>
          {isPregnantOrNursing
            ? 'Weight goals require clinical supervision during pregnancy or nursing.'
            : 'Weight goals require clinical review for your disclosed medical condition.'}
        </div>
      )}

      <div className="space-y-4">
        {type === 'weight' && <>
          <label className="block text-sm">Direction
            <select value={direction} onChange={(event) => { setDirection(event.target.value as 'lose' | 'gain'); setPreview(null) }} className="input mt-1">
              <option value="lose">Lose weight</option><option value="gain">Gain weight</option>
            </select>
          </label>
          <NumberField label="Amount (kg)" value={values.weight} min="0.1" max="100" step="0.1" onChange={changeValue} />
        </>}
        {isNutrientType(type) && <>
          <NumberField label={NUTRIENT_GOALS[type].inputLabel} value={values[type]} min="1"
                       max={NUTRIENT_GOALS[type].max} step="1" onChange={changeValue} />
          <p className="rounded-2xl p-3 text-sm" style={{ background: 'var(--color-surface-soft)', color: 'var(--color-tx2)' }}>
            {type === 'protein'
              ? 'Protein is checked against a weight-based baseline. A lower request is raised to that safer minimum.'
              : type === 'calories'
                ? 'Calories are evaluated as a daily target. Requests below the safe calorie floor are raised and shown in the preview.'
                : `${NUTRIENT_GOALS[type].label} is evaluated from nutrients in your logged meals, using a 10% target range for completed days.`}
          </p>
        </>}
        {type === 'hydration' && <>
          <NumberField label="Water (ml per day)" value={values.hydration} min="1" max="9999" step="50" onChange={changeValue} />
          <p className="rounded-2xl p-3 text-sm" style={{ background: 'var(--color-surface-soft)', color: 'var(--color-tx2)' }}>
            Hydration needs vary with body size and activity. Very high minimums can be unsafe and will be refused rather than saved.
          </p>
        </>}
        {type === 'training' && <>
          <label className="block text-sm">Evaluation period
            <select value={trainingCadence} onChange={(event) => {
              setTrainingCadence(event.target.value as TrainingCadence)
              setPreview(null)
            }} className="input mt-1">
              <option value="weekly">Every week</option>
              <option value="monthly">Every calendar month</option>
              <option value="period">Across the full goal period</option>
            </select>
          </label>
          <NumberField label={trainingTargetLabel(trainingCadence)} value={values.training} min="1" max={String(trainingMax)} step="1" onChange={changeValue} />
          <p className="rounded-2xl p-3 text-sm" style={{ background: 'var(--color-surface-soft)', color: 'var(--color-tx2)' }}>
            Progress comes only from your explicit training check-ins. Meals and profile activity are not counted.
          </p>
        </>}
        <label className="block text-sm">Target date
          <input type="date" min={localDateISO(tomorrow)} max={localDateISO(latestEnd)} value={endsOn}
                 onChange={(event) => { setEndsOn(event.target.value); setPreview(null) }} className="input mt-1" />
        </label>
        {type === 'weight' && <label className="flex min-h-14 items-center gap-3 rounded-2xl border px-4 text-sm" style={{ borderColor: 'var(--color-line)' }}>
          <input type="checkbox" checked={makePrimary} onChange={(event) => { setMakePrimary(event.target.checked); setPreview(null) }} className="h-5 w-5" />
          Use this weight goal for the calorie plan on Today
        </label>}
      </div>
      </fieldset>

      {preview && <GoalPreviewCard type={preview.type} preview={preview.result} />}
      {error && <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      <button type="button" disabled={invalid || blocked || previewGoal.isPending}
              onClick={() => previewGoal.mutate(body())} className="btn-secondary mt-5 w-full disabled:opacity-40">
        {previewGoal.isPending ? 'Calculating...' : 'Preview goal'}
      </button>
      {preview && (
        <button type="button" disabled={create.isPending} onClick={() => create.mutate(preview.payload)}
                className="btn-primary mt-3 w-full disabled:opacity-40">
          {create.isPending ? 'Adding...' : 'Add a goal'}
        </button>
      )}
    </section>
  )
}

function NumberField({ label, value, min, max, step, onChange }: {
  label: string; value: string; min: string; max?: string; step: string; onChange: (value: string) => void
}) {
  return <label className="block text-sm">{label}
    <input type="number" inputMode="decimal" min={min} max={max} step={step} value={value}
           onChange={(event) => onChange(event.target.value)} className="input mt-1" />
  </label>
}

function GoalPreviewCard({ type, preview }: { type: GoalBuilderType; preview: GoalPreview }) {
  const derivation = preview.derivation
  return (
    <div className="card mt-5 p-4" aria-live="polite">
      <div className="flex items-start justify-between gap-3" role="status">
        <div><p className="eyebrow">Resolved plan</p><h2 className="display-title text-2xl">Goal preview</h2></div>
        <span className="rounded-full px-2.5 py-1 text-xs font-semibold capitalize" style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent-strong)' }}>{preview.cadence}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
        {preview.daily_targets.targets.map((target) => (
          <div key={`${target.metric}-${target.scope}`} className="rounded-2xl p-3" style={{ background: 'var(--color-surface-soft)' }}>
            <span className="block capitalize" style={{ color: 'var(--color-tx2)' }}>{formatMetric(target.metric)}</span>
            <strong className="mt-1 block text-lg">{formatNumber(target.value)} {target.unit}</strong>
            <span className="text-xs" style={{ color: 'var(--color-tx2)' }}>{formatDirection(target.direction)}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 border-t pt-3 text-sm" style={{ borderColor: 'var(--color-line)' }}>
        <strong>Safety derivation</strong>
        <Derivation type={type} derivation={derivation} clamped={preview.clamp_fired} />
      </div>
    </div>
  )
}

function Derivation({ type, derivation, clamped }: { type: GoalBuilderType; derivation: Record<string, unknown>; clamped: boolean }) {
  if (type === 'protein') {
    const requested = numberFrom(derivation.requested_protein_g)
    const applied = numberFrom(derivation.applied_protein_g)
    const floor = numberFrom(derivation.protein_floor_g)
    return <p className="mt-1" style={{ color: clamped ? 'var(--color-warn)' : 'var(--color-tx2)' }}>
      {clamped
        ? `You requested ${formatNumber(requested)} g/day, below your RDA-derived ${formatNumber(floor)} g baseline. The applied target is ${formatNumber(applied)} g/day.`
        : `Your ${formatNumber(applied)} g/day target is at or above the RDA-derived ${formatNumber(floor)} g baseline for your recorded weight.`}
    </p>
  }
  if (type === 'calories') {
    const requested = optionalNumberFrom(derivation.requested_intake_kcal)
    const applied = optionalNumberFrom(derivation.applied_intake_kcal)
    const floor = optionalNumberFrom(derivation.calorie_floor_kcal)
    return <p className="mt-1" style={{ color: clamped ? 'var(--color-warn)' : 'var(--color-tx2)' }}>
      {clamped
        ? `You requested ${formatOptionalNumber(requested)} kcal/day. The safe floor is ${formatOptionalNumber(floor)} kcal, so ${formatOptionalNumber(applied)} kcal/day will be applied.`
        : 'Your stated calorie target will be evaluated from the calories in logged meals.'}
    </p>
  }
  if (type === 'carbs' || type === 'fat') {
    return <p className="mt-1" style={{ color: 'var(--color-tx2)' }}>
      Your stated {type} target will be evaluated from logged meals. Completed days within 10% of the target are reached.
    </p>
  }
  if (type === 'hydration') {
    const applied = optionalNumberFrom(derivation.applied_target_ml)
    const estimated = optionalNumberFrom(derivation.estimated_target_ml)
    return <p className="mt-1" style={{ color: 'var(--color-tx2)' }}>
      Applied target: {formatOptionalNumber(applied)} ml/day. Profile-based reference: {formatOptionalNumber(estimated)} ml/day. Extreme minimums are refused for safety.
    </p>
  }
  if (type === 'training') {
    return <p className="mt-1" style={{ color: 'var(--color-tx2)' }}>Calculated from explicit training dates, with one check-in counted per day.</p>
  }
  const requestedRate = numberFrom(derivation.requested_rate_kg_per_week)
  const appliedRate = numberFrom(derivation.applied_rate_kg_per_week)
  const intake = numberFrom(derivation.applied_intake_kcal)
  return <p className="mt-1" style={{ color: clamped ? 'var(--color-warn)' : 'var(--color-tx2)' }}>
    {clamped ? 'Your requested pace was adjusted to the safe limit. ' : ''}
    Requested pace {formatNumber(requestedRate)} kg/week; applied pace {formatNumber(appliedRate)} kg/week with a resolved {formatNumber(intake)} kcal daily target.
  </p>
}

function cadenceExplanation(type: GoalBuilderType, trainingCadence: TrainingCadence): string {
  if (type === 'weight') return 'One result across the date range'
  if (type === 'training' && trainingCadence === 'weekly') return 'Target resets each week'
  if (type === 'training' && trainingCadence === 'monthly') return 'Target resets each calendar month'
  if (type === 'training') return 'One target across the full date range'
  return 'Target resets each day'
}

function cadenceLabel(cadence: TrainingCadence): string {
  if (cadence === 'period') return 'Fixed period'
  return cadence.charAt(0).toUpperCase() + cadence.slice(1)
}

function trainingTargetLabel(cadence: TrainingCadence): string {
  if (cadence === 'weekly') return 'Training days per week'
  if (cadence === 'monthly') return 'Training days per month'
  return 'Training days across the full period'
}

function formatMetric(metric: string): string {
  return metric.replace(/_(kcal|ml|g)$/, '').replaceAll('_', ' ')
}

function formatDirection(direction: string): string {
  if (direction === 'at_most') return 'At most'
  if (direction === 'around') return 'Around'
  return 'At least'
}

function numberFrom(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function optionalNumberFrom(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function formatOptionalNumber(value: number | null): string {
  return value == null ? 'Unavailable' : formatNumber(value)
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatApiError(error: Error): string {
  if (error instanceof ApiRequestError && error.body.suggested_action) {
    return `${error.message} ${error.body.suggested_action}`
  }
  return error.message
}

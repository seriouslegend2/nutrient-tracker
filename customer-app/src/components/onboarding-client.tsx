'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { GoalSetup } from '@/components/goal-setup'
import { api, type Me } from '@/lib/api-client'
import { localDateISO } from '@/lib/date'

type Answers = {
  sex?: string
  date_of_birth?: string
  height_cm?: number
  weight_kg?: number
  waist_cm?: number
  activity: string
  diet?: string
  allergies: string[]
  breakfast_time: string
  lunch_time: string
  dinner_time: string
  portions: Record<string, { count: number }>
  is_pregnant_or_nursing: boolean
  has_medical_condition: boolean
}

const ACTIVITY = [
  ['sedentary', 'Mostly sitting'],
  ['light', 'Light - some walking'],
  ['moderate', 'Moderate - active or 3-4 workouts'],
  ['very_active', 'Very active - daily training'],
  ['extra_active', 'Physical job or two-a-days'],
]

const PORTION_QUESTIONS = [
  { key: 'dal_gravy', label: 'Dal or curry', unit: 'katori', options: [0.5, 1, 1.5, 2] },
  { key: 'rice_grain', label: 'Rice', unit: 'bowl', options: [0.5, 1, 1.5, 2] },
  { key: 'flatbread', label: 'Roti / paratha', unit: 'pieces', options: [1, 2, 3, 4] },
  { key: 'dry_sabzi', label: 'Sabzi', unit: 'katori', options: [0.5, 1, 1.5] },
  { key: 'protein_main', label: 'Chicken / fish', unit: 'g', options: [100, 150, 200, 250] },
  { key: 'curd_raita', label: 'Curd', unit: 'katori', options: [0.5, 1, 1.5] },
  { key: 'beverage_milk', label: 'Milk / tea', unit: 'glass', options: [1, 1.5, 2] },
]

export function OnboardingClient() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)
  const [error, setError] = useState('')
  const [profileComplete, setProfileComplete] = useState(false)
  const [a, setA] = useState<Answers>({
    activity: 'moderate', allergies: [], breakfast_time: '08:00', lunch_time: '13:30',
    dinner_time: '20:30', portions: {}, is_pregnant_or_nursing: false,
    has_medical_condition: false,
  })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })

  useEffect(() => {
    if (me.data?.onboarding_complete && !profileComplete) router.replace('/home')
  }, [me.data, profileComplete, router])

  const submit = useMutation({
    mutationFn: () => api.submitOnboarding(a as unknown as Record<string, unknown>),
    onSuccess: () => {
      queryClient.setQueryData<Me>(['me'], (old) => old ? { ...old, onboarding_complete: true } : old)
      setProfileComplete(true)
      setError('')
    },
    onError: (err) => setError(err.message),
  })

  const set = <K extends keyof Answers>(key: K, value: Answers[K]) =>
    setA((previous) => ({ ...previous, [key]: value }))

  const next = () => {
    const problem = validateStep(step, a) || (step === 4 ? validateStep(0, a) || validateStep(1, a) : '')
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    if (step === 4) submit.mutate()
    else setStep((value) => value + 1)
  }

  if (profileComplete) {
    return (
      <div className="app-shell min-h-screen px-5 pt-8 sm:px-6">
        <p className="eyebrow mb-3">Profile complete</p>
        <div className="mb-6 h-1 rounded-full" style={{ background: 'var(--color-accent)' }} />
        <GoalSetup
          title="Set your first goal"
          isPregnantOrNursing={a.is_pregnant_or_nursing}
          hasMedicalCondition={a.has_medical_condition}
          onCreated={() => router.replace('/home')}
        />
        <button onClick={() => router.replace('/home')} className="mt-4 w-full text-sm" style={{ color: 'var(--color-tx2)' }}>
          Continue without a goal
        </button>
      </div>
    )
  }

  if (me.isPending || me.data?.onboarding_complete) {
    return <main className="grid min-h-screen place-items-center text-sm" style={{ color: 'var(--color-tx2)' }}>Loading your profile…</main>
  }

  return (
    <div className="app-shell min-h-screen px-5 pt-8 sm:px-6">
      <div className="mb-3 flex items-center justify-between">
        <p className="eyebrow">Set up your profile</p>
        <span className="text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>{step + 1} of 5</span>
      </div>
      <div className="mb-6 flex gap-1.5">
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="h-1 flex-1 rounded-full"
               style={{ background: index <= step ? 'var(--color-accent)' : 'var(--color-line)' }} />
        ))}
      </div>

      {step === 0 && (
        <Screen title="About you" why="Required to estimate what your body burns safely.">
          <Choice label="Sex" options={[['male', 'Male'], ['female', 'Female']]}
                  value={a.sex} onChange={(value) => set('sex', value)} />
          <Field label="Date of birth (required)">
            <input type="date" required max={localDateISO()}
                   value={a.date_of_birth ?? ''} onChange={(e) => set('date_of_birth', e.target.value)}
                   className="input" />
          </Field>
        </Screen>
      )}

      {step === 1 && (
        <Screen title="Your body" why="Height and weight are required for body and goal targets. Waist is optional.">
          <NumberField label="Height (cm, required)" value={a.height_cm}
                       onChange={(value) => set('height_cm', value)} min={50} max={275} />
          <NumberField label="Weight (kg, required)" value={a.weight_kg}
                       onChange={(value) => set('weight_kg', value)} min={20} max={400} />
          <NumberField label="Waist (cm, optional)" value={a.waist_cm}
                       onChange={(value) => set('waist_cm', value)} min={20} max={300} />
          <Choice label="How active are you?" options={ACTIVITY} value={a.activity}
                  onChange={(value) => set('activity', value)} />
        </Screen>
      )}

      {step === 2 && (
        <Screen title="How you eat" why="These optional details improve ranking and meal timing.">
          <Choice label="Diet" options={[
            ['vegetarian', 'Vegetarian'], ['eggetarian', 'Eggetarian'],
            ['non_vegetarian', 'Non-vegetarian'], ['vegan', 'Vegan'], ['jain', 'Jain'],
          ]} value={a.diet} onChange={(value) => set('diet', value)} />
          <Field label="Anything you avoid?">
            <input placeholder="peanuts, shellfish…" className="input"
                   onChange={(e) => set('allergies', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            {(['breakfast_time', 'lunch_time', 'dinner_time'] as const).map((key) => (
              <Field key={key} label={key.replace('_time', '')}>
                <input type="time" value={a[key]} onChange={(e) => set(key, e.target.value)} className="input" />
              </Field>
            ))}
          </div>
        </Screen>
      )}

      {step === 3 && (
        <Screen title="Your portions" why="Optional defaults make manual logging faster. You can edit all of them later.">
          {PORTION_QUESTIONS.map((question) => (
            <Field key={question.key} label={question.label}>
              <div className="flex flex-wrap gap-2">
                {question.options.map((option) => (
                  <button key={option} type="button"
                          onClick={() => set('portions', { ...a.portions, [question.key]: { count: option } })}
                          className="choice"
                          data-selected={a.portions[question.key]?.count === option}>
                    {option} {question.unit}
                  </button>
                ))}
              </div>
            </Field>
          ))}
        </Screen>
      )}

      {step === 4 && (
        <Screen title="Goal safety" why="Keep these answers current before setting or changing a weight goal.">
          <Toggle label="I'm pregnant or breastfeeding" checked={a.is_pregnant_or_nursing}
                  onChange={(value) => set('is_pregnant_or_nursing', value)} />
          <Toggle label="I have a medical condition affecting my diet" checked={a.has_medical_condition}
                  onChange={(value) => set('has_medical_condition', value)} />
          {(a.is_pregnant_or_nursing || a.has_medical_condition) && (
            <p className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--color-warn)' }}>
              Weight targets may require guidance from your doctor or dietitian. The goal preview will not bypass safety limits.
            </p>
          )}
        </Screen>
      )}

      {error && <p className="mt-5 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      <div className="mt-8 flex gap-3">
        {step > 0 && <button type="button" onClick={() => setStep((value) => value - 1)} className="btn-secondary">Back</button>}
        <button type="button" onClick={next} disabled={submit.isPending} className="btn-primary flex-1">
          {step === 4 ? (submit.isPending ? 'Saving profile…' : 'Save and set a goal') : 'Continue'}
        </button>
      </div>
    </div>
  )
}

function validateStep(step: number, answers: Answers) {
  if (step === 0) {
    if (!answers.sex) return 'Select your sex to continue.'
    if (!answers.date_of_birth) return 'Enter your date of birth to continue.'
    const dob = new Date(`${answers.date_of_birth}T00:00:00`)
    if (Number.isNaN(dob.getTime()) || dob > new Date()) return 'Enter a valid date of birth.'
  }
  if (step === 1) {
    if (!answers.height_cm || answers.height_cm < 50 || answers.height_cm > 275) return 'Enter a height between 50 and 275 cm.'
    if (!answers.weight_kg || answers.weight_kg < 20 || answers.weight_kg > 400) return 'Enter a weight between 20 and 400 kg.'
    if (answers.waist_cm && (answers.waist_cm < 20 || answers.waist_cm > 300)) return 'Enter a valid waist measurement or leave it blank.'
  }
  return ''
}

function Screen({ title, why, children }: { title: string; why: string; children: React.ReactNode }) {
  return <div className="card p-5 sm:p-7"><h1 className="display-title text-3xl">{title}</h1>
    <p className="mb-6 mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--color-tx2)' }}>{why}</p>
    <div className="space-y-4">{children}</div></div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-sm capitalize" style={{ color: 'var(--color-tx2)' }}>{label}</span>{children}</label>
}

function NumberField({ label, value, onChange, min, max }: {
  label: string; value?: number; onChange: (value?: number) => void; min: number; max: number
}) {
  return <Field label={label}><input type="number" inputMode="decimal" min={min} max={max}
    value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)} className="input" /></Field>
}

function Choice({ label, options, value, onChange }: {
  label: string; options: string[][]; value?: string; onChange: (value: string) => void
}) {
  return <Field label={label}><div className="flex flex-wrap gap-2">{options.map(([key, text]) => (
    <button key={key} type="button" onClick={() => onChange(key)} className="choice" data-selected={value === key}>{text}</button>
  ))}</div></Field>
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex min-h-14 items-center gap-3 rounded-2xl border px-4 text-sm" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface-soft)' }}><input className="h-5 w-5" type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>
}

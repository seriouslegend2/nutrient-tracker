'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api, type GoalPreview } from '@/lib/api-client'

const iso = (date: Date) => date.toISOString().slice(0, 10)
const defaultEnd = () => {
  const date = new Date()
  date.setDate(date.getDate() + 84)
  return iso(date)
}

export function GoalSetup({ isPregnantOrNursing = false, hasMedicalCondition = false, onCreated }: {
  isPregnantOrNursing?: boolean
  hasMedicalCondition?: boolean
  onCreated?: () => void
}) {
  const queryClient = useQueryClient()
  const [direction, setDirection] = useState('lose')
  const [amount, setAmount] = useState('5')
  const [endsOn, setEndsOn] = useState(defaultEnd)
  const [preview, setPreview] = useState<GoalPreview | null>(null)
  const [error, setError] = useState('')

  const body = () => ({
    kind: 'body_weight',
    spec: { direction, amount_kg: Number(amount) },
    starts_on: iso(new Date()),
    ends_on: endsOn,
  })
  const previewGoal = useMutation({
    mutationFn: () => api.previewGoal(body()),
    onSuccess: (value) => { setPreview(value); setError('') },
    onError: (err) => setError(err.message),
  })
  const create = useMutation({
    mutationFn: () => api.createGoal(body()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['goal'] })
      onCreated?.()
    },
    onError: (err) => setError(err.message),
  })

  const invalid = !amount || Number(amount) <= 0 || !endsOn || endsOn <= iso(new Date())
  const blocked = isPregnantOrNursing

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Set your first goal</h1>
      <p className="mb-5 mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>
        Preview the daily targets and any safety adjustment before saving.
      </p>
      {(blocked || hasMedicalCondition) && (
        <div className="mb-4 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--color-warn)' }}>
          {blocked
            ? 'Weight goals require clinical supervision during pregnancy or nursing.'
            : 'A medical condition can change suitable targets. Review this plan with your doctor or dietitian.'}
        </div>
      )}
      <div className="space-y-4">
        <label className="block text-sm">Direction
          <select value={direction} onChange={(e) => { setDirection(e.target.value); setPreview(null) }} className="input mt-1">
            <option value="lose">Lose weight</option><option value="gain">Gain weight</option>
          </select>
        </label>
        <label className="block text-sm">Amount (kg)
          <input type="number" min="0.1" max="100" step="0.1" value={amount}
                 onChange={(e) => { setAmount(e.target.value); setPreview(null) }} className="input mt-1" />
        </label>
        <label className="block text-sm">Target date
          <input type="date" min={iso(new Date())} value={endsOn}
                 onChange={(e) => { setEndsOn(e.target.value); setPreview(null) }} className="input mt-1" />
        </label>
      </div>
      {preview && (
        <div className="card mt-5 p-4">
          <h2 className="text-sm font-medium">Daily preview</h2>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
            {preview.daily_targets.targets.map((target) => (
              <div key={`${target.metric}-${target.scope}`}>
                <span className="capitalize">{target.metric.replace(/_(kcal|g)$/, '').replaceAll('_', ' ')}</span>{' '}
                <strong>{Math.round(target.value)} {target.unit}</strong>
              </div>
            ))}
          </div>
          {preview.clamp_fired && (
            <p className="mt-3 text-sm" style={{ color: 'var(--color-warn)' }}>
              The requested pace was adjusted to stay within the configured safety limits.
            </p>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      <button type="button" disabled={invalid || blocked || previewGoal.isPending}
              onClick={() => previewGoal.mutate()} className="btn-secondary mt-5 w-full disabled:opacity-40">
        {previewGoal.isPending ? 'Calculating…' : 'Preview goal'}
      </button>
      {preview && (
        <button type="button" disabled={create.isPending} onClick={() => create.mutate()}
                className="btn-primary mt-3 w-full disabled:opacity-40">
          {create.isPending ? 'Creating…' : 'Create goal'}
        </button>
      )}
    </section>
  )
}

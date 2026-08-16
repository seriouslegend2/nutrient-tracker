'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api, type MealDraftConfirmResponse } from '@/lib/api-client'
import {
  buildMealDraftConfirmRequest,
  calculateMealDraftTotals,
  parseMediaMealDraft,
  type MealDraftReviewItem,
} from '@/lib/meal-draft'
import { isMealSlot, MEAL_SLOT_OPTIONS, suggestedMealSlot } from '@/lib/meal-slots'

type MealDraftReviewProps = {
  messageId: string
  payload: unknown
  initialDate: string
  initialSlot?: string | null
  onConfirmed?: (result: MealDraftConfirmResponse) => void
  onDiscard?: () => void
}

const INVALIDATION_KEYS = [
  ['messages'], ['day'], ['meals'], ['goals', 'summary'], ['trend'], ['macros'], ['micros'],
  ['goal-vs-actual'], ['meal-patterns'], ['nutrient-series'],
]

export function MealDraftReview({
  messageId,
  payload,
  initialDate,
  initialSlot,
  onConfirmed,
  onDiscard,
}: MealDraftReviewProps) {
  const queryClient = useQueryClient()
  const [draft] = useState(() => parseMediaMealDraft(payload))
  const [items, setItems] = useState<MealDraftReviewItem[]>(() => draft?.items ?? [])
  const [mealDate, setMealDate] = useState(initialDate)
  const [mealSlot, setMealSlot] = useState(isMealSlot(initialSlot) ? initialSlot : suggestedMealSlot())
  const [discarded, setDiscarded] = useState(false)
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null)

  const confirm = useMutation({
    mutationFn: () => api.confirmMessage(
      messageId,
      buildMealDraftConfirmRequest(items, mealDate, mealSlot)
    ),
    onSuccess: async (result) => {
      setConfirmedCount(result.created)
      onConfirmed?.(result)
      await Promise.all(INVALIDATION_KEYS.map((queryKey) =>
        queryClient.invalidateQueries({ queryKey })
      ))
    },
  })
  const discard = useMutation({
    mutationFn: () => api.discardMessage(messageId),
    onSuccess: async () => {
      setDiscarded(true)
      onDiscard?.()
      await queryClient.invalidateQueries({ queryKey: ['messages'] })
    },
  })

  if (discarded) {
    return <p className="rounded-2xl p-4 text-sm" role="status" style={{ background: 'var(--color-surface-soft)', color: 'var(--color-tx2)' }}>Draft discarded.</p>
  }

  if (!draft) {
    return (
      <section className="card p-4" role="alert">
        <p className="font-semibold">This saved draft could not be read.</p>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>
          Discard it and capture the meal again.
        </p>
        <button type="button" className="action-button-danger mt-3" disabled={discard.isPending} onClick={() => discard.mutate()}>{discard.isPending ? 'Discarding...' : 'Discard draft'}</button>
      </section>
    )
  }

  if (confirmedCount != null) {
    return <p className="rounded-2xl p-4 font-semibold" role="status" style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent-strong)' }}>{confirmedCount} {confirmedCount === 1 ? 'item' : 'items'} logged.</p>
  }

  const totals = calculateMealDraftTotals(items)
  const hasNutrition = Object.keys(totals.nutrients).length > 0

  return (
    <section aria-labelledby={`meal-draft-${messageId}`} className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Ready for review</p>
          <h2 id={`meal-draft-${messageId}`} className="display-title mt-0.5 text-2xl">Meal draft</h2>
        </div>
        <span className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent-strong)' }}>
          {items.length} detected
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-semibold">Date
          <input type="date" className="input mt-1" value={mealDate} onChange={(event) => setMealDate(event.target.value)} />
        </label>
        <label className="text-sm font-semibold">Meal
          <select className="input mt-1" value={mealSlot} onChange={(event) => {
            if (isMealSlot(event.target.value)) setMealSlot(event.target.value)
          }}>
            {MEAL_SLOT_OPTIONS.map((slot) => <option key={slot.value} value={slot.value}>{slot.label}</option>)}
          </select>
        </label>
      </div>

      <div className="mt-4 space-y-3">
        {items.map((item) => (
          <DraftItem key={item.id} item={item}
            onChange={(next) => setItems((current) => current.map((value) => value.id === item.id ? next : value))}
            onRemove={() => setItems((current) => current.filter((value) => value.id !== item.id))} />
        ))}
      </div>

      {!items.length && (
        <p className="mt-4 rounded-xl p-3 text-sm" role="alert" style={{ background: 'var(--color-surface-soft)', color: 'var(--color-danger)' }}>
          Keep at least one item to log this draft.
        </p>
      )}

      <div className="mt-4 rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}>
        <p className="text-sm font-semibold">Estimated total</p>
        {hasNutrition ? (
          <NutritionLine nutrients={totals.nutrients} prominent />
        ) : (
          <p className="mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>No resolved nutrition yet.</p>
        )}
        {totals.unresolvedItems > 0 && (
          <p className="mt-1 text-xs" style={{ color: 'var(--color-tx2)' }}>
            {totals.unresolvedItems} unresolved {totals.unresolvedItems === 1 ? 'item is' : 'items are'} not included in this estimate.
          </p>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className="action-button-danger" disabled={confirm.isPending || discard.isPending}
          onClick={() => discard.mutate()}>{discard.isPending ? 'Discarding...' : 'Discard'}</button>
        <button type="button" className="btn-primary" disabled={confirm.isPending || discard.isPending || !items.length || !mealDate}
          onClick={() => confirm.mutate()}>{confirm.isPending ? 'Logging...' : 'Confirm meal'}</button>
      </div>
      {confirm.isError && <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{confirm.error.message}</p>}
      {discard.isError && <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{discard.error.message}</p>}
    </section>
  )
}

function DraftItem({ item, onChange, onRemove }: {
  item: MealDraftReviewItem
  onChange: (item: MealDraftReviewItem) => void
  onRemove: () => void
}) {
  const step = item.measurement === 'grams' ? 10 : 0.5
  const adjust = (delta: number) => {
    const amount = Math.max(step, Math.round((item.amount + delta) * 10) / 10)
    onChange({ ...item, amount })
  }
  const hasNutrition = Object.keys(item.nutrients).length > 0

  return (
    <article className="rounded-2xl border p-3.5" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-bold">{item.resolvedName ?? item.name}</h3>
          {item.resolvedName && item.resolvedName !== item.name && (
            <p className="mt-0.5 text-xs" style={{ color: 'var(--color-accent-strong)' }}>Detected as {item.name}</p>
          )}
          {(item.range || item.confidence) && (
            <p className="mt-0.5 text-xs" style={{ color: 'var(--color-tx2)' }}>
              {item.range ? `Roughly ${formatNumber(item.range.low)}-${formatNumber(item.range.high)} g` : 'Mass range unavailable'}
              {item.confidence ? ` · ${item.confidence} confidence` : ''}
            </p>
          )}
          {item.householdAmount != null && item.householdUnit && (
            <p className="mt-0.5 text-xs" style={{ color: 'var(--color-tx2)' }}>
              Household portion: {formatNumber(item.householdAmount)} {item.householdUnit}
            </p>
          )}
        </div>
        <button type="button" className="min-h-0 text-sm font-semibold" style={{ color: 'var(--color-danger)' }} onClick={onRemove}>Remove</button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="action-button-secondary w-12 shrink-0 px-0" aria-label={`Decrease ${item.name}`} onClick={() => adjust(-step)}>-</button>
        <label className="min-w-0 flex-1 text-center text-xs font-semibold" style={{ color: 'var(--color-tx2)' }}>
          {item.measurement === 'grams' ? 'Grams' : 'Portions'}
          <div className="relative mt-1">
            <input type="number" min={step} step={step} className="input pr-10 text-center tabular-nums" value={item.amount}
              onChange={(event) => {
                const amount = Number(event.target.value)
                if (Number.isFinite(amount) && amount > 0) onChange({ ...item, amount })
              }} />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs">{item.unit}</span>
          </div>
        </label>
        <button type="button" className="action-button-secondary w-12 shrink-0 px-0" aria-label={`Increase ${item.name}`} onClick={() => adjust(step)}>+</button>
      </div>

      {hasNutrition ? <NutritionLine nutrients={calculateMealDraftTotals([item]).nutrients} /> : (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>Nutrition unresolved. It is not included in the estimate.</p>
      )}
    </article>
  )
}

function NutritionLine({ nutrients, prominent = false }: { nutrients: Record<string, number>; prominent?: boolean }) {
  const values = [
    nutrients.calories_kcal != null ? `${Math.round(nutrients.calories_kcal)} kcal` : null,
    nutrients.protein_g != null ? `P ${formatNumber(nutrients.protein_g)} g` : null,
    nutrients.carbs_g != null ? `C ${formatNumber(nutrients.carbs_g)} g` : null,
    nutrients.fat_g != null ? `F ${formatNumber(nutrients.fat_g)} g` : null,
  ].filter(Boolean)
  return <p className={`${prominent ? 'mt-1 text-lg font-bold' : 'mt-2 text-xs font-semibold'} tabular-nums`} style={{ color: prominent ? 'var(--color-tx)' : 'var(--color-tx2)' }}>{values.join(' · ')}</p>
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

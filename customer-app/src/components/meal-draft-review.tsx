'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api, type MealDraftConfirmResponse } from '@/lib/api-client'
import { formatNutrientValue, otherNutrients } from '@/lib/nutrients'
import {
  buildMealDraftConfirmRequest,
  calculateMealDraftTotals,
  mealDraftItemGrams,
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
  const [mealDate, setMealDate] = useState(() => draft?.mealDate ?? initialDate)
  const [mealSlot, setMealSlot] = useState(() => isMealSlot(draft?.mealType)
    ? draft.mealType
    : isMealSlot(initialSlot) ? initialSlot : suggestedMealSlot())
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
          <>
            <NutritionLine nutrients={totals.nutrients} prominent />
            <OtherNutrientsLine nutrients={totals.nutrients} />
          </>
        ) : (
          <p className="mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>No resolved nutrition yet.</p>
        )}
        <p className="mt-1 text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>{formatNumber(totals.totalGrams)} g total</p>
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
  const step = 0.25
  const adjust = (delta: number) => {
    const servings = Math.max(step, Math.round((item.servings + delta) * 100) / 100)
    onChange({ ...item, servings })
  }
  const hasNutrition = Object.keys(item.nutrients).length > 0

  return (
    <article className="rounded-2xl border p-3.5" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-bold">{item.resolvedName}</h3>
          {item.resolvedName !== item.name && (
            <p className="mt-0.5 text-xs" style={{ color: 'var(--color-accent-strong)' }}>Detected as {item.name}</p>
          )}
          <p className="mt-0.5 text-xs" style={{ color: 'var(--color-tx2)' }}>
            Fixed serving: 1 {item.servingUnit} = {formatNumber(item.gramsPerServing)} g
          </p>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--color-tx2)' }}>
            {amountSourceLabel(item.amountSource)}
            {item.range ? ` · estimated range ${formatNumber(item.range.low)}-${formatNumber(item.range.high)} g` : ''}
            {item.confidence ? ` · ${item.confidence} confidence` : ''}
          </p>
        </div>
        <button type="button" className="min-h-0 text-sm font-semibold" style={{ color: 'var(--color-danger)' }} onClick={onRemove}>Remove</button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="action-button-secondary w-12 shrink-0 px-0" aria-label={`Decrease ${item.resolvedName} servings`} onClick={() => adjust(-step)}>-</button>
        <label className="min-w-0 flex-1 text-center text-xs font-semibold" style={{ color: 'var(--color-tx2)' }}>
          Servings
          <div className="relative mt-1">
            <input type="number" min={step} step={step} className="input pr-16 text-center tabular-nums" value={item.servings}
              onChange={(event) => {
                const servings = Number(event.target.value)
                if (Number.isFinite(servings) && servings > 0) onChange({ ...item, servings })
              }} />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs">{item.servingUnit}</span>
          </div>
        </label>
        <button type="button" className="action-button-secondary w-12 shrink-0 px-0" aria-label={`Increase ${item.resolvedName} servings`} onClick={() => adjust(step)}>+</button>
      </div>

      <p className="mt-2 text-xs font-semibold tabular-nums" style={{ color: 'var(--color-tx2)' }}>
        {formatNumber(item.servings)} {item.servingUnit} · {formatNumber(mealDraftItemGrams(item))} g
      </p>
      {hasNutrition ? (() => {
        const nutrients = calculateMealDraftTotals([item]).nutrients
        return <><NutritionLine nutrients={nutrients} /><OtherNutrientsLine nutrients={nutrients} /></>
      })() : (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>No nutrition is available for this dish.</p>
      )}
    </article>
  )
}

function amountSourceLabel(source: string | null): string {
  if (source === 'agent1_user_stated') return 'Quantity provided by you'
  if (source === 'agent1_document_declared') return 'Quantity read from the document'
  if (source === 'agent1_visible' || source === 'agent1_estimated') return 'Quantity estimated by Agent 1'
  return 'Quantity supplied by Agent 1'
}

function NutritionLine({ nutrients, prominent = false }: { nutrients: Record<string, number>; prominent?: boolean }) {
  const values = [
    nutrients.calories_kcal != null ? `${Math.round(nutrients.calories_kcal)} kcal` : null,
    nutrients.protein_g != null ? `P ${formatNumber(nutrients.protein_g)} g` : null,
    nutrients.carbs_g != null ? `C ${formatNumber(nutrients.carbs_g)} g` : null,
    nutrients.fat_g != null ? `F ${formatNumber(nutrients.fat_g)} g` : null,
    nutrients.fiber_g != null ? `Fiber ${formatNumber(nutrients.fiber_g)} g` : null,
  ].filter(Boolean)
  return <p className={`${prominent ? 'mt-1 text-lg font-bold' : 'mt-2 text-xs font-semibold'} tabular-nums`} style={{ color: prominent ? 'var(--color-tx)' : 'var(--color-tx2)' }}>{values.join(' · ')}</p>
}

function OtherNutrientsLine({ nutrients }: { nutrients: Record<string, number> }) {
  const values = otherNutrients(nutrients)
  if (!values.length) return null
  return (
    <p className="mt-1 text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>
      {values.map((item) => `${item.label} ${formatNutrientValue(item.value)} ${item.unit}`).join(' · ')}
    </p>
  )
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

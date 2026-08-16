'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'

import { BottomNav } from '@/components/nav'
import { NutrientSpine } from '@/components/nutrient-spine'
import { api, type Day, type Dish, type Meal } from '@/lib/api-client'
import { isISODate, localDateISO } from '@/lib/date'

const SLOTS = ['breakfast', 'brunch', 'lunch', 'snacks', 'dinner', 'misc'] as const
const SLOT_LABEL: Record<string, string> = {
  breakfast: 'Breakfast', brunch: 'Brunch', lunch: 'Lunch', snacks: 'Snacks', dinner: 'Dinner', misc: 'Other',
}
const PROVENANCE: Record<string, string> = {
  meals: 'you set this', dish_household: 'your saved dish portion',
  category_household: 'your category portion', dish_global: 'standard dish portion',
  category_global: 'general category portion', unknown: 'nutrition unknown',
}
export function MealsClient() {
  const params = useSearchParams()
  const requestedDate = params.get('date')
  const requestedSlot = params.get('slot')
  const [selected, setSelected] = useState(isISODate(requestedDate) ? requestedDate : localDateISO())
  const [addingSlot, setAddingSlot] = useState<string | null>(
    requestedSlot && SLOTS.some((slot) => slot === requestedSlot) ? requestedSlot : null
  )
  const queryClient = useQueryClient()
  const dayQuery = useQuery({ queryKey: ['day', selected], queryFn: () => api.day(selected) })
  const week = useMemo(() => {
    const base = new Date(`${selected}T12:00:00`)
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(base)
      date.setDate(base.getDate() - 3 + index)
      return date
    })
  }, [selected])
  const changed = () => {
    queryClient.invalidateQueries({ queryKey: ['day', selected] })
    queryClient.invalidateQueries({ queryKey: ['goals', 'summary'] })
  }

  return (
    <div className="app-shell px-4 pt-6 sm:px-6">
      <div className="mb-5 flex items-end justify-between">
        <div><p className="mb-1 text-base font-semibold" style={{ color: 'var(--color-accent-strong)' }}>Nourish</p><h1 className="display-title text-[38px] leading-none">Meals</h1></div>
        <button onClick={() => setAddingSlot(suggestedSlot())} className="btn-primary px-4 text-sm">+ Add meal</button>
      </div>

      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-semibold">{new Date(`${selected}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        {selected !== localDateISO() && <button className="action-button" onClick={() => { setSelected(localDateISO()); setAddingSlot(null) }}>Today</button>}
      </div>

      <div className="mb-5 flex gap-2 overflow-x-auto pb-2">
        {week.map((date) => {
          const key = localDateISO(date)
          const active = key === selected
          const isToday = key === localDateISO()
          return <button key={key} onClick={() => { setSelected(key); setAddingSlot(null) }}
            className="min-w-[56px] shrink-0 rounded-2xl px-2 py-2.5 text-center shadow-sm"
            style={{ background: active ? 'var(--color-accent-strong)' : 'var(--color-surface)',
              color: active ? 'oklch(0.98 0.01 100)' : 'var(--color-tx)',
              border: `1px solid ${isToday && !active ? 'var(--color-accent)' : 'var(--color-line)'}` }}>
            <div className="text-[13px] font-semibold uppercase opacity-80">{date.toLocaleDateString(undefined, { weekday: 'short' })}</div>
            <div className="text-lg font-bold tabular-nums">{date.getDate()}</div>
          </button>
        })}
      </div>

      {addingSlot && <ManualMealForm date={selected} initialSlot={addingSlot}
        onCancel={() => setAddingSlot(null)} onCreated={() => { setAddingSlot(null); changed() }} />}
      {dayQuery.data && <DayTotals day={dayQuery.data} />}
      {dayQuery.isError ? <section className="card p-5"><p className="font-semibold">Meals could not be loaded.</p><button className="action-button mt-3" onClick={() => dayQuery.refetch()}>Try again</button></section> : dayQuery.isLoading ? <section className="card p-5">Loading meals…</section> : SLOTS.map((slot) => {
        const items = dayQuery.data?.slots?.[slot] ?? []
         return <section key={slot} className="card mb-3 p-5">
          <div className="mb-2 flex items-baseline justify-between">
             <h2 className="display-title text-xl">{SLOT_LABEL[slot]}</h2>
            <span className="text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>
              {Math.round(items.reduce((sum, item) => sum + (item.nutrients?.calories_kcal ?? 0), 0))} kcal
            </span>
          </div>
          {items.map((item) => <MealRow key={item.id} item={item} onChange={changed} />)}
           {!items.length && <p className="py-1 text-sm" style={{ color: 'var(--color-tx2)' }}>Nothing logged yet.</p>}
           <button onClick={() => setAddingSlot(slot)} className="action-button mt-3 w-full">
            + Add {SLOT_LABEL[slot].toLowerCase()}
          </button>
        </section>
      })}
      <BottomNav />
    </div>
  )
}

function ManualMealForm({ date, initialSlot, onCancel, onCreated }: {
  date: string; initialSlot: string; onCancel: () => void; onCreated: () => void
}) {
  const [slot, setSlot] = useState(initialSlot)
  const [search, setSearch] = useState('')
  const [selectedDish, setSelectedDish] = useState<Dish | null>(null)
  const [custom, setCustom] = useState(false)
  const [portions, setPortions] = useState('1')
  const [grams, setGrams] = useState('')
  const [portionUnit, setPortionUnit] = useState('portion')
  const deferredSearch = useDeferredValue(search.trim())
  const results = useQuery({
    queryKey: ['dish-search', deferredSearch],
    queryFn: () => api.searchDishes(deferredSearch),
    enabled: deferredSearch.length >= 2 && selectedDish?.name !== deferredSearch,
  })
  const resolved = useQuery({
    queryKey: ['dish-portion', selectedDish?.dish_id],
    queryFn: () => api.dishPortion(selectedDish!.dish_id),
    enabled: Boolean(selectedDish),
  })
  useEffect(() => {
    if (resolved.data) setPortionUnit(resolved.data.portion_unit)
  }, [resolved.data])

  const create = useMutation({
    mutationFn: () => api.logMeal({ meal_date: date, meal_type: slot,
      dish_name: search.trim(), food_id: selectedDish?.dish_id,
      portions: custom ? 1 : Number(portions),
      grams: custom ? Number(grams) : undefined,
      portion_unit: custom ? 'g' : portionUnit }),
    onSuccess: onCreated,
  })
  const invalid = custom
    ? !search.trim() || !grams || Number(grams) <= 0
    : !selectedDish || !portions || Number(portions) <= 0

  return <section aria-labelledby="manual-meal-heading" className="card mb-4 p-5 sm:p-6">
    <div className="mb-4 flex items-center justify-between"><h2 id="manual-meal-heading" className="display-title text-2xl">Add manually</h2>
      <button onClick={onCancel} className="action-button-secondary">Close</button></div>
    <div className="grid grid-cols-2 gap-3">
      <label className="text-sm">Date<input value={date} disabled className="input mt-1 opacity-70" /></label>
      <label className="text-sm">Meal
        <select value={slot} onChange={(e) => setSlot(e.target.value)} className="input mt-1">
          {SLOTS.map((value) => <option key={value} value={value}>{SLOT_LABEL[value]}</option>)}
        </select>
      </label>
    </div>
    <label className="mt-3 block text-sm">Dish
      <input value={search} onChange={(e) => { setSearch(e.target.value); setSelectedDish(null); setCustom(false) }}
             placeholder="Search foods and dishes" className="input mt-1" />
    </label>
    {results.isFetching && <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>Searching…</p>}
    {results.data && !selectedDish && (
      <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--color-line)' }}>
        {results.data.items.map((dish) => <button key={dish.dish_id} type="button"
          onClick={() => { setSelectedDish(dish); setSearch(dish.name); setPortionUnit(dish.portion_unit) }}
          className="flex w-full justify-between border-b px-3 py-2 text-left text-sm last:border-b-0"
          style={{ borderColor: 'var(--color-line)' }}><span>{dish.name}</span>
          <span style={{ color: 'var(--color-tx2)' }}>{dish.portion_grams} g/{dish.portion_unit}</span></button>)}
        {!results.data.items.length && <div className="p-3"><p className="text-sm" style={{ color: 'var(--color-tx2)' }}>No matching food found.</p><button type="button" className="action-button mt-2 w-full" onClick={() => setCustom(true)}>Use “{search.trim()}” as a custom food</button></div>}
      </div>
    )}
    {selectedDish && resolved.data && <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>
      Your resolved portion: {resolved.data.portion_grams ?? 'unknown'} g per {resolved.data.portion_unit} · {PROVENANCE[resolved.data.resolved_from] ?? resolved.data.resolved_from}
    </p>}
    {custom ? <div className="mt-3 rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}>
      <p className="font-semibold">Custom food</p>
      <label className="mt-3 block text-sm">Amount eaten (grams)<input type="number" min="1" inputMode="decimal" value={grams} onChange={(e) => setGrams(e.target.value)} className="input mt-1" /></label>
      <p className="mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>You can log this now, but nutrition totals may exclude it until it is matched to a food.</p>
      <button type="button" className="action-button-secondary mt-3" onClick={() => setCustom(false)}>Back to search</button>
    </div> : <div className="mt-3">
      <label className="text-sm">Servings<input type="number" min="0.1" step="0.1" value={portions}
        onChange={(e) => setPortions(e.target.value)} className="input mt-1" /></label>
    </div>}
    {!custom && !selectedDish && search.trim() && <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>
      Select a result, or use a custom food if there is no match.
    </p>}
    {create.error && <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{create.error.message}</p>}
    <button disabled={invalid || create.isPending} onClick={() => create.mutate()}
            className="btn-primary mt-4 w-full disabled:opacity-40">{create.isPending ? 'Adding…' : 'Add meal'}</button>
  </section>
}

function DayTotals({ day }: { day: Day }) {
  const totals = day.totals ?? {}
  return <section className="card mb-4 p-4"><div className="grid grid-cols-4 divide-x text-sm" style={{ borderColor: 'var(--color-line)' }}>
    {(['calories_kcal', 'protein_g', 'carbs_g', 'fat_g'] as const).map((key) => <div key={key} className="text-center">
      <div className="display-title tabular-nums text-xl">{Math.round(totals[key] ?? 0)}</div>
      <div className="text-sm capitalize" style={{ color: 'var(--color-tx2)' }}>{key === 'calories_kcal' ? 'kcal' : key.replace('_g', '')}</div>
    </div>)}
  </div>{day.unaccounted_items > 0 && <p className="mt-3 text-xs" style={{ color: 'var(--color-warn)' }}>
    {day.unaccounted_items} item{day.unaccounted_items > 1 ? 's' : ''} excluded because nutrition is unknown.</p>}</section>
}

function MealRow({ item, onChange }: { item: Meal; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [portions, setPortions] = useState(String(item.portions))
  const unknown = !item.nutrients || Object.keys(item.nutrients).length === 0
  const update = useMutation({
    mutationFn: () => api.adjustMeal(item.id, {
      portions: Number(portions),
    }),
    onSuccess: () => { setEditing(false); onChange() },
  })
  const remove = useMutation({ mutationFn: () => api.deleteMeal(item.id), onSuccess: onChange })

  return <article aria-label={item.dish_name} data-meal-id={item.id} className="border-t py-3 first:border-t-0" style={{ borderColor: 'var(--color-line)' }}>
    <div className="flex items-center gap-3">
      <NutrientSpine nutrients={item.nutrients} />
      <button aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left">
        <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{item.dish_name}</span><span className="mt-0.5 block text-sm" style={{ color: 'var(--color-tx2)' }}>
          {item.portions} {item.portion_unit}{item.grams == null ? '' : ` · ${item.grams} g`}
        </span></span>
        <span className="shrink-0 tabular-nums text-sm font-semibold" style={{ color: unknown ? 'var(--color-warn)' : undefined }}>
          {unknown ? 'unknown' : `${Math.round(item.nutrients.calories_kcal ?? 0)} kcal`}</span>
      </button>
      <button onClick={() => { setOpen(true); setEditing(true) }} className="edit-badge shrink-0" aria-label="Edit serving">Edit serving</button>
    </div>
    {open && <div className="mt-3 text-sm" style={{ color: 'var(--color-tx2)' }}>
      {!unknown && <div className="mb-2 flex flex-wrap gap-4 font-medium tabular-nums"><span>P {Math.round(item.nutrients.protein_g ?? 0)}g</span>
        <span>C {Math.round(item.nutrients.carbs_g ?? 0)}g</span><span>F {Math.round(item.nutrients.fat_g ?? 0)}g</span>
        {item.grams != null && <span>{Math.round(item.grams)}g</span>}</div>}
      <p>Portion: {PROVENANCE[item.resolved_from] ?? item.resolved_from}{item.source !== 'manual' && ` · logged by ${item.source}`}</p>
      {editing ? <div className="mt-3 rounded-2xl border p-4" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface-soft)' }}>
        <label>Servings<input className="input mt-1" type="number" min="0.1" step="0.1" value={portions} onChange={(e) => setPortions(e.target.value)} /></label>
        {update.error && <p className="mt-2" style={{ color: 'var(--color-danger)' }}>{update.error.message}</p>}
        <div className="mt-3 flex gap-2"><button className="action-button" disabled={!portions || Number(portions) <= 0 || update.isPending} onClick={() => update.mutate()}>Save</button>
          <button className="action-button-secondary" onClick={() => setEditing(false)}>Cancel</button></div>
      </div> : <div className="mt-3 flex gap-2"><button className="action-button" onClick={() => setEditing(true)}>Edit portion</button>
        <button className="action-button-danger" disabled={remove.isPending} onClick={() => window.confirm(`Remove ${item.dish_name}?`) && remove.mutate()}>{remove.isPending ? 'Removing…' : 'Remove'}</button></div>}
      {remove.error && <p className="mt-2" style={{ color: 'var(--color-danger)' }}>{remove.error.message}</p>}
    </div>}
  </article>
}

function suggestedSlot() {
  const hour = new Date().getHours()
  if (hour < 11) return 'breakfast'
  if (hour < 15) return 'lunch'
  if (hour < 18) return 'snacks'
  return 'dinner'
}

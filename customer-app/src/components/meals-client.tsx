'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'

import { BottomNav } from '@/components/nav'
import { api, type Day, type Dish, type Meal } from '@/lib/api-client'

const SLOTS = ['breakfast', 'brunch', 'lunch', 'snacks', 'dinner', 'misc'] as const
const SLOT_LABEL: Record<string, string> = {
  breakfast: 'Breakfast', brunch: 'Brunch', lunch: 'Lunch', snacks: 'Snacks', dinner: 'Dinner', misc: 'Other',
}
const PROVENANCE: Record<string, string> = {
  meals: 'you set this', dish_household: 'your saved dish portion',
  category_household: 'your category portion', dish_global: 'standard dish portion',
  category_global: 'general category portion', unknown: 'nutrition unknown',
}
const iso = (date: Date) => date.toISOString().slice(0, 10)

export function MealsClient() {
  const [selected, setSelected] = useState(iso(new Date()))
  const [addingSlot, setAddingSlot] = useState<string | null>(null)
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
  const changed = () => queryClient.invalidateQueries({ queryKey: ['day', selected] })

  return (
    <div className="app-shell px-4 pt-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Meals</h1>
        <button onClick={() => setAddingSlot('misc')} className="rounded-lg px-3 py-2 text-sm font-medium"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}>Add meal</button>
      </div>

      <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
        {week.map((date) => {
          const key = iso(date)
          const active = key === selected
          const isToday = key === iso(new Date())
          return <button key={key} onClick={() => { setSelected(key); setAddingSlot(null) }}
            className="min-w-[52px] shrink-0 rounded-xl px-2 py-2 text-center"
            style={{ background: active ? 'var(--color-accent)' : 'var(--color-surface)',
              color: active ? 'var(--color-bg)' : 'var(--color-tx)',
              border: `1px solid ${isToday && !active ? 'var(--color-accent)' : 'var(--color-line)'}` }}>
            <div className="text-[10px] uppercase opacity-70">{date.toLocaleDateString(undefined, { weekday: 'short' })}</div>
            <div className="text-base tabular-nums">{date.getDate()}</div>
          </button>
        })}
      </div>

      {addingSlot && <ManualMealForm date={selected} initialSlot={addingSlot}
        onCancel={() => setAddingSlot(null)} onCreated={() => { setAddingSlot(null); changed() }} />}
      {dayQuery.data && <DayTotals day={dayQuery.data} />}
      {dayQuery.isLoading ? <p style={{ color: 'var(--color-tx2)' }}>Loading…</p> : SLOTS.map((slot) => {
        const items = dayQuery.data?.slots?.[slot] ?? []
        return <section key={slot} className="card mb-3 p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-medium">{SLOT_LABEL[slot]}</h2>
            <span className="text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>
              {Math.round(items.reduce((sum, item) => sum + (item.nutrients?.calories_kcal ?? 0), 0))} kcal
            </span>
          </div>
          {items.map((item) => <MealRow key={item.id} item={item} onChange={changed} />)}
          {!items.length && <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>Nothing logged.</p>}
          <button onClick={() => setAddingSlot(slot)} className="mt-3 text-sm" style={{ color: 'var(--color-accent)' }}>
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
      portions: Number(portions), grams: grams ? Number(grams) : undefined,
      portion_unit: grams ? 'g' : portionUnit }),
    onSuccess: onCreated,
  })
  const invalid = !search.trim() || !portions || Number(portions) <= 0 ||
    (!selectedDish && !grams) || (grams !== '' && Number(grams) <= 0)

  return <section aria-labelledby="manual-meal-heading" className="card mb-4 p-4">
    <div className="mb-4 flex items-center justify-between"><h2 id="manual-meal-heading" className="font-medium">Add manually</h2>
      <button onClick={onCancel} className="text-sm" style={{ color: 'var(--color-tx2)' }}>Close</button></div>
    <div className="grid grid-cols-2 gap-3">
      <label className="text-sm">Date<input value={date} disabled className="input mt-1 opacity-70" /></label>
      <label className="text-sm">Meal
        <select value={slot} onChange={(e) => setSlot(e.target.value)} className="input mt-1">
          {SLOTS.map((value) => <option key={value} value={value}>{SLOT_LABEL[value]}</option>)}
        </select>
      </label>
    </div>
    <label className="mt-3 block text-sm">Dish
      <input value={search} onChange={(e) => { setSearch(e.target.value); setSelectedDish(null) }}
             placeholder="Search dishes or type your own" className="input mt-1" />
    </label>
    {results.isFetching && <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>Searching…</p>}
    {results.data && !selectedDish && (
      <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--color-line)' }}>
        {results.data.items.map((dish) => <button key={dish.dish_id} type="button"
          onClick={() => { setSelectedDish(dish); setSearch(dish.name); setPortionUnit(dish.portion_unit) }}
          className="flex w-full justify-between border-b px-3 py-2 text-left text-sm last:border-b-0"
          style={{ borderColor: 'var(--color-line)' }}><span>{dish.name}</span>
          <span style={{ color: 'var(--color-tx2)' }}>{dish.portion_grams} g/{dish.portion_unit}</span></button>)}
        <button type="button" onClick={() => setSelectedDish(null)} className="w-full px-3 py-2 text-left text-sm"
                style={{ color: 'var(--color-accent)' }}>Use “{search.trim()}” as free text</button>
      </div>
    )}
    {selectedDish && resolved.data && <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>
      Your resolved portion: {resolved.data.portion_grams ?? 'unknown'} g per {resolved.data.portion_unit} · {PROVENANCE[resolved.data.resolved_from] ?? resolved.data.resolved_from}
    </p>}
    <div className="mt-3 grid grid-cols-2 gap-3">
      <label className="text-sm">Portions<input type="number" min="0.1" step="0.1" value={portions}
        onChange={(e) => setPortions(e.target.value)} className="input mt-1" /></label>
      <label className="text-sm">Exact grams (optional)<input type="number" min="1" value={grams}
        onChange={(e) => setGrams(e.target.value)} placeholder="Use portion default" className="input mt-1" /></label>
    </div>
    {!selectedDish && search.trim() && <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>
      Exact grams are required for a free-text dish.
    </p>}
    {create.error && <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{create.error.message}</p>}
    <button disabled={invalid || create.isPending} onClick={() => create.mutate()}
            className="btn-primary mt-4 w-full disabled:opacity-40">{create.isPending ? 'Adding…' : 'Add meal'}</button>
  </section>
}

function DayTotals({ day }: { day: Day }) {
  const totals = day.totals ?? {}
  return <section className="card mb-4 p-4"><div className="flex justify-between text-sm">
    {(['calories_kcal', 'protein_g', 'carbs_g', 'fat_g'] as const).map((key) => <div key={key} className="text-center">
      <div className="tabular-nums text-lg">{Math.round(totals[key] ?? 0)}</div>
      <div className="text-[11px]" style={{ color: 'var(--color-tx2)' }}>{key === 'calories_kcal' ? 'kcal' : key.replace('_g', '')}</div>
    </div>)}
  </div>{day.unaccounted_items > 0 && <p className="mt-3 text-xs" style={{ color: 'var(--color-warn)' }}>
    {day.unaccounted_items} item{day.unaccounted_items > 1 ? 's' : ''} excluded because nutrition is unknown.</p>}</section>
}

function MealRow({ item, onChange }: { item: Meal; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [portions, setPortions] = useState(String(item.portions))
  const [grams, setGrams] = useState(item.grams == null ? '' : String(item.grams))
  const [saveUsual, setSaveUsual] = useState(false)
  const unknown = !item.nutrients || Object.keys(item.nutrients).length === 0
  const update = useMutation({
    mutationFn: async () => {
      const updated = await api.adjustMeal(item.id, { portions: Number(portions), grams: grams ? Number(grams) : undefined,
        portion_unit: grams ? 'g' : item.portion_unit })
      if (saveUsual && item.food_id && grams) {
        await api.setDishPortion(item.food_id, { portion_unit: item.portion_unit,
          portion_grams: Number(grams) / Number(portions), note: 'Saved from meal correction' })
      }
      return updated
    },
    onSuccess: () => { setEditing(false); onChange() },
  })
  const remove = useMutation({ mutationFn: () => api.deleteMeal(item.id), onSuccess: onChange })

  return <article aria-label={item.dish_name} data-meal-id={item.id} className="border-t py-2 first:border-t-0" style={{ borderColor: 'var(--color-line)' }}>
    <button onClick={() => setOpen(!open)} className="flex w-full items-baseline justify-between text-left">
      <span className="flex-1">{item.dish_name}<span className="ml-2 text-xs" style={{ color: 'var(--color-tx2)' }}>
        {item.grams == null ? `${item.portions} ${item.portion_unit}` : `${item.grams} g`}
      </span></span>
      <span className="tabular-nums text-sm" style={{ color: unknown ? 'var(--color-warn)' : undefined }}>
        {unknown ? 'unknown' : `${Math.round(item.nutrients.calories_kcal ?? 0)} kcal`}</span>
    </button>
    {open && <div className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>
      {!unknown && <div className="mb-2 flex gap-4 tabular-nums"><span>P {Math.round(item.nutrients.protein_g ?? 0)}g</span>
        <span>C {Math.round(item.nutrients.carbs_g ?? 0)}g</span><span>F {Math.round(item.nutrients.fat_g ?? 0)}g</span>
        {item.grams != null && <span>{Math.round(item.grams)}g</span>}</div>}
      <p>Portion: {PROVENANCE[item.resolved_from] ?? item.resolved_from}{item.source !== 'manual' && ` · logged by ${item.source}`}</p>
      {editing ? <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--color-line)' }}>
        <div className="grid grid-cols-2 gap-2"><label>Portions<input className="input mt-1" type="number" min="0.1" step="0.1" value={portions} onChange={(e) => setPortions(e.target.value)} /></label>
          <label>Exact grams<input className="input mt-1" type="number" min="1" value={grams} onChange={(e) => setGrams(e.target.value)} /></label></div>
        {item.food_id && grams && <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={saveUsual} onChange={(e) => setSaveUsual(e.target.checked)} />Save these grams as my usual portion for this dish</label>}
        {update.error && <p className="mt-2" style={{ color: 'var(--color-danger)' }}>{update.error.message}</p>}
        <div className="mt-3 flex gap-3"><button disabled={!portions || Number(portions) <= 0 || update.isPending} onClick={() => update.mutate()} style={{ color: 'var(--color-accent)' }}>Save</button>
          <button onClick={() => setEditing(false)}>Cancel</button></div>
      </div> : <div className="mt-2 flex gap-4"><button onClick={() => setEditing(true)} style={{ color: 'var(--color-accent)' }}>Edit portion</button>
        <button disabled={remove.isPending} onClick={() => window.confirm(`Remove ${item.dish_name}?`) && remove.mutate()} style={{ color: 'var(--color-danger)' }}>{remove.isPending ? 'Removing…' : 'Remove'}</button></div>}
      {remove.error && <p className="mt-2" style={{ color: 'var(--color-danger)' }}>{remove.error.message}</p>}
    </div>}
  </article>
}

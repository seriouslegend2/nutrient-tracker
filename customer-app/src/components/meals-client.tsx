'use client'

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

import { BottomNav } from '@/components/nav'
import { NutrientSpine } from '@/components/nutrient-spine'
import { api, type Day, type Dish, type Meal } from '@/lib/api-client'
import { inclusiveDateRange, isISODate, localDateISO, shiftISODate, startOfWeekISO } from '@/lib/date'
import { formatNutrientValue, otherNutrients, primaryNutrients, scaleNutrients } from '@/lib/nutrients'

const SLOTS = ['breakfast', 'brunch', 'lunch', 'snacks', 'dinner', 'misc'] as const
type MealSlot = (typeof SLOTS)[number]
const SLOT_LABEL: Record<string, string> = {
  breakfast: 'Breakfast', brunch: 'Brunch', lunch: 'Lunch', snacks: 'Snacks', dinner: 'Dinner', misc: 'Other',
}
const PROVENANCE: Record<string, string> = {
  meals: 'you set this', dish_household: 'your saved dish portion',
  category_household: 'your usual household portion', dish_global: 'standard dish portion',
  category_global: 'general category portion', unknown: 'nutrition unknown',
}
export function MealsClient() {
  const params = useSearchParams()
  const requestedDate = params.get('date')
  const requestedSlot = params.get('slot')
  const initialDate = isISODate(requestedDate) ? requestedDate : localDateISO()
  const initialRangeStart = startOfWeekISO(initialDate)
  const [selected, setSelected] = useState(initialDate)
  const [rangeStart, setRangeStart] = useState(initialRangeStart)
  const [rangeEnd, setRangeEnd] = useState(shiftISODate(initialRangeStart, 6))
  const [slotFilter, setSlotFilter] = useState<MealSlot[]>([])
  const [adding, setAdding] = useState<{ date: string; slot: string } | null>(
    requestedSlot && SLOTS.some((slot) => slot === requestedSlot)
      ? { date: initialDate, slot: requestedSlot }
      : null
  )
  const activeDay = useRef<HTMLButtonElement>(null)
  const daySections = useRef(new Map<string, HTMLElement>())
  const pendingJump = useRef(false)
  const queryClient = useQueryClient()
  const range = useMemo(() => inclusiveDateRange(rangeStart, rangeEnd), [rangeEnd, rangeStart])
  const dayQueries = useQueries({
    queries: range.map((date) => ({ queryKey: ['day', date], queryFn: () => api.day(date) })),
  })
  useEffect(() => {
    activeDay.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    if (pendingJump.current) {
      daySections.current.get(selected)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      pendingJump.current = false
    }
  }, [selected, rangeStart, rangeEnd])
  const changed = (date: string) => {
    queryClient.invalidateQueries({ queryKey: ['day', date] })
    queryClient.invalidateQueries({ queryKey: ['goals', 'summary'] })
  }
  const selectDate = (date: string, jump = false) => {
    pendingJump.current = jump
    setSelected(date)
    setAdding(null)
    if (jump && date === selected) {
      daySections.current.get(date)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      pendingJump.current = false
    }
  }
  const addMeal = (date: string, slot = suggestedSlot()) => {
    pendingJump.current = true
    setSelected(date)
    setAdding({ date, slot })
  }
  const applyRange = (start: string, end: string) => {
    if (!isISODate(start) || !isISODate(end)) return
    const safeEnd = end < start ? start : end
    setRangeStart(start)
    setRangeEnd(safeEnd)
    if (selected < start || selected > safeEnd) selectDate(start)
  }
  const showToday = () => {
    const today = localDateISO()
    if (today < rangeStart || today > rangeEnd) {
      const start = startOfWeekISO(today)
      setRangeStart(start)
      setRangeEnd(shiftISODate(start, 6))
    }
    selectDate(today, true)
  }
  const toggleSlot = (slot: MealSlot) => {
    setSlotFilter((current) => current.includes(slot)
      ? current.length === 1 ? [] : current.filter((value) => value !== slot)
      : [...current, slot])
  }

  return (
    <div className="app-shell px-4 pt-6 sm:px-6">
      <div className="mb-5 flex items-end justify-between">
        <div><p className="mb-1 text-base font-semibold" style={{ color: 'var(--color-accent-strong)' }}>Nourish</p><h1 className="display-title text-[38px] leading-none">Meals</h1></div>
        <button onClick={() => addMeal(selected)} className="btn-primary px-4 text-sm">+ Add meal</button>
      </div>

      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-semibold">All meals in the selected range</p>
        {selected !== localDateISO() && <button className="action-button" onClick={showToday}>Today</button>}
      </div>

      <section className="card mb-3 p-4" aria-label="Meal date range">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[138px] flex-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-tx2)' }}>
            From
            <input type="date" value={rangeStart} max={rangeEnd} onChange={(event) => applyRange(event.target.value, rangeEnd)} className="input mt-1" />
          </label>
          <label className="min-w-[138px] flex-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-tx2)' }}>
            To
            <input type="date" value={rangeEnd} min={rangeStart} onChange={(event) => applyRange(rangeStart, event.target.value)} className="input mt-1" />
          </label>
          <div className="flex min-h-11 items-center gap-2">
            {[5, 7, 14].map((days) => <button key={days} type="button"
              onClick={() => applyRange(rangeStart, shiftISODate(rangeStart, days - 1))}
              className={range.length === days ? 'action-button' : 'action-button-secondary'}>{days} days</button>)}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold">{range.length} day{range.length === 1 ? '' : 's'}</p>
          <p className="text-xs" style={{ color: 'var(--color-tx2)' }}>All days are shown below · tap to jump</p>
        </div>
      </section>

      <section className="card mb-3 p-4" aria-labelledby="meal-slot-filter-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="meal-slot-filter-heading" className="font-semibold">Filter meal slots</h2>
          <span className="text-xs" style={{ color: 'var(--color-tx2)' }}>{slotFilter.length ? `${slotFilter.length} selected` : 'Showing all'}</span>
        </div>
        <div className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Meal slots to show">
          <SlotFilterButton label="All" selected={slotFilter.length === 0} onClick={() => setSlotFilter([])} />
          {SLOTS.map((slot) => <SlotFilterButton key={slot} label={SLOT_LABEL[slot]}
            selected={slotFilter.includes(slot)} onClick={() => toggleSlot(slot)} />)}
        </div>
      </section>

      <div className="sticky top-0 z-40 -mx-4 mb-5 border-y px-4 py-2 shadow-sm backdrop-blur sm:-mx-6 sm:px-6"
        style={{ borderColor: 'var(--color-line)', background: 'color-mix(in oklch, var(--color-bg) 92%, transparent)' }}>
        <div className="mx-auto flex max-w-[720px] gap-2 overflow-x-auto py-1" role="tablist" aria-label="Jump to a meal day">
        {range.map((key) => {
          const date = new Date(`${key}T12:00:00`)
          const active = key === selected
          const isToday = key === localDateISO()
          return <button key={key} ref={active ? activeDay : undefined} role="tab" aria-selected={active} onClick={() => selectDate(key, true)}
            className="min-w-[56px] shrink-0 rounded-2xl px-2 py-2.5 text-center shadow-sm"
            style={{ background: active ? 'var(--color-accent-strong)' : 'var(--color-surface)',
              color: active ? 'oklch(0.98 0.01 100)' : 'var(--color-tx)',
              border: `1px solid ${isToday && !active ? 'var(--color-accent)' : 'var(--color-line)'}` }}>
            <div className="text-[13px] font-semibold uppercase opacity-80">{date.toLocaleDateString(undefined, { weekday: 'short' })}</div>
            <div className="text-lg font-bold tabular-nums">{date.getDate()}</div>
          </button>
        })}
        </div>
      </div>

      <div className="space-y-10">
        {range.map((date, index) => {
          const dayQuery = dayQueries[index]
          const populatedSlots = SLOTS.filter((slot) => (dayQuery.data?.slots?.[slot]?.length ?? 0) > 0)
          const visibleSlots = slotFilter.length
            ? populatedSlots.filter((slot) => slotFilter.includes(slot))
            : populatedSlots
          const visibleItems = visibleSlots.flatMap((slot) => dayQuery.data?.slots?.[slot] ?? [])
          const dateLabel = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
          })
          return <section key={date} id={`meal-day-${date}`} className="scroll-mt-4"
            ref={(node) => { if (node) daySections.current.set(date, node); else daySections.current.delete(date) }}
            aria-labelledby={`meal-day-heading-${date}`}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div><p className="eyebrow">{date === localDateISO() ? 'Today' : 'Meal day'}</p>
                <h2 id={`meal-day-heading-${date}`} className="display-title text-2xl">{dateLabel}</h2></div>
              <button className="action-button" onClick={() => addMeal(date)}>+ Add meal</button>
            </div>

            {adding?.date === date && <ManualMealForm date={date} initialSlot={adding.slot}
              onCancel={() => setAdding(null)} onCreated={() => { setAdding(null); changed(date) }} />}
            {dayQuery.data && <DayTotals day={dayQuery.data} visibleItems={slotFilter.length ? visibleItems : undefined} />}
            {dayQuery.isError ? <section className="card p-5"><p className="font-semibold">Meals could not be loaded.</p><button className="action-button mt-3" onClick={() => dayQuery.refetch()}>Try again</button></section>
              : dayQuery.isLoading ? <section className="card p-5">Loading meals…</section>
              : visibleSlots.length ? visibleSlots.map((slot) => {
                const items = dayQuery.data?.slots?.[slot] ?? []
                return <section key={slot} className="card mb-3 p-5">
                  <div className="mb-2 flex items-baseline justify-between">
                    <h3 className="display-title text-xl">{SLOT_LABEL[slot]}</h3>
                    <span className="text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>
                      {Math.round(items.reduce((sum, item) => sum + (item.nutrients?.calories_kcal ?? 0), 0))} kcal
                    </span>
                  </div>
                  {items.map((item) => <MealRow key={item.id} item={item} onChange={() => changed(date)} />)}
                  <button onClick={() => addMeal(date, slot)} className="action-button mt-3 w-full">+ Add {SLOT_LABEL[slot].toLowerCase()}</button>
                </section>
              }) : <section className="card p-5 text-center"><p className="text-sm" style={{ color: 'var(--color-tx2)' }}>{slotFilter.length && populatedSlots.length ? 'No meals logged in the selected slots.' : 'Nothing logged on this day.'}</p>
                {slotFilter.length && populatedSlots.length
                  ? <button onClick={() => setSlotFilter([])} className="action-button mt-3">Show all meal slots</button>
                  : <button onClick={() => addMeal(date)} className="action-button mt-3">+ Add the first meal</button>}</section>}
          </section>
        })}
      </div>
      <BottomNav />
    </div>
  )
}

function SlotFilterButton({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={selected} onClick={onClick}
    className="min-h-10 shrink-0 rounded-full border px-4 text-sm font-semibold"
    style={{
      borderColor: selected ? 'var(--color-accent)' : 'var(--color-line)',
      background: selected ? 'var(--color-accent-soft)' : 'var(--color-surface)',
      color: selected ? 'var(--color-accent-strong)' : 'var(--color-tx2)',
    }}>{label}</button>
}

function ManualMealForm({ date, initialSlot, onCancel, onCreated }: {
  date: string; initialSlot: string; onCancel: () => void; onCreated: () => void
}) {
  const [slot, setSlot] = useState(initialSlot)
  const [search, setSearch] = useState('')
  const [selectedDish, setSelectedDish] = useState<Dish | null>(null)
  const [portions, setPortions] = useState('1')
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
  const previewGrams = (resolved.data?.portion_grams ?? selectedDish?.portion_grams ?? 0) * Number(portions || 0)
  const previewNutrients = scaleNutrients(
    resolved.data?.nutrients_per_unit ?? selectedDish?.nutrients_per_unit ?? {},
    Number(portions || 0)
  )

  const create = useMutation({
    mutationFn: () => api.logMeal({ meal_date: date, meal_type: slot,
      dish_name: search.trim(), food_id: selectedDish?.dish_id,
      portions: Number(portions),
      portion_unit: selectedDish ? portionUnit : undefined }),
    onSuccess: onCreated,
  })
  const invalid = !search.trim() || !portions || Number(portions) <= 0

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
      <input value={search} onChange={(e) => { setSearch(e.target.value); setSelectedDish(null) }}
             placeholder="Search foods and dishes" className="input mt-1" />
    </label>
    {results.isFetching && <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>Searching…</p>}
    {results.data && !selectedDish && (
      <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--color-line)' }}>
        {results.data.items.map((dish) => {
          const nutrients = scaleNutrients(dish.nutrients_per_unit, 1)
          return <button key={dish.dish_id} type="button"
            onClick={() => { setSelectedDish(dish); setSearch(dish.name); setPortionUnit(dish.portion_unit) }}
            className="block w-full border-b px-3 py-2.5 text-left text-sm last:border-b-0"
            style={{ borderColor: 'var(--color-line)' }}>
            <span className="flex justify-between gap-3"><span className="font-semibold">{dish.name}</span>
              <span className="shrink-0" style={{ color: 'var(--color-tx2)' }}>{dish.portion_grams} g/{dish.portion_unit}</span></span>
            <NutrientSummary nutrients={nutrients} className="mt-1 text-xs" />
          </button>
        })}
        {!results.data.items.length && <div className="p-3"><p className="text-sm" style={{ color: 'var(--color-tx2)' }}>No matching food found. Add it with servings and we’ll resolve its category and nutrition.</p></div>}
      </div>
    )}
    {selectedDish && resolved.data && <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>
      Your resolved portion: {resolved.data.portion_grams ?? 'unknown'} g per {resolved.data.portion_unit} · {PROVENANCE[resolved.data.resolved_from] ?? resolved.data.resolved_from}
    </p>}
    <div className="mt-3">
      <label className="text-sm">Servings<input type="number" min="0.1" step="0.1" value={portions}
        onChange={(e) => setPortions(e.target.value)} className="input mt-1" /></label>
    </div>
    {selectedDish && resolved.data && previewGrams > 0 && <div className="mt-3 rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}>
      <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-tx2)' }}>
        Estimated for {formatNutrientValue(Number(portions))} {Number(portions) === 1 ? 'serving' : 'servings'} · {formatNutrientValue(previewGrams)} g
      </p>
      <NutrientSummary nutrients={previewNutrients} className="mt-2 text-sm font-semibold" />
      <OtherNutrients nutrients={previewNutrients} />
    </div>}
    {!selectedDish && search.trim() && <p className="mt-2 text-xs" style={{ color: 'var(--color-tx2)' }}>
      Select a result for an instant match, or add this name and we’ll resolve it.
    </p>}
    {create.error && <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{create.error.message}</p>}
    <button disabled={invalid || create.isPending} onClick={() => create.mutate()}
            className="btn-primary mt-4 w-full disabled:opacity-40">{create.isPending ? 'Adding…' : 'Add meal'}</button>
  </section>
}

function DayTotals({ day, visibleItems }: { day: Day; visibleItems?: Meal[] }) {
  const totals = visibleItems
    ? visibleItems.reduce<Record<string, number>>((sum, item) => {
        Object.entries(item.nutrients ?? {}).forEach(([key, value]) => { sum[key] = (sum[key] ?? 0) + value })
        return sum
      }, {})
    : day.totals ?? {}
  const unaccountedItems = visibleItems
    ? visibleItems.filter((item) => !item.nutrients || Object.keys(item.nutrients).length === 0).length
    : day.unaccounted_items
  return <section className="card mb-4 p-4"><div className="grid grid-cols-4 divide-x text-sm" style={{ borderColor: 'var(--color-line)' }}>
    {(['calories_kcal', 'protein_g', 'carbs_g', 'fat_g'] as const).map((key) => <div key={key} className="text-center">
      <div className="display-title tabular-nums text-xl">{Math.round(totals[key] ?? 0)}</div>
      <div className="text-sm capitalize" style={{ color: 'var(--color-tx2)' }}>{key === 'calories_kcal' ? 'kcal' : key.replace('_g', '')}</div>
    </div>)}
  </div>{unaccountedItems > 0 && <p className="mt-3 text-xs" style={{ color: 'var(--color-warn)' }}>
    {unaccountedItems} item{unaccountedItems > 1 ? 's' : ''} excluded because nutrition is unknown.</p>}</section>
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
      <button aria-expanded={open} onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
        <span className="block truncate font-semibold">{item.dish_name}</span><span className="mt-0.5 block text-sm" style={{ color: 'var(--color-tx2)' }}>
          {item.portions} {item.portion_unit}{item.grams == null ? '' : ` · ${item.grams} g`}
        </span>
        {unknown ? <span className="mt-1 block text-xs" style={{ color: 'var(--color-warn)' }}>Nutrition unknown</span>
          : <NutrientSummary nutrients={item.nutrients} className="mt-1 text-xs font-semibold" />}
      </button>
      <button onClick={() => { setOpen(true); setEditing(true) }} className="edit-badge shrink-0" aria-label="Edit serving">Edit this meal</button>
    </div>
    {open && <div className="mt-3 text-sm" style={{ color: 'var(--color-tx2)' }}>
      {!unknown && <OtherNutrients nutrients={item.nutrients} />}
      <p>Portion: {PROVENANCE[item.resolved_from] ?? item.resolved_from}{item.source !== 'manual' && ` · logged by ${item.source}`}</p>
      {editing ? <div className="mt-3 rounded-2xl border p-4" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface-soft)' }}>
        <p className="mb-2 text-xs">This changes only this meal. Your usual household portion stays the same.</p>
        <label>Servings<input className="input mt-1" type="number" min="0.1" step="0.1" value={portions} onChange={(e) => setPortions(e.target.value)} /></label>
        {update.error && <p className="mt-2" style={{ color: 'var(--color-danger)' }}>{update.error.message}</p>}
        <div className="mt-3 flex gap-2"><button className="action-button" disabled={!portions || Number(portions) <= 0 || update.isPending} onClick={() => update.mutate()}>Save</button>
          <button className="action-button-secondary" onClick={() => setEditing(false)}>Cancel</button></div>
      </div> : <div className="mt-3 flex gap-2"><button className="action-button" onClick={() => setEditing(true)}>Edit this meal</button>
        <button className="action-button-danger" disabled={remove.isPending} onClick={() => window.confirm(`Remove ${item.dish_name}?`) && remove.mutate()}>{remove.isPending ? 'Removing…' : 'Remove'}</button></div>}
      {remove.error && <p className="mt-2" style={{ color: 'var(--color-danger)' }}>{remove.error.message}</p>}
    </div>}
  </article>
}

function NutrientSummary({ nutrients, className = '' }: { nutrients: Record<string, number>; className?: string }) {
  const items = primaryNutrients(nutrients)
  if (!items.length) return null
  return <span className={`block tabular-nums ${className}`} style={{ color: 'var(--color-tx2)' }}>
    {items.map((item, index) => <span key={item.key}>{index > 0 && <span className="mx-1.5 opacity-50">·</span>}
      {item.key === 'calories_kcal' ? `${formatNutrientValue(item.value)} kcal` : `${item.label === 'Protein' ? 'P' : item.label === 'Carbs' ? 'C' : item.label === 'Fat' ? 'F' : item.label} ${formatNutrientValue(item.value)}${item.unit}`}
    </span>)}
  </span>
}

function OtherNutrients({ nutrients }: { nutrients: Record<string, number> }) {
  const items = otherNutrients(nutrients)
  if (!items.length) return null
  return <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>
    {items.map((item) => <span key={item.key}>{item.label} {formatNutrientValue(item.value)}{item.unit}</span>)}
  </div>
}

function suggestedSlot() {
  const hour = new Date().getHours()
  if (hour < 11) return 'breakfast'
  if (hour < 15) return 'lunch'
  if (hour < 18) return 'snacks'
  return 'dinner'
}

import type {
  MealDraftConfirmRequest,
  MediaMealDraftItem,
} from '@/lib/api-client'

export type MealDraftReviewItem = {
  id: string
  name: string
  resolvedName: string | null
  amount: number
  baseAmount: number
  measurement: 'grams' | 'portions'
  unit: string
  gramsPerUnit: number | null
  range: { low: number; high: number } | null
  confidence: string | null
  householdAmount: number | null
  householdUnit: string | null
  foodId: string | null
  nutrients: Record<string, number>
}

export type ParsedMealDraft = {
  items: MealDraftReviewItem[]
  sourceKind: string | null
}

const NUTRIENT_KEYS = new Set(['calories_kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'])

export function parseMediaMealDraft(payload: unknown): ParsedMealDraft | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return null

  const items = payload.items.flatMap((value, index) => {
    const parsed = parseItem(value, index)
    return parsed ? [parsed] : []
  })
  if (!items.length) return null

  const source = isRecord(payload.source_metadata) ? payload.source_metadata.kind : null
  return { items, sourceKind: typeof source === 'string' ? source : null }
}

export function calculateMealDraftTotals(items: MealDraftReviewItem[]): {
  nutrients: Record<string, number>
  unresolvedItems: number
} {
  const nutrients: Record<string, number> = {}
  let unresolvedItems = 0

  for (const item of items) {
    const entries = Object.entries(item.nutrients)
    if (!entries.length) {
      unresolvedItems += 1
      continue
    }
    const scale = item.baseAmount > 0 ? item.amount / item.baseAmount : 1
    for (const [key, value] of entries) {
      nutrients[key] = (nutrients[key] ?? 0) + value * scale
    }
  }

  return { nutrients, unresolvedItems }
}

export function buildMealDraftConfirmRequest(
  items: MealDraftReviewItem[],
  mealDate: string,
  mealType: string
): MealDraftConfirmRequest {
  return {
    meal_date: mealDate,
    meal_type: mealType,
    items: items.map((item) => ({
      dish_name: item.resolvedName ?? item.name,
      grams: item.measurement === 'grams'
        ? item.amount
        : item.gramsPerUnit != null
          ? round(item.amount * item.gramsPerUnit)
          : null,
      portions: item.measurement === 'portions' ? item.amount : 1,
      portion_unit: item.measurement === 'grams' ? 'g' : item.unit,
      ...(item.foodId ? { food_id: item.foodId } : {}),
      ...(item.confidence ? { confidence: item.confidence } : {}),
    })),
  }
}

function parseItem(value: unknown, index: number): MealDraftReviewItem | null {
  if (!isRecord(value)) return null
  const item = value as Partial<MediaMealDraftItem>
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!name) return null

  const portionMetadata = isRecord(item.portion_metadata) ? item.portion_metadata : null
  const grams = firstPositive(item.total_grams, item.estimated_mass_g)
  const householdAmount = firstPositive(
    portionMetadata?.portion_count, item.portions, item.portion_count, item.quantity, item.count
  )
  const householdUnit = firstString(
    portionMetadata?.portion_unit, item.portion_unit, item.unit, item.container
  )
  const gramsPerUnit = firstPositive(portionMetadata?.portion_grams)
  const canUseHouseholdUnit = grams != null && gramsPerUnit != null && householdUnit != null && householdUnit !== 'g'
  const measurement = canUseHouseholdUnit || grams == null ? 'portions' : 'grams'
  const amount = canUseHouseholdUnit ? round(grams / gramsPerUnit) : grams ?? householdAmount ?? 1

  return {
    id: `${index}-${name}`,
    name,
    resolvedName: firstString(item.resolved_name),
    amount,
    baseAmount: amount,
    measurement,
    unit: measurement === 'grams' ? 'g' : householdUnit ?? 'serving',
    gramsPerUnit: measurement === 'portions' ? gramsPerUnit : null,
    range: parseRange(item.mass_range_g),
    confidence: parseConfidence(item.confidence),
    householdAmount,
    householdUnit,
    foodId: typeof item.food_id === 'string' ? item.food_id : null,
    nutrients: parseNutrients(value),
  }
}

function parseNutrients(item: Record<string, unknown>): Record<string, number> {
  const nutrients: Record<string, number> = {}
  const candidates = [item.nutrients, item.resolved_nutrients, item.nutrition]
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    for (const [key, value] of Object.entries(candidate)) {
      if (NUTRIENT_KEYS.has(key) && finiteNumber(value) != null) nutrients[key] = Number(value)
    }
  }
  for (const key of NUTRIENT_KEYS) {
    const value = finiteNumber(item[key])
    if (value != null) nutrients[key] = value
  }

  return nutrients
}

function parseRange(value: unknown): { low: number; high: number } | null {
  if (!isRecord(value)) return null
  const low = finiteNumber(value.low)
  const high = finiteNumber(value.high)
  return low != null && high != null ? { low, high } : null
}

function parseConfidence(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value
  if (!isRecord(value)) return null
  return firstString(value.mass, value.identity)
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed != null && parsed > 0 ? parsed : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function firstPositive(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = positiveNumber(value)
    if (parsed != null) return parsed
  }
  return null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import type {
  MealDraftConfirmRequest,
  MediaMealDraftItem,
} from '@/lib/api-client'
import { normalizeMealServings } from '@/lib/servings'

export type MealDraftReviewItem = {
  id: string
  evidenceId: string
  name: string
  resolvedName: string
  servings: number
  baseServings: number
  servingUnit: string
  gramsPerServing: number
  range: { low: number; high: number } | null
  confidence: string | null
  amountSource: string | null
  foodId: string
  nutrients: Record<string, number>
}

export type ParsedMealDraft = {
  items: MealDraftReviewItem[]
  sourceKind: string | null
  mealDate: string | null
  mealType: string | null
}

const NUTRIENT_KEY = /_(?:g|mg|ug|iu)$/

export function parseMediaMealDraft(payload: unknown): ParsedMealDraft | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return null

  const items = payload.items.flatMap((value, index) => {
    const parsed = parseItem(value, index)
    return parsed ? [parsed] : []
  })
  if (!items.length) return null

  const source = isRecord(payload.source_metadata) ? payload.source_metadata.kind : null
  const firstItem = isRecord(payload.items[0]) ? payload.items[0] : {}
  return {
    items,
    sourceKind: typeof source === 'string' ? source : null,
    mealDate: firstString(payload.meal_date, firstItem.meal_date),
    mealType: firstString(payload.meal_type, firstItem.meal_type),
  }
}

export function mealDraftItemGrams(item: MealDraftReviewItem): number {
  return round(normalizeMealServings(item.servings) * item.gramsPerServing)
}

export function calculateMealDraftTotals(items: MealDraftReviewItem[]): {
  nutrients: Record<string, number>
  totalGrams: number
} {
  const nutrients: Record<string, number> = {}
  let totalGrams = 0

  for (const item of items) {
    totalGrams += mealDraftItemGrams(item)
    const scale = item.baseServings > 0
      ? normalizeMealServings(item.servings) / item.baseServings
      : 1
    for (const [key, value] of Object.entries(item.nutrients)) {
      nutrients[key] = (nutrients[key] ?? 0) + value * scale
    }
  }

  return {
    nutrients: Object.fromEntries(
      Object.entries(nutrients).map(([key, value]) => [key, round(value)])
    ),
    totalGrams: round(totalGrams),
  }
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
      evidence_id: item.evidenceId,
      dish_name: item.resolvedName,
      food_id: item.foodId,
      grams: mealDraftItemGrams(item),
      portions: normalizeMealServings(item.servings),
      portion_unit: item.servingUnit,
      ...(item.confidence ? { confidence: item.confidence } : {}),
    })),
  }
}

function parseItem(value: unknown, index: number): MealDraftReviewItem | null {
  if (!isRecord(value)) return null
  const item = value as Partial<MediaMealDraftItem>
  const name = firstString(item.name)
  const resolvedName = firstString(item.resolved_name)
  const foodId = firstString(item.food_id)
  const evidenceId = firstString(item.evidence_id)
  const portionMetadata = isRecord(item.portion_metadata) ? item.portion_metadata : null
  const servingUnit = firstString(portionMetadata?.portion_unit, item.portion_unit)
  const gramsPerServing = firstPositive(portionMetadata?.portion_grams)
  if (!name || !resolvedName || !foodId || !evidenceId || !servingUnit || gramsPerServing == null) {
    return null
  }

  const totalGrams = firstPositive(item.total_grams, item.estimated_mass_g)
  const rawServings = firstPositive(
    item.servings,
    item.portions,
    totalGrams != null ? totalGrams / gramsPerServing : null,
  ) ?? 1
  const servings = normalizeMealServings(rawServings)
  const servingScale = servings / rawServings

  return {
    id: `${index}-${evidenceId}`,
    evidenceId,
    name,
    resolvedName,
    servings,
    baseServings: servings,
    servingUnit,
    gramsPerServing,
    range: parseRange(item.mass_range_g),
    confidence: parseConfidence(item.confidence),
    amountSource: firstString(item.amount_source),
    foodId,
    nutrients: Object.fromEntries(
      Object.entries(parseNutrients(value)).map(([key, nutrient]) => [
        key,
        round(nutrient * servingScale),
      ])
    ),
  }
}

function parseNutrients(item: Record<string, unknown>): Record<string, number> {
  const nutrients: Record<string, number> = {}
  const candidates = [item.nutrients, item.resolved_nutrients, item.nutrition]
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    for (const [key, value] of Object.entries(candidate)) {
      if (isNutrientKey(key) && finiteNumber(value) != null) nutrients[key] = Number(value)
    }
  }
  for (const [key, candidate] of Object.entries(item)) {
    const value = finiteNumber(candidate)
    if (isNutrientKey(key) && value != null) nutrients[key] = value
  }
  return nutrients
}

function isNutrientKey(key: string): boolean {
  return key === 'calories_kcal' || NUTRIENT_KEY.test(key)
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
